'use strict';

/*
 * Measures how often Kiwa's "predict" mode names the move a human actually
 * played. Two real games, every ply a prediction target (both sides human):
 *   - Morphy's Opera Game (1858)
 *   - The Immortal Game, Anderssen-Kieseritzky (1851)
 */

const engine = require('../engine.js');
engine.setInfoHandler(() => {});

const OPERA_GAME = [
  'e2e4', 'e7e5', 'g1f3', 'd7d6', 'd2d4', 'c8g4', 'd4e5', 'g4f3',
  'd1f3', 'd6e5', 'f1c4', 'g8f6', 'f3b3', 'd8e7', 'b1c3', 'c7c6',
  'c1g5', 'b7b5', 'c3b5', 'c6b5', 'c4b5', 'b8d7', 'e1c1', 'a8d8',
  'd1d7', 'd8d7', 'h1d1', 'e7e6', 'b5d7', 'f6d7', 'b3b8', 'd7b8',
  'd1d8',
];

const IMMORTAL_GAME = [
  'e2e4', 'e7e5', 'f2f4', 'e5f4', 'f1c4', 'd8h4', 'e1f1', 'b7b5',
  'c4b5', 'g8f6', 'g1f3', 'h4h6', 'd2d3', 'f6h5', 'f3h4', 'h6g5',
  'h4f5', 'c7c6', 'g2g4', 'h5f6', 'h1g1', 'c6b5', 'h2h4', 'g5g6',
  'h4h5', 'g6g5', 'd1f3', 'f6g8', 'c1f4', 'g5f6', 'b1c3', 'f8c5',
  'c3d5', 'f6b2', 'f4d6', 'c5g1', 'e4e5', 'b2a1', 'f1e2', 'b8a6',
  'f5g7', 'e8d8', 'f3f6', 'g8f6', 'd6e7',
];

function run(game, opts, label, verbose) {
  engine.setFen(engine.START_FEN);
  const rows = [];
  let top1 = 0, top3 = 0, n = 0;

  for (let i = 0; i < game.length; i++) {
    const actual = game[i];
    const r = engine.predict(opts);
    const ranked = r.moves.map(m => m.move);
    const isTop1 = ranked[0] === actual;
    const isTop3 = ranked.slice(0, 3).includes(actual);
    if (isTop1) top1++;
    if (isTop3) top3++;
    n++;
    rows.push({ ply: i + 1, actual, predicted: ranked[0], rank: ranked.indexOf(actual) + 1, conf: r.confidence });
    if (!engine.applyUciMove(actual)) throw new Error('bad move ' + actual);
  }

  console.log(`\n=== ${label} ===`);
  console.log(`top-1: ${top1}/${n} (${(100 * top1 / n).toFixed(1)}%)   top-3: ${top3}/${n} (${(100 * top3 / n).toFixed(1)}%)`);
  if (verbose) {
    console.log('ply  actual  predicted  rank  conf');
    for (const r of rows) {
      const mark = r.rank === 1 ? ' *' : r.rank === 2 ? ' 2' : r.rank === 3 ? ' 3' : '';
      console.log(
        String(r.ply).padStart(3),
        r.actual.padEnd(7),
        r.predicted.padEnd(10),
        String(r.rank).padStart(3),
        (r.conf * 100).toFixed(1).padStart(6) + '%' + mark
      );
    }
  }
  return { top1, top3, n };
}

const depth = +(process.argv[2] || 5);
const temp = +(process.argv[3] || 30);
const scale = +(process.argv[4] || 1);
const opts = { depth, temperature: temp, priorScale: scale, movetime: 4000 };

const opera = run(OPERA_GAME, opts, `Opera Game — depth ${depth}, T ${temp}, prior ${scale}`, true);
const immortal = run(IMMORTAL_GAME, opts, `Immortal Game — depth ${depth}, T ${temp}, prior ${scale}`, false);

const total = opera.n + immortal.n;
const top1 = opera.top1 + immortal.top1;
const top3 = opera.top3 + immortal.top3;
console.log(`\n=== combined ===`);
console.log(`top-1: ${top1}/${total} (${(100 * top1 / total).toFixed(1)}%)   top-3: ${top3}/${total} (${(100 * top3 / total).toFixed(1)}%)`);
