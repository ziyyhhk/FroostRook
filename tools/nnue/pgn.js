'use strict';

/*
 * tools/nnue/pgn.js
 *
 * Standalone PGN reader + 0x88 board + legal move generator + NNUE feature
 * extraction for the experimental FRNN1 evaluator.
 *
 * This module deliberately does NOT import engine.js: the trainer must keep
 * working even if the engine front-end changes, and it needs the raw board to
 * build accumulator features. The board encoding matches the engine:
 *
 *   board[128], square = rank*16 + file, a1 = 0, rank 0 = white's first rank
 *   white pieces 1..6 = PAWN..KING, black pieces 9..14 (piece | 8)
 *   side 0 = white, 1 = black
 *
 * Licensing of the input data is documented in docs/NNUE.md: the PGN files in
 * test/human-games/ are Lichess database exports (CC0 1.0).
 */

const WHITE = 0, BLACK = 1;
const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const F_CAP = 1, F_EP = 2, F_CASTLE = 4, F_DOUBLE = 8;

const KNIGHT_D = [33, 31, 18, 14, -33, -31, -18, -14];
const KING_D = [17, 16, 15, 1, -1, -15, -16, -17];
const BISHOP_D = [17, 15, -15, -17];
const ROOK_D = [16, -16, 1, -1];

const CHAR_TO_PIECE = {
  P: 1, N: 2, B: 3, R: 4, Q: 5, K: 6,
  p: 9, n: 10, b: 11, r: 12, q: 13, k: 14,
};

const colorOf = p => p >> 3;
const typeOf = p => p & 7;
const pc = (c, t) => t | (c << 3);
const validSq = s => (s & 0x88) === 0;

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

function newBoard() {
  return {
    b: new Int8Array(128),
    side: WHITE,
    castling: 0,
    ep: -1,
    half: 0,
    full: 1,
    kings: [-1, -1],
  };
}

function setFen(pos, fen) {
  pos.b.fill(0);
  const parts = fen.trim().split(/\s+/);
  let rank = 7, file = 0;
  for (const ch of parts[0]) {
    if (ch === '/') { rank--; file = 0; }
    else if (ch >= '1' && ch <= '8') file += ch.charCodeAt(0) - 48;
    else {
      const sq = rank * 16 + file;
      const piece = CHAR_TO_PIECE[ch];
      if (!piece) throw new Error('bad FEN piece ' + ch + ' in ' + fen);
      if (!validSq(sq) || file > 7) throw new Error('bad FEN rank in ' + fen);
      pos.b[sq] = piece;
      if (typeOf(piece) === KING) pos.kings[colorOf(piece)] = sq;
      file++;
    }
  }
  pos.side = parts[1] === 'b' ? BLACK : WHITE;
  pos.castling = 0;
  const cr = parts[2] || '-';
  if (cr.includes('K')) pos.castling |= 1;
  if (cr.includes('Q')) pos.castling |= 2;
  if (cr.includes('k')) pos.castling |= 4;
  if (cr.includes('q')) pos.castling |= 8;
  pos.ep = -1;
  if (parts[3] && parts[3] !== '-') {
    pos.ep = (parts[3].charCodeAt(1) - 49) * 16 + (parts[3].charCodeAt(0) - 97);
  }
  pos.half = parts[4] ? (parseInt(parts[4], 10) || 0) : 0;
  pos.full = parts[5] ? (parseInt(parts[5], 10) || 1) : 1;
  return pos;
}

function getFen(pos) {
  let out = '';
  for (let r = 7; r >= 0; r--) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = pos.b[r * 16 + f];
      if (!p) { empty++; continue; }
      if (empty) { out += empty; empty = 0; }
      const ch = ' PNBRQK'[p & 7];
      out += (p >> 3) === BLACK ? ch.toLowerCase() : ch;
    }
    if (empty) out += empty;
    if (r) out += '/';
  }
  out += ' ' + (pos.side === WHITE ? 'w' : 'b') + ' ';
  let cr = '';
  if (pos.castling & 1) cr += 'K';
  if (pos.castling & 2) cr += 'Q';
  if (pos.castling & 4) cr += 'k';
  if (pos.castling & 8) cr += 'q';
  out += cr || '-';
  out += ' ';
  out += pos.ep >= 0
    ? String.fromCharCode(97 + (pos.ep & 7)) + String.fromCharCode(49 + (pos.ep >> 4))
    : '-';
  out += ' ' + pos.half + ' ' + pos.full;
  return out;
}

function isAttacked(pos, sq, by) {
  const b = pos.b;
  // Pawns: white attackers step +15/+17 from their square.
  if (by === WHITE) {
    if (validSq(sq - 15) && b[sq - 15] === pc(WHITE, PAWN)) return true;
    if (validSq(sq - 17) && b[sq - 17] === pc(WHITE, PAWN)) return true;
  } else {
    if (validSq(sq + 15) && b[sq + 15] === pc(BLACK, PAWN)) return true;
    if (validSq(sq + 17) && b[sq + 17] === pc(BLACK, PAWN)) return true;
  }
  for (const d of KNIGHT_D) {
    const s = sq + d;
    if (validSq(s) && b[s] === pc(by, KNIGHT)) return true;
  }
  for (const d of KING_D) {
    const s = sq + d;
    if (validSq(s) && b[s] === pc(by, KING)) return true;
  }
  for (const d of BISHOP_D) {
    for (let s = sq + d; validSq(s); s += d) {
      const p = b[s];
      if (!p) continue;
      if (colorOf(p) === by && (typeOf(p) === BISHOP || typeOf(p) === QUEEN)) return true;
      break;
    }
  }
  for (const d of ROOK_D) {
    for (let s = sq + d; validSq(s); s += d) {
      const p = b[s];
      if (!p) continue;
      if (colorOf(p) === by && (typeOf(p) === ROOK || typeOf(p) === QUEEN)) return true;
      break;
    }
  }
  return false;
}

function inCheck(pos, side) {
  return isAttacked(pos, pos.kings[side], side ^ 1);
}

// ---------------------------------------------------------------------------
// Move generation. A move is a packed int:
//   bits 0..6  from, bits 7..13 to, bits 14..16 promo (0 = none), bits 17.. flags
// ---------------------------------------------------------------------------

const encMove = (from, to, promo = 0, flags = 0) =>
  (from | (to << 7) | (promo << 14) | (flags << 17)) >>> 0;

const moveFrom = mv => mv & 127;
const moveTo = mv => (mv >>> 7) & 127;
const movePromo = mv => (mv >>> 14) & 7;
const moveFlags = mv => mv >>> 17;

function squareName(sq) {
  return String.fromCharCode(97 + (sq & 7)) + String.fromCharCode(49 + (sq >> 4));
}

function moveToUci(mv) {
  const promo = movePromo(mv);
  return squareName(moveFrom(mv)) + squareName(moveTo(mv)) + (promo ? 'nbrq'[promo - 2] : '');
}

function addPawnMoves(out, pos, from, to, flags) {
  const rank = to >> 4;
  if (rank === 0 || rank === 7) {
    for (let p = 2; p <= 5; p++) out.push(encMove(from, to, p, flags));
  } else {
    out.push(encMove(from, to, 0, flags));
  }
}

function generatePseudo(pos) {
  const out = [];
  const b = pos.b;
  const us = pos.side;
  const them = us ^ 1;
  const forward = us === WHITE ? 16 : -16;
  const startRank = us === WHITE ? 1 : 6;
  const promoRank = us === WHITE ? 7 : 0;

  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) continue;
    const p = b[sq];
    if (!p || colorOf(p) !== us) continue;
    const t = typeOf(p);

    if (t === PAWN) {
      const one = sq + forward;
      if (validSq(one) && !b[one]) {
        if ((one >> 4) === promoRank) addPawnMoves(out, pos, sq, one, 0);
        else {
          out.push(encMove(sq, one, 0, 0));
          const two = one + forward;
          if ((sq >> 4) === startRank && !b[two]) {
            out.push(encMove(sq, two, 0, F_DOUBLE));
          }
        }
      }
      for (const d of [forward - 1, forward + 1]) {
        const to = sq + d;
        if (!validSq(to)) continue;
        const victim = b[to];
        if (victim && colorOf(victim) === them) {
          addPawnMoves(out, pos, sq, to, F_CAP);
        } else if (to === pos.ep && !victim) {
          addPawnMoves(out, pos, sq, to, F_CAP | F_EP);
        }
      }
    } else if (t === KNIGHT) {
      for (const d of KNIGHT_D) {
        const to = sq + d;
        if (!validSq(to)) continue;
        const victim = b[to];
        if (victim && colorOf(victim) === us) continue;
        out.push(encMove(sq, to, 0, victim ? F_CAP : 0));
      }
    } else if (t === KING) {
      for (const d of KING_D) {
        const to = sq + d;
        if (!validSq(to)) continue;
        const victim = b[to];
        if (victim && colorOf(victim) === us) continue;
        out.push(encMove(sq, to, 0, victim ? F_CAP : 0));
      }
      // Castling. Squares: e1=4, f1=5, g1=6, h1=7, a1=0; e8=116, f8=117, g8=118.
      if (us === WHITE && sq === 4) {
        if ((pos.castling & 1) && !b[5] && !b[6] && b[7] === pc(WHITE, ROOK) &&
            !isAttacked(pos, 4, BLACK) && !isAttacked(pos, 5, BLACK) && !isAttacked(pos, 6, BLACK)) {
          out.push(encMove(4, 6, 0, F_CASTLE));
        }
        if ((pos.castling & 2) && !b[3] && !b[2] && !b[1] && b[0] === pc(WHITE, ROOK) &&
            !isAttacked(pos, 4, BLACK) && !isAttacked(pos, 3, BLACK) && !isAttacked(pos, 2, BLACK)) {
          out.push(encMove(4, 2, 0, F_CASTLE));
        }
      } else if (us === BLACK && sq === 116) {
        if ((pos.castling & 4) && !b[117] && !b[118] && b[119] === pc(BLACK, ROOK) &&
            !isAttacked(pos, 116, WHITE) && !isAttacked(pos, 117, WHITE) && !isAttacked(pos, 118, WHITE)) {
          out.push(encMove(116, 118, 0, F_CASTLE));
        }
        if ((pos.castling & 8) && !b[115] && !b[114] && !b[113] && b[112] === pc(BLACK, ROOK) &&
            !isAttacked(pos, 116, WHITE) && !isAttacked(pos, 115, WHITE) && !isAttacked(pos, 114, WHITE)) {
          out.push(encMove(116, 114, 0, F_CASTLE));
        }
      }
    } else {
      const dirs = t === BISHOP ? BISHOP_D : t === ROOK ? ROOK_D : KING_D;
      for (const d of dirs) {
        for (let to = sq + d; validSq(to); to += d) {
          const victim = b[to];
          if (victim) {
            if (colorOf(victim) !== us) out.push(encMove(sq, to, 0, F_CAP));
            break;
          }
          out.push(encMove(sq, to, 0, 0));
        }
      }
    }
  }
  return out;
}

function makeMove(pos, mv) {
  const from = moveFrom(mv), to = moveTo(mv), promo = movePromo(mv), flags = moveFlags(mv);
  const b = pos.b;
  const undo = {
    captured: b[to],
    capturedSq: to,
    castling: pos.castling,
    ep: pos.ep,
    half: pos.half,
    full: pos.full,
    move: mv,
  };
  const piece = b[from];
  const us = colorOf(piece);
  const type = typeOf(piece);

  if (flags & F_CASTLE) {
    // King from/to plus the rook.
    const kingTo = to;
    b[from] = 0;
    b[kingTo] = piece;
    pos.kings[us] = kingTo;
    if (to > from) {
      b[from + 3] = 0;
      b[from + 1] = pc(us, ROOK);
    } else {
      b[from - 4] = 0;
      b[from - 1] = pc(us, ROOK);
    }
  } else {
    b[from] = 0;
    b[to] = promo ? pc(us, promo) : piece;
    if (type === KING) pos.kings[us] = to;
    if (flags & F_EP) {
      const capSq = to - (us === WHITE ? 16 : -16);
      undo.captured = b[capSq];
      undo.capturedSq = capSq;
      b[capSq] = 0;
    }
  }

  pos.ep = (flags & F_DOUBLE) ? from + (us === WHITE ? 16 : -16) : -1;
  pos.half = (type === PAWN || (flags & F_CAP)) ? 0 : pos.half + 1;
  if (us === BLACK) pos.full++;

  // Castling rights: moved king/rook or a rook captured on its home square.
  if (type === KING) {
    pos.castling &= us === WHITE ? ~3 : ~12;
  }
  if (from === 0 || to === 0) pos.castling &= ~2;
  if (from === 7 || to === 7) pos.castling &= ~1;
  if (from === 112 || to === 112) pos.castling &= ~8;
  if (from === 119 || to === 119) pos.castling &= ~4;

  pos.side ^= 1;
  return undo;
}

function unmakeMove(pos, undo) {
  const mv = undo.move;
  const from = moveFrom(mv), to = moveTo(mv), flags = moveFlags(mv);
  const b = pos.b;
  const us = pos.side ^ 1;
  const piece = b[to];

  pos.side = us;
  pos.castling = undo.castling;
  pos.ep = undo.ep;
  pos.half = undo.half;
  pos.full = undo.full;

  if (flags & F_CASTLE) {
    b[to] = 0;
    b[from] = piece;
    pos.kings[us] = from;
    if (to > from) {
      b[from + 1] = 0;
      b[from + 3] = pc(us, ROOK);
    } else {
      b[from - 1] = 0;
      b[from - 4] = pc(us, ROOK);
    }
  } else {
    b[to] = 0;
    // A promotion turns the pawn into `piece`; the pawn must come back.
    b[from] = (flags & F_EP) ? pc(us, PAWN)
      : movePromo(mv) ? pc(us, PAWN)
      : piece;
    if (typeOf(b[from]) === KING) pos.kings[us] = from;
    if (flags & F_EP) b[undo.capturedSq] = undo.captured;
  }

  if (undo.captured && !(flags & F_EP)) b[to] = undo.captured;
}

function isLegal(pos, mv) {
  const us = pos.side;
  const undo = makeMove(pos, mv);
  const ok = !isAttacked(pos, pos.kings[us], us ^ 1);
  unmakeMove(pos, undo);
  return ok;
}

function generateLegal(pos) {
  const out = [];
  for (const mv of generatePseudo(pos)) {
    if (isLegal(pos, mv)) out.push(mv);
  }
  return out;
}

function applyUci(pos, uci) {
  for (const mv of generateLegal(pos)) {
    if (moveToUci(mv) === uci) { makeMove(pos, mv); return true; }
  }
  return false;
}

// ---------------------------------------------------------------------------
// SAN parsing (subset sufficient for standard Lichess PGN exports)
// ---------------------------------------------------------------------------

function sanToMove(pos, sanRaw) {
  let s = sanRaw.replace(/[!?]+/g, '').replace(/\$/g, '');
  s = s.replace(/[+#]+$/, '');
  s = s.replace(/e\.p\.?$/i, '');
  if (/^O-?O$/i.test(s) || /^0-0$/.test(s)) {
    for (const mv of generateLegal(pos)) {
      if (moveFlags(mv) & F_CASTLE) {
        const to = moveTo(mv);
        if (to === 6 || to === 118) return mv;
      }
    }
    return null;
  }
  if (/^O-?O-?O$/i.test(s) || /^0-0-0$/.test(s)) {
    for (const mv of generateLegal(pos)) {
      if (moveFlags(mv) & F_CASTLE) {
        const to = moveTo(mv);
        if (to === 2 || to === 114) return mv;
      }
    }
    return null;
  }

  const SAN_PIECE = { K: 6, Q: 5, R: 4, B: 3, N: 2 };
  // Promotion suffix ("e8=Q", "exd8Q") is easier to peel off before parsing the
  // rest, otherwise the optional disambiguation fields swallow "e8".
  let promo = 0;
  const pmEq = s.match(/=([QRBN])$/);
  if (pmEq) {
    promo = SAN_PIECE[pmEq[1]];
    s = s.slice(0, -2);
  } else if (/[1-8][QRBN]$/.test(s)) {
    promo = SAN_PIECE[s[s.length - 1]];
    s = s.slice(0, -1);
  }

  const m = s.match(/^([KQRBN])?([a-h])?([1-8])?x?([a-h][1-8])$/);
  if (!m) return null;
  const pieceType = m[1] ? SAN_PIECE[m[1]] : PAWN;
  const fromFile = m[2] ? m[2].charCodeAt(0) - 97 : -1;
  const fromRank = m[3] ? m[3].charCodeAt(0) - 49 : -1;
  const to = (m[4].charCodeAt(1) - 49) * 16 + (m[4].charCodeAt(0) - 97);
  const isCapture = s.includes('x');

  let found = null;
  for (const mv of generateLegal(pos)) {
    const from = moveFrom(mv);
    if (moveTo(mv) !== to) continue;
    const piece = pos.b[from];
    if (typeOf(piece) !== pieceType) continue;
    if (fromFile >= 0 && (from & 7) !== fromFile) continue;
    if (fromRank >= 0 && (from >> 4) !== fromRank) continue;
    const flags = moveFlags(mv);
    if (isCapture && !(flags & F_CAP)) continue;
    if (!isCapture && (flags & F_CAP)) continue;
    if (promo && movePromo(mv) !== promo) continue;
    if (!promo && movePromo(mv)) continue;
    if (found !== null) return null; // ambiguous SAN: reject rather than guess
    found = mv;
  }
  return found;
}

// ---------------------------------------------------------------------------
// PGN text parsing
// ---------------------------------------------------------------------------

function stripComments(text) {
  let out = '';
  let i = 0;
  let brace = 0, paren = 0;
  while (i < text.length) {
    const c = text[i];
    if (brace) { if (c === '}') brace--; i++; continue; }
    if (paren) { if (c === ')') paren--; i++; continue; }
    if (c === '{') { brace++; i++; continue; }
    if (c === '(') { paren++; i++; continue; }
    if (c === ';') { while (i < text.length && text[i] !== '\n') i++; continue; }
    out += c;
    i++;
  }
  return out;
}

function splitGameBlocks(text) {
  const blocks = [];
  let cur = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('[Event ')) {
      if (cur.length) blocks.push(cur.join('\n'));
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks.filter(b => /\[Event /.test(b));
}

function parseHeaders(block) {
  const headers = {};
  const lines = block.split(/\r?\n/);
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    const m = line.match(/^\[(\w+)\s+"(.*)"\]$/);
    if (m) headers[m[1]] = m[2];
    else if (line === '') { i++; break; }
    else break;
  }
  return { headers, movetext: lines.slice(i).join('\n') };
}

function tokenizeMovetext(text) {
  const clean = stripComments(text);
  return clean
    .replace(/\d+\.(\.\.)?/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

const RESULT_TOKENS = new Set(['1-0', '0-1', '1/2-1/2', '*']);

/**
 * Parse a single PGN game block. Returns {game} or {skip: reason}.
 * game = {id, result, white, black, moves:[uci], headers}
 */
function parseGame(block) {
  const { headers, movetext } = parseHeaders(block);
  const variant = headers.Variant || 'Standard';
  if (variant !== 'Standard') return { skip: 'variant:' + variant };
  if (headers.SetUp === '1' || headers.FEN) return { skip: 'from-position' };
  const result = headers.Result || '*';
  if (!RESULT_TOKENS.has(result)) return { skip: 'bad-result' };
  if (headers.Termination === 'Aborted') return { skip: 'aborted' };

  const pos = setFen(newBoard(), START_FEN);
  const moves = [];
  let lastSeenResult = null;
  for (const tok of tokenizeMovetext(movetext)) {
    if (RESULT_TOKENS.has(tok)) { lastSeenResult = tok; continue; }
    const mv = sanToMove(pos, tok);
    if (mv === null) {
      return { skip: 'san-fail:' + tok + '@' + (moves.length + 1) };
    }
    makeMove(pos, mv);
    moves.push(moveToUci(mv));
  }
  if (!moves.length) return { skip: 'no-moves' };
  if (lastSeenResult !== null && lastSeenResult !== result && result !== '*') {
    return { skip: 'result-mismatch' };
  }
  const id = headers.GameId || (headers.Site || '').split('/').pop() || '';
  if (!id) return { skip: 'no-id' };
  return {
    game: {
      id,
      result,
      white: headers.White || '?',
      black: headers.Black || '?',
      whiteElo: headers.WhiteElo ? +headers.WhiteElo : null,
      blackElo: headers.BlackElo ? +headers.BlackElo : null,
      utcDate: headers.UTCDate || headers.Date || '?',
      termination: headers.Termination || '?',
      timeControl: headers.TimeControl || '?',
      moves,
    },
  };
}

/** Parse every game from an array of PGN file contents. */
function parseGames(texts) {
  const games = [];
  const skipped = new Map();
  const seen = new Set();
  let plies = 0;
  for (const text of texts) {
    for (const block of splitGameBlocks(text)) {
      const r = parseGame(block);
      if (r.skip) {
        const key = r.skip.split(':')[0];
        skipped.set(key, (skipped.get(key) || 0) + 1);
        continue;
      }
      if (seen.has(r.game.id)) { skipped.set('duplicate-game', (skipped.get('duplicate-game') || 0) + 1); continue; }
      seen.add(r.game.id);
      games.push(r.game);
      plies += r.game.moves.length;
    }
  }
  return { games, plies, skipped };
}

// ---------------------------------------------------------------------------
// NNUE features (FRNN1)
// ---------------------------------------------------------------------------

const INPUT_FEATURES = 768;

/**
 * Feature index for a piece on a 0x88 square, seen from `perspective` (0/1).
 * Layout: 2 sides x 6 piece types x 64 squares, side-major.
 *   0..383   = "own" pieces   (type-1)*64 + mirrored_sq
 *   384..767 = "enemy" pieces 384 + (type-1)*64 + mirrored_sq
 * Squares are vertically mirrored (sq ^ 56) when perspective is black.
 */
function featureIndex(piece, sq, perspective) {
  const rel = ((piece >> 3) ^ perspective) & 1; // 0 = own, 1 = enemy
  const type = (piece & 7) - 1;
  let s = (sq >> 4) * 8 + (sq & 7);
  if (perspective === BLACK) s ^= 56;
  return rel * 384 + type * 64 + s;
}

/** Returns a Uint16Array of feature indices for `perspective`. */
function featuresFor(board, perspective) {
  const feats = [];
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) continue;
    const p = board[sq];
    if (!p) continue;
    feats.push(featureIndex(p, sq, perspective));
  }
  return Uint16Array.from(feats);
}

// ---------------------------------------------------------------------------
// Perft (used as a one-shot self check by the trainer's tests)
// ---------------------------------------------------------------------------

function perft(pos, depth) {
  if (depth === 0) return 1;
  const moves = generateLegal(pos);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const mv of moves) {
    const undo = makeMove(pos, mv);
    n += perft(pos, depth - 1);
    unmakeMove(pos, undo);
  }
  return n;
}

module.exports = {
  WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  START_FEN, INPUT_FEATURES,
  F_CAP, F_EP, F_CASTLE, F_DOUBLE,
  newBoard, setFen, getFen, makeMove, unmakeMove, generateLegal, generatePseudo,
  isAttacked, inCheck, applyUci, moveToUci, moveFrom, moveTo, movePromo, moveFlags,
  squareName, sanToMove, parseGames, parseGame, splitGameBlocks, tokenizeMovetext,
  featureIndex, featuresFor, perft,
};
