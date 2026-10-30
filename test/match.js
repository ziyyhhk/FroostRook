'use strict';

/*
 * Head-to-head match between two engine builds, used to check that a change
 * actually made the engine stronger. Both modules are loaded in one process;
 * each has its own board state.
 *
 *   node test/match.js <path-to-engine-a.js> <path-to-engine-b.js> [games] [ms]
 *
 * Reports the score from B's point of view. Colors alternate every game.
 */

const path = require('path');

const A_PATH = process.argv[2];
const B_PATH = process.argv[3];
const GAMES = Number(process.argv[4] || 20);
const MS = Number(process.argv[5] || 120);

if (!A_PATH || !B_PATH) {
  console.error('usage: node test/match.js <engineA.js> <engineB.js> [games] [ms]');
  process.exit(1);
}

const A = require(path.resolve(A_PATH));
const B = require(path.resolve(B_PATH));

function load(eng, moves) {
  eng.setFen(eng.START_FEN);
  for (const mv of moves) {
    if (!eng.applyUciMove(mv)) throw new Error('illegal replay: ' + mv);
  }
}

// Returns { score } where 1 = white wins, 0 = draw, -1 = black wins.
function playGame(white, black) {
  const moves = [];
  for (let ply = 0; ply < 240; ply++) {
    const eng = ply % 2 === 0 ? white : black;
    load(eng, moves);
    if (eng.getLegalMoves().length === 0) {
      if (!eng.inCheck()) return { score: 0, plies: ply };
      return { score: ply % 2 === 0 ? -1 : 1, plies: ply };
    }
    const res = eng.search({ movetime: MS });
    const best = res.bestMoveStr;
    if (!best || best === '0000') return { score: 0, plies: ply };
    moves.push(best);
  }
  return { score: 0, plies: moves.length };
}

let bWins = 0, aWins = 0, draws = 0;
let bPoints = 0;

for (let g = 0; g < GAMES; g++) {
  const bIsWhite = g % 2 === 0;
  const white = bIsWhite ? B : A;
  const black = bIsWhite ? A : B;
  const { score, plies } = playGame(white, black);
  const bScore = bIsWhite ? score : -score;
  if (bScore > 0) bWins++;
  else if (bScore < 0) aWins++;
  else draws++;
  bPoints += bScore > 0 ? 1 : bScore < 0 ? 0 : 0.5;
  console.log(
    `game ${g + 1}: B as ${bIsWhite ? 'white' : 'black'}, ` +
    `${bScore > 0 ? 'B wins' : bScore < 0 ? 'A wins' : 'draw'} in ${plies} plies`
  );
}

console.log(`\nB score: ${bPoints}/${GAMES} (${(bPoints / GAMES * 100).toFixed(1)}%) ` +
  `+${bWins} =${draws} -${aWins}`);
