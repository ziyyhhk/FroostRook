'use strict';

/*
 * Kiwa — a from-scratch chess engine (0x88 board, alpha-beta, TT, NN-less eval).
 * Runs on Node. Also exposes a "predict" mode that estimates which move a human
 * is most likely to play, using search scores blended with human-move priors.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WHITE = 0, BLACK = 1;
const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const MAX_PLY = 64;
const MAX_MOVES = 256;
const MAX_HIST = 2048;

const INF = 32000;
const MATE = 31000;

const F_CAP = 1 << 17;
const F_EP = 1 << 18;
const F_CASTLE = 1 << 19;
const F_DOUBLE = 1 << 20;

const KNIGHT_D = [33, 31, 18, 14, -33, -31, -18, -14];
const KING_D = [17, 16, 15, 1, -1, -15, -16, -17];
const BISHOP_D = [17, 15, -15, -17];
const ROOK_D = [16, -16, 1, -1];

const VAL_MG = [0, 100, 320, 330, 500, 900, 0];
const VAL_EG = [0, 120, 300, 320, 520, 940, 0];
const PHASE_W = [0, 0, 1, 1, 2, 4, 0];

const colorOf = p => p >> 3;
const typeOf = p => p & 7;
const pc = (c, t) => t | (c << 3);
const validSq = s => (s & 0x88) === 0;

// ---------------------------------------------------------------------------
// Piece-square tables (rank 1 first, i.e. index 0 = a1)
// ---------------------------------------------------------------------------

const PST_PAWN = [
   0,  0,  0,  0,  0,  0,  0,  0,
  -5, -5, -5, -5, -5, -5, -5, -5,
  -3, -3, -3, -3, -3, -3, -3, -3,
  -1, -1, -1, -1, -1, -1, -1, -1,
   2,  2,  3,  5,  5,  3,  2,  2,
   6,  8, 11, 14, 14, 11,  8,  6,
  16, 20, 26, 32, 32, 26, 20, 16,
   0,  0,  0,  0,  0,  0,  0,  0,
];

const PST_KNIGHT = [
  -50, -35, -25, -25, -25, -25, -35, -50,
  -35, -15,   0,   2,   2,   0, -15, -35,
  -25,   2,  10,  14,  14,  10,   2, -25,
  -25,   4,  14,  18,  18,  14,   4, -25,
  -25,   2,  14,  18,  18,  14,   2, -25,
  -25,   4,  10,  14,  14,  10,   4, -25,
  -35, -15,   0,   4,   4,   0, -15, -35,
  -50, -35, -25, -25, -25, -25, -35, -50,
];

const PST_BISHOP = [
  -20, -10, -10, -10, -10, -10, -10, -20,
  -10,   0,   0,   0,   0,   0,   0, -10,
  -10,   0,   5,  10,  10,   5,   0, -10,
  -10,   5,   5,  10,  10,   5,   5, -10,
  -10,   0,  10,  10,  10,  10,   0, -10,
  -10,  10,  10,  10,  10,  10,  10, -10,
  -10,   5,   0,   0,   0,   0,   5, -10,
  -20, -10, -10, -10, -10, -10, -10, -20,
];

const PST_ROOK = [
   0,   0,   0,   0,   0,   0,   0,   0,
   5,  10,  10,  10,  10,  10,  10,   5,
  -5,   0,   0,   0,   0,   0,   0,  -5,
  -5,   0,   0,   0,   0,   0,   0,  -5,
  -5,   0,   0,   0,   0,   0,   0,  -5,
  -5,   0,   0,   0,   0,   0,   0,  -5,
  -5,   0,   0,   0,   0,   0,   0,  -5,
   0,   0,   5,   5,   5,   5,   0,   0,
];

const PST_QUEEN = [
  -20, -10, -10,  -5,  -5, -10, -10, -20,
  -10,   0,   0,   0,   0,   0,   0, -10,
  -10,   0,   5,   5,   5,   5,   0, -10,
   -5,   0,   5,   5,   5,   5,   0,  -5,
    0,   0,   5,   5,   5,   5,   0,  -5,
  -10,   5,   5,   5,   5,   5,   0, -10,
  -10,   0,   5,   0,   0,   0,   0, -10,
  -20, -10, -10,  -5,  -5, -10, -10, -20,
];

const PST_KING_MG = [
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
   20,  20,   0,   0,   0,   0,  20,  20,
   20,  30,  10,   0,   0,  10,  30,  20,
];

const PST_KING_EG = [
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10,   0,   0, -10, -20, -30,
  -30, -10,  20,  30,  30,  20, -10, -30,
  -30, -10,  30,  40,  40,  30, -10, -30,
  -30, -10,  30,  40,  40,  30, -10, -30,
  -30, -10,  20,  30,  30,  20, -10, -30,
  -30, -30,   0,   0,   0,   0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50,
];

const PST = [null, PST_PAWN, PST_KNIGHT, PST_BISHOP, PST_ROOK, PST_QUEEN, null];

// ---------------------------------------------------------------------------
// Zobrist keys + eval tables
// ---------------------------------------------------------------------------

let rngState = 0x9e3779b9 | 0;
function rnd32() {
  let x = rngState;
  x ^= x << 13; x |= 0;
  x ^= x >>> 17;
  x ^= x << 5; x |= 0;
  rngState = x;
  return x;
}

const Z1 = new Int32Array(16 * 128);
const Z2 = new Int32Array(16 * 128);
const ZC1 = new Int32Array(16);
const ZC2 = new Int32Array(16);
const ZE1 = new Int32Array(8);
const ZE2 = new Int32Array(8);
const ZS1 = rnd32();
const ZS2 = rnd32();

const MG = new Int32Array(16 * 128);
const EG = new Int32Array(16 * 128);

(function initTables() {
  for (let p = 0; p < 16 * 128; p++) { Z1[p] = rnd32(); Z2[p] = rnd32(); }
  for (let i = 1; i < 16; i++) { ZC1[i] = rnd32(); ZC2[i] = rnd32(); }
  for (let i = 0; i < 8; i++) { ZE1[i] = rnd32(); ZE2[i] = rnd32(); }

  for (let t = 1; t <= 6; t++) {
    for (let c = 0; c < 2; c++) {
      const piece = pc(c, t);
      for (let sq = 0; sq < 128; sq++) {
        if (!validSq(sq)) continue;
        const rank = sq >> 4, file = sq & 7;
        const wi = rank * 8 + file;
        const bi = (7 - rank) * 8 + file;
        const idx = wi;
        let mgv, egv;
        if (t === KING) {
          mgv = VAL_MG[t] + (c === WHITE ? PST_KING_MG[idx] : PST_KING_MG[bi]);
          egv = VAL_EG[t] + (c === WHITE ? PST_KING_EG[idx] : PST_KING_EG[bi]);
        } else {
          mgv = VAL_MG[t] + (c === WHITE ? PST[t][idx] : PST[t][bi]);
          egv = VAL_EG[t] + (c === WHITE ? PST[t][idx] : PST[t][bi]);
        }
        // Tables are white-perspective, so black contributions are negative.
        if (c === BLACK) { mgv = -mgv; egv = -egv; }
        MG[piece * 128 + sq] = mgv;
        EG[piece * 128 + sq] = egv;
      }
    }
  }
})();

// ---------------------------------------------------------------------------
// Board state
// ---------------------------------------------------------------------------

const board = new Int8Array(128);
const pieceSq = new Int32Array(12 * 16);
const pieceCount = new Int32Array(12);
const kingSq = [0, 0];

let side = WHITE;
let castling = 0;
let epSq = -1;
let halfmove = 0;
let fullmove = 1;

let h1 = 0, h2 = 0;
let mg = 0, eg = 0, phase = 0;
// Pawn-only Zobrist key, maintained incrementally for the pawn-structure cache.
let pk1 = 0, pk2 = 0;

const stCastling = new Int32Array(MAX_HIST);
const stEp = new Int32Array(MAX_HIST);
const stHalf = new Int32Array(MAX_HIST);
const stH1 = new Int32Array(MAX_HIST);
const stH2 = new Int32Array(MAX_HIST);
const stCap = new Int32Array(MAX_HIST);
let stateTop = 0;

const posH1 = new Int32Array(MAX_HIST);
const posH2 = new Int32Array(MAX_HIST);
let histLen = 0;

const moveBuf = new Int32Array(MAX_PLY * MAX_MOVES);
const scoreBuf = new Int32Array(MAX_PLY * MAX_MOVES);

const pvTable = new Int32Array(MAX_PLY * MAX_PLY);
const pvLength = new Int32Array(MAX_PLY);
const killers = new Int32Array(MAX_PLY * 2);
const history = new Int32Array(2 * 128 * 128);
// Reply that refuted the previous move, indexed by that move's from/to.
const counter = new Int32Array(128 * 128);
// The move that led to the current node at each ply, for the countermove table.
const moveStack = new Int32Array(MAX_PLY);

// ---------------------------------------------------------------------------
// Piece handling
// ---------------------------------------------------------------------------

function addPiece(sq, piece) {
  board[sq] = piece;
  const c = piece >> 3, t = piece & 7;
  const pi = c * 6 + t - 1;
  pieceSq[pi * 16 + pieceCount[pi]++] = sq;
  const p = piece * 128 + sq;
  h1 ^= Z1[p]; h2 ^= Z2[p];
  if (t === PAWN) { pk1 ^= Z1[p]; pk2 ^= Z2[p]; }
  mg += MG[p]; eg += EG[p]; phase += PHASE_W[t];
}

function removePieceAt(sq) {
  const piece = board[sq];
  const c = piece >> 3, t = piece & 7;
  const pi = c * 6 + t - 1;
  const cnt = pieceCount[pi];
  const base = pi * 16;
  for (let i = 0; i < cnt; i++) {
    if (pieceSq[base + i] === sq) {
      pieceSq[base + i] = pieceSq[base + cnt - 1];
      pieceCount[pi] = cnt - 1;
      break;
    }
  }
  board[sq] = 0;
  const p = piece * 128 + sq;
  h1 ^= Z1[p]; h2 ^= Z2[p];
  if (t === PAWN) { pk1 ^= Z1[p]; pk2 ^= Z2[p]; }
  mg -= MG[p]; eg -= EG[p]; phase -= PHASE_W[t];
  return piece;
}

// ---------------------------------------------------------------------------
// FEN
// ---------------------------------------------------------------------------

const CHAR_TO_PIECE = {
  P: pc(WHITE, PAWN), N: pc(WHITE, KNIGHT), B: pc(WHITE, BISHOP),
  R: pc(WHITE, ROOK), Q: pc(WHITE, QUEEN), K: pc(WHITE, KING),
  p: pc(BLACK, PAWN), n: pc(BLACK, KNIGHT), b: pc(BLACK, BISHOP),
  r: pc(BLACK, ROOK), q: pc(BLACK, QUEEN), k: pc(BLACK, KING),
};

function setFen(fen) {
  board.fill(0);
  pieceCount.fill(0);
  pieceSq.fill(0);
  mg = 0; eg = 0; phase = 0;
  h1 = 0; h2 = 0;
  pk1 = 0; pk2 = 0;
  stateTop = 0; histLen = 0;

  const parts = fen.trim().split(/\s+/);
  let rank = 7, file = 0;
  for (const ch of parts[0]) {
    if (ch === '/') { rank--; file = 0; }
    else if (ch >= '1' && ch <= '8') file += ch.charCodeAt(0) - 48;
    else {
      const sq = rank * 16 + file;
      const piece = CHAR_TO_PIECE[ch];
      addPiece(sq, piece);
      if (typeOf(piece) === KING) kingSq[colorOf(piece)] = sq;
      file++;
    }
  }

  side = parts[1] === 'b' ? BLACK : WHITE;

  castling = 0;
  const cr = parts[2] || '-';
  if (cr.includes('K')) castling |= 1;
  if (cr.includes('Q')) castling |= 2;
  if (cr.includes('k')) castling |= 4;
  if (cr.includes('q')) castling |= 8;

  epSq = -1;
  if (parts[3] && parts[3] !== '-') {
    const f = parts[3].charCodeAt(0) - 97;
    const r = parts[3].charCodeAt(1) - 49;
    epSq = r * 16 + f;
  }

  halfmove = parts[4] ? parseInt(parts[4], 10) || 0 : 0;
  fullmove = parts[5] ? parseInt(parts[5], 10) || 1 : 1;

  h1 ^= ZC1[castling]; h2 ^= ZC2[castling];
  // FENs often carry an ep square after every double push; hash it only when
  // the capture is legal so repetition identity matches FIDE 9.2.2.
  if (epSq >= 0 && epCapturePossible(side)) { h1 ^= ZE1[epSq & 7]; h2 ^= ZE2[epSq & 7]; }
  if (side === BLACK) { h1 ^= ZS1; h2 ^= ZS2; }

  posH1[0] = h1; posH2[0] = h2;
  histLen = 1;
}

// ---------------------------------------------------------------------------
// Attacks
// ---------------------------------------------------------------------------

function isAttacked(sq, by) {
  const b = board;

  // Pawns
  if (by === WHITE) {
    if (b[sq - 15] === 1 || b[sq - 17] === 1) return true;
  } else {
    if (b[sq + 15] === 9 || b[sq + 17] === 9) return true;
  }

  // Knights
  const n = by === WHITE ? 2 : 10;
  for (let i = 0; i < 8; i++) {
    const s = sq + KNIGHT_D[i];
    if ((s & 0x88) === 0 && b[s] === n) return true;
  }

  // King
  const k = by === WHITE ? 6 : 14;
  for (let i = 0; i < 8; i++) {
    const s = sq + KING_D[i];
    if ((s & 0x88) === 0 && b[s] === k) return true;
  }

  // Sliders
  const rook = by === WHITE ? 4 : 12;
  const bishop = by === WHITE ? 3 : 11;
  const queen = by === WHITE ? 5 : 13;

  for (let i = 0; i < 4; i++) {
    const d = ROOK_D[i];
    let s = sq + d;
    while ((s & 0x88) === 0) {
      const p = b[s];
      if (p) {
        if (p === rook || p === queen) return true;
        break;
      }
      s += d;
    }
  }
  for (let i = 0; i < 4; i++) {
    const d = BISHOP_D[i];
    let s = sq + d;
    while ((s & 0x88) === 0) {
      const p = b[s];
      if (p) {
        if (p === bishop || p === queen) return true;
        break;
      }
      s += d;
    }
  }
  return false;
}

// An en-passant square only distinguishes positions when a legal en-passant
// capture actually exists (FIDE 9.2.2). Merely having a pawn next to it is not
// enough: the capture may expose the king.
function epCapturePossible(by) {
  if (epSq < 0 || board[epSq] !== 0) return false;
  // The capturing pawn stands one rank on the capturer's side of the ep
  // target; the captured pawn stands on the target's far side.
  const pawnRank = epSq + (by === WHITE ? -16 : 16);
  const capSq = pawnRank;
  if (capSq & 0x88) return false;
  if (board[capSq] !== pc(by ^ 1, PAWN)) return false;
  for (let df = -1; df <= 1; df += 2) {
    const from = pawnRank + df;
    if (from & 0x88) continue;
    if (board[from] !== pc(by, PAWN)) continue;
    const savedFrom = board[from];
    const savedTo = board[epSq];
    const savedCap = board[capSq];
    board[from] = 0;
    board[capSq] = 0;
    board[epSq] = pc(by, PAWN);
    const legal = !isAttacked(kingSq[by], by ^ 1);
    board[from] = savedFrom;
    board[capSq] = savedCap;
    board[epSq] = savedTo;
    if (legal) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Move generation
// ---------------------------------------------------------------------------

function addMove(base, n, from, to, promo, flags) {
  moveBuf[base + n] = from | (to << 7) | (promo << 14) | flags;
  return n + 1;
}

function generateMoves(base, capturesOnly) {
  const us = side, them = us ^ 1;
  const b = board;
  let n = 0;

  // Pawns
  const pawnIdx = us * 6 + PAWN - 1;
  const pawnCnt = pieceCount[pawnIdx];
  const dir = us === WHITE ? 16 : -16;
  const startRank = us === WHITE ? 1 : 6;
  const promoRank = us === WHITE ? 6 : 1;

  for (let i = 0; i < pawnCnt; i++) {
    const from = pieceSq[pawnIdx * 16 + i];
    const r = from >> 4;

    for (let df = -1; df <= 1; df += 2) {
      const to = from + dir + df;
      if (to & 0x88) continue;
      const target = b[to];
      if (target && (target >> 3) === them) {
        if (r === promoRank) {
          n = addMove(base, n, from, to, QUEEN, F_CAP);
          n = addMove(base, n, from, to, ROOK, F_CAP);
          n = addMove(base, n, from, to, BISHOP, F_CAP);
          n = addMove(base, n, from, to, KNIGHT, F_CAP);
        } else {
          n = addMove(base, n, from, to, 0, F_CAP);
        }
      } else if (!target && to === epSq && epSq >= 0) {
        n = addMove(base, n, from, to, 0, F_CAP | F_EP);
      }
    }

    if (!capturesOnly) {
      const one = from + dir;
      if (!(one & 0x88) && b[one] === 0) {
        if (r === promoRank) {
          n = addMove(base, n, from, one, QUEEN, 0);
          n = addMove(base, n, from, one, ROOK, 0);
          n = addMove(base, n, from, one, BISHOP, 0);
          n = addMove(base, n, from, one, KNIGHT, 0);
        } else {
          n = addMove(base, n, from, one, 0, 0);
          const two = one + dir;
          if (r === startRank && b[two] === 0) {
            n = addMove(base, n, from, two, 0, F_DOUBLE);
          }
        }
      }
    }
  }

  // Knights
  const knightIdx = us * 6 + KNIGHT - 1;
  const knightCnt = pieceCount[knightIdx];
  const knightPiece = pc(us, KNIGHT);
  for (let i = 0; i < knightCnt; i++) {
    const from = pieceSq[knightIdx * 16 + i];
    for (let j = 0; j < 8; j++) {
      const to = from + KNIGHT_D[j];
      if (to & 0x88) continue;
      const t = b[to];
      if (!t) { if (!capturesOnly) n = addMove(base, n, from, to, 0, 0); }
      else if ((t >> 3) === them) { n = addMove(base, n, from, to, 0, F_CAP); }
    }
  }

  // Bishops
  const bishopIdx = us * 6 + BISHOP - 1;
  const bishopCnt = pieceCount[bishopIdx];
  for (let i = 0; i < bishopCnt; i++) {
    const from = pieceSq[bishopIdx * 16 + i];
    for (let j = 0; j < 4; j++) {
      const d = BISHOP_D[j];
      let to = from + d;
      while (!(to & 0x88)) {
        const t = b[to];
        if (!t) { if (!capturesOnly) n = addMove(base, n, from, to, 0, 0); }
        else {
          if ((t >> 3) === them) n = addMove(base, n, from, to, 0, F_CAP);
          break;
        }
        to += d;
      }
    }
  }

  // Rooks
  const rookIdx = us * 6 + ROOK - 1;
  const rookCnt = pieceCount[rookIdx];
  for (let i = 0; i < rookCnt; i++) {
    const from = pieceSq[rookIdx * 16 + i];
    for (let j = 0; j < 4; j++) {
      const d = ROOK_D[j];
      let to = from + d;
      while (!(to & 0x88)) {
        const t = b[to];
        if (!t) { if (!capturesOnly) n = addMove(base, n, from, to, 0, 0); }
        else {
          if ((t >> 3) === them) n = addMove(base, n, from, to, 0, F_CAP);
          break;
        }
        to += d;
      }
    }
  }

  // Queens
  const queenIdx = us * 6 + QUEEN - 1;
  const queenCnt = pieceCount[queenIdx];
  for (let i = 0; i < queenCnt; i++) {
    const from = pieceSq[queenIdx * 16 + i];
    for (let j = 0; j < 8; j++) {
      const d = j < 4 ? ROOK_D[j] : BISHOP_D[j - 4];
      let to = from + d;
      while (!(to & 0x88)) {
        const t = b[to];
        if (!t) { if (!capturesOnly) n = addMove(base, n, from, to, 0, 0); }
        else {
          if ((t >> 3) === them) n = addMove(base, n, from, to, 0, F_CAP);
          break;
        }
        to += d;
      }
    }
  }

  // King
  const kingFrom = kingSq[us];
  for (let j = 0; j < 8; j++) {
    const to = kingFrom + KING_D[j];
    if (to & 0x88) continue;
    const t = b[to];
    if (!t) { if (!capturesOnly) n = addMove(base, n, kingFrom, to, 0, 0); }
    else if ((t >> 3) === them) { n = addMove(base, n, kingFrom, to, 0, F_CAP); }
  }

  // Castling
  if (!capturesOnly) {
    if (us === WHITE) {
      if ((castling & 1) && b[5] === 0 && b[6] === 0 &&
          !isAttacked(4, them) && !isAttacked(5, them) && !isAttacked(6, them)) {
        n = addMove(base, n, 4, 6, 0, F_CASTLE);
      }
      if ((castling & 2) && b[3] === 0 && b[2] === 0 && b[1] === 0 &&
          !isAttacked(4, them) && !isAttacked(3, them) && !isAttacked(2, them)) {
        n = addMove(base, n, 4, 2, 0, F_CASTLE);
      }
    } else {
      if ((castling & 4) && b[117] === 0 && b[118] === 0 &&
          !isAttacked(116, them) && !isAttacked(117, them) && !isAttacked(118, them)) {
        n = addMove(base, n, 116, 118, 0, F_CASTLE);
      }
      if ((castling & 8) && b[115] === 0 && b[114] === 0 && b[113] === 0 &&
          !isAttacked(116, them) && !isAttacked(115, them) && !isAttacked(114, them)) {
        n = addMove(base, n, 116, 114, 0, F_CASTLE);
      }
    }
  }

  return n;
}

// ---------------------------------------------------------------------------
// Make / unmake
// ---------------------------------------------------------------------------

function makeMove(mv) {
  const from = mv & 127;
  const to = (mv >>> 7) & 127;
  const promo = (mv >>> 14) & 7;
  const flags = mv & (F_CAP | F_EP | F_CASTLE | F_DOUBLE);

  const st = stateTop++;
  stCastling[st] = castling;
  stEp[st] = epSq;
  stHalf[st] = halfmove;
  stH1[st] = h1;
  stH2[st] = h2;
  stCap[st] = 0;

  h1 ^= ZC1[castling]; h2 ^= ZC2[castling];
  if (epSq >= 0 && epCapturePossible(side)) { h1 ^= ZE1[epSq & 7]; h2 ^= ZE2[epSq & 7]; }

  const us = side, them = us ^ 1;
  const moving = board[from];
  let captured = 0;

  if (flags & F_EP) {
    const capSq = to + (us === WHITE ? -16 : 16);
    captured = removePieceAt(capSq);
  } else if (board[to] !== 0) {
    captured = removePieceAt(to);
  }
  stCap[st] = captured;

  removePieceAt(from);
  if (promo) addPiece(to, pc(us, promo));
  else addPiece(to, moving);

  if (flags & F_CASTLE) {
    if (to === 6) { removePieceAt(7); addPiece(5, pc(WHITE, ROOK)); }
    else if (to === 2) { removePieceAt(0); addPiece(3, pc(WHITE, ROOK)); }
    else if (to === 118) { removePieceAt(119); addPiece(117, pc(BLACK, ROOK)); }
    else if (to === 114) { removePieceAt(112); addPiece(115, pc(BLACK, ROOK)); }
  }

  if ((moving & 7) === KING) kingSq[us] = to;

  if ((moving & 7) === KING) {
    castling &= us === WHITE ? ~3 : ~12;
  } else if ((moving & 7) === ROOK) {
    if (from === 0) castling &= ~2;
    else if (from === 7) castling &= ~1;
    else if (from === 112) castling &= ~8;
    else if (from === 119) castling &= ~4;
  }

  if (captured) {
    if (to === 0) castling &= ~2;
    else if (to === 7) castling &= ~1;
    else if (to === 112) castling &= ~8;
    else if (to === 119) castling &= ~4;
    halfmove = 0;
  } else if ((moving & 7) === PAWN) {
    halfmove = 0;
  } else {
    halfmove++;
  }

  epSq = (flags & F_DOUBLE) ? (from + (us === WHITE ? 16 : -16)) : -1;

  h1 ^= ZC1[castling]; h2 ^= ZC2[castling];
  if (epSq >= 0 && epCapturePossible(them)) { h1 ^= ZE1[epSq & 7]; h2 ^= ZE2[epSq & 7]; }
  h1 ^= ZS1; h2 ^= ZS2;

  if (us === BLACK) fullmove++;
  side = them;

  posH1[histLen] = h1; posH2[histLen] = h2; histLen++;
}

function unmakeMove(mv) {
  const st = stateTop - 1;
  stateTop = st;
  histLen--;

  side ^= 1;
  const us = side;
  if (us === BLACK) fullmove--;

  const from = mv & 127;
  const to = (mv >>> 7) & 127;
  const promo = (mv >>> 14) & 7;
  const flags = mv & (F_CAP | F_EP | F_CASTLE | F_DOUBLE);

  const moved = board[to];
  removePieceAt(to);
  addPiece(from, promo ? pc(us, PAWN) : moved);

  if (flags & F_CASTLE) {
    if (to === 6) { removePieceAt(5); addPiece(7, pc(WHITE, ROOK)); }
    else if (to === 2) { removePieceAt(3); addPiece(0, pc(WHITE, ROOK)); }
    else if (to === 118) { removePieceAt(117); addPiece(119, pc(BLACK, ROOK)); }
    else if (to === 114) { removePieceAt(115); addPiece(112, pc(BLACK, ROOK)); }
  }

  if ((moved & 7) === KING) kingSq[us] = from;

  if (flags & F_EP) {
    const capSq = to + (us === WHITE ? -16 : 16);
    addPiece(capSq, stCap[st]);
  } else if (stCap[st]) {
    addPiece(to, stCap[st]);
  }

  castling = stCastling[st];
  epSq = stEp[st];
  halfmove = stHalf[st];
  h1 = stH1[st];
  h2 = stH2[st];
}

function makeNull() {
  const st = stateTop++;
  stCastling[st] = castling;
  stEp[st] = epSq;
  stHalf[st] = halfmove;
  stH1[st] = h1;
  stH2[st] = h2;
  stCap[st] = 0;

  if (epSq >= 0 && epCapturePossible(side)) { h1 ^= ZE1[epSq & 7]; h2 ^= ZE2[epSq & 7]; }
  epSq = -1;
  halfmove++;
  h1 ^= ZS1; h2 ^= ZS2;
  side ^= 1;
}

function unmakeNull() {
  const st = stateTop - 1;
  stateTop = st;
  side ^= 1;
  castling = stCastling[st];
  epSq = stEp[st];
  halfmove = stHalf[st];
  h1 = stH1[st];
  h2 = stH2[st];
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const wpFiles = new Int32Array(8);
const bpFiles = new Int32Array(8);
const PASSED = [0, 8, 12, 20, 35, 60, 100, 0];

// Pawn-structure cache: doubled/isolated/passed score plus pawn file counts,
// keyed by the incremental pawn-only Zobrist key. Pawn structure repeats
// constantly across a search tree, so this turns extras() into O(1) on hits.
const PH_SIZE = 1 << 13;
const PH_MASK = PH_SIZE - 1;
const phKey1 = new Int32Array(PH_SIZE);
const phKey2 = new Int32Array(PH_SIZE);
const phScore = new Int32Array(PH_SIZE);
const phWB = new Int32Array(PH_SIZE);
const phBB = new Int32Array(PH_SIZE);

// Whole-extras cache keyed by the position hash: the remaining extras terms
// (bishop pair, rooks, king shield) only need a lookup on repeated positions.
const EX_SIZE = 1 << 15;
const EX_MASK = EX_SIZE - 1;
const exKey1 = new Int32Array(EX_SIZE);
const exKey2 = new Int32Array(EX_SIZE);
const exScore = new Int32Array(EX_SIZE);

function extras() {
  const idx = ((h1 ^ (h2 << 7) ^ (h2 >>> 25)) | 0) & EX_MASK;
  if (exKey1[idx] === h1 && exKey2[idx] === h2) return exScore[idx];
  const s = extrasRaw();
  exKey1[idx] = h1; exKey2[idx] = h2; exScore[idx] = s;
  return s;
}

function extrasRaw() {
  const wpIdx = 0 * 6 + PAWN - 1, bpIdx = 1 * 6 + PAWN - 1;
  const wpc = pieceCount[wpIdx], bpc = pieceCount[bpIdx];
  let s = 0;

  if (wpc === 0 && bpc === 0) {
    wpFiles.fill(0); bpFiles.fill(0);
  } else {
    const idx = ((pk1 ^ (pk2 << 7) ^ (pk2 >>> 25)) | 0) & PH_MASK;
    if (phKey1[idx] === pk1 && phKey2[idx] === pk2) {
      s = phScore[idx];
      let wb = phWB[idx], bb = phBB[idx];
      for (let f = 0; f < 8; f++) {
        wpFiles[f] = wb & 15; wb >>>= 4;
        bpFiles[f] = bb & 15; bb >>>= 4;
      }
    } else {
      wpFiles.fill(0); bpFiles.fill(0);
      const wpBase = wpIdx * 16, bpBase = bpIdx * 16;
      for (let i = 0; i < wpc; i++) wpFiles[pieceSq[wpBase + i] & 7]++;
      for (let i = 0; i < bpc; i++) bpFiles[pieceSq[bpBase + i] & 7]++;

      // Doubled / isolated
      for (let f = 0; f < 8; f++) {
        if (wpFiles[f] > 1) s -= 12 * (wpFiles[f] - 1);
        if (bpFiles[f] > 1) s += 12 * (bpFiles[f] - 1);
      }
      for (let i = 0; i < wpc; i++) {
        const f = pieceSq[wpBase + i] & 7;
        const left = f > 0 ? wpFiles[f - 1] : 0;
        const right = f < 7 ? wpFiles[f + 1] : 0;
        if (!left && !right) s -= 14;
      }
      for (let i = 0; i < bpc; i++) {
        const f = pieceSq[bpBase + i] & 7;
        const left = f > 0 ? bpFiles[f - 1] : 0;
        const right = f < 7 ? bpFiles[f + 1] : 0;
        if (!left && !right) s += 14;
      }

      // Passed pawns
      for (let i = 0; i < wpc; i++) {
        const sq = pieceSq[wpBase + i];
        const f = sq & 7, r = sq >> 4;
        let blocked = false;
        for (let j = 0; j < bpc; j++) {
          const bs = pieceSq[bpBase + j];
          if ((bs >> 4) > r && Math.abs((bs & 7) - f) <= 1) { blocked = true; break; }
        }
        if (!blocked) s += PASSED[r];
      }
      for (let i = 0; i < bpc; i++) {
        const sq = pieceSq[bpBase + i];
        const f = sq & 7, r = sq >> 4;
        let blocked = false;
        for (let j = 0; j < wpc; j++) {
          const ws = pieceSq[wpBase + j];
          if ((ws >> 4) < r && Math.abs((ws & 7) - f) <= 1) { blocked = true; break; }
        }
        if (!blocked) s -= PASSED[7 - r];
      }

      let wb = 0, bb = 0;
      for (let f = 7; f >= 0; f--) { wb = (wb << 4) | wpFiles[f]; bb = (bb << 4) | bpFiles[f]; }
      phKey1[idx] = pk1; phKey2[idx] = pk2;
      phScore[idx] = s; phWB[idx] = wb; phBB[idx] = bb;
    }
  }

  // Bishop pair
  if (pieceCount[0 * 6 + BISHOP - 1] >= 2) s += 30;
  if (pieceCount[1 * 6 + BISHOP - 1] >= 2) s -= 30;

  // Rooks on open / semi-open files, and on the seventh rank
  for (let c = 0; c < 2; c++) {
    const sign = c === WHITE ? 1 : -1;
    const ri = c * 6 + ROOK - 1;
    const cnt = pieceCount[ri];
    for (let i = 0; i < cnt; i++) {
      const rsq = pieceSq[ri * 16 + i];
      const f = rsq & 7;
      const own = c === WHITE ? wpFiles[f] : bpFiles[f];
      const opp = c === WHITE ? bpFiles[f] : wpFiles[f];
      if (!own && !opp) s += sign * 18;
      else if (!own) s += sign * 8;
      const r = rsq >> 4;
      if ((c === WHITE && r === 6) || (c === BLACK && r === 1)) s += sign * 14;
    }
  }

  // King pawn shield (midgame only)
  if (phase > 8) {
    for (let c = 0; c < 2; c++) {
      const sign = c === WHITE ? 1 : -1;
      const ksq = kingSq[c];
      const d = c === WHITE ? 16 : -16;
      let shield = 0;
      for (let df = -1; df <= 1; df++) {
        const f = (ksq & 7) + df;
        if (f < 0 || f > 7) continue;
        const s1 = ksq + d + df;
        if (validSq(s1) && board[s1] === pc(c, PAWN)) shield += 8;
        else {
          const s2 = s1 + d;
          if (validSq(s2) && board[s2] === pc(c, PAWN)) shield += 4;
          else shield -= 10;
        }
      }
      s += sign * shield;
    }
  }

  return s;
}

function evaluate() {
  const p = Math.min(24, phase);
  let s = Math.trunc((mg * p + eg * (24 - p)) / 24);
  s += extras();
  return (side === WHITE ? s : -s) + 8;
}

// ---------------------------------------------------------------------------
// Transposition table
// ---------------------------------------------------------------------------

const TT_BITS = 21;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const ttKey = new Int32Array(TT_SIZE);
const ttMoveArr = new Int32Array(TT_SIZE);
const ttScore = new Int32Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE);
const ttFlag = new Int8Array(TT_SIZE);

function clearTT() {
  ttKey.fill(0); ttMoveArr.fill(0); ttScore.fill(0);
  ttDepth.fill(0); ttFlag.fill(0);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

let nodes = 0;
let hardStop = Infinity;
let softStop = Infinity;
let nodeLimit = Infinity;
let searchStop = false;
let infoHandler = null;

function setInfoHandler(fn) { infoHandler = fn; }

function hasNonPawn(c) {
  return pieceCount[c * 6 + KNIGHT - 1] > 0 ||
         pieceCount[c * 6 + BISHOP - 1] > 0 ||
         pieceCount[c * 6 + ROOK - 1] > 0 ||
         pieceCount[c * 6 + QUEEN - 1] > 0;
}

function isRepetition() {
  const stop = Math.max(0, histLen - 1 - halfmove);
  for (let i = histLen - 3; i >= stop; i -= 2) {
    if (posH1[i] === h1 && posH2[i] === h2) return true;
  }
  return false;
}

// A claimable threefold: the current position plus two earlier identical
// occurrences within the reversible window. Search uses isRepetition() above to
// break cycles, but a single repetition is not a draw.
function isThreefold() {
  const stop = Math.max(0, histLen - 1 - halfmove);
  let seen = 0;
  for (let i = histLen - 3; i >= stop; i -= 2) {
    if (posH1[i] === h1 && posH2[i] === h2 && ++seen >= 2) return true;
  }
  return false;
}

// Dead position (FIDE 5.2.2): no legal sequence can produce mate. Pawns,
// rooks and queens can always mate in principle, so their presence settles it.
function isInsufficientMaterial() {
  for (let c = 0; c < 2; c++) {
    if (pieceCount[c * 6 + PAWN - 1] || pieceCount[c * 6 + ROOK - 1] ||
        pieceCount[c * 6 + QUEEN - 1]) return false;
  }
  const knights = pieceCount[KNIGHT - 1] + pieceCount[6 + KNIGHT - 1];
  const bishops = pieceCount[BISHOP - 1] + pieceCount[6 + BISHOP - 1];
  if (knights === 0 && bishops === 0) return true;
  if (knights + bishops === 1) return true;
  if (knights === 0) {
    let colour = -1;
    let sameColour = true;
    for (let c = 0; c < 2 && sameColour; c++) {
      const pi = c * 6 + BISHOP - 1;
      for (let i = 0; i < pieceCount[pi]; i++) {
        const sq = pieceSq[pi * 16 + i];
        const sqColour = ((sq >> 4) + (sq & 7)) & 1;
        if (colour < 0) colour = sqColour;
        else if (colour !== sqColour) { sameColour = false; break; }
      }
    }
    if (sameColour) return true;
  }
  return false;
}

function isCheckmate() {
  return inCheck() && getLegalMoves().length === 0;
}

function isStalemate() {
  return !inCheck() && getLegalMoves().length === 0;
}

function isDraw() {
  return isStalemate() || isInsufficientMaterial() || halfmove >= 100 || isThreefold();
}

function moveScore(mv, ttMove, ply, prevMv) {
  if (mv === ttMove) return 1 << 28;
  const from = mv & 127;
  const to = (mv >>> 7) & 127;
  const promo = (mv >>> 14) & 7;
  const flags = mv & (F_CAP | F_EP | F_CASTLE | F_DOUBLE);

  if (promo) return (1 << 24) + promo * 1000;

  if (flags & F_CAP) {
    const victim = board[to] ? typeOf(board[to]) : PAWN;
    const attacker = typeOf(board[from]);
    return (1 << 22) + VAL_MG[victim] * 16 - VAL_MG[attacker];
  }

  if (mv === killers[ply * 2]) return 1 << 21;
  if (mv === killers[ply * 2 + 1]) return 1 << 20;

  if (prevMv && counter[((prevMv & 127) << 7) | ((prevMv >>> 7) & 127)] === mv) return 1 << 19;

  return history[side * 16384 + from * 128 + to];
}

function pickMove(base, n, i) {
  let best = i;
  let bestScore = scoreBuf[base + i];
  for (let j = i + 1; j < n; j++) {
    const sc = scoreBuf[base + j];
    if (sc > bestScore) { best = j; bestScore = sc; }
  }
  if (best !== i) {
    const tm = moveBuf[base + i];
    moveBuf[base + i] = moveBuf[base + best];
    moveBuf[base + best] = tm;
    const ts = scoreBuf[base + i];
    scoreBuf[base + i] = scoreBuf[base + best];
    scoreBuf[base + best] = ts;
  }
  return moveBuf[base + i];
}

function quiesce(alpha, beta, ply, inCheck) {
  nodes++;
  if ((nodes & 1023) === 0) {
    if (nodes >= nodeLimit || Date.now() >= hardStop) searchStop = true;
  }
  if (searchStop) return 0;
  if (ply >= MAX_PLY - 1) return evaluate();

  let best;
  if (!inCheck) {
    const stand = evaluate();
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    best = stand;
  } else {
    best = -INF;
  }

  const base = ply * MAX_MOVES;
  const n = generateMoves(base, !inCheck);
  for (let i = 0; i < n; i++) scoreBuf[base + i] = moveScore(moveBuf[base + i], 0, ply, 0);

  let legal = 0;
  for (let i = 0; i < n; i++) {
    const mv = pickMove(base, n, i);
    const flags = mv & (F_CAP | F_EP | F_CASTLE | F_DOUBLE);

    if (!inCheck) {
      const to = (mv >>> 7) & 127;
      const promo = (mv >>> 14) & 7;
      const victim = (flags & F_CAP) ? (board[to] ? typeOf(board[to]) : PAWN) : 0;
      if (!promo && victim && best + VAL_MG[victim] + 200 < alpha) continue;
    }

    makeMove(mv);
    if (isAttacked(kingSq[side ^ 1], side)) { unmakeMove(mv); continue; }
    legal++;

    const givesCheck = isAttacked(kingSq[side], side ^ 1);
    const sc = -quiesce(-beta, -alpha, ply + 1, givesCheck);
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
  if (inCheck && legal === 0) return -MATE + ply;
  return best;
}

// Late move reduction table: precomputed log(depth)*log(moveNumber) curve.
const LMR = new Array(MAX_PLY);
for (let d = 0; d < MAX_PLY; d++) {
  LMR[d] = new Int32Array(MAX_MOVES);
  if (d < 3) continue;
  const ld = Math.log(d);
  for (let m = 0; m < MAX_MOVES; m++) {
    const r = Math.floor(0.75 + ld * Math.log(Math.max(1, m)) / 2.2);
    LMR[d][m] = r < 1 ? 1 : r;
  }
}

function negamax(depth, alpha, beta, ply, canNull) {
  nodes++;
  if ((nodes & 1023) === 0) {
    if (nodes >= nodeLimit || Date.now() >= hardStop) searchStop = true;
  }
  if (searchStop) return 0;

  pvLength[ply] = ply;

  if (ply > 0) {
    if (halfmove >= 100) return 0;
    if (isRepetition() || isInsufficientMaterial()) return 0;
  }
  if (ply >= MAX_PLY - 1) return evaluate();

  let ttMove = 0;
  const idx = (h1 >>> 0) & TT_MASK;
  if (ttKey[idx] === h2) {
    ttMove = ttMoveArr[idx];
    if (ttDepth[idx] >= depth) {
      let sc = ttScore[idx];
      if (sc > MATE - 1000) sc -= ply;
      else if (sc < -MATE + 1000) sc += ply;
      const fl = ttFlag[idx];
      if (fl === 0) return sc;
      if (fl === 1 && sc <= alpha) return sc;
      if (fl === 2 && sc >= beta) return sc;
    }
  }

  const inCheck = isAttacked(kingSq[side], side ^ 1);
  if (depth <= 0) return quiesce(alpha, beta, ply, inCheck);

  const staticEval = inCheck ? -INF : evaluate();

  if (!inCheck && depth <= 2 && staticEval - 120 * depth >= beta) return staticEval;

  if (canNull && !inCheck && depth >= 3 && staticEval >= beta && hasNonPawn(side)) {
    const R = 2 + (depth > 6 ? 1 : 0);
    makeNull();
    const sc = -negamax(depth - 1 - R, -beta, -beta + 1, ply + 1, false);
    unmakeNull();
    if (searchStop) return 0;
    if (sc >= beta) return beta;
  }

  const base = ply * MAX_MOVES;
  const prevMv = ply > 0 ? moveStack[ply - 1] : 0;
  const n = generateMoves(base, false);
  for (let i = 0; i < n; i++) scoreBuf[base + i] = moveScore(moveBuf[base + i], ttMove, ply, prevMv);

  let bestScore = -INF;
  let bestMove = 0;
  let legal = 0;
  const oldAlpha = alpha;

  for (let i = 0; i < n; i++) {
    const mv = pickMove(base, n, i);
    const flags = mv & (F_CAP | F_EP | F_CASTLE | F_DOUBLE);
    const promo = (mv >>> 14) & 7;

    makeMove(mv);
    if (isAttacked(kingSq[side ^ 1], side)) { unmakeMove(mv); continue; }
    legal++;
    moveStack[ply] = mv;

    const givesCheck = isAttacked(kingSq[side], side ^ 1);
    // Check extension: forced replies are cheap to resolve, so keep the depth.
    let newDepth = depth - 1;
    if (givesCheck && depth >= 2 && depth <= 6 && ply < 40) newDepth++;
    let sc;

    if (legal === 1) {
      sc = -negamax(newDepth, -beta, -alpha, ply + 1, true);
    } else {
      let reduction = 0;
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
        pvTable[ply * MAX_PLY + ply] = mv;
        let j = ply + 1;
        for (; j < pvLength[ply + 1]; j++) {
          pvTable[ply * MAX_PLY + j] = pvTable[(ply + 1) * MAX_PLY + j];
        }
        pvLength[ply] = j;

        if (sc >= beta) {
          if (!(flags & F_CAP) && !promo) {
            if (killers[ply * 2] !== mv) {
              killers[ply * 2 + 1] = killers[ply * 2];
              killers[ply * 2] = mv;
            }
            const hi = side * 16384 + (mv & 127) * 128 + ((mv >>> 7) & 127);
            history[hi] += depth * depth;
            if (history[hi] > (1 << 20)) history[hi] = 1 << 20;
            if (prevMv) counter[((prevMv & 127) << 7) | ((prevMv >>> 7) & 127)] = mv;
          }
          ttStore(depth, sc, 2, mv, ply);
          return sc;
        }
      }
    }
  }

  if (legal === 0) return inCheck ? -MATE + ply : 0;

  ttStore(depth, bestScore, bestScore > oldAlpha ? 0 : 1, bestMove, ply);
  return bestScore;
}

function ttStore(depth, score, flag, move, ply) {
  const idx = (h1 >>> 0) & TT_MASK;
  if (ttKey[idx] === h2 && ttDepth[idx] > depth + 2 && ttFlag[idx] === 0) return;
  ttKey[idx] = h2;
  ttMoveArr[idx] = move;
  ttDepth[idx] = depth;
  ttFlag[idx] = flag;
  let sc = score;
  if (sc > MATE - 1000) sc += ply;
  else if (sc < -MATE + 1000) sc -= ply;
  ttScore[idx] = sc;
}

// ---------------------------------------------------------------------------
// Root search + iterative deepening
// ---------------------------------------------------------------------------

let rootBest = 0;
let rootScore = 0;
let rootDepth = 0;
let rootPrevBest = 0;

function rootSearch(depth, alpha, beta) {
  const base = 0;
  const n = generateMoves(base, false);
  for (let i = 0; i < n; i++) {
    const mv = moveBuf[base + i];
    let sc = moveScore(mv, rootPrevBest, 0, 0);
    if (mv === rootPrevBest) sc = 1 << 29;
    scoreBuf[base + i] = sc;
  }

  let bestScore = -INF;
  let bestMove = 0;
  let legal = 0;
  pvLength[0] = 0;

  for (let i = 0; i < n; i++) {
    const mv = pickMove(base, n, i);
    makeMove(mv);
    if (isAttacked(kingSq[side ^ 1], side)) { unmakeMove(mv); continue; }
    legal++;
    moveStack[0] = mv;

    let sc;
    if (legal === 1) {
      sc = -negamax(depth - 1, -beta, -alpha, 1, true);
    } else {
      sc = -negamax(depth - 1, -alpha - 1, -alpha, 1, true);
      if (sc > alpha && sc < beta) sc = -negamax(depth - 1, -beta, -alpha, 1, true);
    }
    unmakeMove(mv);

    if (searchStop) break;

    if (sc > bestScore) {
      bestScore = sc;
      bestMove = mv;
      if (sc > alpha) {
        alpha = sc;
        pvTable[0] = mv;
        let j = 1;
        for (; j < pvLength[1]; j++) pvTable[j] = pvTable[MAX_PLY + j];
        pvLength[0] = j;
      }
    }
  }

  // No legal move at the root: distinguish checkmate (-MATE) from stalemate
  // (0). Leaving -INF here would not be a legal UCI score or game result.
  if (legal === 0) bestScore = isAttacked(kingSq[side], side ^ 1) ? -MATE : 0;

  return { score: bestScore, move: bestMove, legal };
}

function scoreToUci(sc) {
  if (sc > MATE - 1000) return 'mate ' + Math.ceil((MATE - sc) / 2);
  if (sc < -MATE + 1000) return 'mate ' + -Math.ceil((MATE + sc) / 2);
  return 'cp ' + sc;
}

function extractPv() {
  const out = [];
  for (let i = 0; i < pvLength[0]; i++) out.push(moveToStr(pvTable[i]));
  return out;
}

function search(opts = {}) {
  const now = Date.now();
  const maxDepth = Math.min(opts.depth || MAX_PLY - 1, MAX_PLY - 2);

  let hard = Infinity, soft = Infinity;
  let moveAlloc = 0; // per-move budget in clock mode, for the stability exit
  if (opts.movetime) {
    hard = now + opts.movetime;
    soft = hard;
  } else if (opts.wtime !== undefined) {
    const t = side === WHITE ? opts.wtime : opts.btime;
    const inc = side === WHITE ? (opts.winc || 0) : (opts.binc || 0);
    const mtg = opts.movestogo && opts.movestogo > 0 ? opts.movestogo : 50;
    // Leave a cushion so bestmove always reaches the GUI before the flag.
    const reserve = Math.min(150, Math.max(30, Math.floor(t * 0.02)));
    const budget = Math.max(10, t - reserve);
    let alloc = Math.floor(t / mtg + inc * 0.6);
    alloc = Math.min(alloc, Math.floor(t * 0.5));
    alloc = Math.max(10, Math.min(alloc, budget));
    moveAlloc = alloc;
    soft = now + alloc;
    // Hard limit: one iteration may overshoot the soft budget, but never by
    // more than half of it, and never past the clock cushion.
    hard = now + Math.min(budget, Math.floor(alloc * 1.5));
  } else if (opts.infinite) {
    hard = now + 20000;
    soft = hard;
  } else if (opts.depth) {
    hard = Infinity;
    soft = Infinity;
  } else {
    hard = now + 1000;
    soft = hard;
  }

  hardStop = hard;
  softStop = soft;
  nodeLimit = opts.nodes || Infinity;
  searchStop = false;
  nodes = 0;
  rootPrevBest = 0;
  rootBest = 0;
  rootScore = 0;
  rootDepth = 0;
  pvLength.fill(0);
  killers.fill(0);
  // Age history scores so old cutoffs do not dominate a new position.
  for (let i = 0; i < history.length; i++) history[i] >>= 1;

  const started = now;

  // The root itself can already be a claimable draw. Return a legal move and
  // score 0 immediately; stalemate has no legal move and falls through.
  if (isDraw()) {
    const legal = getLegalMoves();
    if (legal.length) {
      const mv = legal[0];
      const move = moveToStr(mv);
      if (infoHandler) infoHandler(`info depth 1 score cp 0 nodes 0 nps 0 time 0 pv ${move}`);
      return { bestMove: mv, bestMoveStr: move, score: 0, depth: 1, nodes: 0, time: 0, pv: [move] };
    }
  }

  let lastPv = [];
  let prevScore = 0;
  let prevIterMove = 0;
  let stable = 0;

  for (let d = 1; d <= maxDepth; d++) {
    const iterStart = Date.now();
    // Aspiration windows: expect the score to move a little from last depth.
    // Narrow search, widen on a fail, fall back to a full window on mates.
    let res;
    if (d >= 5 && Math.abs(prevScore) < MATE - 100) {
      let delta = 40;
      let alpha = prevScore - delta;
      let beta = prevScore + delta;
      for (;;) {
        res = rootSearch(d, alpha, beta);
        if (searchStop || res.legal === 0) break;
        if (Math.abs(res.score) > MATE - 100) {
          res = rootSearch(d, -INF, INF);
          break;
        }
        if (res.score <= alpha) {
          delta *= 2;
          alpha = Math.max(-INF, res.score - delta);
        } else if (res.score >= beta) {
          delta *= 2;
          beta = Math.min(INF, res.score + delta);
        } else {
          break;
        }
      }
    } else {
      res = rootSearch(d, -INF, INF);
    }
    if (searchStop && d > 1) break;
    if (res.legal === 0) {
      // A timeout can leave legal at 0 before a first root move completes, so
      // only report a terminal score when the position really has none.
      if (getLegalMoves().length === 0) {
        rootScore = res.score;
        rootBest = 0;
        rootDepth = 1;
        if (infoHandler) {
          const elapsed = Math.max(1, Date.now() - started);
          infoHandler(
            `info depth 1 score ${scoreToUci(res.score)} nodes ${nodes} nps ${Math.round(nodes * 1000 / elapsed)} time ${elapsed}`
          );
        }
      }
      break;
    }
    prevScore = res.score;
    rootBest = res.move;
    rootScore = res.score;
    rootDepth = d;
    rootPrevBest = res.move;
    lastPv = extractPv();

    // Stability exit: if the best move has not changed for two iterations,
    // stop once we have used most of the soft budget instead of burning it all.
    if (res.move === prevIterMove) stable++; else stable = 0;
    prevIterMove = res.move;

    if (infoHandler) {
      const elapsed = Math.max(1, Date.now() - started);
      infoHandler(
        `info depth ${d} score ${scoreToUci(res.score)} nodes ${nodes} nps ${Math.round(nodes * 1000 / elapsed)} time ${elapsed} pv ${lastPv.join(' ')}`
      );
    }

    if (Math.abs(res.score) > MATE - 100) break;
    if (searchStop) break;
    const elapsed = Date.now() - started;
    if (Date.now() >= softStop) break;
    if (moveAlloc && stable >= 2 && elapsed >= moveAlloc * 0.55) break;
    // Skip the next iteration if this one's cost says it will not fit in the
    // remaining budget: iteration time roughly doubles each ply.
    if (moveAlloc && elapsed + (Date.now() - iterStart) * 1.6 >= moveAlloc) break;
  }

  // Never return a null move when a legal move exists.
  if (!rootBest) {
    const legal = getLegalMoves();
    if (legal.length) {
      rootBest = legal[0];
      if (rootDepth === 0) rootDepth = 1;
    }
  }

  return {
    bestMove: rootBest,
    bestMoveStr: rootBest ? moveToStr(rootBest) : '0000',
    score: rootScore,
    depth: rootDepth,
    nodes,
    time: Date.now() - started,
    pv: lastPv,
  };
}

// ---------------------------------------------------------------------------
// Human move prediction
// ---------------------------------------------------------------------------

function getLegalMoves() {
  const base = 0;
  const n = generateMoves(base, false);
  const out = [];
  for (let i = 0; i < n; i++) {
    const mv = moveBuf[base + i];
    makeMove(mv);
    if (!isAttacked(kingSq[side ^ 1], side)) out.push(mv);
    unmakeMove(mv);
  }
  return out;
}

function moveToStr(mv) {
  const from = mv & 127;
  const to = (mv >>> 7) & 127;
  const promo = (mv >>> 14) & 7;
  const f1 = String.fromCharCode(97 + (from & 7)) + String.fromCharCode(49 + (from >> 4));
  const f2 = String.fromCharCode(97 + (to & 7)) + String.fromCharCode(49 + (to >> 4));
  let s = f1 + f2;
  if (promo) s += 'nbrq'[promo - 2];
  return s;
}

function openingBonus(mv, from, to) {
  const b = board;
  const us = side;
  const is = (f, t) => from === f && to === t;
  let p = 0;

  if (us === WHITE) {
    // First move: what humans actually play.
    if (fullmove === 1) {
      if (is(0x14, 0x34)) p += 100;      // e2e4
      else if (is(0x13, 0x33)) p += 80;  // d2d4
      else if (is(0x06, 0x25)) p += 25;  // g1f3
      else if (is(0x12, 0x32)) p += 20;  // c2c4
    }

    // 1.e4 e5: White's natural second move.
    if (b[0x34] === 1 && b[0x44] === 9) {
      if (is(0x06, 0x25)) p += 30;       // Nf3
      else if (is(0x05, 0x32)) p += 10;  // Bc4
      else if (is(0x01, 0x22)) p += 6;   // Nc3
      else if (is(0x13, 0x33)) p += 10;  // d4
    }

    // Philidor-ish: ...d6 against e4, White usually takes the centre.
    if (b[0x34] === 1 && b[0x44] === 9 && b[0x53] === 9 && b[0x25] === 2) {
      if (is(0x13, 0x33)) p += 20;       // d4
      else if (is(0x05, 0x32)) p += 10;  // Bc4
      else if (is(0x01, 0x22)) p += 6;   // Nc3
    }

    // 1.d4 d5 / 1.d4 Nf6: natural second moves.
    if (b[0x33] === 1 && (b[0x43] === 9 || b[0x55] === 10)) {
      if (is(0x12, 0x32)) p += 20;       // c4
      else if (is(0x06, 0x25)) p += 14;  // Nf3
      else if (is(0x01, 0x22)) p += 6;   // Nc3
    }

    // Classical e4 e5: Bg5 pin once Black has developed ...Nf6.
    if (b[0x34] === 1 && b[0x44] === 9 && b[0x55] === 10) {
      if (is(0x02, 0x46)) p += 12;       // Bg5
    }

    // e4 e5 Nf3 Nc6: Italian / Spanish.
    if (b[0x34] === 1 && b[0x44] === 9 && b[0x25] === 2 && b[0x52] === 10) {
      if (is(0x05, 0x51)) p += 18;       // Bb5
      else if (is(0x05, 0x32)) p += 16;  // Bc4
      else if (is(0x13, 0x33)) p += 8;   // d4
    }
  } else {
    // Black's first reply, keyed off White's first move.
    if (fullmove === 1) {
      if (b[0x34] === 1) { // 1.e4
        if (is(0x64, 0x44)) p += 95;      // e5
        else if (is(0x62, 0x42)) p += 65; // c5
        else if (is(0x64, 0x54)) p += 18; // e6
        else if (is(0x62, 0x52)) p += 12; // c6
        else if (is(0x76, 0x55)) p += 8;  // Nf6
      } else if (b[0x33] === 1) { // 1.d4
        if (is(0x76, 0x55)) p += 60;      // Nf6
        else if (is(0x63, 0x43)) p += 50; // d5
        else if (is(0x64, 0x54)) p += 15; // e6
        else if (is(0x62, 0x52)) p += 6;  // c6
      } else if (b[0x25] === 2) { // 1.Nf3
        if (is(0x63, 0x43)) p += 35;      // d5
        else if (is(0x76, 0x55)) p += 30; // Nf6
        else if (is(0x62, 0x42)) p += 10; // c5
      } else if (b[0x32] === 1) { // 1.c4
        if (is(0x64, 0x44)) p += 35;      // e5
        else if (is(0x76, 0x55)) p += 25; // Nf6
        else if (is(0x62, 0x42)) p += 12; // c5
      }
    }

    // e4 e5 Nf3: Black's natural reply.
    if (b[0x34] === 1 && b[0x44] === 9 && b[0x25] === 2) {
      if (is(0x71, 0x52)) p += 25;        // Nc6
      else if (is(0x76, 0x55)) p += 8;    // Nf6
      else if (is(0x63, 0x53)) p += 10;   // d6
      else if (is(0x75, 0x42)) p += 4;    // Bc5
    }

    // ...d6 systems: the pinning ...Bg4 is a common human choice.
    if (b[0x34] === 1 && b[0x44] === 9 && b[0x53] === 9 && b[0x25] === 2) {
      if (is(0x72, 0x36)) p += 26;        // Bg4
      else if (is(0x71, 0x52)) p += 8;    // Nc6
    }
  }

  return p;
}

function movePrior(mv, givesCheck, isCastle, opening) {
  const from = mv & 127;
  const to = (mv >>> 7) & 127;
  const promo = (mv >>> 14) & 7;
  const flags = mv & (F_CAP | F_EP | F_CASTLE | F_DOUBLE);
  let p = 0;

  if (flags & F_CASTLE) p += 8;
  if (flags & F_CAP) p += 5;
  if (givesCheck) p += 6;

  if (opening) p += openingBonus(mv, from, to);

  return p;
}

// Feature flags for the human-move model are computed by predict-model.js,
// which walks the board through this context. engine.js hands it make/unmake
// instead of applyUciMove/setFen so that running a prediction can never destroy
// the move history the repetition and fifty-move rules read.
function makeFlagContext(legalInts) {
  let undo = 0;
  return {
    describeMove, getFen, inCheck, getLegalMoves, moveToStr, WHITE,
    get side() { return side; },
    get kingSq() { return kingSq; },
    applyUciMove(uci) {
      const mv = legalInts.find(m => moveToStr(m) === uci);
      if (mv === undefined) return false;
      undo = mv;
      makeMove(mv);
      return true;
    },
    setFen() {
      if (undo) { unmakeMove(undo); undo = 0; }
    },
  };
}

// The blend lives here so test/fit-predict.js can re-fit it on training data
// without re-running the search for every candidate weight.
function blendAndRank(results, cfg) {
  const capScore = sc => Math.max(-1500, Math.min(1500, sc));
  const blended = r =>
    capScore(r.score) * cfg.searchWeight +
    (r.logp !== undefined ? cfg.priorWeight * r.logp : r.prior * cfg.priorScale);

  let maxB = -Infinity;
  for (const r of results) maxB = Math.max(maxB, blended(r));
  let total = 0;
  for (const r of results) { r.p = Math.exp((blended(r) - maxB) / cfg.temperature); total += r.p; }
  for (const r of results) r.p /= total;
  results.sort((a, b) => b.p - a.p);
  return results;
}

function predict(opts = {}) {
  const depth = opts.depth || 5;
  const budget = opts.movetime || 3000;
  const usePrior = opts.prior !== false;

  // Data-driven prior (predict-model.js + data/human-priors.json). Loaded
  // lazily: the engine works with the model files absent, and requiring the
  // book/model at module load would tie every caller to them.
  let model = null, bookData = null;
  // The model is independent of the hand-written structural prior: `prior:false`
  // must still allow a raw, model-scored ranking (test/fit-predict.js relies on
  // that to fit the blend without the structural terms).
  if (opts.model !== false) {
    try {
      model = require('./predict-model.js');
      if (!model.available()) model = null;
    } catch (err) { model = null; }
    if (model) {
      try { bookData = require('./book.js').BOOK; } catch (err) { bookData = null; }
    }
  }
  const mw = model ? model.getWeights() : null;
  const temperature = opts.temperature === undefined ? (mw ? mw.temperature : 30) : opts.temperature;
  const priorScale = opts.priorScale === undefined ? 1 : opts.priorScale;
  const priorWeight = opts.priorWeight === undefined ? (mw ? mw.priorWeight : 0) : opts.priorWeight;
  const searchWeight = opts.searchWeight === undefined ? (mw ? mw.searchWeight : 1) : opts.searchWeight;

  const now = Date.now();
  hardStop = now + budget;
  softStop = hardStop;
  nodeLimit = Infinity;
  searchStop = false;
  nodes = 0;

  const opening = fullmove <= 12;
  const beforeFen = getFen();
  const legal = getLegalMoves();
  const results = [];

  for (const mv of legal) {
    const from = mv & 127;
    makeMove(mv);
    const givesCheck = isAttacked(kingSq[side], side ^ 1);
    const sc = -negamax(depth - 1, -INF, INF, 1, true);
    unmakeMove(mv);
    if (searchStop) break;

    const flags = mv & (F_CAP | F_EP | F_CASTLE | F_DOUBLE);
    // With the trained model the hand-written structural prior is redundant:
    // capture / check / castling / development are features of the model.
    const prior = model ? 0 : (usePrior ? movePrior(mv, givesCheck, !!(flags & F_CASTLE), opening) : 0);
    results.push({ mv, score: sc, prior });
  }

  // If time ran out, give unscored moves a low score rather than dropping them.
  for (const mv of legal) {
    if (!results.some(r => r.mv === mv)) results.push({ mv, score: -2000, prior: 0 });
  }

  let source = model ? 'backoff' : 'hand';
  if (model) {
    const legalInts = results.map(r => r.mv);
    const bookKey = beforeFen.split(' ').slice(0, 3).join(' ');
    // Only this position's book rows are needed for the `inBook` feature.
    const bookTable = new Map();
    if (bookData && bookData[bookKey]) bookTable.set(bookKey, new Set(bookData[bookKey].map(r => r[0])));
    const lp = model.logPrior(makeFlagContext(legalInts), beforeFen, legalInts,
                               legalInts.map(m => moveToStr(m)), bookTable,
                               opts.loo ? new Map([[opts.loo, 1]]) : null);
    if (lp) {
      for (let i = 0; i < results.length; i++) results[i].logp = lp.logp[i];
      source = lp.source;
    } else {
      model = null;
    }
  }

  const ranked = blendAndRank(results, {
    searchWeight, priorWeight, priorScale, temperature,
  });

  const top = ranked.slice(0, opts.top || 5).map(r => ({
    move: moveToStr(r.mv),
    prob: r.p,
    score: r.score,
    prior: r.prior,
    logp: r.logp,
  }));

  return {
    moves: opts.raw ? ranked.map(r => ({ move: moveToStr(r.mv), score: r.score, prior: r.prior, logp: r.logp })) : top,
    best: top.length ? top[0].move : null,
    confidence: top.length ? top[0].prob : 0,
    depth,
    time: Date.now() - now,
    searched: results.length,
    priorSource: model ? source : 'hand',
  };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function applyUciMove(str) {
  const legal = getLegalMoves();
  for (const mv of legal) {
    if (moveToStr(mv) === str) { makeMove(mv); return true; }
  }
  return false;
}

function boardAscii() {
  const rows = [];
  for (let r = 7; r >= 0; r--) {
    let line = (r + 1) + ' ';
    for (let f = 0; f < 8; f++) {
      const p = board[r * 16 + f];
      line += p ? ' PNBRQK'[p & 7] : '.';
      if (p && (p >> 3) === BLACK) line = line.slice(0, -1) + (' PNBRQK'[p & 7]).toLowerCase();
      line += ' ';
    }
    rows.push(line);
  }
  rows.push('  a b c d e f g h');
  return rows.join('\n');
}

function perft(depth, ply = 0) {
  if (depth === 0) return 1;
  const base = ply * MAX_MOVES;
  const n = generateMoves(base, false);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const mv = moveBuf[base + i];
    makeMove(mv);
    if (!isAttacked(kingSq[side ^ 1], side)) total += perft(depth - 1, ply + 1);
    unmakeMove(mv);
  }
  return total;
}

function inCheck() {
  return isAttacked(kingSq[side], side ^ 1);
}

function randomMove() {
  const l = getLegalMoves();
  return l.length ? l[(Math.random() * l.length) | 0] : 0;
}

function greedyMove() {
  const l = getLegalMoves();
  let best = 0, bestScore = -INF;
  for (const mv of l) {
    makeMove(mv);
    const sc = -evaluate();
    unmakeMove(mv);
    if (sc > bestScore) { bestScore = sc; best = mv; }
  }
  return best;
}

function getFen() {
  let out = '';
  for (let r = 7; r >= 0; r--) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = board[r * 16 + f];
      if (!p) { empty++; continue; }
      if (empty) { out += empty; empty = 0; }
      const ch = ' PNBRQK'[p & 7];
      out += (p >> 3) === BLACK ? ch.toLowerCase() : ch;
    }
    if (empty) out += empty;
    if (r) out += '/';
  }
  out += ' ' + (side === WHITE ? 'w' : 'b') + ' ';
  let cr = '';
  if (castling & 1) cr += 'K';
  if (castling & 2) cr += 'Q';
  if (castling & 4) cr += 'k';
  if (castling & 8) cr += 'q';
  out += cr || '-';
  out += ' ' + (epSq >= 0 ? String.fromCharCode(97 + (epSq & 7)) + String.fromCharCode(49 + (epSq >> 4)) : '-');
  out += ' ' + halfmove + ' ' + fullmove;
  return out;
}

function previewKeyAfter(uci) {
  if (typeof uci !== 'string') return null;
  for (const mv of getLegalMoves()) {
    if (moveToStr(mv) !== uci) continue;
    makeMove(mv);
    const fen = getFen();
    unmakeMove(mv);
    return fen.split(' ').slice(0, 3).join(' ');
  }
  return null;
}

function applyMoveInt(mv) {
  makeMove(mv);
}

function describeMove(mv) {
  const from = mv & 127;
  const to = (mv >>> 7) & 127;
  const flags = mv & (F_CAP | F_EP | F_CASTLE | F_DOUBLE);
  return {
    from,
    to,
    piece: typeOf(board[from]),
    color: colorOf(board[from]),
    cap: !!(flags & F_CAP),
    ep: !!(flags & F_EP),
    castle: !!(flags & F_CASTLE),
    promo: (mv >>> 14) & 7,
  };
}

module.exports = {
  WHITE, BLACK, START_FEN,
  setFen, applyUciMove, getLegalMoves, moveToStr, boardAscii,
  search, predict, perft, evaluate, inCheck,
  isCheckmate, isStalemate, isInsufficientMaterial, isDraw,
  isRepetition, isThreefold, epCapturePossible,
  setInfoHandler, clearTT, hasNonPawn,
  randomMove, greedyMove, getFen, applyMoveInt, describeMove, previewKeyAfter,
  get side() { return side; },
  get halfmove() { return halfmove; },
  get fullmove() { return fullmove; },
  get kingSq() { return kingSq; },
  get nodes() { return nodes; },
  VAL_MG,
};
