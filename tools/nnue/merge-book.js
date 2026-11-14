'use strict';

/*
 * Merges the named book (book.js) with game statistics harvested from a
 * CC0 Lichess dump (tools/nnue/build-opening-stats.js).
 *
 *   node tools/nnue/merge-book.js [stats.json] [book.js]
 *
 * Rewrites book.js in place: the `const BOOK = { ... };` literal is replaced
 * with the merged table. Everything else in the file (STYLE_INDEX, ROOT_*,
 * pick/remember/memory) is left untouched. The merged book:
 *
 *   - keeps every named move, boosting its weight by real frequency;
 *   - adds missing moves from game stats with >= MIN_GAMES occurrences
 *     and a score for the side to move of at least 0.42;
 *
 * Personality columns stay per the original layout (balanced, mainline,
 * aggressive, gambit, solid, surprise, positional).
 */
const fs = require('fs');
const path = require('path');

const STATS_PATH = process.argv[2] || '.build/opening-stats.json';
const BOOK_PATH = process.argv[3] || 'book.js';
const MIN_GAMES = Math.max(20, +(process.env.MERGE_MIN_GAMES || 120));
// Gap-fill additions (moves in positions the named book does not cover) can
// use a looser per-move threshold; the named book keeps the shipped parity.
const GAPFILL_MIN = Math.max(20, +(process.env.MERGE_GAPFILL_MIN || MIN_GAMES));
const NAMED_ONLY = process.argv.includes('--named-only');
const GAP_FILL_ONLY = process.argv.includes('--gap-fill-only');

const stats = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));

// Outcome score for the side to move: 1 = win, 0.5 = draw, 0 = loss.
function scoreFor(move, side) {
  const n = move.n || 0;
  if (!n) return 0.5;
  const wins = side === 'w' ? move.white : move.black;
  return (wins + 0.5 * (move.draw || 0)) / n;
}

const positions = {};
for (const [key, entry] of Object.entries(stats)) {
  const total = Object.values(entry.moves).reduce((a, m) => a + m.n, 0);
  if (total < MIN_GAMES) continue;
  positions[key] = { fen: entry.fen, side: entry.side, moves: entry.moves, total };
}

// Parse the existing BOOK literal text out of book.js.
const src = fs.readFileSync(BOOK_PATH, 'utf8');
const startMarker = 'const BOOK = ';
const start = src.indexOf(startMarker);
const endMarker = ';\n\nconst STYLE_INDEX';
const end = src.indexOf(endMarker, start);
if (start < 0 || end < 0) throw new Error('could not locate the BOOK literal in book.js');
const named = JSON.parse(src.slice(start + startMarker.length, end));

const merged = {};
let added = 0, boosted = 0;

// 1) keep & frequency-boost the named book moves
for (const [key, moves] of Object.entries(named)) {
  const stat = positions[key];
  const keep = [];
  for (const mv of moves) {
    const uci = mv[0];
    const n = stat && stat.moves[uci] ? stat.moves[uci].n : 0;
    const out = [uci];
    for (let s = 0; s < 7; s++) {
      let w = mv[1 + s];
      if (n > 0) w = Math.min(255, w + Math.round(Math.log2(n + 1) * 4));
      out.push(Math.max(1, w));
    }
    keep.push(out);
    if (n > 0) boosted++;
  }
  merged[key] = keep;
}

// 2) add missing moves from real games, thresholded by frequency and score.
//    The root repertoire is deliberately curated and the native engine
//    restricts root moves to the sound core; additions there are never made.
//    With --named-only, only step 1 (frequency boosts on the curated named
//    book) is applied — this preserves the exact named theory while making
//    the weights reflect real tournament frequency data.
//    With --gap-fill-only, step 1 is applied the same way, and step 2 adds
//    moves ONLY in positions the named book has nothing for — deepening the
//    book into uncatalogued lines instead of diluting the curated repertoire
//    (a full in-position merge was measured to pull the Positional
//    personality's median book depth below the openings-suite floor; gap-fill
//    cannot, since it never touches a named position).
const START_KEY = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq';
const GAP_FILL = GAP_FILL_ONLY;
if (!NAMED_ONLY)
for (const [key, pos] of Object.entries(positions)) {
  if (key === START_KEY) continue;
  if (GAP_FILL && merged[key]) continue; // named position: leave the curated line alone
  const existing = merged[key] || [];
  const namedSet = new Set(existing.map(m => m[0]));
  const side = key.split(' ')[1];
  const moveMin = GAP_FILL ? GAPFILL_MIN : MIN_GAMES;
  for (const [uci, m] of Object.entries(pos.moves)) {
    if (namedSet.has(uci)) continue;
    if (m.n < moveMin) continue;
    const sc = scoreFor(m, side);
    if (sc < 0.42) continue;
    const base = Math.min(120, Math.round(Math.log2(m.n + 1) * 9));
    const solid = Math.min(120, Math.round(base * (0.6 + sc * 0.8)));
    const surprise = Math.min(90, Math.round(Math.log2(m.n + 1) * 3 + sc * 30));
    existing.push([uci, base, base, Math.round(base * 0.8), base, solid, surprise, solid]);
    added++;
  }
  if (existing.length) merged[key] = existing;
}

// 3) keep every position's moves sorted by descending balanced weight
for (const key of Object.keys(merged)) {
  merged[key].sort((a, b) => b[1] - a[1]);
}

const replacement = startMarker + JSON.stringify(merged) + ';';
fs.writeFileSync(BOOK_PATH, src.slice(0, start) + replacement + src.slice(end + 1));
console.log(`merged ${Object.keys(merged).length} positions into ${BOOK_PATH}`);
console.log(`named moves boosted by game stats: ${boosted}`);
console.log(`new moves added from game stats: ${added}`);
