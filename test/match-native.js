'use strict';

/*
 * Native core vs JavaScript engine at equal thinking time.
 *   node test/match-native.js [ms-per-move] [games]
 *
 * Both sides get the same movetime. Colours alternate; a small set of opening
 * pairs adds variety. The JavaScript engine owns the board; the native core is
 * fed the full move history so its repetition / 50-move handling matches.
 */

const engine = require('../engine.js');
engine.setInfoHandler(() => {});
const native = require('../native.js');

const ms = +(process.argv[2] || 100);
const games = +(process.argv[3] || 10);

const OPENINGS = [
  ['e2e4', 'e7e5'], ['d2d4', 'd7d5'], ['c2c4', 'e7e5'], ['g1f3', 'd7d5'],
  ['e2e4', 'c7c5'], ['d2d4', 'g8f6'], ['e2e4', 'e7e6'], ['e2e4', 'c7c6'],
  ['d2d4', 'f7f5'], ['e2e4', 'd7d5'],
];

function descriptor(moves) {
  return 'fen ' + engine.START_FEN + (moves.length ? ' moves ' + moves.join(' ') : '');
}

async function playGame(nativeIsWhite) {
  engine.setFen(engine.START_FEN);
  engine.clearTT();
  native.newGame();
  const moves = [];

  const opening = OPENINGS[Math.floor(Math.random() * OPENINGS.length)];
  for (const mv of opening) {
    if (!engine.applyUciMove(mv)) return 0.5;
    moves.push(mv);
  }

  for (let ply = 0; ply < 250; ply++) {
    const legal = engine.getLegalMoves();
    if (!legal.length) {
      if (!engine.inCheck()) return 0.5;
      const whiteMated = engine.side === engine.WHITE;
      return whiteMated === nativeIsWhite ? 0 : 1;
    }
    if (engine.halfmove >= 100) return 0.5;

    const nativeToMove = (engine.side === engine.WHITE) === nativeIsWhite;
    let mv;
    if (nativeToMove) {
      if (!native.available()) throw new Error('native exe not found');
      const r = await native.search(descriptor(moves), { movetime: ms });
      mv = r && r.bestMoveStr;
    } else {
      mv = engine.search({ movetime: ms }).bestMoveStr;
    }
    if (!mv || mv === '0000' || !engine.applyUciMove(mv)) {
      return nativeToMove ? 0 : 1;
    }
    moves.push(mv);
  }
  return 0.5;
}

(async () => {
  console.log(`FroostRook native vs JS @ ${ms} ms/move, ${games} games`);
  let score = 0, wins = 0, draws = 0, losses = 0;
  for (let i = 0; i < games; i++) {
    const nativeIsWhite = i % 2 === 0;
    const t0 = Date.now();
    const res = await playGame(nativeIsWhite);
    score += res;
    if (res === 1) wins++;
    else if (res === 0.5) draws++;
    else losses++;
    const el = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`game ${i + 1}: native ${res === 1 ? 'win' : res === 0.5 ? 'draw' : 'loss'} (${el}s)`);
  }
  console.log(`native score ${score}/${games}  (+${wins} =${draws} -${losses})`);
  native.quit();
  process.exit(0);
})().catch(e => {
  console.error('match failed:', e.message);
  native.quit();
  process.exit(1);
});
