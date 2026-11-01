// nnue_bench — experimental FRNN1 NNUE evaluator benchmark / self-test.
//
//   nnue_bench <net> <positions>
//
// positions file: one "<fen>|<expected_cp>" per line (see
// data/nnue/selftest.txt). The expected value is the quantized evaluation of
// the network from the side-to-move perspective; it is produced by the JS
// trainer and must match the C++ implementation exactly (fixed point).
//
// The bench also checks that the incrementally updated accumulator produces
// the same evaluation as a full refresh for every position, and reports
// positions/sec and ns/eval for both full-refresh and incremental evaluation.

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "nnue.h"

namespace {

using Clock = std::chrono::steady_clock;

double secondsSince(Clock::time_point t0) {
  return std::chrono::duration<double>(Clock::now() - t0).count();
}

struct Position {
  int8_t board[128];
  int side = 0;
  int expected = 0;
  int full = 0;
  std::string fen;
};

// Parses the piece placement and side-to-move fields of a FEN. Castling,
// en passant and move counters are irrelevant to the evaluation.
bool parseFen(const std::string& fen, Position& pos) {
  std::memset(pos.board, 0, sizeof(pos.board));
  size_t i = 0;
  int rank = 7;
  int file = 0;
  for (; i < fen.size() && fen[i] != ' '; i++) {
    const char c = fen[i];
    if (c == '/') {
      if (file != 8) return false;
      rank--;
      file = 0;
      if (rank < 0) return false;
      continue;
    }
    if (c >= '1' && c <= '8') {
      file += c - '0';
      if (file > 8) return false;
      continue;
    }
    int piece = 0;
    switch (c) {
      case 'P': piece = 1; break;
      case 'N': piece = 2; break;
      case 'B': piece = 3; break;
      case 'R': piece = 4; break;
      case 'Q': piece = 5; break;
      case 'K': piece = 6; break;
      case 'p': piece = 9; break;
      case 'n': piece = 10; break;
      case 'b': piece = 11; break;
      case 'r': piece = 12; break;
      case 'q': piece = 13; break;
      case 'k': piece = 14; break;
      default: return false;
    }
    if (rank < 0 || file > 7) return false;
    pos.board[rank * 16 + file] = static_cast<int8_t>(piece);
    file++;
  }
  if (file != 8 || rank != 0) return false;
  while (i < fen.size() && fen[i] == ' ') i++;
  if (i >= fen.size()) return false;
  if (fen[i] == 'w') {
    pos.side = 0;
  } else if (fen[i] == 'b') {
    pos.side = 1;
  } else {
    return false;
  }
  pos.fen = fen;
  return true;
}

void applyDiff(const nnue::Network& net, const int8_t* prev, const int8_t* cur,
               nnue::Accumulator& acc) {
  for (int sq = 0; sq < 128; sq++) {
    const int a = prev[sq];
    const int b = cur[sq];
    if (a == b) continue;
    if (a != 0) net.removePiece(a, sq, acc);
    if (b != 0) net.addPiece(b, sq, acc);
  }
}

void reportRate(const char* label, long long evals, double seconds) {
  const double ps = seconds > 0.0 ? static_cast<double>(evals) / seconds : 0.0;
  const double ns = evals > 0 ? seconds * 1e9 / static_cast<double>(evals) : 0.0;
  std::printf("%-13s %12.0f positions/sec   %8.1f ns/eval   (%lld evals, %.3f s)\n",
              label, ps, ns, evals, seconds);
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 3) {
    std::fprintf(stderr, "usage: %s <net> <positions>\n", argv[0]);
    return 1;
  }

  nnue::Network net;
  if (!net.load(argv[1])) {
    std::fprintf(stderr, "nnue_bench: failed to load '%s': %s\n", argv[1],
                 net.error().c_str());
    return 1;
  }

  std::ifstream in(argv[2]);
  if (!in) {
    std::fprintf(stderr, "nnue_bench: cannot open positions file '%s'\n", argv[2]);
    return 1;
  }

  std::vector<Position> positions;
  std::string line;
  int lineNo = 0;
  int parseErrors = 0;
  while (std::getline(in, line)) {
    lineNo++;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty() || line[0] == '#') continue;
    const size_t bar = line.rfind('|');
    if (bar == std::string::npos) {
      std::fprintf(stderr, "nnue_bench: line %d: missing '|'\n", lineNo);
      parseErrors++;
      continue;
    }
    Position pos;
    if (!parseFen(line.substr(0, bar), pos)) {
      std::fprintf(stderr, "nnue_bench: line %d: invalid FEN\n", lineNo);
      parseErrors++;
      continue;
    }
    char* end = nullptr;
    const long v = std::strtol(line.c_str() + bar + 1, &end, 10);
    if (end == line.c_str() + bar + 1) {
      std::fprintf(stderr, "nnue_bench: line %d: invalid expected value\n", lineNo);
      parseErrors++;
      continue;
    }
    pos.expected = static_cast<int>(v);
    positions.push_back(pos);
  }

  std::printf("FRNN1 experimental NNUE benchmark\n");
  std::printf("net: %s (H1=%d, H2=%d, features=%d, shifts=%d/%d/%d, "
              "clamps=%d/%d/%d, checksum=0x%08x)\n",
              argv[1], net.h1, net.h2, nnue::kInputFeatures, net.shift1,
              net.shift2, net.shift3, net.clamp1, net.clamp2, net.clampOut,
              net.checksum);
  std::printf("positions: %zu\n\n", positions.size());

  if (positions.empty() || parseErrors != 0) {
    std::fprintf(stderr, "nnue_bench: no usable positions (parse errors: %d)\n",
                 parseErrors);
    return 1;
  }

  // ---- Self-test: exact fixed-point match against the JS trainer ----------
  std::printf("[selftest]\n");
  int passed = 0;
  int failed = 0;
  nnue::Accumulator fullAcc;
  for (size_t i = 0; i < positions.size(); i++) {
    Position& p = positions[i];
    net.reset(p.board, fullAcc);
    p.full = net.evaluate(fullAcc, p.side);
    if (p.full == p.expected) {
      passed++;
      std::printf("PASS  #%03zu expected=%d got=%d\n", i + 1, p.expected, p.full);
    } else {
      failed++;
      std::printf("FAIL  #%03zu expected=%d got=%d  fen=%s\n", i + 1, p.expected,
                  p.full, p.fen.c_str());
    }
  }
  std::printf("%d/%zu PASS", passed, positions.size());
  if (failed != 0) std::printf(", %d FAIL", failed);
  std::printf("\n\n");

  // ---- Incremental accumulator parity check ------------------------------
  std::printf("[accumulator]\n");
  int incChecks = 0;
  int incMismatches = 0;
  {
    nnue::Accumulator inc;
    for (size_t i = 0; i < positions.size(); i++) {
      if (i == 0) {
        net.reset(positions[0].board, inc);
      } else {
        applyDiff(net, positions[i - 1].board, positions[i].board, inc);
      }
      const int got = net.evaluate(inc, positions[i].side);
      incChecks++;
      if (got != positions[i].full) incMismatches++;
    }
  }
  std::printf("incremental vs full refresh: %d checks, %d mismatches\n\n",
              incChecks, incMismatches);

  // ---- Timing ------------------------------------------------------------
  std::printf("[timing]\n");
  volatile long long sink = 0;

  // Warm up both paths once.
  {
    nnue::Accumulator acc;
    for (const Position& p : positions) {
      net.reset(p.board, acc);
      sink += net.evaluate(acc, p.side);
    }
    net.reset(positions[0].board, acc);
    sink += net.evaluate(acc, positions[0].side);
    for (size_t i = 1; i < positions.size(); i++) {
      applyDiff(net, positions[i - 1].board, positions[i].board, acc);
      sink += net.evaluate(acc, positions[i].side);
    }
  }

  long long fullEvals = 0;
  {
    const auto t0 = Clock::now();
    double elapsed = 0.0;
    do {
      nnue::Accumulator acc;
      for (const Position& p : positions) {
        net.reset(p.board, acc);
        sink += net.evaluate(acc, p.side);
      }
      fullEvals += static_cast<long long>(positions.size());
      elapsed = secondsSince(t0);
    } while (elapsed < 0.25);
    reportRate("full refresh", fullEvals, elapsed);
  }

  long long incEvals = 0;
  {
    const auto t0 = Clock::now();
    double elapsed = 0.0;
    do {
      nnue::Accumulator acc;
      net.reset(positions[0].board, acc);
      sink += net.evaluate(acc, positions[0].side);
      for (size_t i = 1; i < positions.size(); i++) {
        applyDiff(net, positions[i - 1].board, positions[i].board, acc);
        sink += net.evaluate(acc, positions[i].side);
      }
      incEvals += static_cast<long long>(positions.size());
      elapsed = secondsSince(t0);
    } while (elapsed < 0.25);
    reportRate("incremental", incEvals, elapsed);
  }

  std::printf("\n");
  const bool ok = failed == 0 && incMismatches == 0;
  std::printf("%s\n", ok ? "RESULT: PASS" : "RESULT: FAIL");
  (void)sink;
  return ok ? 0 : 1;
}
