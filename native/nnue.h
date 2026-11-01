// Experimental FRNN1 NNUE evaluator (research prototype).
//
// This is NOT integrated into the engine. It is a dependency-free C++17
// inference implementation for the network trained by tools/nnue/train.js.
// Format and quantization are documented in docs/NNUE.md.
//
// Board convention (same as native/kiwa.cpp):
//   int8_t board[128], 0x88. Empty = 0.
//   White pieces 1..6 = PAWN,KNIGHT,BISHOP,ROOK,QUEEN,KING.
//   Black pieces 9..14 = piece | 8.
//   Square = rank * 16 + file, a1 = 0, rank 0 is White's first rank.
//   side: 0 = White to move, 1 = Black to move.
//
// The evaluation is always from the side-to-move perspective, in centipawns,
// using integer arithmetic only (bit-for-bit reproducible).

#ifndef FRNN1_NNUE_H
#define FRNN1_NNUE_H

#include <cstdint>
#include <string>
#include <vector>

namespace nnue {

constexpr int kInputFeatures = 768;  // 2 colors * 6 piece types * 64 squares
constexpr int kMaxHidden = 256;      // loader limit for H1 and H2

// Dual-perspective feature-transformer accumulator. acc.v[0] is White's
// perspective, acc.v[1] is Black's. Both are maintained incrementally.
struct Accumulator {
  int32_t v[2][kMaxHidden];
};

struct Network {
  int h1 = 0;
  int h2 = 0;
  int shift1 = 0;  // right shift applied to the input accumulator
  int shift2 = 0;  // right shift applied to hidden layer 2 pre-activations
  int shift3 = 0;  // right shift applied to the output
  int clamp1 = 255;
  int clamp2 = 255;
  int clampOut = 4000;

  std::vector<int32_t> b1;   // [h1]
  std::vector<int16_t> w1;   // [768 * h1], row major [feature * h1 + h]
  std::vector<int32_t> b2;   // [h2]
  std::vector<int16_t> w2;   // [h1 * h2], row major [h * h2 + j]
  int32_t b3 = 0;
  std::vector<int16_t> w3;   // [h2]

  uint32_t checksum = 0;     // FNV-1a32 of the payload, as stored in the file

  // Loads and validates an FRNN1 file. Returns false and sets error() on
  // failure; ok() then remains false.
  bool load(const char* path);
  bool ok() const { return ok_; }
  const std::string& error() const { return error_; }

  // Sets acc to b1 + the features of every piece on the board (both
  // perspectives).
  void reset(const int8_t* board, Accumulator& acc) const;

  // Incremental feature-transformer updates. piece must be 1..6 or 9..14,
  // square a 0x88 index. Both perspectives are updated.
  void addPiece(int piece, int square, Accumulator& acc) const;
  void removePiece(int piece, int square, Accumulator& acc) const;

  // Forward pass on an already-built accumulator; side selects the
  // side-to-move perspective. Returns centipawns from that side's view.
  int evaluate(const Accumulator& acc, int side) const;

  // Convenience full refresh + evaluate.
  int evaluate(const int8_t* board, int side) const;

 private:
  bool ok_ = false;
  std::string error_;
};

// Feature index: rel * 384 + type * 64 + mirrored_square, where rel is 0 for
// the perspective's own pieces and 1 for enemy pieces, and ranks are mirrored
// for the Black perspective. Mirrors featureIndex() in tools/nnue/pgn.js.
inline int featureIndex(int piece, int square, int perspective) {
  const int rel = ((piece >> 3) ^ perspective) & 1;
  const int type = (piece & 7) - 1;
  int s = (square >> 4) * 8 + (square & 7);
  if (perspective == 1) s ^= 56;
  return rel * 384 + type * 64 + s;
}

}  // namespace nnue

#endif  // FRNN1_NNUE_H
