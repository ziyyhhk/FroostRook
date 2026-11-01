#include "nnue.h"

#include <cstring>
#include <fstream>
#include <iterator>

namespace nnue {
namespace {

constexpr uint32_t kFnvOffset = 2166136261u;
constexpr uint32_t kFnvPrime = 16777619u;

uint16_t readU16(const uint8_t* p) {
  return static_cast<uint16_t>(p[0] | (p[1] << 8));
}

uint32_t readU32(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) |
         (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) |
         (static_cast<uint32_t>(p[3]) << 24);
}

int16_t readI16(const uint8_t* p) {
  uint16_t u = readU16(p);
  int16_t v;
  std::memcpy(&v, &u, sizeof(v));
  return v;
}

int32_t readI32(const uint8_t* p) {
  uint32_t u = readU32(p);
  int32_t v;
  std::memcpy(&v, &u, sizeof(v));
  return v;
}

uint32_t fnv1a32(const uint8_t* p, size_t n) {
  uint32_t h = kFnvOffset;
  for (size_t i = 0; i < n; i++) {
    h ^= p[i];
    h *= kFnvPrime;
  }
  return h;
}

// Clipped ReLU on a fixed-point pre-activation. Matches qrelu() in
// tools/nnue/train.js: positive values are rounded half away from zero.
inline int qrelu(int64_t x, int shift, int maxv) {
  if (x <= 0) return 0;
  if (shift <= 0) return x > maxv ? maxv : static_cast<int>(x);
  const int64_t v = (x + (int64_t{1} << (shift - 1))) >> shift;
  return v > maxv ? maxv : static_cast<int>(v);
}

// Round-half-away-from-zero division by 2^shift. Matches divRound() in
// tools/nnue/train.js.
inline int64_t divRound(int64_t x, int shift) {
  if (shift <= 0) return x;
  const int64_t s = int64_t{1} << shift;
  const int64_t half = s >> 1;
  if (x >= 0) return (x + half) >> shift;
  return -((-x + half) >> shift);
}

}  // namespace

bool Network::load(const char* path) {
  ok_ = false;
  error_.clear();

  std::ifstream f(path, std::ios::binary);
  if (!f) {
    error_ = "cannot open network file";
    return false;
  }
  std::vector<uint8_t> buf((std::istreambuf_iterator<char>(f)),
                           std::istreambuf_iterator<char>());
  if (!f.eof() && f.fail()) {
    error_ = "read error";
    return false;
  }

  const uint8_t magic[6] = {'F', 'R', 'N', 'N', '1', 0};
  if (buf.size() < 32) {
    error_ = "file too short for header";
    return false;
  }
  if (std::memcmp(buf.data(), magic, sizeof(magic)) != 0) {
    error_ = "bad magic (expected FRNN1\\0)";
    return false;
  }

  const int version = buf[6];
  if (version != 1) {
    error_ = "unsupported version";
    return false;
  }

  const int fileH1 = readU16(buf.data() + 8);
  const int fileH2 = readU16(buf.data() + 10);
  const int features = readU16(buf.data() + 12);
  const int fileShift1 = buf[14];
  const int fileShift2 = buf[15];
  const int fileShift3 = buf[16];
  const int fileClamp1 = readU16(buf.data() + 18);
  const int fileClamp2 = readU16(buf.data() + 20);
  const int fileClampOut = readU16(buf.data() + 22);
  const uint32_t storedChecksum = readU32(buf.data() + 28);

  if (features != kInputFeatures) {
    error_ = "unsupported feature count";
    return false;
  }
  if (fileH1 < 1 || fileH1 > kMaxHidden || fileH2 < 1 || fileH2 > kMaxHidden) {
    error_ = "hidden layer size out of range";
    return false;
  }
  if (fileShift1 > 30 || fileShift2 > 30 || fileShift3 > 30) {
    error_ = "shift out of range";
    return false;
  }
  if (fileClamp1 < 0 || fileClamp1 > 255 || fileClamp2 < 0 || fileClamp2 > 255 ||
      fileClampOut < 0 || fileClampOut > 32767) {
    error_ = "activation clamp out of range";
    return false;
  }

  const size_t expected =
      32 + 4u * static_cast<size_t>(fileH1) +
      2u * static_cast<size_t>(kInputFeatures) * static_cast<size_t>(fileH1) +
      4u * static_cast<size_t>(fileH2) +
      2u * static_cast<size_t>(fileH1) * static_cast<size_t>(fileH2) + 4u +
      2u * static_cast<size_t>(fileH2);
  if (buf.size() != expected) {
    error_ = "unexpected file size";
    return false;
  }

  const uint32_t actualChecksum = fnv1a32(buf.data() + 32, buf.size() - 32);
  if (actualChecksum != storedChecksum) {
    error_ = "payload checksum mismatch";
    return false;
  }

  h1 = fileH1;
  h2 = fileH2;
  shift1 = fileShift1;
  shift2 = fileShift2;
  shift3 = fileShift3;
  clamp1 = fileClamp1;
  clamp2 = fileClamp2;
  clampOut = fileClampOut;
  checksum = storedChecksum;

  b1.resize(h1);
  w1.resize(static_cast<size_t>(kInputFeatures) * h1);
  b2.resize(h2);
  w2.resize(static_cast<size_t>(h1) * h2);
  w3.resize(h2);

  size_t o = 32;
  for (int i = 0; i < h1; i++, o += 4) b1[i] = readI32(buf.data() + o);
  for (size_t i = 0; i < w1.size(); i++, o += 2) w1[i] = readI16(buf.data() + o);
  for (int i = 0; i < h2; i++, o += 4) b2[i] = readI32(buf.data() + o);
  for (size_t i = 0; i < w2.size(); i++, o += 2) w2[i] = readI16(buf.data() + o);
  b3 = readI32(buf.data() + o);
  o += 4;
  for (int i = 0; i < h2; i++, o += 2) w3[i] = readI16(buf.data() + o);

  ok_ = true;
  return true;
}

void Network::reset(const int8_t* board, Accumulator& acc) const {
  for (int p = 0; p < 2; p++) {
    for (int h = 0; h < h1; h++) acc.v[p][h] = b1[h];
  }
  for (int sq = 0; sq < 128; sq++) {
    const int piece = board[sq];
    if (piece != 0) addPiece(piece, sq, acc);
  }
}

void Network::addPiece(int piece, int square, Accumulator& acc) const {
  for (int p = 0; p < 2; p++) {
    const int f = featureIndex(piece, square, p);
    const int16_t* w = w1.data() + static_cast<size_t>(f) * h1;
    int32_t* a = acc.v[p];
    for (int h = 0; h < h1; h++) a[h] += w[h];
  }
}

void Network::removePiece(int piece, int square, Accumulator& acc) const {
  for (int p = 0; p < 2; p++) {
    const int f = featureIndex(piece, square, p);
    const int16_t* w = w1.data() + static_cast<size_t>(f) * h1;
    int32_t* a = acc.v[p];
    for (int h = 0; h < h1; h++) a[h] -= w[h];
  }
}

int Network::evaluate(const Accumulator& acc, int side) const {
  if (side != 0 && side != 1) side = 0;

  uint8_t a1[kMaxHidden];
  const int32_t* src = acc.v[side];

  for (int h = 0; h < h1; h++) {
    a1[h] = static_cast<uint8_t>(qrelu(src[h], shift1, clamp1));
  }

  int64_t out = b3;
  for (int j = 0; j < h2; j++) {
    int64_t z = b2[j];
    for (int h = 0; h < h1; h++) {
      z += static_cast<int32_t>(a1[h]) * w2[static_cast<size_t>(h) * h2 + j];
    }
    const int act = qrelu(z, shift2, clamp2);
    out += static_cast<int64_t>(act) * w3[j];
  }

  int64_t cp = divRound(out, shift3);
  if (cp < -clampOut) cp = -clampOut;
  if (cp > clampOut) cp = clampOut;
  return static_cast<int>(cp);
}

int Network::evaluate(const int8_t* board, int side) const {
  Accumulator acc;
  reset(board, acc);
  return evaluate(acc, side);
}

}  // namespace nnue
