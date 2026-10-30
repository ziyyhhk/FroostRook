'use strict';

/*
 * Validates book.js against the engine: every stored position must parse, and
 * every stored move must be legal in that position. Also confirms a handful of
 * named openings are actually covered.
 *
 *   node test/book-check.js
 */

const engine = require('../engine.js');
engine.setInfoHandler(() => {});
const { BOOK } = require('../book.js');

const keys = Object.keys(BOOK);
let moves = 0;
let bad = 0;

function probe(fen) {
  engine.setFen(fen);
  return engine.getLegalMoves().map(engine.moveToStr);
}

for (const key of keys) {
  const legal = probe(key + ' - 0 1');
  for (const [mv, w] of BOOK[key]) {
    moves++;
    if (!(w > 0)) { console.log(`bad weight ${w} for ${mv} in ${key}`); bad++; }
    if (!legal.includes(mv)) { console.log(`illegal book move ${mv} in ${key}`); bad++; }
  }
}

// Named-opening coverage: the book must answer in each of these positions.
const mustHave = [
  ['Start', ''],
  ['King\'s Gambit', 'e2e4 e7e5 f2f4'],
  ['Evans Gambit', 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 b2b4'],
  ['Sicilian Najdorf', 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6'],
  ['Queen\'s Gambit Declined', 'd2d4 d7d5 c2c4 e7e6'],
  ['King\'s Indian', 'd2d4 g8f6 c2c4 g7g6'],
  ['English, Reversed Sicilian', 'c2c4 e7e5'],
  ['Réti', 'g1f3 d7d5'],
  ['Grünfeld', 'd2d4 g8f6 c2c4 g7g6 b1c3 d7d5'],
  ['French', 'e2e4 e7e6'],
  ['Caro-Kann', 'e2e4 c7c6'],
  ['Dutch', 'd2d4 f7f5'],
  ['Alekhine', 'e2e4 g8f6'],
  ['Scandinavian', 'e2e4 d7d5'],
  ['Vienna Gambit', 'e2e4 e7e5 b1c3 g8f6 f2f4'],
];

function keyAfter(moves) {
  engine.setFen(engine.START_FEN);
  for (const mv of moves.split(' ').filter(Boolean)) {
    if (!engine.applyUciMove(mv)) throw new Error('bad test move ' + mv);
  }
  return engine.getFen().split(' ').slice(0, 3).join(' ');
}

let missing = 0;
for (const [name, moves] of mustHave) {
  const key = keyAfter(moves);
  const entry = BOOK[key];
  if (!entry) { console.log(`MISSING ${name}`); missing++; }
  else console.log(`ok  ${name}: ${entry.length} book replies (${entry.slice(0, 3).map(r => r[0]).join(',')})`);
}

console.log(`\n${keys.length} positions, ${moves} moves, ${bad} illegal/invalid, ${missing} named openings missing`);
process.exit(bad || missing ? 1 : 0);
