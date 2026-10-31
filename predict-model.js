'use strict';

/*
 * Data-driven human-move prior, used by engine.js predict().
 *
 * Requires nothing, so engine.js can load it lazily without a require cycle;
 * the caller injects the engine module it inspects. Two evidence sources are
 * mixed:
 *
 *   table    how often humans actually played this move in this position, from
 *            data/human-priors.json (TRAIN split of the CC0 Lichess set);
 *   backoff  twelve deterministic move features scored by their human-vs-legal
 *            odds ratios, which still gives an opinion in positions the table
 *            has never seen (most of the board).
 *
 * If the model files are absent, available() is false and predict() keeps its
 * previous hand-written priors - a bare checkout still works.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PRIORS_FILE = path.join(ROOT, 'data', 'human-priors.json');
const WEIGHTS_FILE = path.join(ROOT, 'data', 'predict-weights.json');

const VAL = [0, 100, 320, 330, 500, 900, 20000];
const CENTER = new Set(['d4', 'e4', 'd5', 'e5']);

const DEFAULT_WEIGHTS = {
  alpha: 0.5,          // Dirichlet smoothing on the count table
  backoffK: 4,         // counts before the table outweighs the feature model
  searchWeight: 1,     // weight on the capped search score
  priorWeight: 0,      // centipawns per nat of log-prior
  temperature: 30,     // softmax temperature on the blended score
};

let cache = null;
let weights = null;

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(PRIORS_FILE, 'utf8'));
    const odds = raw.features.map(f => {
      const st = raw.featureStats[f];
      const h = Math.max(1e-6, Math.min(1 - 1e-6, st.humanRate));
      const l = Math.max(1e-6, Math.min(1 - 1e-6, st.legalRate));
      return [Math.log(h / l), Math.log((1 - h) / (1 - l))];
    });
    cache = { positions: raw.positions, features: raw.features, odds };
  } catch (err) {
    cache = null;
  }
  try {
    weights = Object.assign({}, DEFAULT_WEIGHTS, JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8')));
  } catch (err) {
    weights = Object.assign({}, DEFAULT_WEIGHTS);
  }
  return cache;
}

function getWeights() {
  if (!weights) load();
  return weights;
}

function available() {
  return !!load();
}

function sqName(sq) {
  return String.fromCharCode(97 + (sq & 7)) + String.fromCharCode(49 + (sq >> 4));
}

function chebyshev(a, b) {
  return Math.max(Math.abs((a >> 4) - (b >> 4)), Math.abs((a & 7) - (b & 7)));
}

function keyOf(fen) {
  return fen.split(' ').slice(0, 3).join(' ');
}

function pieceCounts(boardStr) {
  const c = {};
  for (const ch of boardStr) {
    const l = ch.toLowerCase();
    if ('pnbrqk'.includes(l)) c[l] = (c[l] || 0) + 1;
  }
  return c;
}

// Which piece type was lost by the side that did NOT move (promotion safe: the
// walk goes q, r, b, n, p).
function capturedType(beforeBoard, afterBoard) {
  const a = pieceCounts(beforeBoard), b = pieceCounts(afterBoard);
  for (const p of ['q', 'r', 'b', 'n', 'p']) if ((a[p] || 0) - (b[p] || 0) > 0) return p;
  return null;
}

/**
 * Feature flags for one move, matching test/train-priors.js featureFlagsLite.
 * Leaves the engine on the original position.
 */
function moveFlags(eng, beforeFen, mvInt, uci, bookTable) {
  const d = eng.describeMove(mvInt);
  const f = {
    capture: false, castling: false, check: false, queenTrade: false, centralPawn: false,
    develop: false, recapture: false, kingZone: false, hanging: false, inBook: false,
    quiet: false, queenMove: false,
  };
  f.capture = !!(d.cap || d.ep);
  f.castling = !!d.castle;
  f.quiet = !f.capture && !d.castle && !d.promo;
  f.queenMove = d.piece === 5;
  if (d.piece === 1 && (CENTER.has(sqName(d.to)) ||
      (Math.abs((d.to >> 4) - (d.from >> 4)) === 2 && (d.to & 7) >= 2 && (d.to & 7) <= 5))) f.centralPawn = true;
  const home = d.color === eng.WHITE ? 0 : 7;
  if ((d.piece === 2 || d.piece === 3) && (d.from >> 4) === home && (d.to >> 4) !== home) f.develop = true;

  eng.applyUciMove(uci);
  const after = eng.getFen();
  f.check = eng.inCheck();
  const cap = capturedType(beforeFen.split(' ')[0], after.split(' ')[0]);
  const enemyKing = eng.kingSq[eng.side]; // after the move, `side` is the victim
  if (enemyKing !== undefined && chebyshev(d.to, enemyKing) <= 2) f.kingZone = true;

  const moverVal = VAL[d.piece] || 100;
  let minAttacker = Infinity, queenRecapture = false;
  for (const r of eng.getLegalMoves()) {
    const rd = eng.describeMove(r);
    if (!rd.cap || rd.to !== d.to) continue;
    const v = VAL[rd.piece] || 100;
    if (v < minAttacker) minAttacker = v;
    if (rd.piece === 5) queenRecapture = true;
  }
  if (minAttacker <= moverVal && !f.check) f.hanging = true;
  if (cap === 'q' || (d.piece === 5 && queenRecapture)) f.queenTrade = true;

  if (bookTable) {
    const row = bookTable.get(keyOf(beforeFen));
    if (row && row.has(uci)) f.inBook = true;
  }
  eng.setFen(beforeFen);
  return f;
}

/**
 * Log of the unnormalised human prior for each move in `legalUci`.
 *
 * `eng` is the engine module (or a wrapper with the same surface) sitting on
 * `fen`. The caller controls how the board is rewound: engine.js passes a
 * make/unmake wrapper so a prediction never destroys the repetition history,
 * while offline tools can pass the real module.
 *
 * @param {object} eng      engine surface: describeMove, applyUciMove, setFen,
 *                          getFen, inCheck, getLegalMoves, moveToStr, side,
 *                          kingSq, WHITE
 * @param {string} fen      position the moves are played from
 * @param {number[]} legal  legal move ints, caller's order
 * @param {string[]} legalUci the same moves as strings
 * @param {Map} bookTable   position key -> Set(uci) of book moves (inBook flag)
 * @param {Map} [loo]       moves whose observations are withheld, Map(uci->count)
 * @returns {{logp:number[], source:string}|null}
 */
function logPrior(eng, fen, legal, legalUci, bookTable, loo) {
  const model = load();
  if (!model) return null;
  const w = getWeights();

  const counts = new Map();
  let total = 0;
  const rows = model.positions[keyOf(fen)];
  const set = new Set(legalUci);
  if (rows) {
    for (const [uci, n] of rows) {
      if (!set.has(uci)) continue;
      // Leave-one-out: fitting must not score a position using the very
      // observation it is asked to predict, or the count is a copy of the label.
      const c = loo && loo.has(uci) ? Math.max(0, n - loo.get(uci)) : n;
      counts.set(uci, c);
      total += c;
    }
  }
  const lambda = total / (total + w.backoffK);
  const table = legalUci.map(mv => lambda * ((counts.get(mv) || 0) + w.alpha) / (total + w.alpha * legalUci.length));

  const scores = [];
  let max = -Infinity;
  for (let i = 0; i < legal.length; i++) {
    const fl = moveFlags(eng, fen, legal[i], legalUci[i], bookTable);
    let s = 0;
    for (let k = 0; k < model.features.length; k++) {
      if (model.features[k] === 'recapture') continue;   // needs the previous ply
      s += fl[model.features[k]] ? model.odds[k][0] : model.odds[k][1];
    }
    scores.push(s);
    if (s > max) max = s;
  }
  const exp = scores.map(s => Math.exp(s - max));
  const z = exp.reduce((a, b) => a + b, 0) || 1;
  const logp = table.map((v, i) => Math.log(Math.max(1e-9, v + (1 - lambda) * exp[i] / z)));
  return { logp, source: rows ? 'table' : 'backoff' };
}

module.exports = { available, getWeights, logPrior, moveFlags, keyOf, PRIORS_FILE, WEIGHTS_FILE, DEFAULT_WEIGHTS };
