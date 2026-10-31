'use strict';

/*
 * Static validation of the generated opening book:
 *
 *   - every position parses and every stored move is legal;
 *   - every row carries seven non-negative personality weights (balanced,
 *     mainline, aggressive, gambit, solid, surprise, positional), balanced > 0;
 *   - the root and first-reply novelty filters are present;
 *   - the named repertoire actually includes the curated and popular lines.
 *
 *   node test/book-check.js
 */

const assert = require('assert');
const engine = require('../engine.js');
engine.setInfoHandler(() => {});
const { BOOK } = require('../book.js');

const keys = Object.keys(BOOK);
const cols = [0, 0, 0, 0, 0, 0, 0];
let moves = 0;
let bad = 0;
let styleVariation = 0;

function probe(fen) {
  engine.setFen(fen);
  return engine.getLegalMoves().map(engine.moveToStr);
}

for (const key of keys) {
  const legal = new Set(probe(key + ' - 0 1'));
  let prev = Infinity;
  for (const row of BOOK[key]) {
    const [mv, ...weights] = row;
    moves++;
    if (weights.length !== 7) {
      console.log(`wrong weight count (${weights.length}) for ${mv} in ${key}`);
      bad++;
      continue;
    }
    if (!legal.has(mv)) {
      console.log(`illegal book move ${mv} in ${key}`);
      bad++;
    }
    if (!(weights[0] > 0) || weights.some(w => !Number.isInteger(w) || w < 0)) {
      console.log(`invalid weights ${weights} for ${mv} in ${key}`);
      bad++;
    }
    if (weights[0] > prev) {
      console.log(`unsorted balanced weights for ${key}`);
      bad++;
    }
    prev = weights[0];
    weights.forEach((w, i) => { cols[i] += w; });
    if (weights.some(w => w !== weights[0])) styleVariation++;
  }
}

assert(keys.length >= 5000, `book has ${keys.length} positions`);
assert(moves >= 7000, `book has ${moves} moves`);
assert(styleVariation >= 1000, `style columns vary in ${styleVariation} rows`);
assert(bad === 0, `${bad} invalid book rows`);
console.log(`ok: ${keys.length} positions, ${moves} moves, ${styleVariation} style-varying rows`);

// The first move and the first reply must stay inside the sound repertoire.
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq';
const ROOT = new Set(['e2e4', 'd2d4', 'c2c4', 'g1f3', 'b2b3', 'g2g3', 'b2b4', 'f2f4', 'b1c3']);
for (const row of BOOK[START]) assert(ROOT.has(row[0]), `unsound root move ${row[0]}`);
assert.equal(BOOK[START].length, ROOT.size, 'all sound root moves are present');

const SOUND_REPLIES = new Set([
  'e7e5', 'c7c5', 'e7e6', 'c7c6', 'g8f6', 'd7d5', 'b8c6', 'd7d6', 'g7g6', 'b7b6', 'f7f5',
]);
let replyPositions = 0;
engine.setFen(engine.START_FEN);
for (const first of ['e2e4', 'd2d4', 'c2c4', 'g1f3', 'b2b3', 'g2g3', 'b2b4', 'f2f4', 'b1c3']) {
  engine.setFen(engine.START_FEN);
  assert(engine.applyUciMove(first), first);
  const key = engine.getFen().split(' ').slice(0, 3).join(' ');
  const entry = BOOK[key];
  if (!entry) continue;
  replyPositions++;
  for (const row of entry) {
    assert(SOUND_REPLIES.has(row[0]), `unsound first reply ${first} ... ${row[0]}`);
  }
  const distinct = new Set(entry.map(r => r[0]));
  const core = ['e2e4', 'd2d4', 'c2c4', 'g1f3'].includes(first);
  assert(distinct.size >= (core ? 5 : 2),
    `${first} has only ${distinct.size} sound replies`);
}
assert(replyPositions >= 8, `only ${replyPositions} first-move positions have replies`);
console.log(`ok: sound root and first-reply repertoires (${replyPositions} reply positions)`);

// Named-opening coverage: the book must answer in each of these positions.
const mustHave = [
  ['Start', ''],
  ["King's Gambit", 'e2e4 e7e5 f2f4'],
  ['Evans Gambit', 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 b2b4'],
  ['Sicilian Najdorf', 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6'],
  ['Sicilian Dragon', 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 g7g6'],
  ["Queen's Gambit Declined", 'd2d4 d7d5 c2c4 e7e6'],
  ["Queen's Gambit Accepted", 'd2d4 d7d5 c2c4 d5c4'],
  ["King's Indian", 'd2d4 g8f6 c2c4 g7g6'],
  ['Grünfeld', 'd2d4 g8f6 c2c4 g7g6 b1c3 d7d5'],
  ['English, Reversed Sicilian', 'c2c4 e7e5'],
  ['Réti', 'g1f3 d7d5'],
  ['French', 'e2e4 e7e6'],
  ['Caro-Kann', 'e2e4 c7c6'],
  ['Dutch', 'd2d4 f7f5'],
  ['Alekhine', 'e2e4 g8f6'],
  ['Scandinavian', 'e2e4 d7d5'],
  ['Vienna Gambit', 'e2e4 e7e5 b1c3 g8f6 f2f4'],
  ['Wilkes-Barre', 'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 f3g5 f8c5'],
  ['Snyder Sicilian', 'e2e4 c7c5 g1f3 d7d6'],
  ["O'Kelly Sicilian", 'e2e4 c7c5 g1f3'],
  ['Pseudo-Trompowsky', 'd2d4 g8f6 c1g5 e7e6'],
  ['Rapport-Jobava', 'd2d4 d7d5 b1c3 g8f6 c1f4'],
  ['Tennison Gambit', 'g1f3 d7d5 e2e4'],
  ['Urusov Gambit', 'e2e4 e7e5 f1c4 g8f6 g1f3'],
  ['Barry Attack', 'd2d4 g8f6 g1f3 g7g6 c1f4'],
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
  if (!entry) {
    console.log(`MISSING ${name}`);
    missing++;
  } else {
    console.log(`ok  ${name}: ${entry.length} book replies (${entry.slice(0, 3).map(r => r[0]).join(',')})`);
  }
}

assert.equal(missing, 0, `${missing} named openings missing`);
console.log('\nBook check passed.');
