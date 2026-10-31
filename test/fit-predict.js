'use strict';

/*
 * Fit the human-move blend on TRAIN positions only, then write the weights the
 * runtime predictor reads.
 *
 *   node test/fit-predict.js [positions]
 *
 * engine.predict() produces, for every legal move, a capped search score and the
 * log of the human prior learned from data/human-priors.json. How much of each
 * to use, and how peaked the resulting probability distribution should be, are
 * three numbers: searchWeight, priorWeight and temperature. They are chosen by
 * maximising top-1 accuracy on a deterministic sample of the TRAINING games
 * (never the evaluation split), with log-loss as the tie-break, and written to
 * data/predict-weights.json.
 *
 * test/predict-accuracy.js then measures the fitted model on games it has never
 * seen; nothing in this file touches that split.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const e = require(path.join(ROOT, 'engine.js'));
const model = require(path.join(ROOT, 'predict-model.js'));

e.setInfoHandler(() => {});

const DATA = path.join(__dirname, 'data');
const GAMES_FILE = path.join(DATA, 'human-games.json');
const GAMES_META = path.join(DATA, 'human-games.meta.json');
const OUT = path.join(ROOT, 'data', 'predict-weights.json');

const WANT = Math.max(50, +(process.argv[2] || 400));
const DEPTH = +(process.env.FIT_DEPTH || 4);
const MS = +(process.env.FIT_MS || 400);
const PLY_CAP = 40;

function hash32(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h ^ (h >>> 15)) >>> 0;
}

// Deterministic sample: walk the training games in file order, keep plies whose
// position hash falls under a threshold raised until enough samples exist. This
// ignores game boundaries on purpose - a sample per position, not per game - and
// the same threshold reproduces the same set every run.
function samplePositions() {
  const { games } = JSON.parse(fs.readFileSync(GAMES_FILE, 'utf8'));
  const meta = JSON.parse(fs.readFileSync(GAMES_META, 'utf8'));
  const evalIds = new Set(meta.split.evalGameIds);
  const train = games.filter(g => !evalIds.has(g.id));
  if (!train.length) throw new Error('train split is empty');

  for (let thresh = 0.02; thresh <= 1.0001; thresh += 0.02) {
    const out = [];
    for (const g of train) {
      e.setFen(e.START_FEN);
      for (let i = 0; i < Math.min(g.moves.length, PLY_CAP); i++) {
        const fen = e.getFen();
        const h = hash32(g.id + ' ' + i) / 4294967296;
        if (h < thresh) out.push({ fen, actual: g.moves[i], gameId: g.id, ply: i });
        if (!e.applyUciMove(g.moves[i])) break;
      }
    }
    if (out.length >= WANT) return { samples: out.slice(0, WANT), threshold: thresh, trainGames: train.length };
  }
  throw new Error('not enough training positions below the sample threshold');
}

/** Raw per-position evidence: scores, priors and the human move. */
function collect(samples) {
  const rows = [];
  let tableHits = 0;
  for (const s of samples) {
    e.setFen(s.fen);
    const legal = e.getLegalMoves().map(m => e.moveToStr(m));
    if (!legal.includes(s.actual)) continue;
    // loo: the position's own record of `s.actual` is withheld, so the prior
    // cannot be scored against the label it came from.
    const r = e.predict({ depth: DEPTH, movetime: MS, prior: false, loo: s.actual,
                          top: legal.length, raw: true });
    if (!r.moves || r.moves.length < 2) continue;
    if (r.priorSource === 'table') tableHits++;
    rows.push({
      actual: s.actual,
      moves: r.moves.map(m => ({ move: m.move, score: Math.max(-1500, Math.min(1500, m.score)), logp: m.logp })),
    });
  }
  return { rows, tableHits };
}

function score(rows, p) {
  let top1 = 0, top3 = 0, top5 = 0, ll = 0;
  for (const row of rows) {
    const v = row.moves.map(m => m.score * p.searchWeight + p.priorWeight * (m.logp === undefined ? 0 : m.logp));
    const best = Math.max(...v);
    const exp = v.map(x => Math.exp((x - best) / p.temperature));
    const z = exp.reduce((a, b) => a + b, 0) || 1;
    const order = v.map((x, i) => i).sort((a, b) => v[b] - v[a]);
    const rank = order.indexOf(row.moves.findIndex(m => m.move === row.actual));
    if (rank === 0) top1++;
    if (rank < 3) top3++;
    if (rank < 5) top5++;
    const ai = row.moves.findIndex(m => m.move === row.actual);
    if (ai >= 0) ll += -Math.log(Math.max(exp[ai] / z, 1e-12));
  }
  const n = rows.length;
  return { top1: top1 / n, top3: top3 / n, top5: top5 / n, ll: ll / n, n };
}

(async () => {
  if (!model.available()) throw new Error('data/human-priors.json missing - run node test/train-priors.js first');
  const { samples, threshold, trainGames } = samplePositions();
  console.log(`sampled ${samples.length} training positions (hash threshold ${threshold.toFixed(2)}, ` +
              `${trainGames} train games, ply <= ${PLY_CAP})`);
  const { rows, tableHits } = await collect(samples);
  console.log(`scored ${rows.length} positions, ${tableHits} with a table hit; ` +
              `search depth ${DEPTH}, ${MS} ms budget`);

  const grid = [];
  for (const priorWeight of [0, 40, 80, 120, 180, 250, 350, 500])
    for (const temperature of [12, 20, 30, 45, 70, 110])
      for (const searchWeight of [0.6, 1, 1.6])
        grid.push({ searchWeight, priorWeight, temperature });

  const results = grid.map(p => Object.assign({}, p, score(rows, p)))
    .sort((a, b) => b.top1 - a.top1 || a.ll - b.ll);

  console.log('\ntop fits on train (leave-one-out: each position is scored as if its own observation had not been seen):');
  for (const r of results.slice(0, 6)) {
    console.log(`  priorWeight ${String(r.priorWeight).padStart(4)}  T ${String(r.temperature).padStart(3)}  ` +
                `searchWeight ${r.searchWeight}  ->  top-1 ${(100 * r.top1).toFixed(1)}%  ` +
                `top-3 ${(100 * r.top3).toFixed(1)}%  top-5 ${(100 * r.top5).toFixed(1)}%  ll ${r.ll.toFixed(3)}`);
  }
  const best = results[0];
  const base = results.find(r => r.priorWeight === 0 && r.temperature === 30 && r.searchWeight === 1) || best;
  console.log(`\nsearch-only reference: top-1 ${(100 * base.top1).toFixed(1)}%  ` +
              `top-3 ${(100 * base.top3).toFixed(1)}%  top-5 ${(100 * base.top5).toFixed(1)}%  ll ${base.ll.toFixed(3)}`);

  const out = {
    searchWeight: best.searchWeight,
    priorWeight: best.priorWeight,
    temperature: best.temperature,
    alpha: model.getWeights().alpha,
    backoffK: model.getWeights().backoffK,
    fitted: {
      positions: rows.length, tableHits, trainGames, plyCap: PLY_CAP,
      depth: DEPTH, msPerPosition: MS, threshold,
      trainTop1: +(100 * best.top1).toFixed(2), trainLogLoss: +best.ll.toFixed(4),
      searchOnlyTop1: +(100 * base.top1).toFixed(2),
    },
    note: 'Fitted on the TRAIN split of the CC0 Lichess set only. test/predict-accuracy.js measures the held-out EVAL split.',
    fittedAt: new Date().toISOString(),
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${path.relative(ROOT, OUT)}`);
  console.log('  ' + JSON.stringify({ searchWeight: out.searchWeight, priorWeight: out.priorWeight, temperature: out.temperature }));
})().catch(err => {
  console.error('fit failed:', err.message);
  process.exit(1);
});
