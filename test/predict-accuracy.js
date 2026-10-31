'use strict';

/*
 * Human-move prediction harness. Evaluates ANY predictor on the held-out EVAL
 * split of test/data/human-games.json.
 *
 *   node test/predict-accuracy.js                                  # baselines, full eval
 *   node test/predict-accuracy.js --predictor ./my-model.js
 *   node test/predict-accuracy.js --limit 1200                     # documented subset
 *   node test/predict-accuracy.js --bands --verbose
 *   node test/predict-accuracy.js --predictor builtin:train-prior
 *
 * PREDICTOR INTERFACE (so a model can be wired in without touching engine.js)
 *   module.exports = {
 *     name: 'string',
 *     init?(ctx)                 // once, before the first sample
 *     predict(fen, legal, ctx)   // engine is sitting ON `fen`; legal = [uci]
 *   }
 * `predict` returns either
 *   [uci, uci, ...]                       ranked, best first (no probabilities)
 *   [{move, prob}, ...] | {moves: [...]}  ranked WITH probabilities
 *   null / []                             "no opinion" (counts as a miss)
 * `ctx` = { key, ply, plyIndex, side: 'white'|'black', gameId, game, legal, source }
 *
 * Built-in baselines selectable with `builtin:<name>`:
 *   uniform      legal moves in engine move-generation order, flat probability
 *   train-prior  the CC0 position table (data/human-priors.json) with a
 *                naive-Bayes feature backoff - no search, no fitted weights
 *   engine-d4    what Kiwa's JS search picks at depth 4 (engine.search only;
 *                engine.predict() is deliberately NOT used anywhere in here)
 *
 * Metrics: top-1/3/5 with a Wilson 95% interval, coverage, mean log-loss and a
 * 10-bin expected calibration error, overall plus per-ply-band and per-colour.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const e = require(path.join(ROOT, 'engine.js'));
const priors = require(path.join(ROOT, 'test/train-priors.js'));

const DATA = path.join(__dirname, 'data');
const GAMES_FILE = path.join(DATA, 'human-games.json');
const GAMES_META = path.join(DATA, 'human-games.meta.json');
const PRIORS_FILE = path.join(ROOT, 'data', 'human-priors.json');

const EPS = 1e-6;          // probability floor, keeps log-loss finite
const BANDS = [
  { name: 'opening (ply 1-16)', lo: 1, hi: 16 },
  { name: 'middlegame (ply 17-64)', lo: 17, hi: 64 },
  { name: 'endgame (ply 65+)', lo: 65, hi: Infinity },
];

// --- stats ------------------------------------------------------------------

function hash32(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h ^ (h >>> 15)) >>> 0;
}

// Wilson score interval: honest for small n and proportions near 0 or 1.
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n;
  const d = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / d;
  const half = (z / d) * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function pct(x) { return (100 * x).toFixed(2) + '%'; }
function fmtCI(k, n) {
  if (!n) return 'n/a';
  const [lo, hi] = wilson(k, n);
  return `${k}/${n} = ${pct(k / n)} [95% CI ${pct(lo)}-${pct(hi)}]`;
}

function newBucket() { return { n: 0, t1: 0, t3: 0, t5: 0, cov: 0, ll: 0, llN: 0, conf: [], hit: [], rank: [], src: {} }; }

function accumulate(b, ranked, probs, actual, source) {
  b.n++;
  const idx = ranked.indexOf(actual);
  const top1 = idx === 0;
  if (top1) b.t1++;
  if (idx >= 0 && idx < 3) b.t3++;
  if (idx >= 0 && idx < 5) b.t5++;
  if (idx >= 0) b.cov++;
  b.rank.push(idx >= 0 ? idx + 1 : Infinity);
  if (source) b.src[source] = (b.src[source] || 0) + 1;
  if (probs) {
    const p = idx >= 0 ? probs[idx] : 0;
    b.ll += -Math.log(Math.max(EPS, p));
    b.llN++;
    if (probs.length) { b.conf.push(probs[0]); b.hit.push(top1 ? 1 : 0); }
  }
  return top1;
}

// Expected calibration error of the top-1 probability vs the actual hit rate.
function ece(conf, hit, bins = 10) {
  if (!conf.length) return null;
  const buckets = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
  for (let i = 0; i < conf.length; i++) {
    const b = Math.min(bins - 1, Math.floor(conf[i] * bins));
    buckets[b].n++; buckets[b].p += conf[i]; buckets[b].y += hit[i];
  }
  let sum = 0;
  const rows = [];
  for (let i = 0; i < bins; i++) {
    const b = buckets[i];
    if (!b.n) { rows.push({ bin: `${(i / bins).toFixed(1)}-${((i + 1) / bins).toFixed(1)}`, n: 0, pred: null, actual: null }); continue; }
    const avgP = b.p / b.n, avgY = b.y / b.n;
    sum += (b.n / conf.length) * Math.abs(avgP - avgY);
    rows.push({ bin: `${(i / bins).toFixed(1)}-${((i + 1) / bins).toFixed(1)}`, n: b.n, pred: avgP, actual: avgY });
  }
  return { value: sum, rows };
}

// --- eval samples -----------------------------------------------------------

function buildEvalSamples(evalIds) {
  const { games } = JSON.parse(fs.readFileSync(GAMES_FILE, 'utf8'));
  const out = [];
  for (const g of games) {
    if (!evalIds.has(g.id)) continue;
    e.setFen(e.START_FEN);
    for (let ply = 0; ply < g.moves.length; ply++) {
      const fen = e.getFen();
      const legal = e.getLegalMoves().map(m => e.moveToStr(m));
      if (!legal.length) break;
      const actual = g.moves[ply];
      if (!legal.includes(actual)) break; // dataset guarantees this; belt and braces
      out.push({
        gameId: g.id, ply: ply + 1, plyIndex: ply, fen,
        key: fen.split(' ').slice(0, 3).join(' '),
        side: e.side === e.WHITE ? 'white' : 'black',
        legal, actual, game: g,
      });
      e.applyUciMove(actual);
    }
  }
  return out;
}

// --- built-in predictors ----------------------------------------------------

function makeUniform() {
  return {
    name: 'uniform (move-generation order)',
    predict: (fen, legal) => legal.map(m => ({ move: m, prob: 1 / legal.length })),
  };
}

function makeTrainPrior(opts) {
  const P = JSON.parse(fs.readFileSync(PRIORS_FILE, 'utf8'));
  const FEATS = P.features;
  const fs_ = P.featureStats;
  const alpha = opts.alpha ?? 0.5;   // add-one-ish smoothing on the count table
  const K = opts.backoffK ?? 4;      // counts needed before the table beats the backoff
  let tableHits = 0, calls = 0;

  // log-odds of each feature under "human played this" vs "any legal move"
  const w = FEATS.map(f => {
    const h = Math.max(1e-6, Math.min(1 - 1e-6, fs_[f].humanRate));
    const l = Math.max(1e-6, Math.min(1 - 1e-6, fs_[f].legalRate));
    return [Math.log(h / l), Math.log((1 - h) / (1 - l))];
  });

  function nbScore(fen, mvInt, legalInts) {
    const flags = priors.featureFlagsLite(fen, e.moveToStr(mvInt), mvInt, legalInts);
    if (!flags) return -50;
    let s = 0;
    for (let i = 0; i < FEATS.length; i++) {
      const f = FEATS[i];
      if (f === 'recapture') continue; // no previous-ply context at prediction time
      s += flags[f] ? w[i][0] : w[i][1];
    }
    return s;
  }

  return {
    name: 'train-prior (CC0 position table + naive-Bayes feature backoff)',
    predict(fen, legal, ctx) {
      const rows = P.positions[ctx.key];
      const counts = new Map();
      let total = 0;
      if (rows) {
        const legalSet = new Set(legal);
        for (const [uci, n] of rows) if (legalSet.has(uci)) { counts.set(uci, n); total += n; }
      }
      const lambda = total / (total + K);
      const legalInts = e.getLegalMoves();
      const tableTerm = new Map();
      for (const m of legal) tableTerm.set(m, lambda * ((counts.get(m) || 0) + alpha) / (total + alpha * legal.length));
      const nb = new Map();
      let nbMax = -Infinity;
      for (const mv of legalInts) { const s = nbScore(fen, mv, legalInts); nb.set(e.moveToStr(mv), s); if (s > nbMax) nbMax = s; }
      // softmax the naive-Bayes log-odds with temperature 1 (documented, not fitted)
      let z = 0;
      const exp = new Map();
      for (const [m, s] of nb) { const v = Math.exp(s - nbMax); exp.set(m, v); z += v; }
      const p = legal.map(m => ({ move: m, prob: tableTerm.get(m) + (1 - lambda) * (exp.get(m) || 0) / z }));
      const z2 = p.reduce((s, r) => s + r.prob, 0) || 1;
      for (const r of p) r.prob /= z2;
      p.sort((a, b) => b.prob - a.prob);
      calls++;
      if (rows) tableHits++;
      return { moves: p, source: rows ? 'table' : 'backoff' };
    },
    info: () => ({ predictions: calls, whereKeyWasInTable: tableHits, positionsInTable: Object.keys(P.positions).length, alpha, backoffK: K }),
  };
}

function makeEngineD4(opts) {
  const depth = opts.depth ?? 4;
  const rankedDepths = [];
  for (let d = depth; d >= 1; d--) rankedDepths.push(d);
  let calls = 0, ms = 0;
  return {
    name: `engine move at depth ${depth} (Kiwa JS search, iterative-deepening ranking)`,
    predict(fen) {
      const t0 = Date.now();
      e.setFen(fen);
      const legal = e.getLegalMoves().map(m => e.moveToStr(m));
      const ranked = [];
      for (const d of rankedDepths) {
        const r = e.search({ depth: d });
        const mv = r && r.bestMoveStr;
        if (mv && legal.includes(mv) && !ranked.includes(mv)) ranked.push(mv);
      }
      // top-5 needs more than the 4 iteration winners: pad with the rest of the
      // legal moves in move-generation order. Documented, arbitrary tail.
      for (const m of legal) if (!ranked.includes(m)) ranked.push(m);
      // Fixed geometric confidence: p_i proportional to 0.5^i over the searched
      // moves, 0.02 for every unranked move. NOT a calibrated model - it exists
      // so log-loss/ECE are computable for a single-move search baseline.
      const w = ranked.map((m, i) => (i < rankedDepths.length ? Math.pow(0.5, i) : 0.02));
      const z = w.reduce((s, x) => s + x, 0);
      calls++; ms += Date.now() - t0;
      return { moves: ranked.map((m, i) => ({ move: m, prob: w[i] / z })), source: `search-d1..${depth}` };
    },
    info: () => ({ searches: calls, ms }),
  };
}

function loadPredictor(spec, opts) {
  if (spec === 'builtin:uniform') return makeUniform();
  if (spec === 'builtin:train-prior') return makeTrainPrior(opts);
  if (spec === 'builtin:engine-d4') return makeEngineD4(opts);
  const abs = path.resolve(ROOT, spec);
  const mod = require(abs);
  const p = typeof mod === 'function' ? mod(opts) : mod;
  if (typeof p.predict !== 'function') throw new Error(spec + ' must export predict(fen, legal, ctx)');
  if (!p.name) p.name = path.basename(spec);
  return p;
}

// --- run --------------------------------------------------------------------

function parseArgs(argv) {
  const o = { predictors: [], limit: 0, seed: 'kiwa-subset-v1', bands: false, verbose: false, split: 'eval' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--predictor') o.predictors.push(argv[++i]);
    else if (a === '--limit') o.limit = +argv[++i];
    else if (a === '--seed') o.seed = argv[++i];
    else if (a === '--depth') o.depth = +argv[++i];
    else if (a === '--bands') o.bands = true;
    else if (a === '--verbose') o.verbose = true;
    else if (a === '--split') o.split = argv[++i];
    else if (a === '--alpha') o.alpha = +argv[++i];
    else if (a === '--backoff-k') o.backoffK = +argv[++i];
    else if (a === '--list') o.list = true;
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else console.error('ignoring unknown argument: ' + a);
  }
  if (!o.predictors.length) o.predictors = ['builtin:uniform', 'builtin:train-prior', 'builtin:engine-d4'];
  return o;
}

const USAGE = `usage: node test/predict-accuracy.js [options]
  --predictor NAME      builtin:uniform | builtin:train-prior | builtin:engine-d4 | ./path/to/model.js  (repeatable)
  --limit N             evaluate a deterministic subset of N eval positions (printed rule keeps it reproducible)
  --seed STR            seed for the subset rule (default kiwa-subset-v1)
  --split eval|train    default eval; --split train leaks and is only for debugging
  --depth N             depth for the builtin engine baseline (default 4)
  --alpha F             count smoothing for builtin:train-prior (default 0.5)
  --backoff-k F         table-vs-backoff mixture constant (default 4)
  --bands               print per-ply-band rows (always printed here anyway)
  --verbose             one line per position
  --list                dump the sampled positions and exit`;

function main() {
  const opts = parseArgs(process.argv);
  if (!fs.existsSync(GAMES_FILE)) { console.error('Missing test/data/human-games.json - run: node test/fetch-human-games.js'); process.exit(1); }
  const meta = JSON.parse(fs.readFileSync(GAMES_META, 'utf8'));
  e.setInfoHandler(() => {});

  if (opts.split !== 'eval') console.log(`NOTE: --split ${opts.split} is NOT a held-out measurement${opts.split === 'train' ? ' (the prior table was fit on these games).' : ''}\n`);
  const wanted = opts.split === 'eval' ? new Set(meta.split.evalGameIds)
    : opts.split === 'train' ? new Set(meta.split.trainGameIds)
    : new Set([...meta.split.evalGameIds, ...meta.split.trainGameIds]);
  let samples = buildEvalSamples(wanted);

  if (opts.limit && opts.limit < samples.length) {
    const scored = samples.map(s => ({ s, h: hash32(`${opts.seed}|${s.gameId}|${s.ply}`) }));
    scored.sort((a, b) => a.h - b.h || (a.s.gameId < b.s.gameId ? -1 : 1));
    samples = scored.slice(0, opts.limit).map(x => x.s);
    samples.sort((a, b) => (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : a.ply - b.ply));
    console.log(`SUBSET: ${samples.length} of the eval split, chosen by the ${opts.seed ? 'documented deterministic rule' : 'rule'} `
      + `hash32("${opts.seed}|gameId|ply") ascending, first ${opts.limit}. Rule and seed are printed so the `
      + `same positions come back next run.\n`);
  }
  console.log(`held-out samples: ${samples.length} plies from ${new Set(samples.map(s => s.gameId)).size} eval games `
    + `(split: ${meta.split.method})`);
  console.log(`WARNING: this is a HELD-OUT SET OF A FEW THOUSAND PLIES AT MOST from ${meta.totals.evalGames} games by `
    + `${meta.accounts.length} Lichess accounts. Intervals below are +/- several points; treat anything inside an `
    + `interval as "not distinguishable", and re-run as the dataset grows. Small-set numbers are NOT a claim about `
    + `general human accuracy.\n`);

  if (opts.list) { samples.forEach((s, i) => console.log(i, s.gameId, s.ply, s.side, s.fen, s.actual)); return; }

  const predictors = opts.predictors.map(spec => loadPredictor(spec, opts));
  const state = predictors.map(() => ({ all: newBucket(), byBand: BANDS.map(() => newBucket()), byColour: { white: newBucket(), black: newBucket() } }));
  const started = Date.now();
  // uniform-over-legal log-loss floor for exactly this sample set
  const meanLnLegal = list => list.length ? list.reduce((s, x) => s + Math.log(x.legal.length), 0) / list.length : null;
  const floors = {
    all: meanLnLegal(samples),
    bands: BANDS.map(b => meanLnLegal(samples.filter(s => s.ply >= b.lo && s.ply <= b.hi))),
    white: meanLnLegal(samples.filter(s => s.side === 'white')),
    black: meanLnLegal(samples.filter(s => s.side === 'black')),
  };

  for (const s of samples) {
    e.setFen(s.fen);
    const legal = s.legal.slice();
    for (let pi = 0; pi < predictors.length; pi++) {
      const p = predictors[pi];
      let out;
      try {
        if (p.init && !p._inited) { p.init({ meta, priorsFile: PRIORS_FILE, opts }); p._inited = true; }
        out = p.predict(s.fen, legal, { key: s.key, ply: s.ply, plyIndex: s.plyIndex, side: s.side, gameId: s.gameId, game: s.game, legal, source: 'eval' });
      } catch (err) {
        if (opts.verbose) console.error(`  predictor ${p.name} threw at ${s.gameId} ply ${s.ply}: ${err.message}`);
        out = null;
      }
      let ranked = [], probs = null;
      if (Array.isArray(out) || (out && Array.isArray(out.moves))) {
        const arr = Array.isArray(out) ? out : out.moves;
        if (arr.length && typeof arr[0] === 'object') { ranked = arr.map(x => x.move); probs = arr.map(x => +x.prob); }
        else { ranked = arr.slice(); }
      }
      const legalSet = new Set(legal);
      ranked = ranked.filter(m => legalSet.has(m));
      if (probs) {
        let z = 0; const clean = [];
        for (let i = 0; i < ranked.length; i++) { const v = Math.max(0, probs[i] || 0); clean.push(v); z += v; }
        if (z > 0) { for (let i = 0; i < clean.length; i++) clean[i] /= z; probs = clean; } else probs = null;
      }
      if (!ranked.length) probs = null;
      const source = (out && out.source) || (Array.isArray(out) && out.length === 0 ? 'none' : 'ranked');
      const b = state[pi].all;
      accumulate(b, ranked, probs, s.actual, source);
      const bandIdx = BANDS.findIndex(x => s.ply >= x.lo && s.ply <= x.hi);
      if (bandIdx >= 0) accumulate(state[pi].byBand[bandIdx], ranked, probs, s.actual, source);
      accumulate(state[pi].byColour[s.side], ranked, probs, s.actual, source);

      if (opts.verbose) {
        const med = r => { const f = r.filter(x => isFinite(x)); f.sort((a, b2) => a - b2); return f.length ? f[f.length >> 1] : NaN; };
        console.log(`  ${String(s.ply).padStart(3)} ${s.side[0]} ${s.actual} -> ${ranked.slice(0, 3).join(',')} ${probs ? '(p1 ' + probs[0].toFixed(3) + ')' : ''} rank=${ranked.indexOf(s.actual) + 1} medRank=${med(b.rank)}`);
      }
    }
  }

  // --- report ---------------------------------------------------------------
  console.log(`\nevaluated ${samples.length} positions in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  for (let pi = 0; pi < predictors.length; pi++) {
    const p = predictors[pi], st = state[pi];
    console.log('\n' + '='.repeat(78));
    console.log(`PREDICTOR: ${p.name}`);
    if (p.info) console.log(`  internals: ${JSON.stringify(p.info())}`);
    report('ALL', st.all, floors.all);
    for (let bi = 0; bi < BANDS.length; bi++) report(BANDS[bi].name, st.byBand[bi], floors.bands[bi]);
    report('WHITE to move', st.byColour.white, floors.white);
    report('BLACK to move', st.byColour.black, floors.black);
    const e1 = ece(st.all.conf, st.all.hit);
    if (e1) {
      console.log(`  ECE (top-1 prob vs hit rate, 10 bins): ${e1.value.toFixed(4)}`);
      console.log('    bin            n    predicted   actual');
      for (const r of e1.rows) console.log(`    ${r.bin.padEnd(8)}  ${String(r.n).padStart(6)}   ${r.pred === null ? '   -' : (100 * r.pred).toFixed(1) + '%'}      ${r.actual === null ? '-' : (100 * r.actual).toFixed(1) + '%'}`);
    } else console.log('  ECE: n/a (predictor returned no probabilities)');
  }
  console.log('\n' + '='.repeat(78));
  console.log('Honest notes:');
  console.log('  * "engine-d4" gets its top-3/top-5 from the best moves of the depth-4,3,2,1 iterations,');
  console.log('    padded with unranked legal moves in move-generation order; its probabilities are a fixed');
  console.log('    geometric 0.5^i shape, so its ECE measures an overconfident single-move predictor, not a model.');
  console.log('  * "train-prior" is a count table plus a naive-Bayes feature backoff. Nothing is fitted, no');
  console.log('    weights were tuned on eval, and the table only covers plies 1-' + (JSON.parse(fs.readFileSync(PRIORS_FILE, 'utf8')).plyCap) + '.');
  console.log('  * Accuracy is bounded below by how much the pool of players differs from whoever the engine');
  console.log('    will actually meet. Lichess blitz/bullet amateurs are not one distribution.');
}

function report(label, b, floor) {
  if (!b.n) { console.log(`  ${label}: no samples`); return; }
  const med = xs => { const f = xs.filter(x => isFinite(x)); if (!f.length) return null; f.sort((a, x) => a - x); return f[f.length >> 1]; };
  const srcs = Object.entries(b.src).sort((a, x) => x[1] - a[1]).map(([k, v]) => `${k} ${v} (${pct(v / b.n)})`).join(', ');
  console.log(`  ${label}  n=${b.n}`);
  console.log(`     top-1 ${fmtCI(b.t1, b.n)}`);
  console.log(`     top-3 ${fmtCI(b.t3, b.n)}`);
  console.log(`     top-5 ${fmtCI(b.t5, b.n)}`);
  console.log(`     coverage (human move somewhere in the ranking) ${fmtCI(b.cov, b.n)}${srcs ? '   [source: ' + srcs + ']' : ''}`);
  console.log(`     mean log-loss ${b.llN ? (b.ll / b.llN).toFixed(4) : 'n/a (no probabilities)'}   uniform-over-legal floor ${floor === null ? 'n/a' : floor.toFixed(4)}`);
  const m = med(b.rank);
  if (m !== null) console.log(`     median rank of the human move: ${m}`);
}

if (require.main === module) main();

module.exports = { buildEvalSamples, hash32, wilson, ece, loadPredictor, BANDS };
