// Kiwa native — C++17 port of the Kiwa search core.
// Standalone UCI engine; the Node front-end (uci.js) adds the opening book,
// human-move prediction and terminal play mode on top of it.
//
// Build (MSYS2 / MinGW-w64):
//   g++ -O3 -march=native -std=c++17 -static -o kiwa-native.exe kiwa.cpp
//
// Extra commands beyond UCI: perft <d>, bench, eval, d.

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cctype>

#include "nnue.h"   // experimental integrated NNUE evaluator (gated by the NNUE option)

#include <cmath>
#include <string>
#include <vector>
#include <sstream>
#include <iostream>
#include <thread>
#include <atomic>
#include <mutex>
#include <chrono>
#include <algorithm>
#include <random>
#include <unordered_map>
#include <ctime>
#ifdef _WIN32
#include <windows.h>
#endif
#include <fstream>
#include "book_data.h"

using namespace std;

typedef int64_t i64;
typedef uint64_t u64;

enum { WHITE = 0, BLACK = 1 };
enum { PAWN = 1, KNIGHT, BISHOP, ROOK, QUEEN, KING };

const int F_CAP = 1 << 17;
const int F_EP = 1 << 18;
const int F_CASTLE = 1 << 19;
const int F_DOUBLE = 1 << 20;

const int MAX_PLY = 64;
const int MAX_MOVES = 256;
const int MAX_HIST = 2048;
const int INF = 32000;
const int MATE = 31000;

static inline int pc(int c, int t) { return t | (c << 3); }
static inline int typeOf(int p) { return p & 7; }
static inline int colorOf(int p) { return p >> 3; }
static inline bool validSq(int s) { return (s & 0x88) == 0; }
// Index into pieceSq/pieceCount; distinct from the packed board code `pc()`.
static inline int pieceIndex(int c, int t) { return c * 6 + t - 1; }

static inline bool attacked(int sq, int by);
static bool epCapturePossible(int by);

static const int KNIGHT_D[8] = { 33, 31, 18, 14, -33, -31, -18, -14 };
static const int KING_D[8] = { 17, 16, 15, 1, -1, -15, -16, -17 };
static const int BISHOP_D[4] = { 17, 15, -15, -17 };
static const int ROOK_D[4] = { 16, -16, 1, -1 };

static const int VAL_MG[7] = { 0, 100, 320, 330, 500, 900, 0 };
static const int VAL_EG[7] = { 0, 120, 300, 320, 520, 940, 0 };
static const int PHASE_W[7] = { 0, 0, 1, 1, 2, 4, 0 };

// ---------------------------------------------------------------------------
// Piece-square tables (rank 1 first, i.e. index 0 = a1)
// ---------------------------------------------------------------------------

static const int PST_PAWN[64] = {
   0,  0,  0,  0,  0,  0,  0,  0,
  -5, -5, -5, -5, -5, -5, -5, -5,
  -3, -3, -3, -3, -3, -3, -3, -3,
  -1, -1, -1, -1, -1, -1, -1, -1,
   2,  2,  3,  5,  5,  3,  2,  2,
   6,  8, 11, 14, 14, 11,  8,  6,
  16, 20, 26, 32, 32, 26, 20, 16,
   0,  0,  0,  0,  0,  0,  0,  0,
};

static const int PST_KNIGHT[64] = {
  -50, -35, -25, -25, -25, -25, -35, -50,
  -35, -15,   0,   2,   2,   0, -15, -35,
  -25,   2,  10,  14,  14,  10,   2, -25,
  -25,   4,  14,  18,  18,  14,   4, -25,
  -25,   2,  14,  18,  18,  14,   2, -25,
  -25,   4,  10,  14,  14,  10,   4, -25,
  -35, -15,   0,   4,   4,   0, -15, -35,
  -50, -35, -25, -25, -25, -25, -35, -50,
};

static const int PST_BISHOP[64] = {
  -20, -10, -10, -10, -10, -10, -10, -20,
  -10,   0,   0,   0,   0,   0,   0, -10,
  -10,   0,   5,  10,  10,   5,   0, -10,
  -10,   5,   5,  10,  10,   5,   5, -10,
  -10,   0,  10,  10,  10,  10,   0, -10,
  -10,  10,  10,  10,  10,  10,  10, -10,
  -10,   5,   0,   0,   0,   0,   5, -10,
  -20, -10, -10, -10, -10, -10, -10, -20,
};

static const int PST_ROOK[64] = {
   0,   0,   0,   0,   0,   0,   0,   0,
   5,  10,  10,  10,  10,  10,  10,   5,
  -5,   0,   0,   0,   0,   0,   0,  -5,
  -5,   0,   0,   0,   0,   0,   0,  -5,
  -5,   0,   0,   0,   0,   0,   0,  -5,
  -5,   0,   0,   0,   0,   0,   0,  -5,
  -5,   0,   0,   0,   0,   0,   0,  -5,
   0,   0,   5,   5,   5,   5,   0,   0,
};

static const int PST_QUEEN[64] = {
  -20, -10, -10,  -5,  -5, -10, -10, -20,
  -10,   0,   0,   0,   0,   0,   0, -10,
  -10,   0,   5,   5,   5,   5,   0, -10,
   -5,   0,   5,   5,   5,   5,   0,  -5,
    0,   0,   5,   5,   5,   5,   0,  -5,
  -10,   5,   5,   5,   5,   5,   0, -10,
  -10,   0,   5,   0,   0,   0,   0, -10,
  -20, -10, -10,  -5,  -5, -10, -10, -20,
};

static const int PST_KING_MG[64] = {
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
   20,  20,   0,   0,   0,   0,  20,  20,
   20,  30,  10,   0,   0,  10,  30,  20,
};

static const int PST_KING_EG[64] = {
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10,   0,   0, -10, -20, -30,
  -30, -10,  20,  30,  30,  20, -10, -30,
  -30, -10,  30,  40,  40,  30, -10, -30,
  -30, -10,  30,  40,  40,  30, -10, -30,
  -30, -10,  20,  30,  30,  20, -10, -30,
  -30, -30,   0,   0,   0,   0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50,
};

static const int* PST[7] = { nullptr, PST_PAWN, PST_KNIGHT, PST_BISHOP, PST_ROOK, PST_QUEEN, nullptr };

// ---------------------------------------------------------------------------
// Zobrist keys + eval tables
// ---------------------------------------------------------------------------

static u64 rngState = 0x9e3779b97f4a7c15ULL;
static u64 rnd64() {
  u64 z = (rngState += 0x9e3779b97f4a7c15ULL);
  z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
  z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
  return z ^ (z >> 31);
}

static u64 Z[16 * 128];
static u64 ZC[16];
static u64 ZE[8];
static u64 ZS;

static int MG[16 * 128];
static int EG[16 * 128];

static void initTables() {
  for (int p = 0; p < 16 * 128; p++) Z[p] = rnd64();
  for (int i = 1; i < 16; i++) ZC[i] = rnd64();
  for (int i = 0; i < 8; i++) ZE[i] = rnd64();
  ZS = rnd64();

  for (int t = 1; t <= 6; t++) {
    for (int c = 0; c < 2; c++) {
      const int piece = pc(c, t);
      for (int sq = 0; sq < 128; sq++) {
        if (!validSq(sq)) continue;
        const int rank = sq >> 4, file = sq & 7;
        const int wi = rank * 8 + file;
        const int bi = (7 - rank) * 8 + file;
        int mgv, egv;
        if (t == KING) {
          mgv = VAL_MG[t] + (c == WHITE ? PST_KING_MG[wi] : PST_KING_MG[bi]);
          egv = VAL_EG[t] + (c == WHITE ? PST_KING_EG[wi] : PST_KING_EG[bi]);
        } else {
          mgv = VAL_MG[t] + (c == WHITE ? PST[t][wi] : PST[t][bi]);
          egv = VAL_EG[t] + (c == WHITE ? PST[t][wi] : PST[t][bi]);
        }
        if (c == BLACK) { mgv = -mgv; egv = -egv; }
        MG[piece * 128 + sq] = mgv;
        EG[piece * 128 + sq] = egv;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Board state
// ---------------------------------------------------------------------------

// All mutable position/search state is thread-local: each search thread owns
// a full board and search stack, so "Threads" can run real parallel searches.
static thread_local int8_t board[128];
static thread_local int pieceSq[12 * 16];
static thread_local int pieceCount[12];
static thread_local int kingSq[2];

static thread_local int side = WHITE;
static thread_local int castling = 0;
static thread_local int epSq = -1;
// Whether ZE[epSq] is currently XORed into the key. Computing this costs a
// legal-capture check (with board edits) and only changes when a pawn double
// push happens, so it is cached instead of re-derived on every make/unmake.
static thread_local bool epKeyed = false;
static thread_local int halfmove = 0;
static thread_local int fullmove = 1;

static thread_local u64 key = 0;      // full position key
static thread_local u64 pawnKey = 0;  // pawn-only key, for the pawn-structure cache
static thread_local int mg = 0, eg = 0, phase = 0;

static thread_local int stCastling[MAX_HIST];
static thread_local int stEp[MAX_HIST];
static thread_local int8_t stEpKeyed[MAX_HIST];
static thread_local int stHalf[MAX_HIST];
static thread_local u64 stKey[MAX_HIST];
static thread_local int stCap[MAX_HIST];
static thread_local int stateTop = 0;

static thread_local u64 posKeys[MAX_HIST];
static thread_local int histLen = 0;

static thread_local uint32_t moveBuf[MAX_PLY * MAX_MOVES];
static thread_local int scoreBuf[MAX_PLY * MAX_MOVES];

static thread_local int pvTable[MAX_PLY * MAX_PLY];
static thread_local int pvLength[MAX_PLY];
static thread_local int killers[MAX_PLY * 2];
static thread_local int counter[128 * 128];
static thread_local int history[2 * 128 * 128];
static thread_local uint32_t moveStack[MAX_PLY];

// ---------------------------------------------------------------------------
// Experimental NNUE evaluator (integration for FRNN1-format nets).
// The accumulator below is maintained incrementally through the same two
// board primitives the search uses everywhere (addPiece/removePieceAt), so
// search, qsearch, make/unmake, castling, promotions and en passant stay in
// sync automatically. Threads own their boards thread_local, so the
// accumulator is thread_local to match.
// ---------------------------------------------------------------------------
static nnue::Network nnueNet;
static bool nnueLoaded = false;
static atomic<bool> nnueEnabled(false);   // set by the NNUE setoption
static thread_local nnue::Accumulator nnueAcc;

static bool nnueLoadNet() {
  const char* envPath = getenv("FROOSTROOK_NNUE");
  const char* candidates[] = {
    envPath,
    "data/nnue/frnn1.bin",
    "../data/nnue/frnn1.bin",
    "../../data/nnue/frnn1.bin",
  };
#ifdef _WIN32
  char exeBuf[512];
  if (GetModuleFileNameA(nullptr, exeBuf, sizeof(exeBuf)) > 0) {
    string exePath(exeBuf);
    const size_t slash = exePath.find_last_of("\\/");
    if (slash != string::npos) {
      const string dir = exePath.substr(0, slash);
      const string direct = dir + "/data/nnue/frnn1.bin";
      const string parent = dir + "/../data/nnue/frnn1.bin";
      return nnueNet.load(envPath ? envPath : direct.c_str()) || nnueNet.load(direct.c_str()) || nnueNet.load(parent.c_str());
    }
  }
#endif
  for (const char* c : candidates) {
    if (!c) continue;
    if (nnueNet.load(c)) return true;
  }
  return false;
}

static inline void nnueResetAcc() {
  for (int p = 0; p < 2; p++) {
    for (int h = 0; h < nnueNet.h1; h++) nnueAcc.v[p][h] = nnueNet.b1[h];
  }
}

// ---------------------------------------------------------------------------
// Piece handling
// ---------------------------------------------------------------------------

static inline void addPiece(int sq, int piece) {
  board[sq] = (int8_t)piece;
  if (nnueLoaded) nnueNet.addPiece(piece, sq, nnueAcc);
  const int c = piece >> 3, t = piece & 7;
  const int pi = c * 6 + t - 1;
  pieceSq[pi * 16 + pieceCount[pi]++] = sq;
  const int p = piece * 128 + sq;
  key ^= Z[p];
  if (t == PAWN) pawnKey ^= Z[p];
  mg += MG[p]; eg += EG[p]; phase += PHASE_W[t];
}

static inline int removePieceAt(int sq) {
  const int piece = board[sq];
  if (nnueLoaded) nnueNet.removePiece(piece, sq, nnueAcc);
  const int c = piece >> 3, t = piece & 7;
  const int pi = c * 6 + t - 1;
  const int cnt = pieceCount[pi];
  const int base = pi * 16;
  for (int i = 0; i < cnt; i++) {
    if (pieceSq[base + i] == sq) {
      pieceSq[base + i] = pieceSq[base + cnt - 1];
      pieceCount[pi] = cnt - 1;
      break;
    }
  }
  board[sq] = 0;
  const int p = piece * 128 + sq;
  key ^= Z[p];
  if (t == PAWN) pawnKey ^= Z[p];
  mg -= MG[p]; eg -= EG[p]; phase -= PHASE_W[t];
  return piece;
}

// ---------------------------------------------------------------------------
// FEN
// ---------------------------------------------------------------------------

static int charToPiece(char ch) {
  switch (ch) {
    case 'P': return pc(WHITE, PAWN);
    case 'N': return pc(WHITE, KNIGHT);
    case 'B': return pc(WHITE, BISHOP);
    case 'R': return pc(WHITE, ROOK);
    case 'Q': return pc(WHITE, QUEEN);
    case 'K': return pc(WHITE, KING);
    case 'p': return pc(BLACK, PAWN);
    case 'n': return pc(BLACK, KNIGHT);
    case 'b': return pc(BLACK, BISHOP);
    case 'r': return pc(BLACK, ROOK);
    case 'q': return pc(BLACK, QUEEN);
    case 'k': return pc(BLACK, KING);
    default: return 0;
  }
}

static void setFen(const string& fen) {
  memset(board, 0, sizeof(board));
  memset(pieceCount, 0, sizeof(pieceCount));
  memset(pieceSq, 0, sizeof(pieceSq));
  mg = 0; eg = 0; phase = 0;
  key = 0; pawnKey = 0;
  stateTop = 0; histLen = 0;
  epSq = -1;
  if (nnueLoaded) nnueResetAcc();

  istringstream ss(fen);
  string placement, stm, cast, ep, half, full;
  ss >> placement >> stm >> cast >> ep >> half >> full;

  int rank = 7, file = 0;
  for (char ch : placement) {
    if (ch == '/') { rank--; file = 0; }
    else if (ch >= '1' && ch <= '8') file += ch - '0';
    else {
      const int sq = rank * 16 + file;
      const int piece = charToPiece(ch);
      if (piece) {
        addPiece(sq, piece);
        if (typeOf(piece) == KING) kingSq[colorOf(piece)] = sq;
      }
      file++;
    }
  }

  side = (stm == "b") ? BLACK : WHITE;

  castling = 0;
  if (cast.find('K') != string::npos) castling |= 1;
  if (cast.find('Q') != string::npos) castling |= 2;
  if (cast.find('k') != string::npos) castling |= 4;
  if (cast.find('q') != string::npos) castling |= 8;

  if (!ep.empty() && ep != "-") {
    const int f = ep[0] - 'a';
    const int r = ep[1] - '1';
    epSq = r * 16 + f;
  }

  halfmove = half.empty() ? 0 : atoi(half.c_str());
  fullmove = full.empty() ? 1 : atoi(full.c_str());
  if (fullmove < 1) fullmove = 1;

  key ^= ZC[castling];
  // An ep square only distinguishes positions when the capture is legal
  // (FIDE 9.2.2). FENs often carry an ep square after every double push.
  epKeyed = epSq >= 0 && epCapturePossible(side);
  if (epKeyed) key ^= ZE[epSq & 7];
  if (side == BLACK) key ^= ZS;

  posKeys[0] = key;
  histLen = 1;
}

// ---------------------------------------------------------------------------
// Attacks
// ---------------------------------------------------------------------------

static inline bool attacked(int sq, int by) {
  const int8_t* b = board;

  if (by == WHITE) {
    if (validSq(sq - 15) && b[sq - 15] == pc(WHITE, PAWN)) return true;
    if (validSq(sq - 17) && b[sq - 17] == pc(WHITE, PAWN)) return true;
  } else {
    if (validSq(sq + 15) && b[sq + 15] == pc(BLACK, PAWN)) return true;
    if (validSq(sq + 17) && b[sq + 17] == pc(BLACK, PAWN)) return true;
  }

  const int n = pc(by, KNIGHT);
  for (int i = 0; i < 8; i++) {
    const int s = sq + KNIGHT_D[i];
    if (validSq(s) && b[s] == n) return true;
  }

  const int k = pc(by, KING);
  for (int i = 0; i < 8; i++) {
    const int s = sq + KING_D[i];
    if (validSq(s) && b[s] == k) return true;
  }

  const int rook = pc(by, ROOK);
  const int bishop = pc(by, BISHOP);
  const int queen = pc(by, QUEEN);

  for (int i = 0; i < 4; i++) {
    const int d = ROOK_D[i];
    int s = sq + d;
    while (validSq(s)) {
      const int p = b[s];
      if (p) {
        if (p == rook || p == queen) return true;
        break;
      }
      s += d;
    }
  }
  for (int i = 0; i < 4; i++) {
    const int d = BISHOP_D[i];
    int s = sq + d;
    while (validSq(s)) {
      const int p = b[s];
      if (p) {
        if (p == bishop || p == queen) return true;
        break;
      }
      s += d;
    }
  }
  return false;
}

// A legal en-passant capture changes the position's possible moves, so only
// then is the ep square part of the Zobrist key and repetition identity.
// Merely having a pawn beside the square is not enough: the capture may
// expose the king.
static bool epCapturePossible(int by) {
  if (epSq < 0 || board[epSq] != 0) return false;
  // The capturing pawn stands one rank on the capturer's side of the ep
  // target; the captured pawn stands on the target's far side.
  const int pawnRank = epSq + (by == WHITE ? -16 : 16);
  const int capSq = pawnRank;
  if (!validSq(capSq) || board[capSq] != pc(by ^ 1, PAWN)) return false;
  for (int df = -1; df <= 1; df += 2) {
    const int from = pawnRank + df;
    if (!validSq(from) || board[from] != pc(by, PAWN)) continue;
    const int8_t savedFrom = board[from];
    const int8_t savedTo = board[epSq];
    const int8_t savedCap = board[capSq];
    board[from] = 0;
    board[capSq] = 0;
    board[epSq] = (int8_t)pc(by, PAWN);
    const bool legal = !attacked(kingSq[by], by ^ 1);
    board[from] = savedFrom;
    board[capSq] = savedCap;
    board[epSq] = savedTo;
    if (legal) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Static exchange evaluation
// ---------------------------------------------------------------------------

static const int SEE_VAL[7] = { 0, 100, 320, 330, 500, 900, 10000 };

// Least valuable piece of colour `by` attacking `to` on a local board copy.
// Called repeatedly it also exposes x-ray attackers, because the previous
// attacker has already been removed from the copy.
static int leastAttacker(const int8_t* b, int to, int by, int& outType) {
  int bestSq = 0, bestVal = 1 << 20, bestType = 0;
  auto consider = [&](int sq, int t) {
    if (!validSq(sq)) return;
    if (b[sq] != (int8_t)pc(by, t)) return;
    const int v = SEE_VAL[t];
    if (v < bestVal) { bestVal = v; bestSq = sq; bestType = t; }
  };

  if (by == WHITE) {
    consider(to - 15, PAWN);
    consider(to - 17, PAWN);
  } else {
    consider(to + 15, PAWN);
    consider(to + 17, PAWN);
  }
  for (int i = 0; i < 8; i++) consider(to + KNIGHT_D[i], KNIGHT);
  for (int i = 0; i < 8; i++) consider(to + KING_D[i], KING);
  for (int i = 0; i < 4; i++) {
    const int d = BISHOP_D[i];
    int s = to + d;
    while (validSq(s)) {
      if (b[s]) {
        consider(s, BISHOP);
        consider(s, QUEEN);
        break;
      }
      s += d;
    }
  }
  for (int i = 0; i < 4; i++) {
    const int d = ROOK_D[i];
    int s = to + d;
    while (validSq(s)) {
      if (b[s]) {
        consider(s, ROOK);
        consider(s, QUEEN);
        break;
      }
      s += d;
    }
  }
  outType = bestType;
  return bestSq;
}

// Full swap-list SEE. Positive means the capture wins material with best play
// on both sides, negative means it loses material. Pins are ignored, which is
// the usual approximation for ordering and pruning.
static int see(uint32_t mv) {
  const int from = mv & 127;
  const int to = (mv >> 7) & 127;
  const int promo = (mv >> 14) & 7;
  const int flags = mv & (F_CAP | F_EP);
  if (!(flags & F_CAP)) return 0;

  int8_t b[128];
  memcpy(b, board, sizeof(b));

  int gain[32];
  int d = 0;
  const int us = side;
  const int victim = (flags & F_EP) ? PAWN : typeOf(board[to]);
  gain[0] = SEE_VAL[victim];
  int onTo = promo ? promo : typeOf(board[from]);
  if (promo) gain[0] += SEE_VAL[promo] - SEE_VAL[PAWN];

  b[from] = 0;
  if (flags & F_EP) b[to + (us == WHITE ? -16 : 16)] = 0;
  b[to] = (int8_t)pc(us, onTo);

  int stm = us ^ 1;
  while (d < 30) {
    int atkType = 0;
    const int atkSq = leastAttacker(b, to, stm, atkType);
    if (!atkSq) break;
    d++;
    gain[d] = SEE_VAL[onTo] - gain[d - 1];
    b[atkSq] = 0;
    int newType = atkType;
    if (atkType == PAWN &&
        ((stm == WHITE && (to >> 4) == 7) || (stm == BLACK && (to >> 4) == 0))) {
      newType = QUEEN;
    }
    b[to] = (int8_t)pc(stm, newType);
    onTo = newType;
    stm ^= 1;
  }
  while (d > 0) {
    d--;
    gain[d] = -max(-gain[d], gain[d + 1]);
  }
  return gain[0];
}

// ---------------------------------------------------------------------------
// Move generation
// ---------------------------------------------------------------------------

static inline int addMove(int base, int n, int from, int to, int promo, int flags) {
  moveBuf[base + n] = (uint32_t)(from | (to << 7) | (promo << 14) | flags);
  return n + 1;
}

static int generateMoves(int base, bool capturesOnly) {
  const int us = side, them = us ^ 1;
  const int8_t* b = board;
  int n = 0;

  // Pawns
  const int pawnIdx = us * 6 + PAWN - 1;
  const int pawnCnt = pieceCount[pawnIdx];
  const int dir = us == WHITE ? 16 : -16;
  const int startRank = us == WHITE ? 1 : 6;
  const int promoRank = us == WHITE ? 6 : 1;

  for (int i = 0; i < pawnCnt; i++) {
    const int from = pieceSq[pawnIdx * 16 + i];
    const int r = from >> 4;

    for (int df = -1; df <= 1; df += 2) {
      const int to = from + dir + df;
      if (to & 0x88) continue;
      const int target = b[to];
      if (target && (target >> 3) == them) {
        if (r == promoRank) {
          n = addMove(base, n, from, to, QUEEN, F_CAP);
          n = addMove(base, n, from, to, ROOK, F_CAP);
          n = addMove(base, n, from, to, BISHOP, F_CAP);
          n = addMove(base, n, from, to, KNIGHT, F_CAP);
        } else {
          n = addMove(base, n, from, to, 0, F_CAP);
        }
      } else if (!target && to == epSq && epSq >= 0) {
        n = addMove(base, n, from, to, 0, F_CAP | F_EP);
      }
    }

    if (!capturesOnly) {
      const int one = from + dir;
      if (!(one & 0x88) && b[one] == 0) {
        if (r == promoRank) {
          n = addMove(base, n, from, one, QUEEN, 0);
          n = addMove(base, n, from, one, ROOK, 0);
          n = addMove(base, n, from, one, BISHOP, 0);
          n = addMove(base, n, from, one, KNIGHT, 0);
        } else {
          n = addMove(base, n, from, one, 0, 0);
          const int two = one + dir;
          if (r == startRank && b[two] == 0) {
            n = addMove(base, n, from, two, 0, F_DOUBLE);
          }
        }
      }
    }
  }

  // Knights
  const int knightIdx = us * 6 + KNIGHT - 1;
  const int knightCnt = pieceCount[knightIdx];
  for (int i = 0; i < knightCnt; i++) {
    const int from = pieceSq[knightIdx * 16 + i];
    for (int j = 0; j < 8; j++) {
      const int to = from + KNIGHT_D[j];
      if (to & 0x88) continue;
      const int t = b[to];
      if (!t) { if (!capturesOnly) n = addMove(base, n, from, to, 0, 0); }
      else if ((t >> 3) == them) { n = addMove(base, n, from, to, 0, F_CAP); }
    }
  }

  // Bishops
  const int bishopIdx = us * 6 + BISHOP - 1;
  const int bishopCnt = pieceCount[bishopIdx];
  for (int i = 0; i < bishopCnt; i++) {
    const int from = pieceSq[bishopIdx * 16 + i];
    for (int j = 0; j < 4; j++) {
      const int d = BISHOP_D[j];
      int to = from + d;
      while (!(to & 0x88)) {
        const int t = b[to];
        if (!t) { if (!capturesOnly) n = addMove(base, n, from, to, 0, 0); }
        else {
          if ((t >> 3) == them) n = addMove(base, n, from, to, 0, F_CAP);
          break;
        }
        to += d;
      }
    }
  }

  // Rooks
  const int rookIdx = us * 6 + ROOK - 1;
  const int rookCnt = pieceCount[rookIdx];
  for (int i = 0; i < rookCnt; i++) {
    const int from = pieceSq[rookIdx * 16 + i];
    for (int j = 0; j < 4; j++) {
      const int d = ROOK_D[j];
      int to = from + d;
      while (!(to & 0x88)) {
        const int t = b[to];
        if (!t) { if (!capturesOnly) n = addMove(base, n, from, to, 0, 0); }
        else {
          if ((t >> 3) == them) n = addMove(base, n, from, to, 0, F_CAP);
          break;
        }
        to += d;
      }
    }
  }

  // Queens
  const int queenIdx = us * 6 + QUEEN - 1;
  const int queenCnt = pieceCount[queenIdx];
  for (int i = 0; i < queenCnt; i++) {
    const int from = pieceSq[queenIdx * 16 + i];
    for (int j = 0; j < 8; j++) {
      const int d = j < 4 ? ROOK_D[j] : BISHOP_D[j - 4];
      int to = from + d;
      while (!(to & 0x88)) {
        const int t = b[to];
        if (!t) { if (!capturesOnly) n = addMove(base, n, from, to, 0, 0); }
        else {
          if ((t >> 3) == them) n = addMove(base, n, from, to, 0, F_CAP);
          break;
        }
        to += d;
      }
    }
  }

  // King
  const int kingFrom = kingSq[us];
  for (int j = 0; j < 8; j++) {
    const int to = kingFrom + KING_D[j];
    if (to & 0x88) continue;
    const int t = b[to];
    if (!t) { if (!capturesOnly) n = addMove(base, n, kingFrom, to, 0, 0); }
    else if ((t >> 3) == them) { n = addMove(base, n, kingFrom, to, 0, F_CAP); }
  }

  // Castling
  if (!capturesOnly) {
    if (us == WHITE) {
      if ((castling & 1) && b[5] == 0 && b[6] == 0 &&
          !attacked(4, them) && !attacked(5, them) && !attacked(6, them)) {
        n = addMove(base, n, 4, 6, 0, F_CASTLE);
      }
      if ((castling & 2) && b[3] == 0 && b[2] == 0 && b[1] == 0 &&
          !attacked(4, them) && !attacked(3, them) && !attacked(2, them)) {
        n = addMove(base, n, 4, 2, 0, F_CASTLE);
      }
    } else {
      if ((castling & 4) && b[117] == 0 && b[118] == 0 &&
          !attacked(116, them) && !attacked(117, them) && !attacked(118, them)) {
        n = addMove(base, n, 116, 118, 0, F_CASTLE);
      }
      if ((castling & 8) && b[115] == 0 && b[114] == 0 && b[113] == 0 &&
          !attacked(116, them) && !attacked(115, them) && !attacked(114, them)) {
        n = addMove(base, n, 116, 114, 0, F_CASTLE);
      }
    }
  }

  return n;
}

// ---------------------------------------------------------------------------
// Make / unmake
// ---------------------------------------------------------------------------

static inline void makeMove(uint32_t mv) {
  const int from = mv & 127;
  const int to = (mv >> 7) & 127;
  const int promo = (mv >> 14) & 7;
  const int flags = mv & (F_CAP | F_EP | F_CASTLE | F_DOUBLE);

  const int st = stateTop++;
  stCastling[st] = castling;
  stEp[st] = epSq;
  stEpKeyed[st] = epKeyed ? 1 : 0;
  stHalf[st] = halfmove;
  stKey[st] = key;
  stCap[st] = 0;

  key ^= ZC[castling];
  if (epKeyed) key ^= ZE[epSq & 7];

  const int us = side, them = us ^ 1;
  const int moving = board[from];
  int captured = 0;

  if (flags & F_EP) {
    const int capSq = to + (us == WHITE ? -16 : 16);
    captured = removePieceAt(capSq);
  } else if (board[to] != 0) {
    captured = removePieceAt(to);
  }
  stCap[st] = captured;

  removePieceAt(from);
  if (promo) addPiece(to, pc(us, promo));
  else addPiece(to, moving);

  if (flags & F_CASTLE) {
    if (to == 6) { removePieceAt(7); addPiece(5, pc(WHITE, ROOK)); }
    else if (to == 2) { removePieceAt(0); addPiece(3, pc(WHITE, ROOK)); }
    else if (to == 118) { removePieceAt(119); addPiece(117, pc(BLACK, ROOK)); }
    else if (to == 114) { removePieceAt(112); addPiece(115, pc(BLACK, ROOK)); }
  }

  if ((moving & 7) == KING) kingSq[us] = to;

  if ((moving & 7) == KING) {
    castling &= us == WHITE ? ~3 : ~12;
  } else if ((moving & 7) == ROOK) {
    if (from == 0) castling &= ~2;
    else if (from == 7) castling &= ~1;
    else if (from == 112) castling &= ~8;
    else if (from == 119) castling &= ~4;
  }

  if (captured) {
    if (to == 0) castling &= ~2;
    else if (to == 7) castling &= ~1;
    else if (to == 112) castling &= ~8;
    else if (to == 119) castling &= ~4;
    halfmove = 0;
  } else if ((moving & 7) == PAWN) {
    halfmove = 0;
  } else {
    halfmove++;
  }

  epSq = (flags & F_DOUBLE) ? (from + (us == WHITE ? 16 : -16)) : -1;

  key ^= ZC[castling];
  epKeyed = epSq >= 0 && epCapturePossible(them);
  if (epKeyed) key ^= ZE[epSq & 7];
  key ^= ZS;

  if (us == BLACK) fullmove++;
  side = them;

  posKeys[histLen++] = key;
}

static inline void unmakeMove(uint32_t mv) {
  const int st = --stateTop;
  histLen--;

  side ^= 1;
  const int us = side;
  if (us == BLACK) fullmove--;

  const int from = mv & 127;
  const int to = (mv >> 7) & 127;
  const int promo = (mv >> 14) & 7;
  const int flags = mv & (F_CAP | F_EP | F_CASTLE | F_DOUBLE);

  const int moved = board[to];
  removePieceAt(to);
  addPiece(from, promo ? pc(us, PAWN) : moved);

  if (flags & F_CASTLE) {
    if (to == 6) { removePieceAt(5); addPiece(7, pc(WHITE, ROOK)); }
    else if (to == 2) { removePieceAt(3); addPiece(0, pc(WHITE, ROOK)); }
    else if (to == 118) { removePieceAt(117); addPiece(119, pc(BLACK, ROOK)); }
    else if (to == 114) { removePieceAt(115); addPiece(112, pc(BLACK, ROOK)); }
  }

  if ((moved & 7) == KING) kingSq[us] = from;

  if (flags & F_EP) {
    const int capSq = to + (us == WHITE ? -16 : 16);
    addPiece(capSq, stCap[st]);
  } else if (stCap[st]) {
    addPiece(to, stCap[st]);
  }

  castling = stCastling[st];
  epSq = stEp[st];
  epKeyed = stEpKeyed[st] != 0;
  halfmove = stHalf[st];
  key = stKey[st];
}

static inline void makeNull() {
  const int st = stateTop++;
  stCastling[st] = castling;
  stEp[st] = epSq;
  stEpKeyed[st] = epKeyed ? 1 : 0;
  stHalf[st] = halfmove;
  stKey[st] = key;
  stCap[st] = 0;

  if (epKeyed) key ^= ZE[epSq & 7];
  epSq = -1;
  epKeyed = false;
  halfmove++;
  key ^= ZS;
  side ^= 1;
}

static inline void unmakeNull() {
  const int st = --stateTop;
  side ^= 1;
  castling = stCastling[st];
  epSq = stEp[st];
  epKeyed = stEpKeyed[st] != 0;
  halfmove = stHalf[st];
  key = stKey[st];
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

static thread_local int wpFiles[8];
static thread_local int bpFiles[8];
static int PASSED_MG[8] = { 0, 8, 12, 20, 35, 60, 100, 0 };  // ranks 3-6 synced from TUNE
static int PASSED_EG[8] = { 0, 8, 12, 20, 35, 60, 100, 0 };  // ranks 3-6 synced from TUNE

// Mobility per safe destination square, indexed by piece type. A destination
// occupied by the enemy counts, but squares covered by an enemy pawn do not.
// Ray-scan mobility is the most expensive term in the evaluation, so which
// piece types get it is a build-time switch measured by test/eval-ab.js and the duel mode of test/elo.js:
//   0 = off, 1 = knights and bishops only, 2 = also rooks and queens.
#ifndef KIWA_MOB
#define KIWA_MOB 1
#endif
// Threat and king-safety terms are separate switches so each can be ablated
// with the same A/B method used for the mobility build switch.
#ifndef KIWA_THREATS
#define KIWA_THREATS 1
#endif
#ifndef KIWA_KINGSAFETY
#define KIWA_KINGSAFETY 1
#endif
#ifndef KIWA_FUTILITY
#define KIWA_FUTILITY 1
#endif

// Texel-tunable evaluation parameters. The defaults are exactly the values
// the 1.0.3-beta engine shipped with; a hidden `tunebench` command (see the
// UCI command section) coordinate-descends them against a dataset of
// Stockfish-labelled positions and prints the result. The shipped engine
// never mutates TUNE[] at startup; syncTuneArrays() applies TUNE[] to the
// mutable eval arrays once at init and after every tuner pass.
enum TuneParam {
  P_MOB_N_MG, P_MOB_B_MG, P_MOB_R_MG, P_MOB_Q_MG,
  P_MOB_N_EG, P_MOB_B_EG, P_MOB_R_EG, P_MOB_Q_EG,
  P_OUT_N_MG, P_OUT_N_EG, P_OUT_B_MG, P_OUT_B_EG,
  P_PAWN_N, P_PAWN_B, P_PAWN_R, P_PAWN_Q,
  P_LOOSE_N, P_LOOSE_B, P_LOOSE_R, P_LOOSE_Q,
  P_PASS_MG3, P_PASS_MG4, P_PASS_MG5, P_PASS_MG6,
  P_PASS_EG3, P_PASS_EG4, P_PASS_EG5, P_PASS_EG6,
  P_ROOK_PASS_MG, P_ROOK_PASS_EG,
  P_DOUBLED_MG, P_DOUBLED_EG,
  P_ISOLATED_MG, P_ISOLATED_EG,
  P_CONN_MG, P_CONN_EG,
  P_BACK_MG, P_BACK_EG,
  P_BISHOP_PAIR_MG, P_BISHOP_PAIR_EG,
  P_BADB_MG, P_BADB_EG,
  P_ROOK_OPEN_MG, P_ROOK_OPEN_EG,
  P_ROOK_SEMI_MG, P_ROOK_SEMI_EG,
  P_ROOK_7TH_MG, P_ROOK_7TH_EG,
  P_ROOK_CONN_MG, P_ROOK_CONN_EG,
  P_PASS_KD,
  P_KD_CAP, P_OPEN_MG, P_SEMI_MG,
  P_SHIELD_PAWN, P_SHIELD_PAWN2, P_SHIELD_HOLE,
  P_TEMPO,
  P_ATTACK_KNIGHT, P_ATTACK_ROOK, P_ATTACK_QUEEN,
  TUNE_PARAM_COUNT
};
static int TUNE[TUNE_PARAM_COUNT] = {
  3, 2, 2, 1,               // P_MOB_*_MG (knight bishop rook queen)
  3, 2, 3, 1,               // P_MOB_*_EG
  25, 15, 15, 10,           // P_OUT_*
  45, 40, 30, 15,           // P_PAWN_*
  30, 30, 25, 20,           // P_LOOSE_*
  20, 35, 60, 100,          // P_PASS_MG ranks 3..6
  20, 35, 60, 100,          // P_PASS_EG ranks 3..6
  18, 12,                   // P_ROOK_PASS_*
  12, 12,                   // P_DOUBLED_*
  14, 14,                   // P_ISOLATED_*
  4, 2,                     // P_CONN_*
  6, 8,                     // P_BACK_*
  30, 30,                   // P_BISHOP_PAIR_*
  3, 2,                     // P_BADB_*
  18, 18,                   // P_ROOK_OPEN_*
  8, 8,                     // P_ROOK_SEMI_*
  14, 14,                   // P_ROOK_7TH_*
  12, 8,                    // P_ROOK_CONN_*
  2,                        // P_PASS_KD (passed-pawn king-distance multiplier)
  40, 20, 12,               // P_KD_CAP, P_OPEN_MG, P_SEMI_MG
  8, 4, 10,                 // P_SHIELD_PAWN, P_SHIELD_PAWN2, P_SHIELD_HOLE
  8,                        // P_TEMPO
  2, 3, 5,                  // P_ATTACK_KNIGHT, P_ATTACK_ROOK, P_ATTACK_QUEEN
};
static const char* TUNE_NAMES[TUNE_PARAM_COUNT] = {
  "P_MOB_N_MG", "P_MOB_B_MG", "P_MOB_R_MG", "P_MOB_Q_MG",
  "P_MOB_N_EG", "P_MOB_B_EG", "P_MOB_R_EG", "P_MOB_Q_EG",
  "P_OUT_N_MG", "P_OUT_N_EG", "P_OUT_B_MG", "P_OUT_B_EG",
  "P_PAWN_N", "P_PAWN_B", "P_PAWN_R", "P_PAWN_Q",
  "P_LOOSE_N", "P_LOOSE_B", "P_LOOSE_R", "P_LOOSE_Q",
  "P_PASS_MG3", "P_PASS_MG4", "P_PASS_MG5", "P_PASS_MG6",
  "P_PASS_EG3", "P_PASS_EG4", "P_PASS_EG5", "P_PASS_EG6",
  "P_ROOK_PASS_MG", "P_ROOK_PASS_EG",
  "P_DOUBLED_MG", "P_DOUBLED_EG",
  "P_ISOLATED_MG", "P_ISOLATED_EG",
  "P_CONN_MG", "P_CONN_EG",
  "P_BACK_MG", "P_BACK_EG",
  "P_BISHOP_PAIR_MG", "P_BISHOP_PAIR_EG",
  "P_BADB_MG", "P_BADB_EG",
  "P_ROOK_OPEN_MG", "P_ROOK_OPEN_EG",
  "P_ROOK_SEMI_MG", "P_ROOK_SEMI_EG",
  "P_ROOK_7TH_MG", "P_ROOK_7TH_EG",
  "P_ROOK_CONN_MG", "P_ROOK_CONN_EG",
  "P_PASS_KD",
  "P_KD_CAP", "P_OPEN_MG", "P_SEMI_MG",
  "P_SHIELD_PAWN", "P_SHIELD_PAWN2", "P_SHIELD_HOLE",
  "P_TEMPO",
  "P_ATTACK_KNIGHT", "P_ATTACK_ROOK", "P_ATTACK_QUEEN",
};
static thread_local bool texelTuning = false;
// Shipped defaults; the tuner clamps every parameter to within +/-50% of these
// to stop the optimizer chasing noise on sparse features into absurd values.
static const int TUNE_DEFAULT[TUNE_PARAM_COUNT] = {
  3, 2, 2, 1,
  3, 2, 3, 1,
  25, 15, 15, 10,
  45, 40, 30, 15,
  30, 30, 25, 20,
  20, 35, 60, 100,
  20, 35, 60, 100,
  18, 12,
  12, 12,
  14, 14,
  4, 2,
  6, 8,
  30, 30,
  3, 2,
  18, 18,
  8, 8,
  14, 14,
  12, 8,
  2,
  40, 20, 12,
  8, 4, 10,
  8,
  2, 3, 5,

};
// Singular-extension and late-move-pruning switches are kept so their value
// can be re-measured with the same A/B method used for mobility/threats.
#ifndef KIWA_SINGULAR
#define KIWA_SINGULAR 0
#endif
#ifndef KIWA_LMP
#define KIWA_LMP 0
#endif
#ifndef KIWA_RAZOR
#define KIWA_RAZOR 0
#endif
static int MOB_MG[7] = { 0, 0, 3, 2, 2, 1, 0 };  // synced from TUNE
static int MOB_EG[7] = { 0, 0, 3, 2, 3, 1, 0 };  // synced from TUNE
static const int OUTPOST_N_MG = 25, OUTPOST_N_EG = 15;
static const int OUTPOST_B_MG = 15, OUTPOST_B_EG = 10;
// A piece attacked by an enemy pawn, or attacked while undefended, is a
// liability a shallow search often misses. Knights and bishops are hit hardest
// because losing one for a pawn decides most club-level games. The two
// penalties stack: a loose knight on a pawn-attacked square loses both.
static int THREAT_PAWN[7] = { 0, 0, 45, 40, 30, 15, 0 };  // synced from TUNE
static int THREAT_LOOSE[7] = { 0, 0, 30, 30, 25, 20, 0 };  // synced from TUNE
// Attack-map weight per piece type (pawn, knight, bishop, rook, queen, king).
static int ATTACK_WEIGHT[7] = { 0, 1, 2, 2, 3, 5, 1 };  // synced from TUNE
static const int ROOK_PASSER_MG = 18, ROOK_PASSER_EG = 12;
static const int KING_DANGER_CAP = 40;
static const int KING_OPEN_FILE_MG = 20, KING_HALF_OPEN_FILE_MG = 12;

// Push the current TUNE[] values into the mutable eval arrays. Called once
// at startup (identity update) and by the tuner after each accepted move.
static void syncTuneArrays() {
  MOB_MG[KNIGHT] = TUNE[P_MOB_N_MG]; MOB_MG[BISHOP] = TUNE[P_MOB_B_MG];
  MOB_MG[ROOK] = TUNE[P_MOB_R_MG]; MOB_MG[QUEEN] = TUNE[P_MOB_Q_MG];
  MOB_EG[KNIGHT] = TUNE[P_MOB_N_EG]; MOB_EG[BISHOP] = TUNE[P_MOB_B_EG];
  MOB_EG[ROOK] = TUNE[P_MOB_R_EG]; MOB_EG[QUEEN] = TUNE[P_MOB_Q_EG];
  PASSED_MG[3] = TUNE[P_PASS_MG3]; PASSED_MG[4] = TUNE[P_PASS_MG4];
  PASSED_MG[5] = TUNE[P_PASS_MG5]; PASSED_MG[6] = TUNE[P_PASS_MG6];
  PASSED_EG[3] = TUNE[P_PASS_EG3]; PASSED_EG[4] = TUNE[P_PASS_EG4];
  PASSED_EG[5] = TUNE[P_PASS_EG5]; PASSED_EG[6] = TUNE[P_PASS_EG6];
  THREAT_PAWN[KNIGHT] = TUNE[P_PAWN_N]; THREAT_PAWN[BISHOP] = TUNE[P_PAWN_B];
  THREAT_PAWN[ROOK] = TUNE[P_PAWN_R]; THREAT_PAWN[QUEEN] = TUNE[P_PAWN_Q];
  THREAT_LOOSE[KNIGHT] = TUNE[P_LOOSE_N]; THREAT_LOOSE[BISHOP] = TUNE[P_LOOSE_B];
  THREAT_LOOSE[ROOK] = TUNE[P_LOOSE_R]; THREAT_LOOSE[QUEEN] = TUNE[P_LOOSE_Q];
  ATTACK_WEIGHT[KNIGHT] = TUNE[P_ATTACK_KNIGHT]; ATTACK_WEIGHT[BISHOP] = TUNE[P_ATTACK_KNIGHT];
  ATTACK_WEIGHT[ROOK] = TUNE[P_ATTACK_ROOK]; ATTACK_WEIGHT[QUEEN] = TUNE[P_ATTACK_QUEEN];
}

// Pawn attack maps. They depend only on the pawn placement, so they are
// rebuilt only when the pawn key changes, not on every full-extras miss.
static thread_local int8_t wPawnAtk[128];
static thread_local int8_t bPawnAtk[128];
// Weighted attack maps for both colours, rebuilt with the positional extras.
// Pawn attacks weigh 1, minors 2, rooks 3, queens 5 and kings 1. The same map
// answers "is this square attacked?" and "is this piece defended?".
static thread_local int8_t atkMap[2][128];
static thread_local u64 pawnAtkKey = 0;
static thread_local bool pawnAtkValid = false;

// Pawn-structure cache keyed by the pawn-only Zobrist key.
static const int PH_SIZE = 1 << 13;
static const int PH_MASK = PH_SIZE - 1;
static thread_local u64 phKey[PH_SIZE];
static thread_local int phScoreMg[PH_SIZE];
static thread_local int phScoreEg[PH_SIZE];
static thread_local int phWB[PH_SIZE];
static thread_local int phBB[PH_SIZE];
static thread_local uint64_t phPassW[PH_SIZE];
static thread_local uint64_t phPassB[PH_SIZE];

// Whole-extras cache keyed by the position hash. Two ways per bucket: a
// depth-12 search visits more distinct positions than a small table can hold,
// and every miss rebuilds the attack maps and all positional terms. 17 bits
// cut the miss count by ~11% in the bench versus the old 15-bit table.
#ifndef EX_BITS
#define EX_BITS 17
#endif
static const int EX_SIZE = 1 << EX_BITS;
static const int EX_MASK = EX_SIZE - 1;
static thread_local u64 exKey[EX_SIZE];
static thread_local int exScoreMg[EX_SIZE];
static thread_local int exScoreEg[EX_SIZE];
static thread_local int extraMg, extraEg;
static thread_local u64 exCalls = 0, exMisses = 0;

static inline int chebDist(int a, int b) {
  const int dr = abs((a >> 4) - (b >> 4));
  const int df = abs((a & 7) - (b & 7));
  return dr > df ? dr : df;
}

static inline void fillPawnAttacks() {
  for (int i = 0; i < 128; i++) { wPawnAtk[i] = 0; bPawnAtk[i] = 0; }
  const int wn = pieceCount[0 * 6 + PAWN - 1];
  for (int i = 0; i < wn; i++) {
    const int sq = pieceSq[(0 * 6 + PAWN - 1) * 16 + i];
    int a = sq + 15; if (validSq(a)) wPawnAtk[a] = 1;
    a = sq + 17; if (validSq(a)) wPawnAtk[a] = 1;
  }
  const int bn = pieceCount[1 * 6 + PAWN - 1];
  for (int i = 0; i < bn; i++) {
    const int sq = pieceSq[(1 * 6 + PAWN - 1) * 16 + i];
    int a = sq - 15; if (validSq(a)) bPawnAtk[a] = 1;
    a = sq - 17; if (validSq(a)) bPawnAtk[a] = 1;
  }
}

// Enemy pawns that could ever attack `sq` (one rank behind it, adjacent file).
static inline bool enemyPawnCanReach(int sq, int c) {
  const int a = sq + (c == WHITE ? 15 : -15);
  const int b = sq + (c == WHITE ? 17 : -17);
  return (validSq(a) && board[a] == pc(c ^ 1, PAWN)) ||
         (validSq(b) && board[b] == pc(c ^ 1, PAWN));
}

static const int QUEEN_D[8] = { 17, 15, -15, -17, 16, -16, 1, -1 };

// Pseudo-legal destination count, excluding own pieces and enemy-pawn cover.
static inline int pieceMobility(int c, int t, int sq, const int8_t* enemyPawnAtk) {
  int m = 0;
  if (t == KNIGHT) {
    for (int i = 0; i < 8; i++) {
      const int ns = sq + KNIGHT_D[i];
      if (!validSq(ns)) continue;
      const int b = board[ns];
      if (b && (b >> 3) == c) continue;
      if (enemyPawnAtk[ns]) continue;
      m++;
    }
    return m;
  }
  const int* dirs;
  int n;
  if (t == BISHOP) { dirs = BISHOP_D; n = 4; }
  else if (t == ROOK) { dirs = ROOK_D; n = 4; }
  else { dirs = QUEEN_D; n = 8; }
  for (int i = 0; i < n; i++) {
    int ns = sq;
    while (true) {
      ns += dirs[i];
      if (!validSq(ns)) break;
      const int b = board[ns];
      if (b && (b >> 3) == c) break;
      if (!enemyPawnAtk[ns]) m++;
      if (b) break;
    }
  }
  return m;
}

// Weighted attack maps for both colours. Sliders stop at the first blocker but
// still mark the blocker's square, so the maps are usable both for king danger
// (enemy attacks) and for deciding whether a piece is defended (own attacks).
// Pawn attacks come from the pawn-attack arrays that extrasRaw already keeps.
static void buildAttackMaps() {
  memset(atkMap[WHITE], 0, 128);
  memset(atkMap[BLACK], 0, 128);
  for (int c = 0; c < 2; c++) {
    int8_t* out = atkMap[c];
    const int8_t* pawns = c == WHITE ? wPawnAtk : bPawnAtk;
    for (int sq = 0; sq < 128; sq++) if (pawns[sq]) out[sq] = 1;
    for (int t = KNIGHT; t <= KING; t++) {
      const int w = ATTACK_WEIGHT[t];
      const int pi = c * 6 + t - 1;
      for (int i = 0; i < pieceCount[pi]; i++) {
        const int from = pieceSq[pi * 16 + i];
        if (t == KNIGHT) {
          for (int d = 0; d < 8; d++) {
            const int s = from + KNIGHT_D[d];
            if (validSq(s)) out[s] += w;
          }
        } else if (t == KING) {
          for (int d = 0; d < 8; d++) {
            const int s = from + KING_D[d];
            if (validSq(s)) out[s] += w;
          }
        } else {
          const int* dirs = t == BISHOP ? BISHOP_D : (t == ROOK ? ROOK_D : QUEEN_D);
          const int nd = t == QUEEN ? 8 : 4;
          for (int d = 0; d < nd; d++) {
            int s = from;
            while (true) {
              s += dirs[d];
              if (!validSq(s)) break;
              out[s] += w;
              if (board[s]) break;
            }
          }
        }
      }
    }
  }
}

static void extrasRaw() {
  const int wpIdx = 0 * 6 + PAWN - 1, bpIdx = 1 * 6 + PAWN - 1;
  const int wpc = pieceCount[wpIdx], bpc = pieceCount[bpIdx];
  int xmg = 0, xeg = 0;
  uint64_t passW = 0, passB = 0;

  if (!pawnAtkValid || pawnAtkKey != pawnKey) {
    fillPawnAttacks();
    pawnAtkKey = pawnKey;
    pawnAtkValid = true;
  }

  if (wpc == 0 && bpc == 0) {
    for (int f = 0; f < 8; f++) { wpFiles[f] = 0; bpFiles[f] = 0; }
  } else {
    const int idx = (int)(pawnKey & PH_MASK);
    if (phKey[idx] == pawnKey) {
      xmg = phScoreMg[idx]; xeg = phScoreEg[idx];
      passW = phPassW[idx]; passB = phPassB[idx];
      int wb = phWB[idx], bb = phBB[idx];
      for (int f = 0; f < 8; f++) {
        wpFiles[f] = wb & 15; wb >>= 4;
        bpFiles[f] = bb & 15; bb >>= 4;
      }
    } else {
      for (int f = 0; f < 8; f++) { wpFiles[f] = 0; bpFiles[f] = 0; }
      const int wpBase = wpIdx * 16, bpBase = bpIdx * 16;
      for (int i = 0; i < wpc; i++) wpFiles[pieceSq[wpBase + i] & 7]++;
      for (int i = 0; i < bpc; i++) bpFiles[pieceSq[bpBase + i] & 7]++;

      // Doubled / isolated
      for (int f = 0; f < 8; f++) {
        if (wpFiles[f] > 1) { xmg -= TUNE[P_DOUBLED_MG] * (wpFiles[f] - 1); xeg -= TUNE[P_DOUBLED_EG] * (wpFiles[f] - 1); }
        if (bpFiles[f] > 1) { xmg += TUNE[P_DOUBLED_MG] * (bpFiles[f] - 1); xeg += TUNE[P_DOUBLED_EG] * (bpFiles[f] - 1); }
      }
      for (int i = 0; i < wpc; i++) {
        const int f = pieceSq[wpBase + i] & 7;
        const int left = f > 0 ? wpFiles[f - 1] : 0;
        const int right = f < 7 ? wpFiles[f + 1] : 0;
        if (!left && !right) { xmg -= TUNE[P_ISOLATED_MG]; xeg -= TUNE[P_ISOLATED_EG]; }
      }
      for (int i = 0; i < bpc; i++) {
        const int f = pieceSq[bpBase + i] & 7;
        const int left = f > 0 ? bpFiles[f - 1] : 0;
        const int right = f < 7 ? bpFiles[f + 1] : 0;
        if (!left && !right) { xmg += TUNE[P_ISOLATED_MG]; xeg += TUNE[P_ISOLATED_EG]; }
      }

      // Connected pawns (defended or phalanx), never on an isolated pawn.
      for (int c = 0; c < 2; c++) {
        const int sign = c == WHITE ? 1 : -1;
        const int pi = c * 6 + PAWN - 1;
        const int own = pc(c, PAWN);
        const int back = c == WHITE ? -16 : 16;
        const int* fileCnt = c == WHITE ? wpFiles : bpFiles;
        const int8_t* enemyAtk = c == WHITE ? bPawnAtk : wPawnAtk;
        for (int i = 0; i < pieceCount[pi]; i++) {
          const int sq = pieceSq[pi * 16 + i];
          const int f = sq & 7;
          bool connected = false;
          for (int df = -1; df <= 1 && !connected; df += 2) {
            if (f + df < 0 || f + df > 7) continue;
            const int support = sq + back + df;
            if (validSq(support) && board[support] == own) connected = true;
            const int side = sq + df;
            if (validSq(side) && board[side] == own) connected = true;
          }
          if (connected) { xmg += sign * TUNE[P_CONN_MG]; xeg += sign * TUNE[P_CONN_EG]; }

          // Backward: no pawn able to defend it, yet an adjacent-file pawn
          // exists (so isolated pawns are not counted twice), and its stop
          // square is covered by an enemy pawn.
          const int r = sq >> 4;
          const int rr = c == WHITE ? r : 7 - r;
          if (rr >= 1 && rr <= 5) {
            bool defended = false, anyAdj = false;
            for (int df = -1; df <= 1; df += 2) {
              if (f + df < 0 || f + df > 7) continue;
              if (fileCnt[f + df]) anyAdj = true;
              const int support = sq + back + df;
              if (validSq(support) && board[support] == own) defended = true;
            }
            if (!defended && anyAdj) {
              const int stop = sq + (c == WHITE ? 16 : -16);
              if (validSq(stop) && enemyAtk[stop]) { xmg -= sign * TUNE[P_BACK_MG]; xeg -= sign * TUNE[P_BACK_EG]; }
            }
          }
        }
      }

      // Passed pawns (rank bonus here; king distance is added below).
      for (int i = 0; i < wpc; i++) {
        const int sq = pieceSq[wpBase + i];
        const int f = sq & 7, r = sq >> 4;
        bool blocked = false;
        for (int j = 0; j < bpc; j++) {
          const int bs = pieceSq[bpBase + j];
          if ((bs >> 4) > r && abs((bs & 7) - f) <= 1) { blocked = true; break; }
        }
        if (!blocked) {
          xmg += PASSED_MG[r]; xeg += PASSED_EG[r];
          passW |= 1ULL << (r * 8 + f);
        }
      }
      for (int i = 0; i < bpc; i++) {
        const int sq = pieceSq[bpBase + i];
        const int f = sq & 7, r = sq >> 4;
        bool blocked = false;
        for (int j = 0; j < wpc; j++) {
          const int ws = pieceSq[wpBase + j];
          if ((ws >> 4) < r && abs((ws & 7) - f) <= 1) { blocked = true; break; }
        }
        if (!blocked) {
          xmg -= PASSED_MG[7 - r]; xeg -= PASSED_EG[7 - r];
          passB |= 1ULL << (r * 8 + f);
        }
      }

      int wb = 0, bb = 0;
      for (int f = 7; f >= 0; f--) { wb = (wb << 4) | wpFiles[f]; bb = (bb << 4) | bpFiles[f]; }
      phKey[idx] = pawnKey;
      phScoreMg[idx] = xmg; phScoreEg[idx] = xeg; phWB[idx] = wb; phBB[idx] = bb;
      phPassW[idx] = passW; phPassB[idx] = passB;
    }
  }

  // Rook behind a passed pawn (Tarrasch): the rogue supports the push and
  // keeps the square in front under fire. This needs both rook and pawn
  // placement, so it lives outside the pawn-keyed cache and is recomputed on
  // every whole-extras miss; caching it under the pawn key would freeze the
  // bonus when only a rook moves.
  for (int c = 0; c < 2; c++) {
    const int sign = c == WHITE ? 1 : -1;
    const uint64_t pass = c == WHITE ? passW : passB;
    if (!pass) continue;
    const int pi = c * 6 + PAWN - 1, ri = c * 6 + ROOK - 1;
    if (!pieceCount[ri]) continue;
    for (int i = 0; i < pieceCount[pi]; i++) {
      const int sq = pieceSq[pi * 16 + i];
      const int f = sq & 7, r = sq >> 4;
      if (!(pass & (1ULL << (r * 8 + f)))) continue;
      for (int j = 0; j < pieceCount[ri]; j++) {
        const int rs = pieceSq[ri * 16 + j];
        if ((rs & 7) == f && (c == WHITE ? (rs >> 4) < r : (rs >> 4) > r)) {
          xmg += sign * TUNE[P_ROOK_PASS_MG]; xeg += sign * TUNE[P_ROOK_PASS_EG];
          break;
        }
      }
    }
  }

  // Passed-pawn king distance: an enemy king far from the promotion square is
  // worth more in the endgame. Recomputed only on whole-extras cache misses.
  for (int c = 0; c < 2; c++) {
    const int sign = c == WHITE ? 1 : -1;
    const int pi = c * 6 + PAWN - 1;
    const int epi = (c ^ 1) * 6 + PAWN - 1;
    for (int i = 0; i < pieceCount[pi]; i++) {
      const int sq = pieceSq[pi * 16 + i];
      const int f = sq & 7, r = sq >> 4;
      bool passed = true;
      for (int j = 0; j < pieceCount[epi]; j++) {
        const int es = pieceSq[epi * 16 + j];
        const int er = es >> 4;
        if (c == WHITE ? (er > r && abs((es & 7) - f) <= 1)
                       : (er < r && abs((es & 7) - f) <= 1)) { passed = false; break; }
      }
      if (!passed) continue;
      const int promo = c == WHITE ? ((sq & 7) | 0x70) : (sq & 7);
      const int d = chebDist(kingSq[c ^ 1], promo);
      xeg += sign * (7 - d) * TUNE[P_PASS_KD];
    }
  }

  // Mobility, excluding squares covered by an enemy pawn. Ray scans are the
  // most expensive term in the evaluation, so the piece set is a build-time
  // switch used by the A/B measurements: KIWA_MOB=0 off, 1 knights+bishops,
  // 2 also rooks+queens. The shipped value is chosen by measurement.
  {
    const int mobMax = KIWA_MOB == 0 ? KNIGHT - 1 : (KIWA_MOB == 1 ? BISHOP : QUEEN);
    for (int c = 0; c < 2; c++) {
      const int sign = c == WHITE ? 1 : -1;
      const int8_t* enemyAtk = c == WHITE ? bPawnAtk : wPawnAtk;
      for (int t = KNIGHT; t <= mobMax; t++) {
        const int pi = c * 6 + t - 1;
        for (int i = 0; i < pieceCount[pi]; i++) {
          const int m = pieceMobility(c, t, pieceSq[pi * 16 + i], enemyAtk);
          if (m) { xmg += sign * m * MOB_MG[t]; xeg += sign * m * MOB_EG[t]; }
        }
      }
    }
  }

  // Outposts: knight/bishop on the 4th-6th rank, defended by an own pawn and
  // not attackable by an enemy pawn (now or after a push).
  for (int c = 0; c < 2; c++) {
    const int sign = c == WHITE ? 1 : -1;
    const int8_t* ownAtk = c == WHITE ? wPawnAtk : bPawnAtk;
    const int8_t* enemyAtk = c == WHITE ? bPawnAtk : wPawnAtk;
    for (int t = KNIGHT; t <= BISHOP; t++) {
      const int pi = c * 6 + t - 1;
      for (int i = 0; i < pieceCount[pi]; i++) {
        const int sq = pieceSq[pi * 16 + i];
        const int r = sq >> 4;
        const bool rankOk = c == WHITE ? (r >= 3 && r <= 5) : (r >= 2 && r <= 4);
        if (!rankOk || !ownAtk[sq] || enemyAtk[sq]) continue;
        if (enemyPawnCanReach(sq, c)) continue;
        if (t == KNIGHT) { xmg += sign * TUNE[P_OUT_N_MG]; xeg += sign * TUNE[P_OUT_N_EG]; }
        else { xmg += sign * TUNE[P_OUT_B_MG]; xeg += sign * TUNE[P_OUT_B_EG]; }
      }
    }
  }

  // Bishop pair
  if (pieceCount[0 * 6 + BISHOP - 1] >= 2) { xmg += TUNE[P_BISHOP_PAIR_MG]; xeg += TUNE[P_BISHOP_PAIR_EG]; }
  if (pieceCount[1 * 6 + BISHOP - 1] >= 2) { xmg -= TUNE[P_BISHOP_PAIR_MG]; xeg -= TUNE[P_BISHOP_PAIR_EG]; }

  // Bad bishop: own pawns on the bishop's colour restrict it.
  for (int c = 0; c < 2; c++) {
    const int sign = c == WHITE ? 1 : -1;
    const int bi = c * 6 + BISHOP - 1, pi = c * 6 + PAWN - 1;
    for (int i = 0; i < pieceCount[bi]; i++) {
      const int sq = pieceSq[bi * 16 + i];
      const int bc = ((sq >> 4) + (sq & 7)) & 1;
      int bad = 0;
      for (int j = 0; j < pieceCount[pi]; j++) {
        const int ps = pieceSq[pi * 16 + j];
        if ((((ps >> 4) + (ps & 7)) & 1) == bc) bad++;
      }
      if (bad > 6) bad = 6;
      xmg -= sign * TUNE[P_BADB_MG] * bad; xeg -= sign * TUNE[P_BADB_EG] * bad;
    }
  }

  // Rooks on open / semi-open files, on the seventh rank, and connected.
  for (int c = 0; c < 2; c++) {
    const int sign = c == WHITE ? 1 : -1;
    const int ri = c * 6 + ROOK - 1;
    const int cnt = pieceCount[ri];
    for (int i = 0; i < cnt; i++) {
      const int rsq = pieceSq[ri * 16 + i];
      const int f = rsq & 7;
      const int own = c == WHITE ? wpFiles[f] : bpFiles[f];
      const int opp = c == WHITE ? bpFiles[f] : wpFiles[f];
      if (!own && !opp) { xmg += sign * TUNE[P_ROOK_OPEN_MG]; xeg += sign * TUNE[P_ROOK_OPEN_EG]; }
      else if (!own) { xmg += sign * TUNE[P_ROOK_SEMI_MG]; xeg += sign * TUNE[P_ROOK_SEMI_EG]; }
      const int r = rsq >> 4;
      if ((c == WHITE && r == 6) || (c == BLACK && r == 1)) { xmg += sign * TUNE[P_ROOK_7TH_MG]; xeg += sign * TUNE[P_ROOK_7TH_EG]; }
    }
    for (int i = 0; i < cnt; i++) {
      for (int j = i + 1; j < cnt; j++) {
        const int a = pieceSq[ri * 16 + i], b = pieceSq[ri * 16 + j];
        if ((a >> 4) != (b >> 4)) continue;
        const int step = a < b ? 1 : -1;
        bool clear = true;
        for (int sq = a + step; sq != b; sq += step) {
          if (board[sq]) { clear = false; break; }
        }
        if (clear) { xmg += sign * TUNE[P_ROOK_CONN_MG]; xeg += sign * TUNE[P_ROOK_CONN_EG]; }
      }
    }
  }

  // King pawn shield (midgame only)
  if (phase > 8) {
    for (int c = 0; c < 2; c++) {
      const int sign = c == WHITE ? 1 : -1;
      const int ksq = kingSq[c];
      const int d = c == WHITE ? 16 : -16;
      int shield = 0;
      for (int df = -1; df <= 1; df++) {
        const int f = (ksq & 7) + df;
        if (f < 0 || f > 7) continue;
        const int s1 = ksq + d + df;
        if (validSq(s1) && board[s1] == pc(c, PAWN)) shield += TUNE[P_SHIELD_PAWN];
        else {
          const int s2 = s1 + d;
          if (validSq(s2) && board[s2] == pc(c, PAWN)) shield += TUNE[P_SHIELD_PAWN2];
          else shield -= TUNE[P_SHIELD_HOLE];
        }
      }
      xmg += sign * shield;
    }
  }

#if KIWA_THREATS || KIWA_KINGSAFETY
  buildAttackMaps();
#endif

#if KIWA_THREATS
  // Piece threats. A pawn attack on a minor is the most common way a club
  // player loses material, and an undefended attacked piece is the next. The
  // search resolves real tactics; this term keeps the leaf evaluation honest
  // when the horizon cuts off the capture.
  for (int c = 0; c < 2; c++) {
    const int sign = c == WHITE ? 1 : -1;
    const int8_t* enemyAtk = atkMap[c ^ 1];
    const int8_t* ownAtk = atkMap[c];
    const int8_t* enemyPawns = c == WHITE ? bPawnAtk : wPawnAtk;
    for (int t = KNIGHT; t <= QUEEN; t++) {
      const int pi = c * 6 + t - 1;
      for (int i = 0; i < pieceCount[pi]; i++) {
        const int sq = pieceSq[pi * 16 + i];
        int pen = 0;
        if (enemyPawns[sq]) pen += THREAT_PAWN[t];
        if (enemyAtk[sq] && !ownAtk[sq]) pen += THREAT_LOOSE[t];
        xmg -= sign * pen;
        xeg -= sign * (pen * 3 / 4);
      }
    }
  }
#endif

#if KIWA_KINGSAFETY
  // King danger, middlegame only: weighted enemy attacks on the king's ring,
  // plus open and half-open files next to the king. Squaring the attack count
  // makes one loose attacker cheap and a real mating build-up expensive.
  if (phase > 8) {
    static const int RING[9] = { 0, 17, 16, 15, 1, -1, -15, -16, -17 };
    for (int c = 0; c < 2; c++) {
      const int sign = c == WHITE ? 1 : -1;
      const int ksq = kingSq[c];
      const int8_t* enemy = atkMap[c ^ 1];
      int danger = 0;
      for (int d = 0; d < 9; d++) {
        const int s = ksq + RING[d];
        if (validSq(s)) danger += enemy[s];
      }
      if (danger > TUNE[P_KD_CAP]) danger = TUNE[P_KD_CAP];
      xmg -= sign * (danger * danger / 8);

      const int kf = ksq & 7;
      for (int df = -1; df <= 1; df++) {
        const int f = kf + df;
        if (f < 0 || f > 7) continue;
        const int own = c == WHITE ? wpFiles[f] : bpFiles[f];
        const int opp = c == WHITE ? bpFiles[f] : wpFiles[f];
        if (!own) xmg -= sign * (opp ? TUNE[P_SEMI_MG] : TUNE[P_OPEN_MG]);
      }
    }
  }
#endif

  extraMg = xmg; extraEg = xeg;
}

static void extras() {
  exCalls++;
  // The whole-position cache is keyed by position only, not by the tunable
  // parameter vector; bypass it while coordinate-descending.
  if (texelTuning) { extrasRaw(); return; }
  const size_t base = (size_t)(key & EX_MASK) & ~(size_t)1;
  if (exKey[base] == key) {
    extraMg = exScoreMg[base]; extraEg = exScoreEg[base];
    return;
  }
  if (exKey[base + 1] == key) {
    extraMg = exScoreMg[base + 1]; extraEg = exScoreEg[base + 1];
    return;
  }
  exMisses++;
  extrasRaw();
  size_t slot;
  if (exKey[base] == 0) slot = base;
  else if (exKey[base + 1] == 0) slot = base + 1;
  else slot = base + (size_t)((key >> 17) & 1);
  exKey[slot] = key; exScoreMg[slot] = extraMg; exScoreEg[slot] = extraEg;
}

// Positional terms (pawn structure, outposts, bishop quality, rook activity,
// king shield, passed-pawn king distance, mobility). KIWA_EXTRAS=0 compiles the
// block out, which is how the ablation duels in the README were measured; the
// shipped build has it on. Keep the switch: without it the claim that these
// terms are worth their ~40% cost in nodes/s cannot be re-checked.
#ifndef KIWA_EXTRAS
#define KIWA_EXTRAS 1
#endif

static int evaluate() {
  if (nnueLoaded && nnueEnabled.load(memory_order_relaxed)) {
    // FRNN nets were trained on Stockfish PV1 evals (which include tempo),
    // so the net score is used as-is with no hand-added tempo lobe.
    return nnueNet.evaluate(nnueAcc, side);
  }
  const int p = phase > 24 ? 24 : phase;
  int s = (mg * p + eg * (24 - p)) / 24;
#if KIWA_EXTRAS
  extras();
  s += (extraMg * p + extraEg * (24 - p)) / 24;
#endif
  return (side == WHITE ? s : -s) + TUNE[P_TEMPO];
}

// ---------------------------------------------------------------------------
// Transposition table
// ---------------------------------------------------------------------------

// 16 bytes per entry; the number of entries is rounded down to a power of two.
// All search threads share one table (Lazy SMP). Writers store the payload
// BEFORE the key and readers load the key BEFORE the payload, behind release /
// acquire fences. Every field is at most 8 bytes and naturally aligned; x86
// (and ARM, for this ordering pattern) never make the key visible before the
// stores that precede it, so a racing reader either misses the old key or
// sees a consistent same-position payload — never one spliced together from
// two positions. The full 64-bit key is stored, so collisions stay at the
// accidental 1-in-2^64 rate.
struct alignas(16) TTEntry {
  u64 key;
  // Single 64-bit payload: bits 0-31 move (internal 0x88 encoding),
  // bits 32-47 score (int16, |value| <= 31000 + MAX_PLY), bits 48-55 depth,
  // bits 56-63 flag (0 exact / 1 upper / 2 lower). One aligned 8-byte
  // load/store is atomic on x86-64 and on ARM for naturally aligned words,
  // so a racing reader gets the whole old or whole new payload, never a
  // field-spliced mix.
  u64 payload;
};
static_assert(sizeof(TTEntry) == 16, "TT entry must stay 16 bytes");
static inline u64 packTT(uint32_t mv, int sc, int depth, int flag) {
  return (u64)mv | ((u64)(uint16_t)(int16_t)sc << 32) |
         ((u64)(uint8_t)depth << 48) | ((u64)(uint8_t)flag << 56);
}
static inline void unpackTT(u64 p, uint32_t& mv, int& sc, int& depth, int& flag) {
  mv = (uint32_t)(p & 0xffffffffu);
  sc = (int)(int16_t)((p >> 32) & 0xffffu);
  depth = (int)((p >> 48) & 0xffu);
  flag = (int)((p >> 56) & 0xffu);
}
static size_t ttSize = 0;
static size_t ttMask = 0;
static int hashMB = 64;
static int multiPvOption = 1;
static inline size_t ttIdx(u64 k) { return (size_t)(k & ttMask); }
static vector<TTEntry> ttEntries;

static void clearTT() {
  if (!ttSize) return;
  fill(ttEntries.begin(), ttEntries.end(), TTEntry{0, 0});
}

static void resizeTT(int mb) {
  if (mb < 1) mb = 1;
  if (mb > 512) mb = 512;
  hashMB = mb;
  size_t entries = ((size_t)mb * 1024 * 1024) / sizeof(TTEntry);
  size_t n = 1024;
  while (n * 2 <= entries && n < (1u << 26)) n *= 2;
  ttSize = n;
  ttMask = n - 1;
  ttEntries.assign(n, TTEntry{0, 0});
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

static thread_local u64 nodes = 0;
static thread_local bool searchStop = false;
static thread_local int threadId = 0;
static atomic<bool> abortFlag(false);
static int moveOverhead = 30; // ms of the clock never spent, for GUI/IPC latency
static bool ownBook = true;
static int bookDepthPlies = 24;
static int bookVariety = 100;

// Opening personalities. The generated book carries six weight columns per
// move; a personality only changes which column is used, never the legality of
// the move. The search validates questionable choices before they are played.
enum BookStyle {
  BOOK_BALANCED = 0,
  BOOK_MAINLINE = 1,
  BOOK_AGGRESSIVE = 2,
  BOOK_GAMBIT = 3,
  BOOK_SOLID = 4,
  BOOK_SURPRISE = 5,
  BOOK_POSITIONAL = 6
};
static const char* BOOK_STYLE_NAMES[7] = {
  "Balanced", "Mainline", "Aggressive", "Gambit", "Solid", "Surprise", "Positional"
};
static int bookStyle = BOOK_BALANCED;
static int bookDiversity = 50; // anti-repetition strength across games
static i64 randomSeed = 0;     // 0 = derive from the clock

static int threads = 1;
static bool bookAllowed = false; // only for games that started from the initial position

static u64 makeBookSeed() {
  if (randomSeed != 0) return (u64)randomSeed;
  return (u64)chrono::steady_clock::now().time_since_epoch().count() ^
         ((u64)random_device{}() << 32);
}
static mt19937_64 bookRng(makeBookSeed());

// Session memory, kept across ucinewgame. White and Black have separate
// repertoires, and the resulting-position set makes the memory transposition
// aware: playing 1.d4 d5 2.Nf3 or 1.Nf3 d5 2.d4 is recognised as the same line.
struct BookMemorySide {
  unordered_map<uint64_t, uint8_t> moves;   // hash(position, move)
  unordered_map<uint64_t, uint8_t> results; // hash(resulting position)
};
static BookMemorySide bookMem[2];

static void bumpBookCount(unordered_map<uint64_t, uint8_t>& m, u64 k) {
  auto it = m.find(k);
  if (it == m.end()) m.emplace(k, 1);
  else if (it->second < 12) it->second++;
}

// Age the counts once per game so recent games dominate without dropping
// anything outright. Rounding up matters: a line played once keeps count 1,
// so it is still remembered after ucinewgame; repeated lines fade toward 1.
// Clearing is explicit via "Clear Book Memory".
static void ageBookMemory() {
  for (auto& sideMem : bookMem) {
    for (auto* map : { &sideMem.moves, &sideMem.results }) {
      for (auto it = map->begin(); it != map->end();) {
        it->second = (uint8_t)((it->second + 1) / 2);
        if (it->second == 0) it = map->erase(it);
        else ++it;
      }
    }
  }
}

static void clearBookMemory() {
  for (auto& sideMem : bookMem) {
    sideMem.moves.clear();
    sideMem.results.clear();
  }
}

static int parseBookStyle(const string& v) {
  string s = v;
  for (char& c : s) c = (char)tolower((unsigned char)c);
  if (s == "mainline") return BOOK_MAINLINE;
  if (s == "aggressive") return BOOK_AGGRESSIVE;
  if (s == "gambit") return BOOK_GAMBIT;
  if (s == "solid") return BOOK_SOLID;
  if (s == "surprise") return BOOK_SURPRISE;
  if (s == "positional") return BOOK_POSITIONAL;
  return BOOK_BALANCED;
}

// Process-wide search limits. They were thread_local while the search ran
// one thread per invocation; ponderhit converts an ongoing ponder search
// to normal clock limits from the main thread, so these are shared. All
// writes use relaxed atomics; the search reads them in its time check.
static atomic<u64> nodeLimit(0);
static atomic<i64> hardStop(INT64_MAX);
static atomic<i64> softStop(INT64_MAX);
static atomic<i64> moveAlloc(0);

static thread_local int rootBest = 0;
static thread_local int rootScore = 0;
static thread_local int rootDepth = 0;
static thread_local int rootPrevBest = 0;
// Static evaluations by ply, for the "improving" test (eval exceeds the one
// from two plies ago). Used to widen pruning margins when the position is
// getting better for the side to move.
static thread_local int staticEvalStack[MAX_PLY + 2];

static int LMR[64][MAX_MOVES];

static i64 nowMs() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

// Process CPU time (user+kernel), used by `bench` because wall time on a
// shared machine is dominated by scheduling noise, not engine speed.
static i64 cpuMs() {
#ifdef _WIN32
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) return 0;
  ULARGE_INTEGER k, u;
  k.LowPart = kernel.dwLowDateTime; k.HighPart = kernel.dwHighDateTime;
  u.LowPart = user.dwLowDateTime; u.HighPart = user.dwHighDateTime;
  return (i64)((k.QuadPart + u.QuadPart) / 10000);
#else
  return (i64)((double)clock() * 1000.0 / (double)CLOCKS_PER_SEC);
#endif
}

static inline bool timeUp() {
  return abortFlag.load(memory_order_relaxed) ||
         (i64)nowMs() >= hardStop.load(memory_order_relaxed) ||
         (nodeLimit.load(memory_order_relaxed) != 0 && nodes >= nodeLimit.load(memory_order_relaxed));
}

static bool hasNonPawn(int c) {
  return pieceCount[c * 6 + KNIGHT - 1] > 0 ||
         pieceCount[c * 6 + BISHOP - 1] > 0 ||
         pieceCount[c * 6 + ROOK - 1] > 0 ||
         pieceCount[c * 6 + QUEEN - 1] > 0;
}

// Any earlier occurrence: used inside the search to cut cycles. A single
// repetition is not a draw and must not be scored as one.
static bool isRepetition() {
  int stop = histLen - 1 - halfmove;
  if (stop < 0) stop = 0;
  for (int i = histLen - 3; i >= stop; i -= 2) {
    if (posKeys[i] == key) return true;
  }
  return false;
}

// A real threefold claim: the current position plus two earlier identical
// positions within the reversible window. This is the root adjudication rule.
static bool isThreefold() {
  int stop = histLen - 1 - halfmove;
  if (stop < 0) stop = 0;
  int seen = 0;
  for (int i = histLen - 3; i >= stop; i -= 2) {
    if (posKeys[i] == key && ++seen >= 2) return true;
  }
  return false;
}

// Dead positions under FIDE 5.2.2: no sequence of legal moves can lead to
// mate. That covers K vs K, K+minor vs K, and any number of bishops that all
// live on one colour (K+B vs K+B with same-coloured bishops included).
static bool insufficientMaterial() {
  for (int c = 0; c < 2; c++) {
    if (pieceCount[pieceIndex(c, PAWN)] || pieceCount[pieceIndex(c, ROOK)] ||
        pieceCount[pieceIndex(c, QUEEN)]) {
      return false;
    }
  }
  const int knights = pieceCount[pieceIndex(WHITE, KNIGHT)] + pieceCount[pieceIndex(BLACK, KNIGHT)];
  const int bishops = pieceCount[pieceIndex(WHITE, BISHOP)] + pieceCount[pieceIndex(BLACK, BISHOP)];
  if (knights == 0 && bishops == 0) return true; // bare kings
  if (knights + bishops == 1) return true;      // one minor piece
  if (knights == 0) {
    int colour = -1;
    bool sameColour = true;
    for (int c = 0; c < 2 && sameColour; c++) {
      const int pi = pieceIndex(c, BISHOP);
      for (int i = 0; i < pieceCount[pi]; i++) {
        const int sq = pieceSq[pi * 16 + i];
        const int sqColour = ((sq >> 4) + (sq & 7)) & 1;
        if (colour < 0) colour = sqColour;
        else if (colour != sqColour) sameColour = false;
      }
    }
    if (sameColour) return true;
  }
  return false;
}

static int moveScore(uint32_t mv, uint32_t ttMove, int ply, uint32_t prevMv) {
  if (mv == ttMove) return 1 << 28;
  const int from = mv & 127;
  const int to = (mv >> 7) & 127;
  const int promo = (mv >> 14) & 7;
  const int flags = mv & (F_CAP | F_EP | F_CASTLE | F_DOUBLE);

  if (promo) {
    int sc = (1 << 24) + promo * 1000;
    if (flags & F_CAP) sc += VAL_MG[board[to] ? typeOf(board[to]) : PAWN] * 8;
    return sc;
  }

  if (flags & F_CAP) {
    const int victim = board[to] ? typeOf(board[to]) : PAWN;
    const int seev = see(mv);
    if (seev >= 0) return (1 << 22) + seev * 16;
    return (1 << 19) + seev;
  }

  if (mv == (uint32_t)killers[ply * 2]) return 1 << 21;
  if (mv == (uint32_t)killers[ply * 2 + 1]) return 1 << 20;

  if (prevMv && (uint32_t)counter[((prevMv & 127) << 7) | ((prevMv >> 7) & 127)] == mv) return 1 << 19;

  return history[side * 16384 + from * 128 + to];
}

static uint32_t pickMove(int base, int n, int i) {
  int best = i;
  int bestScore = scoreBuf[base + i];
  for (int j = i + 1; j < n; j++) {
    const int sc = scoreBuf[base + j];
    if (sc > bestScore) { best = j; bestScore = sc; }
  }
  if (best != i) {
    swap(moveBuf[base + i], moveBuf[base + best]);
    swap(scoreBuf[base + i], scoreBuf[base + best]);
  }
  return moveBuf[base + i];
}

static int quiesce(int alpha, int beta, int ply, bool inCheck) {
  nodes++;
  if ((nodes & 1023) == 0 && timeUp()) searchStop = true;
  if (searchStop) return 0;
  if (ply >= MAX_PLY - 1) return evaluate();

  int best;
  if (!inCheck) {
    const int stand = evaluate();
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    best = stand;
  } else {
    best = -INF;
  }

  const int base = ply * MAX_MOVES;
  const int n = generateMoves(base, !inCheck);
  for (int i = 0; i < n; i++) scoreBuf[base + i] = moveScore(moveBuf[base + i], 0, ply, 0);

  int legal = 0;
  for (int i = 0; i < n; i++) {
    const uint32_t mv = pickMove(base, n, i);
    const int flags = mv & (F_CAP | F_EP | F_CASTLE | F_DOUBLE);

    if (!inCheck) {
      const int to = (mv >> 7) & 127;
      const int promo = (mv >> 14) & 7;
      const int victim = (flags & F_CAP) ? (board[to] ? typeOf(board[to]) : PAWN) : 0;
      if (!promo && victim && best + VAL_MG[victim] + 200 < alpha) continue;
      // A capture of a cheaper piece by a more valuable one is the only kind
      // that can lose material by the exchange sequence; check those with SEE
      // rather than every capture. Checks and promotions are never pruned.
#ifndef NO_SEE_PRUNE
      if (!promo && (flags & F_CAP) && victim &&
          VAL_MG[victim] < VAL_MG[typeOf(board[mv & 127])] && see(mv) < 0) {
        continue;
      }
#endif
    }

    makeMove(mv);
    if (attacked(kingSq[side ^ 1], side)) { unmakeMove(mv); continue; }
    legal++;

    const bool givesCheck = attacked(kingSq[side], side ^ 1);
    const int sc = -quiesce(-beta, -alpha, ply + 1, givesCheck);
    unmakeMove(mv);

    if (searchStop) return 0;
    if (sc > best) {
      best = sc;
      if (sc > alpha) {
        alpha = sc;
        if (sc >= beta) return sc;
      }
    }
  }
  // In check with no legal evasion the position is mate, not a leaf eval.
  if (inCheck && legal == 0) return -MATE + ply;
  return best;
}

static void ttStore(int depth, int score, int flag, uint32_t move, int ply) {
  const size_t idx = ttIdx(key);
  int sc = score;
  if (sc > MATE - 1000) sc += ply;
  else if (sc < -MATE + 1000) sc -= ply;
  TTEntry& e = ttEntries[idx];
  const int curDepth = (int)((e.payload >> 48) & 0xffu);
  // Always-overwrite replacement (Newest entry wins the slot), preferred by
  // A/B measurement on this engine; a different-position deep entry is kept
  // only under the legacy depth-gated rule when KIWA_TT_DEPTH_PREF is set.
#ifdef KIWA_TT_DEPTH_PREF
  if (e.key != key && curDepth > depth + 2) return;
#else
  if (e.key == key && curDepth > depth + 2 && ((e.payload >> 56) & 0xffu) == 0) return;
#endif
  // Payload is published before the key; the aligned 8-byte store is atomic
  // and x86/ARM keep it visible before the key store that follows.
  e.payload = packTT(move, sc, depth, flag);
  atomic_thread_fence(memory_order_release);
  e.key = key;
}

static int negamax(int depth, int alpha, int beta, int ply, bool canNull, uint32_t excludedMove = 0) {
  nodes++;
  if ((nodes & 1023) == 0 && timeUp()) searchStop = true;
  if (searchStop) return 0;

  pvLength[ply] = ply;

  if (ply > 0) {
    if (halfmove >= 100) return 0;
    if (isRepetition() || insufficientMaterial()) return 0;
    // Mate-distance pruning: no mate found deeper than the current bounds
    // can improve on them, and a loss worse than a known mate scores like one.
#ifndef KIWA_NO_MATEPRUNE
    if (alpha < -MATE + ply) alpha = -MATE + ply;
    if (beta > MATE - ply) beta = MATE - ply;
    if (alpha >= beta) return alpha;
#endif
  }
  if (ply >= MAX_PLY - 1) return evaluate();

  uint32_t ttMove = 0;
  int ttDepthOp = -1, ttScoreOp = 0;
  uint8_t ttFlagOp = 0;
  {
    const size_t idx = ttIdx(key);
    if (ttEntries[idx].key == key) {
      atomic_thread_fence(memory_order_acquire);
      uint32_t pm = 0; int ps = 0, pdepth = 0, pflag = 0;
      unpackTT(ttEntries[idx].payload, pm, ps, pdepth, pflag);
      ttMove = pm;
      ttDepthOp = pdepth;
      ttScoreOp = ps;
      ttFlagOp = (uint8_t)pflag;
      if (ttDepthOp >= depth) {
        int sc = ttScoreOp;
        if (sc > MATE - 1000) sc -= ply;
        else if (sc < -MATE + 1000) sc += ply;
        if (ttFlagOp == 0) return sc;
        if (ttFlagOp == 1 && sc <= alpha) return sc;
        if (ttFlagOp == 2 && sc >= beta) return sc;
      }
    }
  }

  const bool inCheck = attacked(kingSq[side], side ^ 1);
  if (depth <= 0) return quiesce(alpha, beta, ply, inCheck);

  // IIR deliberately absent: A/B tests showed it lost tactics without a
  // node-count win, so the reduced re-search is not worth it.
  const int staticEval = inCheck ? -INF : evaluate();
  staticEvalStack[ply] = staticEval;
  const bool improving = excludedMove == 0 && !inCheck && ply >= 2 &&
                         staticEvalStack[ply - 2] != -INF && staticEval > staticEvalStack[ply - 2];

  // Singular extension: when the TT move fails high against a reduced
  // null-window search of every other move, nothing else comes close, so
  // search it one ply deeper. Only when a TT move exists with enough depth.
#if KIWA_SINGULAR
  int singularExt = 0;
  if (excludedMove == 0 && ply > 0 && depth >= 8 && ttMove != 0 && !inCheck &&
      ttDepthOp >= depth - 3 && (ttFlagOp == 0 || ttFlagOp == 2)) {
    int sBeta = ttScoreOp;
    if (sBeta > MATE - 1000) sBeta -= ply;
    else if (sBeta < -MATE + 1000) sBeta += ply;
    sBeta -= (25 + 3 * depth);
    if (sBeta < -MATE + ply) sBeta = -MATE + ply;
    const int sScore = negamax((depth - 1) / 2, sBeta - 1, sBeta, ply, false, ttMove);
    if (sScore < sBeta) singularExt = 1;
  }
#endif

  // Reverse futility pruning: a node whose static eval beats beta by a wide
  // margin is a fail-high even before searching.
  if (excludedMove == 0 && !inCheck && depth <= 2 && staticEval - 120 * depth >= beta) return staticEval;
#if KIWA_RAZOR
  // Razoring: when statically hopeless, drop into qsearch; a fail-low return
  // there confirms the node is lost, so prune the rest of the search.
  if (excludedMove == 0 && !inCheck && depth <= 3 && staticEval != -INF &&
      staticEval + 150 + 150 * depth < alpha) {
    const int sc = quiesce(alpha, beta, ply, false);
    if (sc <= alpha) return sc;
  }
#endif

  // Null move is tried wherever it can fail high against the current beta.
  // In pure-PV full windows beta is infinite so the test costs one shallow
  // subtree and can never cut; against a finite aspiration beta at a PV
  // child it is the cheap fail-high signal the root re-search relies on.
  if (canNull && !inCheck && depth >= 3 && staticEval >= beta && hasNonPawn(side)) {
    const int R = 2 + (depth > 6 ? 1 : 0);
    makeNull();
    const int sc = -negamax(depth - 1 - R, -beta, -beta + 1, ply + 1, false);
    unmakeNull();
    if (searchStop) return 0;
    if (sc >= beta) return beta;
  }

  const int base = ply * MAX_MOVES;
  const uint32_t prevMv = ply > 0 ? moveStack[ply - 1] : 0;
  const int n = generateMoves(base, false);
  for (int i = 0; i < n; i++) scoreBuf[base + i] = moveScore(moveBuf[base + i], ttMove, ply, prevMv);

  int bestScore = -INF;
  uint32_t bestMove = 0;
  int legal = 0;
  const int oldAlpha = alpha;
  // Quiet moves already tried at this node, for history malus on a cutoff.
  int quietHist[64];
  int nQuiet = 0;

  for (int i = 0; i < n; i++) {
    const uint32_t mv = pickMove(base, n, i);
    if (excludedMove != 0 && mv == excludedMove) continue;
    const int flags = mv & (F_CAP | F_EP | F_CASTLE | F_DOUBLE);
    const int promo = (mv >> 14) & 7;
    const int us = side;

    makeMove(mv);
    if (attacked(kingSq[side ^ 1], side)) { unmakeMove(mv); continue; }
    legal++;
    moveStack[ply] = mv;

    const int lmrFrom = mv & 127, lmrTo = (mv >> 7) & 127;
    const int lmrHi = us * 16384 + lmrFrom * 128 + lmrTo;

    const bool givesCheck = attacked(kingSq[side], side ^ 1);
    // Futility pruning of quiet moves. Checks, captures and promotions are
    // never pruned, and the first legal move is always searched; only the
    // recursive call is saved. KIWA_FUTILITY=0 measures what it costs.
#if KIWA_FUTILITY
    if (excludedMove == 0 && !inCheck && legal > 1 && !(flags & F_CAP) && !promo && !givesCheck) {
      if (depth <= 3 && staticEval != -INF) {
        const int fut = 100 + 100 * depth + (improving ? 60 : 0);
        if (staticEval + fut <= alpha) { unmakeMove(mv); continue; }
      }
    }
#endif
#if KIWA_LMP
    // Late-move pruning: beyond a move-count limit, quiet moves that can
    // neither raise alpha nor cut are skipped at low depth. Improving nodes
    // keep more candidates; captures were always exempt.
    if (excludedMove == 0 && !inCheck && depth <= 4 && legal > 1 && !(flags & F_CAP) && !promo && !givesCheck) {
      const int lmpLimit = improving ? (3 + depth * depth) : (2 + depth);
      if (legal > lmpLimit) { unmakeMove(mv); continue; }
    }
#endif
    if (!(flags & F_CAP) && !promo && nQuiet < 64) {
      quietHist[nQuiet++] = us * 16384 + (mv & 127) * 128 + ((mv >> 7) & 127);
    }

    // Check extension: forced replies are cheap to resolve, so keep the depth.
    // Singular extension (when enabled) deepens only the TT move, after the
    // verification search proved no sibling comes close.
    int newDepth = depth - 1;
    if (givesCheck && depth >= 2 && depth <= 6 && ply < 40) newDepth++;
#if KIWA_SINGULAR
    if (mv == ttMove) newDepth += singularExt;
#endif
    int sc;

    if (legal == 1) {
      sc = -negamax(newDepth, -beta, -alpha, ply + 1, true);
    } else {
      int reduction = 0;
      if (depth >= 3 && legal >= 4 && !promo && !inCheck && !givesCheck) {
        if (!(flags & F_CAP)) {
          reduction = LMR[depth][legal];
#ifdef KIWA_LMR_HISTORY
          // Trust history: search moves that have scored well closer to full
          // depth, and barely-tried or losing-history moves shallower.
          const int hs = history[lmrHi];
          if (hs >= 4096) reduction -= 1;
          if (hs >= 16384) reduction -= 1;
          if (hs < -4096) reduction += 1;
#endif
        } else if (see(mv) < 0) {
          // A losing capture is not worth full depth unless it refutes.
          reduction = LMR[depth][legal];
        }
        if (reduction > newDepth - 1) reduction = newDepth - 1;
        if (reduction < 0) reduction = 0;
      }
      sc = -negamax(newDepth - reduction, -alpha - 1, -alpha, ply + 1, true);
      if (sc > alpha && reduction > 0) {
        sc = -negamax(newDepth, -alpha - 1, -alpha, ply + 1, true);
      }
      if (sc > alpha && sc < beta) {
        sc = -negamax(newDepth, -beta, -alpha, ply + 1, true);
      }
    }
    unmakeMove(mv);

    if (searchStop) return 0;

    if (sc > bestScore) {
      bestScore = sc;
      bestMove = mv;
      if (sc > alpha) {
        alpha = sc;
        if (excludedMove == 0) {
          pvTable[ply * MAX_PLY + ply] = (int)mv;
          int j = ply + 1;
          for (; j < pvLength[ply + 1]; j++) {
            pvTable[ply * MAX_PLY + j] = pvTable[(ply + 1) * MAX_PLY + j];
          }
          pvLength[ply] = j;
        }

        if (sc >= beta) {
          if (!(flags & F_CAP) && !promo) {
            if ((uint32_t)killers[ply * 2] != mv) {
              killers[ply * 2 + 1] = killers[ply * 2];
              killers[ply * 2] = (int)mv;
            }
            const int hi = side * 16384 + (mv & 127) * 128 + ((mv >> 7) & 127);
            history[hi] += depth * depth;
            if (history[hi] > (1 << 20)) history[hi] = 1 << 20;
            if (prevMv) counter[((prevMv & 127) << 7) | ((prevMv >> 7) & 127)] = (int)mv;
          }
          // Quiet moves that were tried and failed to raise alpha are worse
          // than the move that cut: score them down. Skipping the last entry
          // avoids penalising the cutoff move itself.
          const int upto = (!(flags & F_CAP) && !promo) ? nQuiet - 1 : nQuiet;
          for (int k = 0; k < upto; k++) {
            int& h = history[quietHist[k]];
            h -= depth * depth;
            if (h < -(1 << 20)) h = -(1 << 20);
          }
          if (excludedMove == 0) ttStore(depth, sc, 2, mv, ply);
          return sc;
        }
      }
    }
  }

  if (legal == 0) return inCheck ? -MATE + ply : 0;

  if (excludedMove == 0) ttStore(depth, bestScore, bestScore > oldAlpha ? 0 : 1, bestMove, ply);
  return bestScore;
}

struct RootResult {
  int score = -INF;
  uint32_t move = 0;
  int legal = 0;
};

static RootResult rootSearch(int depth, int alpha, int beta) {
  const int base = 0;
  const int n = generateMoves(base, false);
  for (int i = 0; i < n; i++) {
    const uint32_t mv = moveBuf[base + i];
    int sc = moveScore(mv, (uint32_t)rootPrevBest, 0, 0);
    if ((int)mv == rootPrevBest) sc = 1 << 29;
    // Helpers start at slightly different root orders, otherwise every thread
    // with an empty slice would walk the identical tree.
    if (threadId > 0) sc += (int)((mv * 2654435761u + (uint32_t)threadId * 7919u) % 17u);
    scoreBuf[base + i] = sc;
  }

  RootResult res;
  pvLength[0] = 0;

  for (int i = 0; i < n; i++) {
    const uint32_t mv = pickMove(base, n, i);
    makeMove(mv);
    if (attacked(kingSq[side ^ 1], side)) { unmakeMove(mv); continue; }
    res.legal++;
    moveStack[0] = mv;

    int sc;
    if (res.legal == 1) {
      sc = -negamax(depth - 1, -beta, -alpha, 1, true);
    } else {
      sc = -negamax(depth - 1, -alpha - 1, -alpha, 1, true);
      if (sc > alpha && sc < beta) sc = -negamax(depth - 1, -beta, -alpha, 1, true);
    }
    unmakeMove(mv);

    if (searchStop) break;

    if (sc > res.score) {
      res.score = sc;
      res.move = mv;
      if (sc > alpha) {
        alpha = sc;
        pvTable[0] = (int)mv;
        int j = 1;
        for (; j < pvLength[1]; j++) pvTable[j] = pvTable[MAX_PLY + j];
        pvLength[0] = j;
      }
    }
  }

  // No legal move at the root: distinguish checkmate from stalemate. Without
  // this the score stays at -INF, which is neither a legal UCI score nor a
  // correct game result.
  if (res.legal == 0) res.score = attacked(kingSq[side], side ^ 1) ? -MATE : 0;

  return res;
}

struct RootLine {
  uint32_t move = 0;
  int score = -INF;
  vector<int> pv;
};

// MultiPV root. Each move is searched with a window whose lower bound is the
// score of the current Nth best line, so a move's score is exact whenever it
// can enter the reported set, and moves that cannot are abandoned cheaply.
// Only the top nLines lines are kept; scores below the cut are bounds, which
// is what UCI MultiPV requires.
static vector<RootLine> rootSearchMulti(int depth, int nLines, const vector<RootLine>& prev) {
  const int n = generateMoves(0, false);
  for (int i = 0; i < n; i++) {
    const uint32_t mv = moveBuf[i];
    int sc = moveScore(mv, 0, 0, 0);
    for (int k = 0; k < (int)prev.size(); k++) {
      if (prev[(size_t)k].move == mv) { sc = (1 << 29) - k; break; }
    }
    scoreBuf[i] = sc;
  }

  vector<RootLine> found;
  int alphaN = -INF;
  for (int i = 0; i < n; i++) {
    const uint32_t mv = pickMove(0, n, i);
    makeMove(mv);
    if (attacked(kingSq[side ^ 1], side)) { unmakeMove(mv); continue; }
    moveStack[0] = mv;

    const int sc = -negamax(depth - 1, -INF, -alphaN, 1, true);
    const int pvLen = pvLength[1];
    unmakeMove(mv);
    if (searchStop) break;
    if ((int)found.size() >= nLines && sc <= alphaN) continue;

    RootLine rl;
    rl.move = mv;
    rl.score = sc;
    rl.pv.push_back((int)mv);
    for (int j = 1; j < pvLen; j++) rl.pv.push_back(pvTable[MAX_PLY + j]);
    size_t pos = 0;
    while (pos < found.size() && found[pos].score >= sc) pos++;
    found.insert(found.begin() + (long)pos, rl);
    if ((int)found.size() > nLines) found.pop_back();
    if ((int)found.size() == nLines) alphaN = found.back().score;
  }
  return found;
}

static string scoreToUci(int sc) {
  auto ceilDiv2 = [](int v) { return v >= 0 ? (v + 1) / 2 : -((-v + 1) / 2); };
  if (sc > MATE - 1000) return "mate " + to_string(ceilDiv2(MATE - sc));
  if (sc < -MATE + 1000) return "mate " + to_string(-ceilDiv2(MATE + sc));
  return "cp " + to_string(sc);
}

static string moveToStr(uint32_t mv) {
  const int from = mv & 127;
  const int to = (mv >> 7) & 127;
  const int promo = (mv >> 14) & 7;
  string s;
  s += (char)('a' + (from & 7));
  s += (char)('1' + (from >> 4));
  s += (char)('a' + (to & 7));
  s += (char)('1' + (to >> 4));
  if (promo) s += "..nbrq"[promo];
  return s;
}

struct SearchOpts {
  i64 movetime = 0;
  i64 wtime = -1, btime = -1;
  i64 winc = 0, binc = 0;
  int movestogo = 0;
  int depth = 0;
  u64 nodeBudget = 0;
  int multiPv = 1;
  bool infinite = false;
  bool ponder = false;
};

struct SearchResult {
  uint32_t bestMove = 0;
  string bestMoveStr;
  int score = 0;
  int depth = 0;
  u64 nodes = 0;
  i64 time = 0;
  vector<string> pv;
};

// Ponder state: while a ponder search is running, ponderActive is true and
// ponderOpts carries the clock arguments from the `go ponder` command. On
// `ponderhit` the limits are recomputed for a normal search on the current
// position instead of restarting it, so the work spent pondering is not
// thrown away.
static bool ponderActive = false;
static SearchOpts ponderOpts;

static mutex outMutex;

static void emitInfo(const string& line) {
  lock_guard<mutex> lock(outMutex);
  printf("%s\n", line.c_str());
  fflush(stdout);
}

// Shared clock budget calculation for both a normal `go` and the `ponderhit`
// conversion. moveAlloc is set to the per-move allocation by the caller.
static void clockBudget(const SearchOpts& opts, i64 started, i64& hard, i64& soft, i64& alloc) {
  if (opts.movetime) {
    hard = started + opts.movetime;
    soft = hard;
    // Soft-stop heuristic deliberately not applied to movetime-limited
    // searches: the budget is too small to stop safely on a stable PV,
    // and stopping early costs more than the saved milliseconds.
    alloc = 0;
    return;
  }
  if (opts.wtime >= 0) {
    const i64 t = side == WHITE ? opts.wtime : opts.btime;
    const i64 inc = side == WHITE ? opts.winc : opts.binc;
    const i64 usable = max((i64)10, t - moveOverhead);
    const i64 mtg = opts.movestogo > 0 ? opts.movestogo : 50;
    const i64 reserve = min((i64)150, max((i64)30, usable / 50));
    const i64 budget = max((i64)10, usable - reserve);
    alloc = (i64)floor((double)usable / (double)mtg + (double)inc * 0.6);
    alloc = min(alloc, usable / 2);
    alloc = max((i64)10, min(alloc, budget));
    soft = started + alloc;
    hard = started + min(budget, (i64)floor(alloc * 1.5));
    return;
  }
  if (opts.infinite || opts.ponder) { hard = started + 20000; soft = hard; alloc = 0; return; }
  if (opts.depth) { hard = INT64_MAX; soft = INT64_MAX; alloc = 0; return; }
  hard = started + 1000;
  soft = hard;
  alloc = 1000;
}

static SearchResult search(const SearchOpts& rawOpts) {
  SearchOpts opts = rawOpts;
  const i64 started = nowMs();
  const int maxDepth = min(opts.depth ? opts.depth : MAX_PLY - 1, MAX_PLY - 2);

  i64 hard = INT64_MAX, soft = INT64_MAX, allocLocal = 0;
  clockBudget(opts, started, hard, soft, allocLocal);
  moveAlloc.store(allocLocal, memory_order_relaxed);

  hardStop = hard;
  softStop = soft;
  nodeLimit = opts.nodeBudget;
  searchStop = false;
  nodes = 0;
  rootPrevBest = 0;
  rootBest = 0;
  rootScore = 0;
  rootDepth = 0;
  memset(pvLength, 0, sizeof(pvLength));
  memset(killers, 0, sizeof(killers));
  for (int i = 0; i < 2 * 128 * 128; i++) history[i] >>= 1;

  // The root can already be a claimable draw. Answer immediately with score 0,
  // but only when a legal move exists: checkmate/stalemate take precedence and
  // are handled by the normal root search below. A threefold claim requires
  // three occurrences, not merely one earlier repetition.
  if (halfmove >= 100 || isThreefold() || insufficientMaterial()) {
    const int n = generateMoves(0, false);
    for (int i = 0; i < n; i++) {
      const uint32_t mv = moveBuf[i];
      makeMove(mv);
      const bool legal = !attacked(kingSq[side ^ 1], side);
      unmakeMove(mv);
      if (legal) {
        SearchResult drawn;
        drawn.bestMove = mv;
        drawn.bestMoveStr = moveToStr(mv);
        drawn.score = 0;
        drawn.depth = 1;
        drawn.nodes = 0;
        drawn.time = nowMs() - started;
        drawn.pv.push_back(drawn.bestMoveStr);
        if (threadId == 0) {
          ostringstream line;
          line << "info depth 1 score cp 0 nodes 0 nps 0 time " << drawn.time
               << " pv " << drawn.bestMoveStr;
          emitInfo(line.str());
        }
        return drawn;
      }
    }
  }

  SearchResult out;
  int prevScore = 0;
  uint32_t prevIterMove = 0;
  int stable = 0;
  const int nLines = min(8, max(1, opts.multiPv));
  vector<RootLine> prevLines;
  vector<string> lastPv;

  for (int d = 1; d <= maxDepth; d++) {
    const i64 iterStart = nowMs();

    if (nLines > 1) {
      vector<RootLine> lines = rootSearchMulti(d, nLines, prevLines);
      if (searchStop) break;
      if (lines.empty()) {
        rootScore = attacked(kingSq[side], side ^ 1) ? -MATE : 0;
        rootBest = 0;
        rootDepth = 1;
        if (threadId == 0) {
          const i64 elapsed = max((i64)1, nowMs() - started);
          ostringstream line;
          line << "info depth 1 score " << scoreToUci(rootScore)
               << " nodes " << nodes
               << " nps " << (nodes * 1000 / (u64)elapsed)
               << " time " << elapsed;
          emitInfo(line.str());
        }
        break;
      }
      prevLines = lines;
      prevScore = lines[0].score;
      rootBest = (int)lines[0].move;
      rootScore = lines[0].score;
      rootDepth = d;
      rootPrevBest = rootBest;
      lastPv.clear();
      for (int m : lines[0].pv) lastPv.push_back(moveToStr((uint32_t)m));

      if (threadId == 0) {
        const i64 elapsed = max((i64)1, nowMs() - started);
        for (int k = 0; k < (int)lines.size(); k++) {
          ostringstream line;
          line << "info depth " << d << " multipv " << (k + 1)
               << " score " << scoreToUci(lines[(size_t)k].score)
               << " nodes " << nodes
               << " nps " << (nodes * 1000 / (u64)elapsed)
               << " time " << elapsed << " pv";
          for (int m : lines[(size_t)k].pv) line << " " << moveToStr((uint32_t)m);
          emitInfo(line.str());
        }
      }

      if (abs(rootScore) > MATE - 100) break;
      const i64 elapsed = nowMs() - started;
      if (nowMs() >= softStop) break;
      if (moveAlloc && elapsed >= moveAlloc * 55 / 100) break;
      if (moveAlloc && elapsed + (nowMs() - iterStart) * 16 / 10 >= moveAlloc) break;
      continue;
    }

    RootResult res;
    if (d >= 5 && abs(prevScore) < MATE - 100) {
      int delta = 40;
      int alpha = prevScore - delta;
      int beta = prevScore + delta;
      for (;;) {
        res = rootSearch(d, alpha, beta);
        if (searchStop || res.legal == 0) break;
        if (abs(res.score) > MATE - 100) {
          res = rootSearch(d, -INF, INF);
          break;
        }
        if (res.score <= alpha) {
          delta *= 2;
          alpha = max(-INF, res.score - delta);
        } else if (res.score >= beta) {
          delta *= 2;
          beta = min(INF, res.score + delta);
        } else {
          break;
        }
      }
    } else {
      res = rootSearch(d, -INF, INF);
    }
    if (searchStop && d > 1) break;
    if (res.legal == 0) {
      // A time-out can also leave legal == 0 after an interrupted first move,
      // so verify that the position really has no legal move before treating
      // it as terminal.
      bool anyLegal = false;
      const int nRoot = generateMoves(0, false);
      for (int i = 0; i < nRoot && !anyLegal; i++) {
        const uint32_t mv = moveBuf[i];
        makeMove(mv);
        anyLegal = !attacked(kingSq[side ^ 1], side);
        unmakeMove(mv);
      }
      if (!anyLegal) {
        // Checkmate or stalemate: report the terminal score, then 0000.
        rootScore = res.score;
        rootBest = 0;
        rootDepth = 1;
        if (threadId == 0) {
          const i64 elapsed = max((i64)1, nowMs() - started);
          ostringstream line;
          line << "info depth 1 score " << scoreToUci(res.score)
               << " nodes " << nodes
               << " nps " << (nodes * 1000 / (u64)elapsed)
               << " time " << elapsed;
          emitInfo(line.str());
        }
      }
      break;
    }
    prevScore = res.score;
    rootBest = (int)res.move;
    rootScore = res.score;
    rootDepth = d;
    rootPrevBest = (int)res.move;

    lastPv.clear();
    for (int i = 0; i < pvLength[0]; i++) lastPv.push_back(moveToStr((uint32_t)pvTable[i]));

    if (res.move == prevIterMove) stable++; else stable = 0;
    prevIterMove = res.move;

    {
      const i64 elapsed = max((i64)1, nowMs() - started);
      ostringstream line;
      line << "info depth " << d << " score " << scoreToUci(res.score)
           << " nodes " << nodes
           << " nps " << (nodes * 1000 / (u64)elapsed)
           << " time " << elapsed << " pv";
      for (auto& m : lastPv) line << " " << m;
      if (threadId == 0) emitInfo(line.str());
    }

    if (abs(res.score) > MATE - 100) break;
    if (searchStop) break;
    const i64 elapsed = nowMs() - started;
    if (nowMs() >= softStop) break;
    if (moveAlloc && stable >= 2 && elapsed >= moveAlloc * 55 / 100) break;
    if (moveAlloc && elapsed + (nowMs() - iterStart) * 16 / 10 >= moveAlloc) break;
  }

  // Never return a null move when a legal move exists.
  if (!rootBest) {
    const int n = generateMoves(0, false);
    for (int i = 0; i < n; i++) {
      const uint32_t mv = moveBuf[i];
      makeMove(mv);
      const bool legal = !attacked(kingSq[side ^ 1], side);
      unmakeMove(mv);
      if (legal) {
        rootBest = (int)mv;
        if (rootDepth == 0) rootDepth = 1;
        break;
      }
    }
  }

  out.bestMove = (uint32_t)rootBest;
  out.bestMoveStr = rootBest ? moveToStr((uint32_t)rootBest) : "0000";
  out.score = rootScore;
  out.depth = rootDepth;
  out.nodes = nodes;
  out.time = nowMs() - started;
  out.pv = lastPv;
  return out;
}

// ---------------------------------------------------------------------------
// Perft
// ---------------------------------------------------------------------------

static u64 perft(int depth) {
  if (depth == 0) return 1;
  const int n = generateMoves(0, false);
  uint32_t moves[MAX_MOVES];
  // Copy because recursive calls reuse moveBuf at base 0.
  for (int i = 0; i < n; i++) moves[i] = moveBuf[i];
  u64 total = 0;
  for (int i = 0; i < n; i++) {
    makeMove(moves[i]);
    if (!attacked(kingSq[side ^ 1], side)) total += perft(depth - 1);
    unmakeMove(moves[i]);
  }
  return total;
}

// ---------------------------------------------------------------------------
// UCI
// ---------------------------------------------------------------------------

static void printBoard() {
  string out;
  for (int r = 7; r >= 0; r--) {
    for (int f = 0; f < 8; f++) {
      const int p = board[r * 16 + f];
      char c = '.';
      if (p) {
        const char* white = " PNBRQK";
        const char* black = " pnbrqk";
        c = (p >> 3) == WHITE ? white[p & 7] : black[p & 7];
      }
      out += c;
      out += ' ';
    }
    out += '\n';
  }
  out += side == WHITE ? "white to move" : "black to move";
  emitInfo(out);
}

static bool applyUciMove(const string& mvStr) {
  const int n = generateMoves(0, false);
  for (int i = 0; i < n; i++) {
    const uint32_t mv = moveBuf[i];
    if (moveToStr(mv) == mvStr) {
      makeMove(mv);
      return true;
    }
  }
  return false;
}

// Each search thread has its own board, so replay the game in that thread's
// state before searching. This preserves castling, en passant, repetition and
// the fifty-move counter exactly as the main thread sees them.
static void prepareThreadPosition(const string& fen, const vector<string>& moves) {
  setFen(fen);
  for (const string& mv : moves) applyUciMove(mv);
}

// ---------------------------------------------------------------------------
// Opening book (generated from book.js by test/gen-native-book.js)
// ---------------------------------------------------------------------------

static uint64_t bookHash(const string& s) {
  uint64_t h = 14695981039346656037ULL;
  for (unsigned char c : s) {
    h ^= (uint64_t)c;
    h *= 1099511628211ULL;
  }
  return h;
}

// Same key as book.js: FEN board + side + castling, with no en-passant field.
static string bookPositionKey() {
  string s;
  static const char* pieceChars = " PNBRQK";
  for (int r = 7; r >= 0; r--) {
    int empty = 0;
    for (int f = 0; f < 8; f++) {
      const int p = board[r * 16 + f];
      if (!p) { empty++; continue; }
      if (empty) { s += (char)('0' + empty); empty = 0; }
      const char c = pieceChars[p & 7];
      s += ((p >> 3) == WHITE) ? c : (char)tolower((unsigned char)c);
    }
    if (empty) s += (char)('0' + empty);
    if (r) s += '/';
  }
  s += side == WHITE ? " w " : " b ";
  if (!castling) s += '-';
  else {
    if (castling & 1) s += 'K';
    if (castling & 2) s += 'Q';
    if (castling & 4) s += 'k';
    if (castling & 8) s += 'q';
  }
  return s;
}

static bool parseBoolValue(const string& v) {
  string s = v;
  for (char& c : s) c = (char)tolower((unsigned char)c);
  return s == "true" || s == "1" || s == "on" || s == "yes";
}

// The generated book keeps a sound group of first moves. Personalities narrow
// that group: only Surprise deliberately plays sound offbeat first moves, and
// Gambit sticks to open/double-queen-pawn starts where real gambits live.
static bool rootMoveAllowed(uint32_t mv, int style) {
  const int from = mv & 127, to = (mv >> 7) & 127;
  auto is = [&](int f, int t) { return from == f && to == t; };
  const bool e4 = is(20, 52), d4 = is(19, 51), c4 = is(18, 50), nf3 = is(6, 37);
  if (style == BOOK_SURPRISE) {
    return e4 || d4 || c4 || nf3 ||
           is(17, 33) || // b3
           is(22, 38) || // g3
           is(17, 49) || // b4
           is(21, 53) || // f4
           is(1, 34);    // Nc3
  }
  if (style == BOOK_GAMBIT) return e4 || d4;
  return e4 || d4 || c4 || nf3;
}

// A quick, silent search used to sanity-check a book line before playing it.
// It uses the normal search (TT and pruning included) with a small node budget
// so it cannot stall the move; threadId -1 suppresses info output.
static int silentScore(int budget) {
  const int savedThread = threadId;
  threadId = -1;
  SearchOpts o;
  o.nodeBudget = (u64)budget;
  o.depth = 8;
  SearchResult r = search(o);
  threadId = savedThread;
  return r.score;
}

static int bookCandidateScore(uint32_t mv, int budget) {
  makeMove(mv);
  const int score = -silentScore(budget);
  unmakeMove(mv);
  return score;
}

static uint32_t bookPick() {
  if (!ownBook || !bookAllowed || bookDepthPlies <= 0) return 0;
  if (histLen - 1 >= bookDepthPlies) return 0;

  const uint64_t h = bookHash(bookPositionKey());
  uint32_t lo = 0, hi = bookdata::ENTRY_COUNT;
  while (lo < hi) {
    const uint32_t mid = (lo + hi) / 2;
    if (bookdata::ENTRIES[mid].key < h) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= bookdata::ENTRY_COUNT || bookdata::ENTRIES[lo].key != h) return 0;
  const bookdata::Entry& entry = bookdata::ENTRIES[lo];

  // Resolve book moves to full legal encodings, keeping both the balanced
  // weight and the weight of the selected personality.
  struct Cand { uint32_t mv; int w; int wb; };
  Cand cands[64];
  int cn = 0, styleTotal = 0;
  const int legalN = generateMoves(0, false);
  for (uint32_t i = 0; i < entry.count; i++) {
    const bookdata::Move& bm = bookdata::MOVES[entry.offset + i];
    const int bf = bm.move & 127, bt = (bm.move >> 7) & 127, bp = (bm.move >> 14) & 7;
    for (int j = 0; j < legalN; j++) {
      const uint32_t mv = moveBuf[j];
      if ((mv & 127) == bf && ((mv >> 7) & 127) == bt && ((mv >> 14) & 7) == bp) {
        if (cn < 64) {
          cands[cn].mv = mv;
          cands[cn].w = bm.w[bookStyle];
          cands[cn].wb = bm.w[BOOK_BALANCED] ? bm.w[BOOK_BALANCED] : 1;
          cn++;
        }
        break;
      }
    }
  }
  if (!cn) return 0;

  // Drop anything illegal in the live position (a stored ep move, for example).
  for (int i = 0; i < cn; i++) {
    makeMove(cands[i].mv);
    const bool legal = !attacked(kingSq[side ^ 1], side);
    unmakeMove(cands[i].mv);
    if (!legal) {
      cands[i].w = 0;
      cands[i].wb = 0;
    }
  }

  // The first move must remain a real repertoire choice for the personality.
  if (histLen == 1) {
    for (int i = 0; i < cn; i++) {
      if (!rootMoveAllowed(cands[i].mv, bookStyle)) {
        cands[i].w = 0;
        cands[i].wb = 0;
      }
    }
  }

  for (int i = 0; i < cn; i++) styleTotal += cands[i].w;
  const bool fallback = styleTotal <= 0;
  int maxW = 0;
  for (int i = 0; i < cn; i++) {
    if (fallback) cands[i].w = cands[i].wb;
    if (cands[i].w > maxW) maxW = cands[i].w;
  }
  if (maxW <= 0) return 0;

  // Variety 0 keeps only the most popular book move; 100 keeps every named
  // continuation, still weighted toward the personality's main lines.
  const int cutoff = (int)((i64)maxW * (100 - bookVariety) / 100);
  for (int i = 0; i < cn; i++) {
    if (cands[i].w < cutoff) cands[i].w = 0;
  }

  BookMemorySide& mem = bookMem[side];
  const double factor = 1.0 + 0.015 * bookDiversity;
  int adj[64] = {0};
  int total = 0;
  for (int i = 0; i < cn; i++) {
    if (cands[i].w <= 0) continue;
    if (bookDiversity > 0) {
      int reps = 0;
      const u64 mk = h ^ ((u64)cands[i].mv * 0x9E3779B97F4A7C15ULL);
      auto mit = mem.moves.find(mk);
      if (mit != mem.moves.end()) reps += mit->second;
      makeMove(cands[i].mv);
      const u64 rk = bookHash(bookPositionKey());
      unmakeMove(cands[i].mv);
      auto rit = mem.results.find(rk);
      if (rit != mem.results.end()) reps += rit->second;
      if (reps > 0) {
        double penalty = 1.0;
        for (int k = 0; k < reps && penalty < 1e6; k++) penalty *= factor;
        adj[i] = (int)max(1.0, floor((double)cands[i].w / penalty));
      } else {
        adj[i] = cands[i].w;
      }
    } else {
      adj[i] = cands[i].w;
    }
    total += adj[i];
  }
  if (total <= 0) {
    // Every candidate was filtered; keep the best book move rather than
    // dropping the book entirely.
    for (int i = 0; i < cn; i++) if (cands[i].w > 0) return cands[i].mv;
    return 0;
  }

  int r = (int)(bookRng() % (u64)total);
  int chosenIdx = -1;
  for (int i = 0; i < cn; i++) {
    if (adj[i] <= 0) continue;
    if (r < adj[i]) { chosenIdx = i; break; }
    r -= adj[i];
  }
  if (chosenIdx < 0) {
    for (int i = 0; i < cn; i++) if (adj[i] > 0) { chosenIdx = i; break; }
  }
  if (chosenIdx < 0) return 0;

  // Search-check lines that look questionable: rare book continuations, and
  // in the sharp personalities any non-main choice. A clearly worse move is
  // dropped in favour of the most popular remaining book move. The margins
  // are deliberately generous for gambits: a sound sacrifice can evaluate
  // below a quiet line without being a mistake.
  const int ply = histLen - 1;
  const bool sharp = bookStyle == BOOK_AGGRESSIVE || bookStyle == BOOK_GAMBIT ||
                     bookStyle == BOOK_SURPRISE;
  const bool questionable = sharp
      ? (cands[chosenIdx].w * 100 < maxW * 55)
      : (cands[chosenIdx].w * 100 < maxW * 35);
  if (ply >= 2 && ply <= 10 && questionable) {
    const int budget = 5000;
    const int rootScore = silentScore(budget);
    const int candScore = bookCandidateScore(cands[chosenIdx].mv, budget);
    int margin = 120;
    if (bookStyle == BOOK_GAMBIT) margin = 300;
    else if (bookStyle == BOOK_AGGRESSIVE) margin = 200;
    else if (bookStyle == BOOK_SURPRISE) margin = 180;
    if (candScore < rootScore - margin) {
      int alt = -1;
      for (int i = 0; i < cn; i++) {
        if (i == chosenIdx || adj[i] <= 0) continue;
        if (alt < 0 || cands[i].w > cands[alt].w) alt = i;
      }
      if (alt < 0) return 0; // no book move survived: let the search answer
      chosenIdx = alt;
    }
  }

  const uint32_t chosen = cands[chosenIdx].mv;

  // Remember what was played, under the side that chose it.
  makeMove(chosen);
  const u64 resultKey = bookHash(bookPositionKey());
  unmakeMove(chosen);
  bumpBookCount(mem.moves, h ^ ((u64)chosen * 0x9E3779B97F4A7C15ULL));
  bumpBookCount(mem.results, resultKey);
  return chosen;
}

static const char* START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
static string gameFen = START_FEN;
static vector<string> gameMoves;

// ---------------------------------------------------------------------------
// Texel tuning (hidden diagnostic, not part of the UCI surface)
// ---------------------------------------------------------------------------

// One dataset sample: FEN string + Stockfish cp from the side to move.
struct TexelSample {
  string fen;
  int cp;
};

static double texelSigmoid(double x) { return 1.0 / (1.0 + exp(-x)); }

static double texelLoss(const vector<TexelSample>& data, const vector<int>& idx) {
  double s = 0.0;
  for (const int i : idx) {
    setFen(data[(size_t)i].fen);
    const int ev = evaluate();
    const double d = texelSigmoid(ev / 400.0) - texelSigmoid(data[(size_t)i].cp / 400.0);
    s += d * d;
  }
  return s / (double)idx.size();
}

static void runTexelBench(const string& file, int maxEpochs, int subsetSize) {
  ifstream in(file);
  if (!in) { emitInfo("info string tunebench: cannot open " + file); return; }
  vector<TexelSample> data;
  string line;
  while (getline(in, line)) {
    const size_t tab = line.find('\t');
    if (tab == string::npos) continue;
    TexelSample s;
    s.fen = line.substr(0, tab);
    s.cp = atoi(line.c_str() + tab + 1);
    data.push_back(std::move(s));
  }
  if (data.empty()) { emitInfo("info string tunebench: no samples"); return; }

  // 90/10 split: tune on the train view, report on validation.
  vector<int> trainIdx, valIdx;
  for (size_t i = 0; i < data.size(); i++) {
    if (i % 10 == 9) valIdx.push_back((int)i); else trainIdx.push_back((int)i);
  }
  // Sub-sample the training view for the per-parameter sweeps.
  if ((int)trainIdx.size() > subsetSize) {
    mt19937_64 rng(20240517);
    std::vector<int> pick(trainIdx.begin(), trainIdx.end());
    std::shuffle(pick.begin(), pick.end(), rng);
    pick.resize((size_t)subsetSize);
    trainIdx.swap(pick);
  }

  texelTuning = true;
  const i64 t0 = nowMs();
  double best = texelLoss(data, trainIdx);
  double valBest = texelLoss(data, valIdx);
  ostringstream hdr;
  hdr << "info string tunebench: " << data.size() << " samples, train "
      << trainIdx.size() << " val " << valIdx.size()
      << " loss " << best << " val " << valBest;
  emitInfo(hdr.str());

  int step = 4;  // global step; halved when a full pass no longer improves
  int epoch = 0;
  while (epoch < maxEpochs) {
    bool improved = false;
    for (int p = 0; p < TUNE_PARAM_COUNT; p++) {
      const int base = TUNE[p];
      const int stepFor = max(1, min(12, abs(base) / 5 + 1)) * step / 4 + 1;
      const int limLo = TUNE_DEFAULT[p] - max(3, (int)(abs(TUNE_DEFAULT[p]) / 2));
      const int limHi = TUNE_DEFAULT[p] + max(3, (int)(abs(TUNE_DEFAULT[p]) / 2));
      for (int dir = -1; dir <= 1; dir += 2) {
        const int candidate = base + dir * stepFor;
        if (candidate < limLo || candidate > limHi) continue;
        TUNE[p] = candidate;
        syncTuneArrays();
        const double l = texelLoss(data, trainIdx);
        if (l < best) {
          best = l;
          improved = true;
          ostringstream msg;
          msg << "info string tunebench epoch " << epoch << " " << TUNE_NAMES[p]
              << " " << base << " -> " << TUNE[p] << " loss " << best;
          emitInfo(msg.str());
          goto param_done;
        }
      }
      TUNE[p] = base;
      syncTuneArrays();
  param_done:
      (void)0;
    }
    if (!improved) {
      if (step <= 1) break;
      step = max(1, step / 2);
      ostringstream msg;
      msg << "info string tunebench: no improvement, step now " << step;
      emitInfo(msg.str());
    }
    const double val = texelLoss(data, valIdx);
    if (val < valBest) valBest = val;
    ostringstream pass;
    pass << "info string tunebench pass " << epoch << " loss " << best << " val " << val;
    emitInfo(pass.str());
    epoch++;
  }
  texelTuning = false;

  emitInfo("info string tunebench result:");
  for (int p = 0; p < TUNE_PARAM_COUNT; p++) {
    ostringstream row;
    row << "info string tune " << TUNE_NAMES[p] << " " << TUNE[p];
    emitInfo(row.str());
  }
  ostringstream fin;
  fin << "info string tunebench done epochs=" << epoch << " trainLoss " << best
      << " valLoss " << valBest << " time " << (nowMs() - t0) << "ms";
  emitInfo(fin.str());
}

int main(int argc, char** argv) {
  initTables();
  syncTuneArrays();
  nnueLoaded = nnueLoadNet();
  for (int d = 0; d < MAX_PLY; d++) {
    for (int m = 0; m < MAX_MOVES; m++) {
      if (d < 3) { LMR[d][m] = 0; continue; }
      const int r = (int)floor(0.75 + log((double)d) * log((double)max(1, m)) / 2.2);
      LMR[d][m] = r < 1 ? 1 : r;
    }
  }
  setFen(START_FEN);
  resizeTT(hashMB);

  // Optional one-shot modes: `kiwa-native perft <d>` / `kiwa-native bench`
  if (argc >= 2) {
    if (string(argv[1]) == "perft" && argc >= 3) {
      const u64 t0 = (u64)nowMs();
      const u64 n = perft(atoi(argv[2]));
      printf("%llu nodes  %lld ms\n", (unsigned long long)n, (long long)(nowMs() - (i64)t0));
      return 0;
    }
    if (string(argv[1]) == "bench") {
      clearTT();
      SearchOpts o;
      o.depth = 12;
      const i64 c0 = cpuMs();
      SearchResult r = search(o);
      const i64 cpu = max((i64)1, cpuMs() - c0);
      printf("bestmove %s  score %s  depth %d  nodes %llu  time %lldms  nps %llu"
             "  cpu %lldms  cpunps %llu  extras %llu/%llu\n",
             r.bestMoveStr.c_str(), scoreToUci(r.score).c_str(), r.depth,
             (unsigned long long)r.nodes, (long long)r.time,
             (unsigned long long)(r.nodes * 1000 / (u64)max((i64)1, r.time)),
             (long long)cpu,
             (unsigned long long)(r.nodes * 1000 / (u64)cpu),
             (unsigned long long)exMisses, (unsigned long long)exCalls);
      return 0;
    }
  }

  string line;
  thread searchThread;
  auto stopSearch = [&]() {
    abortFlag.store(true);
    if (searchThread.joinable()) searchThread.join();
    abortFlag.store(false);
    ponderActive = false;
  };

  while (getline(cin, line)) {
    istringstream iss(line);
    string cmd;
    iss >> cmd;
    if (cmd.empty()) continue;

    if (cmd == "uci") {
      emitInfo("id name FroostRook 1.0.3 Beta");
      emitInfo("id author ziyyhhk");
      emitInfo("id string core C++ native");
      emitInfo("option name Threads type spin default 1 min 1 max 8");
      emitInfo("option name Hash type spin default 64 min 1 max 512");
      emitInfo("option name MultiPV type spin default 1 min 1 max 8");
      emitInfo("option name OwnBook type check default true");
      emitInfo("option name Book Depth type spin default 24 min 0 max 60");
      emitInfo("option name Book Variety type spin default 100 min 0 max 100");
      emitInfo("option name Book Style type combo default Balanced var Balanced var Mainline var Aggressive var Positional var Solid var Gambit var Surprise");
      emitInfo("option name Opening Diversity type spin default 50 min 0 max 100");
      emitInfo("option name Random Seed type spin default 0 min 0 max 2147483647");
      emitInfo("option name Clear Book Memory type button");
      emitInfo("option name Move Overhead type spin default 30 min 0 max 1000");
      emitInfo("option name Clear Hash type button");
      if (nnueLoaded) emitInfo("option name NNUE type check default false");
      emitInfo("uciok");
    } else if (cmd == "setoption") {
      // setoption name <name, spaces allowed> [value <value>]
      // A button is sent as `setoption name X`, and some GUIs append a bare
      // `value` with nothing after it. Without the second form the word "value"
      // would stay inside the name and the option would be silently ignored.
      size_t np = line.find("name ");
      size_t vp = line.find(" value ");
      if (vp == string::npos) {
        const string suffix = " value";
        if (line.size() >= suffix.size() &&
            line.compare(line.size() - suffix.size(), suffix.size(), suffix) == 0) {
          vp = line.size() - suffix.size();
        }
      }
      if (np != string::npos) {
        string name = line.substr(np + 5, vp == string::npos ? string::npos : vp - (np + 5));
        string value = vp == string::npos ? "" : line.substr(vp + 7);
        size_t b = name.find_first_not_of(" \t");
        size_t e = name.find_last_not_of(" \t");
        name = b == string::npos ? "" : name.substr(b, e - b + 1);
        for (char& c : name) c = (char)tolower((unsigned char)c);
        b = value.find_first_not_of(" \t");
        e = value.find_last_not_of(" \t");
        value = b == string::npos ? "" : value.substr(b, e - b + 1);

        if (name == "hash") {
          stopSearch();
          resizeTT(atoi(value.c_str()));
        } else if (name == "multipv") {
          multiPvOption = max(1, min(8, atoi(value.c_str())));
        } else if (name == "clear hash") {
          stopSearch();
          clearTT();
        } else if (name == "move overhead") {
          moveOverhead = max(0, min(1000, atoi(value.c_str())));
        } else if (name == "ownbook") {
          ownBook = parseBoolValue(value);
        } else if (name == "book depth") {
          bookDepthPlies = max(0, min(60, atoi(value.c_str())));
        } else if (name == "book variety") {
          bookVariety = max(0, min(100, atoi(value.c_str())));
        } else if (name == "book style") {
          bookStyle = parseBookStyle(value);
        } else if (name == "opening diversity") {
          bookDiversity = max(0, min(100, atoi(value.c_str())));
        } else if (name == "random seed") {
          randomSeed = max((i64)0, (i64)atoll(value.c_str()));
          bookRng.seed(makeBookSeed());
        } else if (name == "clear book memory") {
          clearBookMemory();
        } else if (name == "threads") {
          threads = max(1, min(8, atoi(value.c_str())));
        } else if (name == "nnue") {
          nnueEnabled.store(parseBoolValue(value), memory_order_relaxed);
        }
      }
    } else if (cmd == "isready") {
      emitInfo("readyok");
    } else if (cmd == "ucinewgame") {
      stopSearch();
      clearTT();
      // Opening memory deliberately survives a new game. Ageing the counts
      // keeps recent games strongest instead of locking the repertoire.
      ageBookMemory();
      setFen(START_FEN);
      gameFen = START_FEN;
      gameMoves.clear();
      bookAllowed = false;
    } else if (cmd == "position") {
      stopSearch();
      string kind;
      iss >> kind;
      string fen;
      bookAllowed = kind == "startpos";
      if (kind == "startpos") {
        fen = START_FEN;
      } else if (kind == "fen") {
        string part;
        for (int i = 0; i < 6 && iss >> part; i++) fen += part + (i < 5 ? " " : "");
      }
      setFen(fen);
      gameFen = fen;
      gameMoves.clear();
      string token;
      while (iss >> token) {
        if (token == "moves") {
          string mvStr;
          while (iss >> mvStr) {
            if (applyUciMove(mvStr)) gameMoves.push_back(mvStr);
            else fprintf(stderr, "illegal move ignored: %s\n", mvStr.c_str());
          }
        } else if (token == "ponder") {
          // UCI pondering: predict the opponent's next move. The engine
          // searches the resulting position on `go ponder`; the move is not
          // claimed as part of the real game (repetition/undo is unaffected).
          string mvStr;
          if (iss >> mvStr) {
            if (applyUciMove(mvStr)) gameMoves.push_back(mvStr);
            else fprintf(stderr, "illegal ponder move %s ignored\n", mvStr.c_str());
          }
        }
      }
    } else if (cmd == "go") {
      stopSearch();
      SearchOpts o;
      string token;
      while (iss >> token) {
        if (token == "wtime") iss >> o.wtime;
        else if (token == "btime") iss >> o.btime;
        else if (token == "winc") iss >> o.winc;
        else if (token == "binc") iss >> o.binc;
        else if (token == "movestogo") iss >> o.movestogo;
        else if (token == "depth") iss >> o.depth;
        else if (token == "nodes") iss >> o.nodeBudget;
        else if (token == "movetime") iss >> o.movetime;
        else if (token == "infinite") o.infinite = true;
        else if (token == "ponder") o.ponder = true;
      }
      // Book replies are instant. Explicit depth/node/infinite searches and
      // MultiPV are analysis requests, so the book stays out of those.
      o.multiPv = multiPvOption;
      if (ownBook && bookAllowed && !o.depth && !o.nodeBudget && !o.infinite &&
          !o.ponder && multiPvOption <= 1) {
        const uint32_t bm = bookPick();
        if (bm) {
          const string mv = moveToStr(bm);
          emitInfo("info depth 1 score cp 15 nodes 1 time 0 pv " + mv);
          emitInfo("bestmove " + mv);
          continue;
        }
      }
      if (searchThread.joinable()) searchThread.join();
      abortFlag.store(false);
      const string fen = gameFen;
      const vector<string> moves = gameMoves;
      // Track ponder state for ponderhit: `go ponder` arms it, any other go
      // (or ponderhit itself) disarms it.
      ponderActive = o.ponder;
      ponderOpts = o;
      // MultiPV output is a single ordered list; helper threads would emit
      // competing lines, so MultiPV runs the search on one thread.
      const int nthreads = multiPvOption > 1 ? 1 : threads;
      searchThread = thread([o, fen, moves, nthreads]() {
        if (nthreads <= 1) {
          threadId = 0;
          prepareThreadPosition(fen, moves);
          SearchResult r = search(o);
          lock_guard<mutex> lock(outMutex);
          printf("bestmove %s\n", r.bestMoveStr.c_str());
          fflush(stdout);
          return;
        }

        // Lazy SMP: every thread searches the same root on its own board
        // copy, all sharing one transposition table. Helpers perturb only
        // the root move order (so they diverge enough to add nodes) and
        // feed the shared table; the reported bestmove always comes from
        // thread 0, whose tree benefits from the helpers' stores. Helper
        // threads report no info lines (threadId == 0 gate in search()).
        vector<SearchResult> results((size_t)nthreads);
        vector<thread> pool;
        pool.reserve((size_t)nthreads);
        for (int i = 0; i < nthreads; i++) {
          pool.emplace_back([&, i]() {
            threadId = i;
            prepareThreadPosition(fen, moves);
            results[(size_t)i] = search(o);
          });
        }
        for (auto& t : pool) t.join();

        const SearchResult& best = results[0];

        lock_guard<mutex> lock(outMutex);
        printf("bestmove %s\n", best.bestMoveStr.c_str());
        fflush(stdout);
      });
    } else if (cmd == "stop") {
      abortFlag.store(true);
      if (searchThread.joinable()) searchThread.join();
      abortFlag.store(false);
      ponderActive = false;
    } else if (cmd == "ponderhit") {
      // The predicted move was played: stop pondering on a 20-second cap and
      // continue the same search with the normal clock budget instead of
      // restarting it. Search limits live in shared atomics so the search
      // thread picks them up without being restarted.
      if (ponderActive && searchThread.joinable()) {
        const i64 now = nowMs();
        i64 hard = INT64_MAX, soft = INT64_MAX, alloc = 0;
        clockBudget(ponderOpts, now, hard, soft, alloc);
        nodeLimit.store(ponderOpts.nodeBudget, memory_order_relaxed);
        softStop.store(soft, memory_order_relaxed);
        hardStop.store(hard, memory_order_relaxed);
        moveAlloc.store(alloc, memory_order_relaxed);
        ponderActive = false;
        emitInfo("info string ponderhit: continuing with normal clock budget");
      } else {
        emitInfo("info string ponderhit ignored: no ponder search in progress");
      }
    } else if (cmd == "quit") {
      abortFlag.store(true);
      if (searchThread.joinable()) searchThread.join();
      return 0;
    } else if (cmd == "d") {
      stopSearch();
      printBoard();
    } else if (cmd == "eval") {
      stopSearch();
      emitInfo("info string eval " + to_string(evaluate()) + " cp");
    } else if (cmd == "bookmemory") {
      // Diagnostic requested explicitly by a test or a GUI. Never emitted
      // during a normal search. position_results is the count stored by the
      // side that just moved into the current position, so a transposition
      // reached by another move order reports the same hit.
      stopSearch();
      u64 wm = 0, wr = 0, bm = 0, br = 0;
      for (const auto& e : bookMem[0].moves) wm += e.second;
      for (const auto& e : bookMem[0].results) wr += e.second;
      for (const auto& e : bookMem[1].moves) bm += e.second;
      for (const auto& e : bookMem[1].results) br += e.second;
      const u64 h = bookHash(bookPositionKey());
      const int prev = side ^ 1;
      const auto pr = bookMem[prev].results.find(h);
      u64 posRes = pr == bookMem[prev].results.end() ? 0 : pr->second;
      u64 posMoves = 0;
      const int n = generateMoves(0, false);
      for (int i = 0; i < n; i++) {
        const auto it = bookMem[side].moves.find(h ^ ((u64)moveBuf[i] * 0x9E3779B97F4A7C15ULL));
        if (it != bookMem[side].moves.end()) posMoves += it->second;
      }
      emitInfo("info string book memory white_moves=" + to_string((unsigned long long)wm) +
               " white_results=" + to_string((unsigned long long)wr) +
               " black_moves=" + to_string((unsigned long long)bm) +
               " black_results=" + to_string((unsigned long long)br) +
               " position_results=" + to_string((unsigned long long)posRes) +
               " position_moves=" + to_string((unsigned long long)posMoves));
    } else if (cmd == "nnuecheck") {
      // Hidden diagnostic: compare the incrementally maintained accumulator
      // with a full refresh on the current board. A healthy engine prints 0.
      stopSearch();
      if (!nnueLoaded) {
        emitInfo("info string nnuecheck: no net loaded");
      } else {
        nnue::Accumulator full;
        nnueNet.reset(board, full);
        int bad = 0;
        for (int p = 0; p < 2; p++)
          for (int h = 0; h < nnueNet.h1; h++)
            if (full.v[p][h] != nnueAcc.v[p][h]) bad++;
        emitInfo("info string nnuecheck deltas=" + to_string(bad));
      }
    } else if (cmd == "perft") {
      stopSearch();
      int d = 1;
      iss >> d;
      const i64 t0 = nowMs();
      const u64 n = perft(d);
      emitInfo("perft " + to_string(d) + " " + to_string((unsigned long long)n) + " " + to_string((long long)(nowMs() - t0)) + "ms");
    } else if (cmd == "tunebench") {
      // Hidden diagnostic: Texel coordinate-descent on TUNE[] against a
      // dataset of <fen>\t<cp> lines. Not advertised as a UCI option.
      stopSearch();
      string file;
      int maxEpochs = 24, subset = 25000;
      iss >> file >> maxEpochs >> subset;
      runTexelBench(file, maxEpochs, subset);
    } else if (cmd == "bench") {
      stopSearch();
      clearTT();
      SearchOpts o;
      o.depth = 12;
      const i64 c0 = cpuMs();
      SearchResult r = search(o);
      const i64 cpu = max((i64)1, cpuMs() - c0);
      ostringstream s;
      s << "bench depth " << r.depth << " nodes " << r.nodes << " time " << r.time
        << "ms nps " << (r.nodes * 1000 / (u64)max((i64)1, r.time))
        << " cpu " << cpu << "ms cpunps " << (r.nodes * 1000 / (u64)cpu)
        << " best " << r.bestMoveStr;
      emitInfo(s.str());
    }
  }
  // stdin closed (EOF): stop any in-flight search before exiting. Without
  // this, returning from main() destroys a joinable search thread, and the
  // std::thread destructor calls std::terminate.
  abortFlag.store(true);
  if (searchThread.joinable()) searchThread.join();
  return 0;
}
