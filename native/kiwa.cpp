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

static int8_t board[128];
static int pieceSq[12 * 16];
static int pieceCount[12];
static int kingSq[2];

static int side = WHITE;
static int castling = 0;
static int epSq = -1;
static int halfmove = 0;
static int fullmove = 1;

static u64 key = 0;      // full position key
static u64 pawnKey = 0;  // pawn-only key, for the pawn-structure cache
static int mg = 0, eg = 0, phase = 0;

static int stCastling[MAX_HIST];
static int stEp[MAX_HIST];
static int stHalf[MAX_HIST];
static u64 stKey[MAX_HIST];
static int stCap[MAX_HIST];
static int stateTop = 0;

static u64 posKeys[MAX_HIST];
static int histLen = 0;

static uint32_t moveBuf[MAX_PLY * MAX_MOVES];
static int scoreBuf[MAX_PLY * MAX_MOVES];

static int pvTable[MAX_PLY * MAX_PLY];
static int pvLength[MAX_PLY];
static int killers[MAX_PLY * 2];
static int counter[128 * 128];
static int history[2 * 128 * 128];
static uint32_t moveStack[MAX_PLY];

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
  if (epSq >= 0) key ^= ZE[epSq & 7];
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
  if (epSq >= 0) key ^= ZE[epSq & 7];

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
  if (epSq >= 0) key ^= ZE[epSq & 7];
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

  if (epSq >= 0) key ^= ZE[epSq & 7];
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

static int wpFiles[8];
static int bpFiles[8];
static const int PASSED[8] = { 0, 8, 12, 20, 35, 60, 100, 0 };

// Pawn-structure cache keyed by the pawn-only Zobrist key.
static const int PH_SIZE = 1 << 13;
static const int PH_MASK = PH_SIZE - 1;
static u64 phKey[PH_SIZE];
static int phScore[PH_SIZE];
static int phWB[PH_SIZE];
static int phBB[PH_SIZE];

// Whole-extras cache keyed by the position hash.
static const int EX_SIZE = 1 << 15;
static const int EX_MASK = EX_SIZE - 1;
static u64 exKey[EX_SIZE];
static int exScore[EX_SIZE];

static int extrasRaw() {
  const int wpIdx = 0 * 6 + PAWN - 1, bpIdx = 1 * 6 + PAWN - 1;
  const int wpc = pieceCount[wpIdx], bpc = pieceCount[bpIdx];
  int s = 0;

  if (wpc == 0 && bpc == 0) {
    for (int f = 0; f < 8; f++) { wpFiles[f] = 0; bpFiles[f] = 0; }
  } else {
    const int idx = (int)(pawnKey & PH_MASK);
    if (phKey[idx] == pawnKey) {
      s = phScore[idx];
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
        if (wpFiles[f] > 1) s -= 12 * (wpFiles[f] - 1);
        if (bpFiles[f] > 1) s += 12 * (bpFiles[f] - 1);
      }
      for (int i = 0; i < wpc; i++) {
        const int f = pieceSq[wpBase + i] & 7;
        const int left = f > 0 ? wpFiles[f - 1] : 0;
        const int right = f < 7 ? wpFiles[f + 1] : 0;
        if (!left && !right) s -= 14;
      }
      for (int i = 0; i < bpc; i++) {
        const int f = pieceSq[bpBase + i] & 7;
        const int left = f > 0 ? bpFiles[f - 1] : 0;
        const int right = f < 7 ? bpFiles[f + 1] : 0;
        if (!left && !right) s += 14;
      }

      // Passed pawns
      for (int i = 0; i < wpc; i++) {
        const int sq = pieceSq[wpBase + i];
        const int f = sq & 7, r = sq >> 4;
        bool blocked = false;
        for (int j = 0; j < bpc; j++) {
          const int bs = pieceSq[bpBase + j];
          if ((bs >> 4) > r && abs((bs & 7) - f) <= 1) { blocked = true; break; }
        }
        if (!blocked) s += PASSED[r];
      }
      for (int i = 0; i < bpc; i++) {
        const int sq = pieceSq[bpBase + i];
        const int f = sq & 7, r = sq >> 4;
        bool blocked = false;
        for (int j = 0; j < wpc; j++) {
          const int ws = pieceSq[wpBase + j];
          if ((ws >> 4) < r && abs((ws & 7) - f) <= 1) { blocked = true; break; }
        }
        if (!blocked) s -= PASSED[7 - r];
      }

      int wb = 0, bb = 0;
      for (int f = 7; f >= 0; f--) { wb = (wb << 4) | wpFiles[f]; bb = (bb << 4) | bpFiles[f]; }
      phKey[idx] = pawnKey;
      phScore[idx] = s; phWB[idx] = wb; phBB[idx] = bb;
    }
  }

  // Bishop pair
  if (pieceCount[0 * 6 + BISHOP - 1] >= 2) s += 30;
  if (pieceCount[1 * 6 + BISHOP - 1] >= 2) s -= 30;

  // Rooks on open / semi-open files, and on the seventh rank
  for (int c = 0; c < 2; c++) {
    const int sign = c == WHITE ? 1 : -1;
    const int ri = c * 6 + ROOK - 1;
    const int cnt = pieceCount[ri];
    for (int i = 0; i < cnt; i++) {
      const int rsq = pieceSq[ri * 16 + i];
      const int f = rsq & 7;
      const int own = c == WHITE ? wpFiles[f] : bpFiles[f];
      const int opp = c == WHITE ? bpFiles[f] : wpFiles[f];
      if (!own && !opp) s += sign * 18;
      else if (!own) s += sign * 8;
      const int r = rsq >> 4;
      if ((c == WHITE && r == 6) || (c == BLACK && r == 1)) s += sign * 14;
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
      s += sign * shield;
    }
  }

  return s;
}

static int extras() {
  const int idx = (int)(key & EX_MASK);
  if (exKey[idx] == key) return exScore[idx];
  const int s = extrasRaw();
  exKey[idx] = key; exScore[idx] = s;
  return s;
}

static int evaluate() {
  const int p = phase > 24 ? 24 : phase;
  int s = (mg * p + eg * (24 - p)) / 24;
  s += extras();
  return (side == WHITE ? s : -s) + 8;
}

// ---------------------------------------------------------------------------
// Transposition table
// ---------------------------------------------------------------------------

// 18 bytes per slot; the number of slots is rounded down to a power of two.
static size_t ttSize = 0;
static size_t ttMask = 0;
static int hashMB = 64;
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

static u64 nodes = 0;
static bool searchStop = false;
static atomic<bool> abortFlag(false);
static int moveOverhead = 30; // ms of the clock never spent, for GUI/IPC latency
static u64 nodeLimit = 0;
static i64 hardStop = INT64_MAX;
static i64 softStop = INT64_MAX;
static i64 moveAlloc = 0;

static int rootBest = 0;
static int rootScore = 0;
static int rootDepth = 0;
static int rootPrevBest = 0;

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

static bool isRepetition() {
  int stop = histLen - 1 - halfmove;
  if (stop < 0) stop = 0;
  for (int i = histLen - 3; i >= stop; i -= 2) {
    if (posKeys[i] == key) return true;
  }
  return false;
}

static int moveScore(uint32_t mv, uint32_t ttMove, int ply, uint32_t prevMv) {
  if (mv == ttMove) return 1 << 28;
  const int from = mv & 127;
  const int to = (mv >> 7) & 127;
  const int promo = (mv >> 14) & 7;
  const int flags = mv & (F_CAP | F_EP | F_CASTLE | F_DOUBLE);

  if (promo) return (1 << 24) + promo * 1000;

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

  for (int i = 0; i < n; i++) {
    const uint32_t mv = pickMove(base, n, i);
    const int flags = mv & (F_CAP | F_EP | F_CASTLE | F_DOUBLE);

    if (!inCheck) {
      const int to = (mv >> 7) & 127;
      const int promo = (mv >> 14) & 7;
      const int victim = (flags & F_CAP) ? (board[to] ? typeOf(board[to]) : PAWN) : 0;
      if (!promo && victim && best + VAL_MG[victim] + 200 < alpha) continue;
    }

    makeMove(mv);
    if (attacked(kingSq[side ^ 1], side)) { unmakeMove(mv); continue; }

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
  return best;
}

static void ttStore(int depth, int score, int flag, uint32_t move, int ply) {
  const int idx = (int)(key & ttMask);
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
    if (isRepetition()) return 0;
  }
  if (ply >= MAX_PLY - 1) return evaluate();

  uint32_t ttMove = 0;
  const int idx = (int)(key & ttMask);
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

  for (int i = 0; i < n; i++) {
    const uint32_t mv = pickMove(base, n, i);
    const int flags = mv & (F_CAP | F_EP | F_CASTLE | F_DOUBLE);
    const int promo = (mv >> 14) & 7;

    makeMove(mv);
    if (attacked(kingSq[side ^ 1], side)) { unmakeMove(mv); continue; }
    legal++;
    moveStack[ply] = mv;

    const bool givesCheck = attacked(kingSq[side], side ^ 1);
    // Check extension: forced replies are cheap to resolve, so keep the depth.
    int newDepth = depth - 1;
    if (givesCheck && depth >= 2 && depth <= 6 && ply < 40) newDepth++;
    int sc;

    if (legal == 1) {
      sc = -negamax(newDepth, -beta, -alpha, ply + 1, true);
    } else {
      int reduction = 0;
      if (depth >= 3 && legal >= 4 && !(flags & F_CAP) && !promo && !inCheck && !givesCheck) {
        reduction = LMR[depth][legal];
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
      rootScore = res.score;
      rootBest = 0;
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
      emitInfo(line.str());
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

int main(int argc, char** argv) {
  initTables();
  for (int d = 0; d < MAX_PLY; d++) {
    for (int m = 0; m < MAX_MOVES; m++) {
      if (d < 3) { LMR[d][m] = 0; continue; }
      const int r = (int)floor(0.75 + log((double)d) * log((double)max(1, m)) / 2.2);
      LMR[d][m] = r < 1 ? 1 : r;
    }
  }
  setFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
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
      emitInfo("id name Kiwa 2.0.1 (native)");
      emitInfo("id author Kiwa");
      emitInfo("option name Hash type spin default 64 min 1 max 512");
      emitInfo("option name Clear Hash type button");
      emitInfo("option name Move Overhead type spin default 30 min 0 max 1000");
      emitInfo("uciok");
    } else if (cmd == "setoption") {
      // setoption name <name, spaces allowed> [value <value>]
      size_t np = line.find("name ");
      size_t vp = line.find(" value ");
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
        }
      }
    } else if (cmd == "isready") {
      emitInfo("readyok");
    } else if (cmd == "ucinewgame") {
      stopSearch();
      clearTT();
    } else if (cmd == "position") {
      stopSearch();
      string kind;
      iss >> kind;
      string fen;
      if (kind == "startpos") {
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
      } else if (kind == "fen") {
        string part;
        for (int i = 0; i < 6 && iss >> part; i++) fen += part + (i < 5 ? " " : "");
      }
      setFen(fen);
      string token;
      while (iss >> token) {
        if (token == "moves") {
          string mvStr;
          while (iss >> mvStr) {
            if (!applyUciMove(mvStr)) fprintf(stderr, "illegal move ignored: %s\n", mvStr.c_str());
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
      if (searchThread.joinable()) searchThread.join();
      abortFlag.store(false);
      searchThread = thread([o]() {
        SearchResult r = search(o);
        {
          lock_guard<mutex> lock(outMutex);
          printf("bestmove %s\n", r.bestMoveStr.c_str());
          fflush(stdout);
        }
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
