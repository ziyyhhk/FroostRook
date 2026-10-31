'use strict';

/*
 * Builds Kiwa's opening book from the lichess-org/chess-openings database plus
 * a small curated set of gambit/trap lines.
 *
 * Input:  book-data/{a,b,c,d,e}.tsv  (eco \t name \t pgn)
 *         book-data/traps.tsv        (same columns, optional)
 * Output: book.js — FEN-keyed, weighted, used by the UCI front-end only.
 *
 * A move that hands the opponent mate in one is never stored: the named-line
 * database records both sides of famous miniatures (Fool's Mate, Scholar's
 * Mate), and a book should not reproduce the losing side of a trick.
 *
 * Run with: node test/gen-book.js
 * Refresh data: curl -O https://raw.githubusercontent.com/lichess-org/chess-openings/master/{a,b,c,d,e}.tsv
 */

const fs = require('fs');
const path = require('path');
const e = require('../engine.js');

const DATA = path.join(__dirname, '..', 'book-data');
const OUT = path.join(__dirname, '..', 'book.js');

// --- SAN (as written in the TSV) -> UCI ------------------------------------

function sanToUci(san) {
  let s = String(san).trim().replace(/\s+/g, '');
  s = s.replace(/[+#!?]+$/, '');
  const legal = e.getLegalMoves();
  if (!legal.length) return null;

  if (s === 'O-O' || s === '0-0') {
    for (const mv of legal) {
      const d = e.describeMove(mv);
      if (d.castle && (d.to === 6 || d.to === 118)) return e.moveToStr(mv);
    }
    return null;
  }
  if (s === 'O-O-O' || s === '0-0-0') {
    for (const mv of legal) {
      const d = e.describeMove(mv);
      if (d.castle && (d.to === 2 || d.to === 114)) return e.moveToStr(mv);
    }
    return null;
  }

  const m = s.match(/([a-h][1-8])(?:=?([QRBN]))?$/);
  if (!m) return null;
  const toStr = m[1];
  const promoChar = m[2] || '';
  const to = (toStr.charCodeAt(1) - 49) * 16 + (toStr.charCodeAt(0) - 97);
  const destIdx = s.lastIndexOf(toStr);

  let prefix = s.slice(0, destIdx);
  let pieceType = 1; // pawn
  const PIECE_FROM_SAN = { K: 6, Q: 5, R: 4, B: 3, N: 2 };
  if (/^[KQRBN]/.test(prefix)) {
    pieceType = PIECE_FROM_SAN[prefix[0]];
    prefix = prefix.slice(1);
  }
  prefix = prefix.replace(/x/g, '');
  let fromFile = -1;
  let fromRank = -1;
  for (const ch of prefix) {
    if (ch >= 'a' && ch <= 'h') fromFile = ch.charCodeAt(0) - 97;
    else if (ch >= '1' && ch <= '8') fromRank = ch.charCodeAt(0) - 49;
  }

  const isCapture = s.includes('x');
  const promo = promoChar ? ' PNBRQ'.indexOf(promoChar) : 0;

  for (const mv of legal) {
    const d = e.describeMove(mv);
    if (d.piece !== pieceType || d.to !== to) continue;
    if (fromFile >= 0 && (d.from & 7) !== fromFile) continue;
    if (fromRank >= 0 && (d.from >> 4) !== fromRank) continue;
    if (isCapture && !d.cap) continue;
    if (promo && d.promo !== promo) continue;
    return e.moveToStr(mv);
  }
  return null;
}

function tokensOf(pgn) {
  return pgn
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s+/)
    .filter(t => t && !/^\d+\.+$/.test(t));
}

// --- build -----------------------------------------------------------------

function keyOf(fen) {
  // Board + side + castling. En passant is deliberately excluded: most GUIs
  // normalise the ep square to "-", and it only changes the legal moves in a
  // vanishingly small share of opening positions.
  return fen.split(' ').slice(0, 3).join(' ');
}

// True when, after the move already played into `afterFen`, the side to move
// has a checkmating reply. Called once per candidate book move.
function allowsMateInOne(afterFen) {
  e.setFen(afterFen);
  const replies = e.getLegalMoves().map(e.moveToStr);
  for (const r of replies) {
    e.setFen(afterFen);
    e.applyUciMove(r);
    if (e.inCheck() && e.getLegalMoves().length === 0) return true;
  }
  return false;
}

const book = new Map(); // FEN-key -> Map(move -> weight)
let lines = 0;
let plies = 0;
let blunders = 0;
const bad = [];

const FILES = ['a', 'b', 'c', 'd', 'e'];
if (fs.existsSync(path.join(DATA, 'traps.tsv'))) FILES.push('traps');
for (const f of FILES) {
  const file = path.join(DATA, f + '.tsv');
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
  for (const row of rows) {
    const cols = row.split('\t');
    const pgn = cols[2];
    if (!pgn) continue;

    e.setFen(e.START_FEN);
    let ok = true;
    const seen = new Set();
    for (const tok of tokensOf(pgn)) {
      const uci = sanToUci(tok);
      if (!uci) {
        ok = false;
        bad.push(`${cols[0]} ${cols[1]}: ${tok}`);
        break;
      }
      const key = keyOf(e.getFen());
      const dup = seen.has(key); // repeated position inside one line
      seen.add(key);
      if (!e.applyUciMove(uci)) {
        ok = false;
        bad.push(`${cols[0]} ${cols[1]}: ${tok}`);
        break;
      }
      const afterFen = e.getFen();
      const safe = !allowsMateInOne(afterFen);
      e.setFen(afterFen);
      if (!safe) {
        blunders++;
        continue;
      }
      if (!dup) {
        if (!book.has(key)) book.set(key, new Map());
        const moves = book.get(key);
        moves.set(uci, (moves.get(uci) || 0) + 1);
        plies++;
      }
    }
    if (ok) lines++;
  }
}

const obj = {};
let entries = 0;
let dropped = 0;
for (const k of [...book.keys()].sort()) {
  // Re-probe with an empty ep square: a stored ep capture is illegal there.
  e.setFen(k + ' - 0 1');
  const legal = new Set(e.getLegalMoves().map(e.moveToStr));
  const moves = book.get(k);
  const list = [...moves.entries()]
    .filter(([mv]) => (legal.has(mv) ? true : (dropped++, false)))
    // sqrt keeps main lines clearly favoured without burying rare gambits:
    // e4 (~1300 named lines) outweighs a3 (5) by ~16:1, not 260:1.
    .map(([mv, w]) => [mv, Math.max(1, Math.round(Math.sqrt(w) * 10))])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (list.length) {
    obj[k] = list;
    entries += list.length;
  }
}

/* eslint-disable */
const src = `'use strict';

/*
 * Kiwa's opening book. Keyed by the first three FEN fields (board, side to
 * move, castling rights), so transpositions share an entry. Weights count how
 * many named opening lines play that move; pick() draws randomly in proportion
 * to weight, so repeat games do not look identical.
 *
 * Source: lichess-org/chess-openings (CC0) plus curated gambit/trap lines,
 * ${lines} lines. Moves that allow mate in one are excluded. Generated by
 * test/gen-book.js — do not edit by hand.
 *
 * The search itself never consults this book, so perft and WAC are unaffected.
 */

const BOOK = ${JSON.stringify(obj)};

function pick(fen, variety = 100) {
  const key = fen.split(' ').slice(0, 3).join(' ');
  const entry = BOOK[key];
  if (!entry) return null;
  const maxW = entry[0][1];
  const cutoff = maxW * (100 - Math.max(0, Math.min(100, variety))) / 100;
  const pool = entry.filter(m => m[1] >= cutoff);
  let total = 0;
  for (let i = 0; i < pool.length; i++) total += pool[i][1];
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= pool[i][1];
    if (r < 0) return pool[i][0];
  }
  return pool[0][0];
}

module.exports = { pick, BOOK };
`;
/* eslint-enable */

fs.writeFileSync(OUT, src);
console.log(
  `book.js written: ${Object.keys(obj).length} positions, ${entries} moves, ${dropped} dropped, ` +
  `${blunders} blunder moves filtered, ${lines} lines, ${plies} plies`
);
if (bad.length) {
  console.log(`skipped ${bad.length} lines with unparsed/illegal moves:`);
  for (const b of bad.slice(0, 10)) console.log('  ' + b);
}
