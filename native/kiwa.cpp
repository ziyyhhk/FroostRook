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
   0,   0,  0,   0,   0,   0,   0,   0,
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
  // The capturing pawn square is adjacent file, same rank as the ep square
  // (the double-pushed pawn is on the rank behind the ep square).
  // Full implementation continues in the original file...
