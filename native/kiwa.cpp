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
static thread_local int halfmove = 0;
static thread_local int fullmove = 1;

static thread_local u64 key = 0;      // full position key
static thread_local u64 pawnKey = 0;  // pawn-only key, for the pawn-structure cache
static thread_local int mg = 0, eg = 0, phase = 0;

static thread_local int stCastling[MAX_HIST];
static thread_local int stEp[MAX_HIST];
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
// Piece handling
// ---------------------------------------------------------------------------

static inline void addPiece(int sq, int piece) {
  board[sq] = (int8_t)piece;
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
  if (epSq >= 0 && epCapturePossible(side)) key ^= ZE[epSq & 7];
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
  stHalf[st] = halfmove;
  stKey[st] = key;
  stCap[st] = 0;

  key ^= ZC[castling];
  if (epSq >= 0 && epCapturePossible(side)) key ^= ZE[epSq & 7];

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
  if (epSq >= 0 && epCapturePossible(them)) key ^= ZE[epSq & 7];
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
  halfmove = stHalf[st];
  key = stKey[st];
}

static inline void makeNull() {
  const int st = stateTop++;
  stCastling[st] = castling;
  stEp[st] = epSq;
  stHalf[st] = halfmove;
  stKey[st] = key;
  stCap[st] = 0;

  if (epSq >= 0 && epCapturePossible(side)) key ^= ZE[epSq & 7];
  epSq = -1;
  halfmove++;
  key ^= ZS;
  side ^= 1;
}

static inline void unmakeNull() {
  const int st = --stateTop;
  side ^= 1;
  castling = stCastling[st];
  epSq = stEp[st];
  halfmove = stHalf[st];
  key = stKey[st];
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

static thread_local int wpFiles[8];
static thread_local int bpFiles[8];
static const int PASSED_MG[8] = { 0, 8, 12, 20, 35, 60, 100, 0 };
static const int PASSED_EG[8] = { 0, 8, 12, 20, 35, 60, 100, 0 };

// Mobility per safe destination square, indexed by piece type. A destination
// occupied by the enemy counts, but squares covered by an enemy pawn do not.
// Ray-scan mobility is the most expensive term in the evaluation, so which
// piece types get it is a build-time switch measured by test/eval-ab.js and the duel mode of test/elo.js:
//   0 = off, 1 = knights and bishops only, 2 = also rooks and queens.
#ifndef KIWA_MOB
#define KIWA_MOB 2
#endif
static const int MOB_MG[7] = { 0, 0, 3, 2, 2, 1, 0 };
static const int MOB_EG[7] = { 0, 0, 3, 2, 3, 1, 0 };
static const int OUTPOST_N_MG = 25, OUTPOST_N_EG = 15;
static const int OUTPOST_B_MG = 15, OUTPOST_B_EG = 10;

// Pawn attack maps, rebuilt on every full-extras miss.
static thread_local int8_t wPawnAtk[128];
static thread_local int8_t bPawnAtk[128];

// Pawn-structure cache keyed by the pawn-only Zobrist key.
static const int PH_SIZE = 1 << 13;
static const int PH_MASK = PH_SIZE - 1;
static thread_local u64 phKey[PH_SIZE];
static thread_local int phScoreMg[PH_SIZE];
static thread_local int phScoreEg[PH_SIZE];
static thread_local int phWB[PH_SIZE];
static thread_local int phBB[PH_SIZE];

// Whole-extras cache keyed by the position hash.
static const int EX_SIZE = 1 << 15;
static const int EX_MASK = EX_SIZE - 1;
static thread_local u64 exKey[EX_SIZE];
static thread_local int exScoreMg[EX_SIZE];
static thread_local int exScoreEg[EX_SIZE];
static thread_local int extraMg, extraEg;

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

static void extrasRaw() {
  const int wpIdx = 0 * 6 + PAWN - 1, bpIdx = 1 * 6 + PAWN - 1;
  const int wpc = pieceCount[wpIdx], bpc = pieceCount[bpIdx];
  int xmg = 0, xeg = 0;

  fillPawnAttacks();

  if (wpc == 0 && bpc == 0) {
    for (int f = 0; f < 8; f++) { wpFiles[f] = 0; bpFiles[f] = 0; }
  } else {
    const int idx = (int)(pawnKey & PH_MASK);
    if (phKey[idx] == pawnKey) {
      xmg = phScoreMg[idx]; xeg = phScoreEg[idx];
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
        if (wpFiles[f] > 1) { xmg -= 12 * (wpFiles[f] - 1); xeg -= 12 * (wpFiles[f] - 1); }
        if (bpFiles[f] > 1) { xmg += 12 * (bpFiles[f] - 1); xeg += 12 * (bpFiles[f] - 1); }
      }
      for (int i = 0; i < wpc; i++) {
        const int f = pieceSq[wpBase + i] & 7;
        const int left = f > 0 ? wpFiles[f - 1] : 0;
        const int right = f < 7 ? wpFiles[f + 1] : 0;
        if (!left && !right) { xmg -= 14; xeg -= 14; }
      }
      for (int i = 0; i < bpc; i++) {
        const int f = pieceSq[bpBase + i] & 7;
        const int left = f > 0 ? bpFiles[f - 1] : 0;
        const int right = f < 7 ? bpFiles[f + 1] : 0;
        if (!left && !right) { xmg += 14; xeg += 14; }
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
          if (connected) { xmg += sign * 4; xeg += sign * 2; }

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
              if (validSq(stop) && enemyAtk[stop]) { xmg -= sign * 6; xeg -= sign * 8; }
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
        if (!blocked) { xmg += PASSED_MG[r]; xeg += PASSED_EG[r]; }
      }
      for (int i = 0; i < bpc; i++) {
        const int sq = pieceSq[bpBase + i];
        const int f = sq & 7, r = sq >> 4;
        bool blocked = false;
        for (int j = 0; j < wpc; j++) {
          const int ws = pieceSq[wpBase + j];
          if ((ws >> 4) < r && abs((ws & 7) - f) <= 1) { blocked = true; break; }
        }
        if (!blocked) { xmg -= PASSED_MG[7 - r]; xeg -= PASSED_EG[7 - r]; }
      }

      int wb = 0, bb = 0;
      for (int f = 7; f >= 0; f--) { wb = (wb << 4) | wpFiles[f]; bb = (bb << 4) | bpFiles[f]; }
      phKey[idx] = pawnKey;
      phScoreMg[idx] = xmg; phScoreEg[idx] = xeg; phWB[idx] = wb; phBB[idx] = bb;
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
      xeg += sign * (7 - d) * 2;
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
        if (t == KNIGHT) { xmg += sign * OUTPOST_N_MG; xeg += sign * OUTPOST_N_EG; }
        else { xmg += sign * OUTPOST_B_MG; xeg += sign * OUTPOST_B_EG; }
      }
    }
  }

  // Bishop pair
  if (pieceCount[0 * 6 + BISHOP - 1] >= 2) { xmg += 30; xeg += 30; }
  if (pieceCount[1 * 6 + BISHOP - 1] >= 2) { xmg -= 30; xeg -= 30; }

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
      xmg -= sign * 3 * bad; xeg -= sign * 2 * bad;
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
      if (!own && !opp) { xmg += sign * 18; xeg += sign * 18; }
      else if (!own) { xmg += sign * 8; xeg += sign * 8; }
      const int r = rsq >> 4;
      if ((c == WHITE && r == 6) || (c == BLACK && r == 1)) { xmg += sign * 14; xeg += sign * 14; }
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
        if (clear) { xmg += sign * 12; xeg += sign * 8; }
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
        if (validSq(s1) && board[s1] == pc(c, PAWN)) shield += 8;
        else {
          const int s2 = s1 + d;
          if (validSq(s2) && board[s2] == pc(c, PAWN)) shield += 4;
          else shield -= 10;
        }
      }
      xmg += sign * shield; xeg += sign * shield;
    }
  }

  extraMg = xmg; extraEg = xeg;
}

static void extras() {
  const int idx = (int)(key & EX_MASK);
  if (exKey[idx] == key) {
    extraMg = exScoreMg[idx]; extraEg = exScoreEg[idx];
    return;
  }
  extrasRaw();
  exKey[idx] = key; exScoreMg[idx] = extraMg; exScoreEg[idx] = extraEg;
}

// Positional terms (pawn structure, outposts, bishop quality, rook activity,
// king shield, passed-pawn king distance, mobility). Measured by
// test/eval-ab.js: they buy tactical accuracy at a fixed time control but cost
// nodes per second, so the switch stays for reproduction of those runs.
#ifndef KIWA_EXTRAS
#define KIWA_EXTRAS 1
#endif

static int evaluate() {
  const int p = phase > 24 ? 24 : phase;
  int s = (mg * p + eg * (24 - p)) / 24;
#if KIWA_EXTRAS
  extras();
  s += (extraMg * p + extraEg * (24 - p)) / 24;
#endif
  return (side == WHITE ? s : -s) + 8;
}

// ---------------------------------------------------------------------------
// Transposition table
// ---------------------------------------------------------------------------

// 18 bytes per slot; the number of slots is rounded down to a power of two.
static size_t ttSize = 0;
static size_t ttMask = 0;
static int hashMB = 64;
// Each search thread gets a private slice of the shared table, so no locks
// and no data races. -1 means "use the whole table".
static thread_local size_t ttOffset = 0;
static thread_local size_t ttSegMask = (size_t)-1;
static inline size_t ttIdx(u64 k) {
  const size_t m = ttSegMask == (size_t)-1 ? ttMask : ttSegMask;
  return ttOffset + (size_t)(k & m);
}
static vector<u64> ttKey;
static vector<uint32_t> ttMoveArr;
static vector<int32_t> ttScore;
static vector<int8_t> ttDepth;
static vector<int8_t> ttFlag;

static void clearTT() {
  if (!ttSize) return;
  fill(ttKey.begin(), ttKey.end(), 0);
  fill(ttMoveArr.begin(), ttMoveArr.end(), 0);
  fill(ttScore.begin(), ttScore.end(), 0);
  fill(ttDepth.begin(), ttDepth.end(), 0);
  fill(ttFlag.begin(), ttFlag.end(), 0);
}

static void resizeTT(int mb) {
  if (mb < 1) mb = 1;
  if (mb > 512) mb = 512;
  hashMB = mb;
  size_t entries = ((size_t)mb * 1024 * 1024) / 18;
  size_t n = 1024;
  while (n * 2 <= entries && n < (1u << 24)) n *= 2;
  ttSize = n;
  ttMask = n - 1;
  ttKey.assign(n, 0);
  ttMoveArr.assign(n, 0);
  ttScore.assign(n, 0);
  ttDepth.assign(n, 0);
  ttFlag.assign(n, 0);
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

static thread_local u64 nodeLimit = 0;
static thread_local i64 hardStop = INT64_MAX;
static thread_local i64 softStop = INT64_MAX;
static thread_local i64 moveAlloc = 0;

static thread_local int rootBest = 0;
static thread_local int rootScore = 0;
static thread_local int rootDepth = 0;
static thread_local int rootPrevBest = 0;

static int LMR[64][MAX_MOVES];

static i64 nowMs() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

static inline bool timeUp() {
  return abortFlag.load(memory_order_relaxed) || nowMs() >= hardStop || (nodeLimit && nodes >= nodeLimit);
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
    const int attacker = typeOf(board[from]);
    return (1 << 22) + VAL_MG[victim] * 16 - VAL_MG[attacker];
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
  if (ttKey[idx] == key && ttDepth[idx] > depth + 2 && ttFlag[idx] == 0) return;
  ttKey[idx] = key;
  ttMoveArr[idx] = move;
  ttDepth[idx] = (int8_t)depth;
  ttFlag[idx] = (int8_t)flag;
  int sc = score;
  if (sc > MATE - 1000) sc += ply;
  else if (sc < -MATE + 1000) sc -= ply;
  ttScore[idx] = sc;
}

static int negamax(int depth, int alpha, int beta, int ply, bool canNull) {
  nodes++;
  if ((nodes & 1023) == 0 && timeUp()) searchStop = true;
  if (searchStop) return 0;

  pvLength[ply] = ply;

  if (ply > 0) {
    if (halfmove >= 100) return 0;
    if (isRepetition() || insufficientMaterial()) return 0;
  }
  if (ply >= MAX_PLY - 1) return evaluate();

  uint32_t ttMove = 0;
  const size_t idx = ttIdx(key);
  if (ttKey[idx] == key) {
    ttMove = ttMoveArr[idx];
    if (ttDepth[idx] >= depth) {
      int sc = ttScore[idx];
      if (sc > MATE - 1000) sc -= ply;
      else if (sc < -MATE + 1000) sc += ply;
      const int fl = ttFlag[idx];
      if (fl == 0) return sc;
      if (fl == 1 && sc <= alpha) return sc;
      if (fl == 2 && sc >= beta) return sc;
    }
  }

  const bool inCheck = attacked(kingSq[side], side ^ 1);
  if (depth <= 0) return quiesce(alpha, beta, ply, inCheck);

  const int staticEval = inCheck ? -INF : evaluate();

  if (!inCheck && depth <= 2 && staticEval - 120 * depth >= beta) return staticEval;

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
    const int flags = mv & (F_CAP | F_EP | F_CASTLE | F_DOUBLE);
    const int promo = (mv >> 14) & 7;
    const int us = side;

    makeMove(mv);
    if (attacked(kingSq[side ^ 1], side)) { unmakeMove(mv); continue; }
    legal++;
    moveStack[ply] = mv;
    if (!(flags & F_CAP) && !promo && nQuiet < 64) {
      quietHist[nQuiet++] = us * 16384 + (mv & 127) * 128 + ((mv >> 7) & 127);
    }

    const bool givesCheck = attacked(kingSq[side], side ^ 1);
    // Check extension: forced replies are cheap to resolve, so keep the depth.
    int newDepth = depth - 1;
    if (givesCheck && depth >= 2 && depth <= 6 && ply < 40) newDepth++;
    int sc;

    if (legal == 1) {
      sc = -negamax(newDepth, -beta, -alpha, ply + 1, true);
    } else {
      int reduction = 0;
      if (depth >= 3 && legal >= 4 && !promo && !inCheck && !givesCheck) {
        if (!(flags & F_CAP)) {
          reduction = LMR[depth][legal];
        } else if (see(mv) < 0) {
          // A losing capture is not worth full depth unless it refutes.
          reduction = LMR[depth][legal];
        }
        if (reduction > newDepth - 1) reduction = newDepth - 1;
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
        pvTable[ply * MAX_PLY + ply] = (int)mv;
        int j = ply + 1;
        for (; j < pvLength[ply + 1]; j++) {
          pvTable[ply * MAX_PLY + j] = pvTable[(ply + 1) * MAX_PLY + j];
        }
        pvLength[ply] = j;

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
          ttStore(depth, sc, 2, mv, ply);
          return sc;
        }
      }
    }
  }

  if (legal == 0) return inCheck ? -MATE + ply : 0;

  ttStore(depth, bestScore, bestScore > oldAlpha ? 0 : 1, bestMove, ply);
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
  bool infinite = false;
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

static mutex outMutex;

static void emitInfo(const string& line) {
  lock_guard<mutex> lock(outMutex);
  printf("%s\n", line.c_str());
  fflush(stdout);
}

static SearchResult search(const SearchOpts& rawOpts) {
  SearchOpts opts = rawOpts;
  const i64 started = nowMs();
  const int maxDepth = min(opts.depth ? opts.depth : MAX_PLY - 1, MAX_PLY - 2);

  i64 hard = INT64_MAX, soft = INT64_MAX;
  moveAlloc = 0;
  if (opts.movetime) {
    hard = started + opts.movetime;
    soft = hard;
  } else if (opts.wtime >= 0) {
    const i64 t = side == WHITE ? opts.wtime : opts.btime;
    const i64 inc = side == WHITE ? opts.winc : opts.binc;
    const i64 usable = max((i64)10, t - moveOverhead);
    const i64 mtg = opts.movestogo > 0 ? opts.movestogo : 50;
    const i64 reserve = min((i64)150, max((i64)30, usable / 50));
    const i64 budget = max((i64)10, usable - reserve);
    i64 alloc = (i64)floor((double)usable / (double)mtg + (double)inc * 0.6);
    alloc = min(alloc, usable / 2);
    alloc = max((i64)10, min(alloc, budget));
    moveAlloc = alloc;
    soft = started + alloc;
    hard = started + min(budget, (i64)floor(alloc * 1.5));
  } else if (opts.infinite) {
    hard = started + 20000;
    soft = hard;
  } else if (opts.depth) {
    hard = INT64_MAX;
    soft = INT64_MAX;
  } else {
    hard = started + 1000;
    soft = hard;
  }

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
  vector<string> lastPv;

  for (int d = 1; d <= maxDepth; d++) {
    const i64 iterStart = nowMs();
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

int main(int argc, char** argv) {
  initTables();
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
      SearchResult r = search(o);
      printf("bestmove %s  score %s  depth %d  nodes %llu  time %lldms  nps %llu\n",
             r.bestMoveStr.c_str(), scoreToUci(r.score).c_str(), r.depth,
             (unsigned long long)r.nodes, (long long)r.time,
             (unsigned long long)(r.nodes * 1000 / (u64)max((i64)1, r.time)));
      return 0;
    }
  }

  string line;
  thread searchThread;
  auto stopSearch = [&]() {
    abortFlag.store(true);
    if (searchThread.joinable()) searchThread.join();
    abortFlag.store(false);
  };

  while (getline(cin, line)) {
    istringstream iss(line);
    string cmd;
    iss >> cmd;
    if (cmd.empty()) continue;

    if (cmd == "uci") {
      emitInfo("id name KiwaChess 2.3.0");
      emitInfo("id author Kiwa");
      emitInfo("id string core C++ native");
      emitInfo("option name Threads type spin default 1 min 1 max 8");
      emitInfo("option name Hash type spin default 64 min 1 max 512");
      emitInfo("option name OwnBook type check default true");
      emitInfo("option name Book Depth type spin default 24 min 0 max 60");
      emitInfo("option name Book Variety type spin default 100 min 0 max 100");
      emitInfo("option name Book Style type combo default Balanced var Balanced var Mainline var Aggressive var Positional var Solid var Gambit var Surprise");
      emitInfo("option name Opening Diversity type spin default 50 min 0 max 100");
      emitInfo("option name Random Seed type spin default 0 min 0 max 2147483647");
      emitInfo("option name Clear Book Memory type button");
      emitInfo("option name Move Overhead type spin default 30 min 0 max 1000");
      emitInfo("option name Clear Hash type button");
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
          break;
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
      }
      // Book replies are instant. Explicit depth/node/infinite searches are
      // analysis requests, so the book stays out of those.
      if (ownBook && bookAllowed && !o.depth && !o.nodeBudget && !o.infinite) {
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
      const int nthreads = threads;
      searchThread = thread([o, fen, moves, nthreads]() {
        if (nthreads <= 1) {
          threadId = 0;
          ttOffset = 0;
          ttSegMask = (size_t)-1;
          prepareThreadPosition(fen, moves);
          SearchResult r = search(o);
          lock_guard<mutex> lock(outMutex);
          printf("bestmove %s\n", r.bestMoveStr.c_str());
          fflush(stdout);
          return;
        }

        // Split the advertised Hash into private, power-of-two slices.
        size_t seg = 1024;
        while (seg * 2 * (size_t)nthreads <= ttSize) seg *= 2;

        vector<SearchResult> results((size_t)nthreads);
        vector<thread> pool;
        pool.reserve((size_t)nthreads);
        for (int i = 0; i < nthreads; i++) {
          pool.emplace_back([&, i]() {
            threadId = i;
            ttOffset = (size_t)i * seg;
            ttSegMask = seg - 1;
            prepareThreadPosition(fen, moves);
            results[(size_t)i] = search(o);
          });
        }
        for (auto& t : pool) t.join();

        auto mateState = [](int sc) {
          return sc > MATE - 100 ? 1 : (sc < -MATE + 100 ? -1 : 0);
        };
        int bi = 0;
        for (int i = 1; i < nthreads; i++) {
          const SearchResult& r = results[(size_t)i];
          const SearchResult& b = results[(size_t)bi];
          const int ms = mateState(r.score), bs = mateState(b.score);
          bool better;
          if (ms != bs) better = ms > bs;
          else if (r.depth != b.depth) better = r.depth > b.depth;
          else if (r.score != b.score) better = r.score > b.score;
          else better = r.nodes > b.nodes;
          if (better) bi = i;
        }
        const SearchResult& best = results[(size_t)bi];

        lock_guard<mutex> lock(outMutex);
        if (bi != 0) {
          ostringstream info;
          info << "info depth " << best.depth << " score " << scoreToUci(best.score)
               << " nodes " << best.nodes << " time " << best.time << " pv";
          if (best.pv.empty()) info << " " << best.bestMoveStr;
          else for (auto& m : best.pv) info << " " << m;
          printf("%s\n", info.str().c_str());
        }
        printf("bestmove %s\n", best.bestMoveStr.c_str());
        fflush(stdout);
      });
    } else if (cmd == "stop") {
      abortFlag.store(true);
      if (searchThread.joinable()) searchThread.join();
      abortFlag.store(false);
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
    } else if (cmd == "perft") {
      stopSearch();
      int d = 1;
      iss >> d;
      const i64 t0 = nowMs();
      const u64 n = perft(d);
      emitInfo("perft " + to_string(d) + " " + to_string((unsigned long long)n) + " " + to_string((long long)(nowMs() - t0)) + "ms");
    } else if (cmd == "bench") {
      stopSearch();
      clearTT();
      SearchOpts o;
      o.depth = 12;
      SearchResult r = search(o);
      ostringstream s;
      s << "bench depth " << r.depth << " nodes " << r.nodes << " time " << r.time
        << "ms nps " << (r.nodes * 1000 / (u64)max((i64)1, r.time))
        << " best " << r.bestMoveStr;
      emitInfo(s.str());
    }
  }
  return 0;
}
