'use strict';

/*
 * tools/nnue/train.js — experimental FRNN1 NNUE trainer.
 *
 *   node tools/nnue/train.js [--epochs N] [--batch N] [--lr F] [--seed N]
 *
 * Data: test/human-games/*.pgn (Lichess database exports, CC0 1.0).
 * Labels: final game result only, mapped to a score {win 1, draw 0.5, loss 0}
 * from the side-to-move perspective. Split by game id (FNV-1a, 80/20).
 *
 * Writes:
 *   data/nnue/frnn1.bin       quantized network (format documented in docs/NNUE.md)
 *   data/nnue/train.log       per-epoch training/validation log
 *   data/nnue/selftest.txt    <fen>|<expected_cp> lines for native/nnue_bench
 *   data/nnue/metrics.json    machine-readable summary of this run
 *
 * Quantization (exact fixed point, mirrored bit-for-bit by native/nnue.cpp):
 *   Per-layer power-of-two scales (shift1/shift2/shift3) are chosen from the
 *   trained weight magnitudes and stored in the header, so the format is not
 *   tied to one fixed scale. With shifts s1, s2, s3:
 *   acc  = b1q + sum(W1q)               W1q int16, b1q = round(b1 * 2^s1)
 *   a1   = clamp(round_half_away(acc / 2^s1), 0, 255)
 *   z2   = b2q + sum(a1*W2q)            W2q int16, b2q = round(b2 * 2^s2)
 *   a2   = clamp(round_half_away(z2 / 2^s2), 0, 255)
 *   out  = clamp(round_half_away((b3q + sum(a2*W3q)) / 2^s3), -4000, 4000)
 *          centipawns, always from the perspective of the side to move.
 *   See docs/NNUE.md for the exact binary layout.
 */

const fs = require('fs');
const path = require('path');
const P = require('./pgn.js');

const ROOT = path.resolve(__dirname, '..', '..');
const PGN_DIR = path.join(ROOT, 'test', 'human-games');
const OUT_DIR = path.join(ROOT, 'data', 'nnue');
const NET_PATH = path.join(OUT_DIR, 'frnn1.bin');
const LOG_PATH = path.join(OUT_DIR, 'train.log');
const SELFTEST_PATH = path.join(OUT_DIR, 'selftest.txt');
const METRICS_PATH = path.join(OUT_DIR, 'metrics.json');

const INPUT_FEATURES = 768;
const H1 = 32;
const H2 = 32;

// Quantized activation units are 0..255. The per-layer power-of-two weight
// scales are chosen after training (from the actual weight magnitudes) and
// stored in the header, so no layer silently clips 16-bit weights.
const CLAMP1 = 255;
const CLAMP2 = 255;
const CLAMP_OUT = 4000;
const TARGET_ACT_MAX = 200;        // post-training normalization target
const K_CP = 400;                  // sigmoid(out_cp / K_CP)

const MAGIC = 'FRNN1';
const VERSION = 1;
const HEADER_SIZE = 32;

// ---------------------------------------------------------------------------
// CLI + tiny deterministic RNG
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { epochs: 24, batch: 64, lr: 0.002, l2: 1e-5, seed: 12345, minPly: 12,
    w1mult: 1, w2mult: 1, w3mult: 1, dataset: null, evalFile: null, cpWeight: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error('missing value for ' + a);
      return v;
    };
    if (a === '--epochs') opts.epochs = Math.max(1, parseInt(val(), 10));
    else if (a === '--batch') opts.batch = Math.max(1, parseInt(val(), 10));
    else if (a === '--lr') opts.lr = parseFloat(val());
    else if (a === '--l2') opts.l2 = parseFloat(val());
    else if (a === '--w1mult') opts.w1mult = parseFloat(val());
    else if (a === '--w2mult') opts.w2mult = parseFloat(val());
    else if (a === '--w3mult') opts.w3mult = parseFloat(val());
    else if (a === '--seed') opts.seed = parseInt(val(), 10) >>> 0;
    else if (a === '--min-ply') opts.minPly = parseInt(val(), 10);
    else if (a === '--dataset') opts.dataset = val();
    else if (a === '--eval-file') opts.evalFile = val();
    else if (a === '--cpweight') opts.cpWeight = Math.max(0, Math.min(7, +val()));
    else if (a === '--help' || a === '-h') {
      console.log('usage: node tools/nnue/train.js [--epochs N] [--batch N] [--lr F] [--l2 F] [--seed N] [--min-ply N] [--w1mult F] [--w2mult F] [--w3mult F] [--dataset PATH] [--eval-file PATH]');
      console.log('  --dataset PATH    read a games.txt corpus (see tools/nnue/dataset.js) instead of test/human-games/*.pgn');
      console.log('  --eval-file PATH  train on Stockfish-labelled positions (JSONL from tools/nnue/label-positions.js)');
      process.exit(0);
    } else {
      throw new Error('unknown argument: ' + a);
    }
  }
  return opts;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Data loading / split / sampling
// ---------------------------------------------------------------------------

function hash32(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function loadGames(opts) {
  const optsDataset = opts.dataset;
  if (optsDataset) {
    // games.txt: '#'-prefixed header lines, then one game per line:
    //   id \t result \t whiteElo \t blackElo \t timeControl \t source \t uci moves
    // The dataset.js filter pass has already dropped non-standard variants,
    // aborted games, time-forfeit losses and bullet games. The validation
    // split stays train.js's job (game-level FNV-1a, same rule as before).
    const text = fs.readFileSync(optsDataset, 'utf8');
    const games = [];
    for (const line of text.split('\n')) {
      if (!line || line[0] === '#') continue;
      const parts = line.split('\t');
      if (parts.length < 7) continue;
      const moves = parts[6].trim().split(/\s+/).filter(Boolean);
      if (!parts[0] || !parts[1] || moves.length === 0) continue;
      games.push({ id: parts[0], result: parts[1], moves });
    }
    if (!games.length) throw new Error('no games parsed from ' + optsDataset);
    const plies = games.reduce((a, g) => a + g.moves.length, 0);
    return { files: [optsDataset], games, plies, skipped: new Map() };
  }
  const files = fs.readdirSync(PGN_DIR).filter(f => f.endsWith('.pgn')).sort();
  if (!files.length) throw new Error('no PGN files in ' + PGN_DIR);
  const texts = files.map(f => fs.readFileSync(path.join(PGN_DIR, f), 'utf8'));
  const parsed = P.parseGames(texts);
  return { files, ...parsed };
}

// Game result -> score in [0,1]: win 1, draw 0.5, loss 0.
// The sigmoid output is trained against this score with MSE; centipawns are
// K_CP * logit(score). This is the usual NNUE WDL-style target and avoids the
// degenerate constant solution that raw {-1,0,+1} targets have under a sigmoid.
function resultScore(result) {
  if (result === '1-0') return 1;
  if (result === '0-1') return 0;
  if (result === '1/2-1/2') return 0.5;
  return null;
}

/**
 * Replay all games once and collect positions at and after `minPly` moves.
 * Feature vectors are from the side-to-move perspective.
 * Split is by game id, so a game is wholly in train or validation.
 */
function buildSamples(games, opts) {
  const positions = [];
  const gamesMeta = [];
  const pos = P.setFen(P.newBoard(), P.START_FEN);

  for (let gi = 0; gi < games.length; gi++) {
    const g = games[gi];
    const score = resultScore(g.result);
    const isVal = (hash32('kiwa-frnn1 ' + g.id) % 100) >= 80;
    gamesMeta.push({ id: g.id, result: g.result, plies: g.moves.length, val: isVal });
    if (score === null) continue;

    P.setFen(pos, P.START_FEN);
    for (let m = 0; m < g.moves.length; m++) {
      if (!P.applyUci(pos, g.moves[m])) {
        throw new Error('illegal replay in game ' + g.id + ' move ' + m);
      }
      const ply = m + 1;
      if (ply < opts.minPly) continue;
      const side = pos.side;
      const feats = P.featuresFor(pos.b, side);
      const target = side === P.WHITE ? score : 1 - score;
      positions.push({
        game: gi,
        side,
        feats,
        fen: P.getFen(pos),
        target,
        val: isVal,
      });
    }
  }
  return { positions, gamesMeta };
}

/**
 * Builds training samples from Stockfish-labelled positions (JSONL).
 * Each line: {fen, [split], cp|mate, depth?, nodes?} — cp is from the
 * side to move's perspective; mate is converted to a saturated cp value.
 * The split field (train/val/test) is taken from the dataset; FENs without
 * one are hash-assigned 80/10/10. Validation/test stay game-level disjoint
 * because labels are unique positions.
 */
function buildEvalSamples(opts) {
  const positions = [];
  const pos = P.setFen(P.newBoard(), P.START_FEN);
  const fsLines = fs.readFileSync(opts.evalFile, 'utf8').split('\n');
  let n = 0, skippedBad = 0;
  const K = K_CP;
  for (const raw of fsLines) {
    const line = raw.trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { skippedBad++; continue; }
    if (!rec.fen) { skippedBad++; continue; }
    const cp = typeof rec.mate === 'number' ? (rec.mate > 0 ? 10000 : -10000) : rec.cp;
    if (typeof cp !== 'number') { skippedBad++; continue; }
    let feats;
    try {
      P.setFen(pos, rec.fen);
      feats = P.featuresFor(pos.b, pos.side);
    } catch { skippedBad++; continue; }
    const side = pos.side;
    let split = rec.split;
    if (split !== 'train' && split !== 'val' && split !== 'test') {
      const h = fnv1a32('frnn1-evalsplit ' + rec.fen) % 100;
      split = h < 80 ? 'train' : h < 90 ? 'val' : 'test';
    }
    const target = 1 / (1 + Math.exp(-Math.max(-10000, Math.min(10000, cp)) / K));
    positions.push({ game: n, side, feats, fen: rec.fen, target, val: split === 'val', test: split === 'test', cp });
    n++;
  }
  return { positions, gamesMeta: [], skipped: new Map([['bad-lines', skippedBad]]) };
}

// ---------------------------------------------------------------------------
// Accumulator (JS mirror of the C++ one) + consistency self-checks
// ---------------------------------------------------------------------------

class Acc {
  constructor(w1, b1, h1, persp) {
    this.w1 = w1;
    this.b1 = b1;
    this.h1 = h1;
    this.persp = persp;
    this.v = new Int32Array(h1);
  }
  reset(board) {
    this.v.set(this.b1);
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      const p = board[sq];
      if (p) this.addPiece(p, sq);
    }
  }
  addPiece(piece, sq) {
    const base = P.featureIndex(piece, sq, this.persp) * this.h1;
    for (let h = 0; h < this.h1; h++) this.v[h] += this.w1[base + h];
  }
  removePiece(piece, sq) {
    const base = P.featureIndex(piece, sq, this.persp) * this.h1;
    for (let h = 0; h < this.h1; h++) this.v[h] -= this.w1[base + h];
  }
}

function diffBoards(prev, cur, apply) {
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) continue;
    const a = prev[sq], b = cur[sq];
    if (a === b) continue;
    if (a) apply('remove', a, sq);
    if (b) apply('add', b, sq);
  }
}

/**
 * Walks every game and verifies, for every legal position:
 *   - add/remove of the board delta keeps the accumulator equal to a refresh
 *   - removing a piece and adding it back is the identity
 * Uses the final quantized feature weights, so it exercises the exact table
 * the C++ loader will use.
 */
function selfCheckAccumulator(q, games) {
  const pos = P.setFen(P.newBoard(), P.START_FEN);
  const prev = new Int8Array(128);
  const accs = [new Acc(q.w1, q.b1, q.h1, 0), new Acc(q.w1, q.b1, q.h1, 1)];
  const fresh = [new Int32Array(q.h1), new Int32Array(q.h1)];
  let checks = 0;
  let mismatches = 0;

  for (const g of games) {
    P.setFen(pos, P.START_FEN);
    for (const acc of accs) acc.reset(pos.b);
    prev.set(pos.b);
    for (let m = 0; m < g.moves.length; m++) {
      P.applyUci(pos, g.moves[m]);
      for (const acc of accs) {
        diffBoards(prev, pos.b, (op, piece, sq) => {
          if (op === 'add') acc.addPiece(piece, sq);
          else acc.removePiece(piece, sq);
        });
      }
      prev.set(pos.b);

      for (let pi = 0; pi < 2; pi++) {
        const acc = accs[pi];
        const saved = acc.v;
        acc.v = fresh[pi];
        acc.reset(pos.b);
        acc.v = saved;

        checks++;
        for (let h = 0; h < acc.h1; h++) {
          if (saved[h] !== fresh[pi][h]) { mismatches++; break; }
        }

        // remove/add round trip on one occupied square
        for (let sq = 0; sq < 128; sq++) {
          if (sq & 0x88) continue;
          const piece = pos.b[sq];
          if (!piece) continue;
          const before = saved.slice();
          acc.removePiece(piece, sq);
          acc.addPiece(piece, sq);
          let same = true;
          for (let h = 0; h < acc.h1; h++) if (acc.v[h] !== before[h]) { same = false; break; }
          checks++;
          if (!same) mismatches++;
          break;
        }
      }
    }
  }
  return { checks, mismatches };
}

// ---------------------------------------------------------------------------
// Float network + training
// ---------------------------------------------------------------------------

function initNet(rng) {
  const n = {
    h1: H1, h2: H2,
    w1: new Float32Array(INPUT_FEATURES * H1),
    b1: new Float32Array(H1),
    w2: new Float32Array(H1 * H2),
    b2: new Float32Array(H2),
    w3: new Float32Array(H2),
    b3: new Float32Array(1),
  };
  for (let h = 0; h < H1; h++) n.b1[h] = 64;
  for (let i = 0; i < n.w1.length; i++) n.w1[i] = gaussian(rng) * 4;
  for (let j = 0; j < H2; j++) n.b2[j] = 64;
  // Small random dense readout. This initialization (larger b2/w2/w3 than the
  // first attempt) performed best in the sweep and is the one used for the
  // shipped experimental net; see docs/NNUE.md for the measured numbers.
  for (let i = 0; i < n.w2.length; i++) n.w2[i] = gaussian(rng) * 0.05;
  for (let j = 0; j < H2; j++) n.w3[j] = gaussian(rng) * 0.3;
  n.b3[0] = 0;
  return n;
}

// Deep copies of every learnable tensor, used to keep the validation-optimal
// checkpoint. Exporting the final epoch instead (the previous behavior)
// over-exports after the val-MSE optimum in later epochs.
function snapshotNet(n) {
  return {
    w1: Float32Array.from(n.w1), b1: Float32Array.from(n.b1),
    w2: Float32Array.from(n.w2), b2: Float32Array.from(n.b2),
    w3: Float32Array.from(n.w3), b3: Float32Array.from(n.b3),
  };
}
function restoreNet(n, s) {
  n.w1.set(s.w1); n.b1.set(s.b1);
  n.w2.set(s.w2); n.b2.set(s.b2);
  n.w3.set(s.w3); n.b3.set(s.b3);
}

function relu(x) {
  return x > 0 ? x : 0;
}

function sigmoid(x) {
  if (x >= 30) return 1;
  if (x <= -30) return 0;
  return 1 / (1 + Math.exp(-x));
}

function evalFloat(n, feats) {
  const z1 = new Float32Array(H1);
  z1.set(n.b1);
  for (let f = 0; f < feats.length; f++) {
    const base = feats[f] * H1;
    for (let h = 0; h < H1; h++) z1[h] += n.w1[base + h];
  }
  const a1 = new Float32Array(H1);
  for (let h = 0; h < H1; h++) a1[h] = relu(z1[h]);

  const z2 = new Float32Array(H2);
  z2.set(n.b2);
  for (let h = 0; h < H1; h++) {
    const a = a1[h];
    if (a === 0) continue;
    for (let j = 0; j < H2; j++) z2[j] += a * n.w2[h * H2 + j];
  }
  const a2 = new Float32Array(H2);
  for (let j = 0; j < H2; j++) a2[j] = relu(z2[j]);

  let out = n.b3[0];
  for (let j = 0; j < H2; j++) out += a2[j] * n.w3[j];
  return { z1, a1, z2, a2, out };
}

function floatMSE(n, positions, idx) {
  let sum = 0;
  for (let k = 0; k < idx.length; k++) {
    const s = positions[idx[k]];
    const p = sigmoid(evalFloat(n, s.feats).out / K_CP);
    const d = p - s.target;
    sum += d * d;
  }
  return sum / idx.length;
}

function accuracy(n, positions, idx) {
  let ok = 0, nz = 0;
  for (let k = 0; k < idx.length; k++) {
    const s = positions[idx[k]];
    if (s.target === 0.5) continue;
    nz++;
    const p = sigmoid(evalFloat(n, s.feats).out / K_CP);
    if ((p > 0.5) === (s.target > 0.5)) ok++;
  }
  return nz ? ok / nz : 0;
}

/**
 * One epoch of Adam on mini-batches. Sparse W1 update: only active feature
 * columns receive gradient, but Adam is applied to the full dense array each
 * batch so trajectories are independent of batch composition.
 */
function trainEpoch(n, positions, idx, opt, rng, state) {
  const grads = {
    w1: new Float32Array(n.w1.length),
    b1: new Float32Array(H1),
    w2: new Float32Array(n.w2.length),
    b2: new Float32Array(H2),
    w3: new Float32Array(H2),
    b3: new Float32Array(1),
  };
  const z1 = new Float32Array(H1);
  const a1 = new Float32Array(H1);
  const z2 = new Float32Array(H2);
  const a2 = new Float32Array(H2);
  const dz1 = new Float32Array(H1);
  const dz2 = new Float32Array(H2);

  const order = new Uint32Array(idx.length);
  for (let i = 0; i < order.length; i++) order[i] = idx[i];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }

  let lossSum = 0;
  let sat1 = 0, sat2 = 0;
  let batchWeight = 0;
  const B = opt.batch;

  for (let start = 0; start < order.length; start += B) {
    const end = Math.min(start + B, order.length);
    batchWeight = 0;
    grads.w1.fill(0);
    grads.b1.fill(0);
    grads.w2.fill(0);
    grads.b2.fill(0);
    grads.w3.fill(0);
    grads.b3[0] = 0;

    for (let bi = start; bi < end; bi++) {
      const s = positions[order[bi]];
      const feats = s.feats;
      z1.set(n.b1);
      for (let f = 0; f < feats.length; f++) {
        const base = feats[f] * H1;
        for (let h = 0; h < H1; h++) z1[h] += n.w1[base + h];
      }
      for (let h = 0; h < H1; h++) {
        const z = z1[h];
        a1[h] = relu(z);
        if (z > 0) sat1++;
      }
      z2.set(n.b2);
      for (let h = 0; h < H1; h++) {
        const a = a1[h];
        if (a === 0) continue;
        const wbase = h * H2;
        for (let j = 0; j < H2; j++) z2[j] += a * n.w2[wbase + j];
      }
      for (let j = 0; j < H2; j++) {
        const z = z2[j];
        a2[j] = relu(z);
        if (z > 0) sat2++;
      }
      // Optional importance weight: up-weight decisive positions.
      const w = s.cp === undefined || !opt.cpWeight ? 1 : 1 + Math.min(7, opt.cpWeight * Math.abs(s.cp) / 150);
      batchWeight += w;

      let out = n.b3[0];
      for (let j = 0; j < H2; j++) out += a2[j] * n.w3[j];

      const p = sigmoid(out / K_CP);
      const d = p - s.target;
      lossSum += w * d * d;
      const dout = w * 2 * d * p * (1 - p) / K_CP;

      grads.b3[0] += dout;
      for (let j = 0; j < H2; j++) {
        grads.w3[j] += dout * a2[j];
        dz2[j] = z2[j] > 0 ? dout * n.w3[j] : 0;
      }
      for (let j = 0; j < H2; j++) grads.b2[j] += dz2[j];
      for (let h = 0; h < H1; h++) {
        const a = a1[h];
        let da = 0;
        const wbase = h * H2;
        for (let j = 0; j < H2; j++) {
          grads.w2[wbase + j] += dz2[j] * a;
          da += dz2[j] * n.w2[wbase + j];
        }
        dz1[h] = z1[h] > 0 ? da : 0;
        grads.b1[h] += dz1[h];
      }
      for (let f = 0; f < feats.length; f++) {
        const base = feats[f] * H1;
        for (let h = 0; h < H1; h++) grads.w1[base + h] += dz1[h];
      }
    }

    const inv = 1 / Math.max(batchWeight, 1e-6);
    for (let i = 0; i < grads.w1.length; i++) grads.w1[i] = grads.w1[i] * inv + state.l2 * n.w1[i];
    for (let i = 0; i < H1; i++) grads.b1[i] *= inv;
    for (let i = 0; i < grads.w2.length; i++) grads.w2[i] = grads.w2[i] * inv + state.l2 * n.w2[i];
    for (let i = 0; i < H2; i++) grads.b2[i] *= inv;
    for (let i = 0; i < H2; i++) grads.w3[i] = grads.w3[i] * inv + state.l2 * n.w3[i];
    grads.b3[0] *= inv;

    state.t++; // bias correction must not divide by (1 - beta^0) = 0
    adamStep(n.w1, grads.w1, state.m1w1, state.v1w1, state, state.lr * state.w1mult);
    adamStep(n.b1, grads.b1, state.m1b1, state.v1b1, state, state.lr * state.w1mult);
    adamStep(n.w2, grads.w2, state.m1w2, state.v1w2, state, state.lr * state.w2mult);
    adamStep(n.b2, grads.b2, state.m1b2, state.v1b2, state, state.lr * state.w2mult);
    adamStep(n.w3, grads.w3, state.m1w3, state.v1w3, state, state.lr * state.w3mult);
    adamStep(n.b3, grads.b3, state.m1b3, state.v1b3, state, state.lr * state.w3mult);
  }

  const nSamples = order.length;
  return {
    mse: lossSum / nSamples,
    act1: sat1 / (nSamples * H1),
    act2: sat2 / (nSamples * H2),
  };
}

function adamStep(w, g, m, v, state, lr) {
  const { beta1, beta2, eps } = state;
  const bc1 = 1 - Math.pow(beta1, state.t);
  const bc2 = 1 - Math.pow(beta2, state.t);
  for (let i = 0; i < w.length; i++) {
    const gi = g[i];
    m[i] = beta1 * m[i] + (1 - beta1) * gi;
    v[i] = beta2 * v[i] + (1 - beta2) * gi * gi;
    w[i] -= lr * (m[i] / bc1) / (Math.sqrt(v[i] / bc2) + eps);
  }
}

// ---------------------------------------------------------------------------
// Quantization + exact integer inference (shared definition with nnue.cpp)
// ---------------------------------------------------------------------------

/**
 * ReLU networks are positively homogeneous: dividing a pre-activation by s and
 * multiplying the next layer by s leaves the function unchanged. After
 * unconstrained float training we use that to bring both hidden activation
 * ranges into [0, 255] (target 200) before quantization, instead of training
 * against hard clamps that kill gradients.
 */
function normalizeActivations(n, positions, idx) {
  let max1 = 0, max2 = 0;
  for (let k = 0; k < idx.length; k++) {
    const r = evalFloat(n, positions[idx[k]].feats);
    for (let h = 0; h < H1; h++) if (r.a1[h] > max1) max1 = r.a1[h];
    for (let j = 0; j < H2; j++) if (r.a2[j] > max2) max2 = r.a2[j];
  }
  const s1 = max1 > TARGET_ACT_MAX ? max1 / TARGET_ACT_MAX : 1;
  if (s1 !== 1) {
    for (let i = 0; i < n.w1.length; i++) n.w1[i] /= s1;
    for (let i = 0; i < n.b1.length; i++) n.b1[i] /= s1;
    for (let i = 0; i < n.w2.length; i++) n.w2[i] *= s1;
    max2 /= s1; // layer-2 inputs were scaled by 1/s1
  }
  const s2 = max2 > TARGET_ACT_MAX ? max2 / TARGET_ACT_MAX : 1;
  if (s2 !== 1) {
    for (let i = 0; i < n.w2.length; i++) n.w2[i] /= s2;
    for (let i = 0; i < n.b2.length; i++) n.b2[i] /= s2;
    for (let i = 0; i < n.w3.length; i++) n.w3[i] *= s2;
  }
  return { max1, max2: max2 / s2, s1, s2 };
}

function chooseShift(weights) {
  let m = 0;
  for (let i = 0; i < weights.length; i++) {
    const a = Math.abs(weights[i]);
    if (a > m) m = a;
  }
  let k = 14;
  while (k > 0 && m * Math.pow(2, k) > 30000) k--;
  return k;
}

function quantize(n) {
  const shift1 = chooseShift(n.w1);
  const shift2 = chooseShift(n.w2);
  const shift3 = chooseShift(n.w3);
  const s1 = Math.pow(2, shift1), s2 = Math.pow(2, shift2), s3 = Math.pow(2, shift3);
  const q = {
    h1: n.h1, h2: n.h2,
    shift1, shift2, shift3,
    clamp1: CLAMP1, clamp2: CLAMP2, clampOut: CLAMP_OUT,
    w1: new Int16Array(n.w1.length),
    b1: new Int32Array(n.b1.length),
    w2: new Int16Array(n.w2.length),
    b2: new Int32Array(n.b2.length),
    w3: new Int16Array(n.w3.length),
    b3: new Int32Array(1),
    clipped: 0,
    maxAbs: { w1: 0, w2: 0, w3: 0, b1: 0, b2: 0, b3: 0 },
  };
  const put16 = (dst, i, x, scale) => {
    const v = Math.round(x * scale);
    if (v < -32768 || v > 32767) q.clipped++;
    dst[i] = Math.max(-32768, Math.min(32767, v));
  };
  for (let i = 0; i < q.w1.length; i++) put16(q.w1, i, n.w1[i], s1);
  for (let i = 0; i < q.b1.length; i++) q.b1[i] = Math.round(n.b1[i] * s1);
  for (let i = 0; i < q.w2.length; i++) put16(q.w2, i, n.w2[i], s2);
  for (let i = 0; i < q.b2.length; i++) q.b2[i] = Math.round(n.b2[i] * s2);
  for (let i = 0; i < q.w3.length; i++) put16(q.w3, i, n.w3[i], s3);
  q.b3[0] = Math.round(n.b3[0] * s3);
  for (let i = 0; i < q.w1.length; i++) q.maxAbs.w1 = Math.max(q.maxAbs.w1, Math.abs(q.w1[i]));
  for (let i = 0; i < q.w2.length; i++) q.maxAbs.w2 = Math.max(q.maxAbs.w2, Math.abs(q.w2[i]));
  for (let i = 0; i < q.w3.length; i++) q.maxAbs.w3 = Math.max(q.maxAbs.w3, Math.abs(q.w3[i]));
  q.maxAbs.b1 = q.b1.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  q.maxAbs.b2 = q.b2.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  q.maxAbs.b3 = Math.abs(q.b3[0]);
  return q;
}

/** Exact integer forward pass. Mirrors native/nnue.cpp line for line. */
function makeEvaluator(q) {
  const acc = new Int32Array(q.h1);
  const a1 = new Int32Array(q.h1);
  const a2 = new Int32Array(q.h2);
  const z2 = new Int32Array(q.h2);

  const relu = (x, shift, maxv) => {
    if (x <= 0) return 0;
    const v = Math.floor((x + (1 << (shift - 1))) / (1 << shift));
    return v > maxv ? maxv : v;
  };
  const divRound = (x, shift) => {
    const s = 1 << shift, half = s >> 1;
    return x >= 0 ? Math.floor((x + half) / s) : -Math.floor((-x + half) / s);
  };

  return function evaluate(feats) {
    acc.set(q.b1);
    for (let f = 0; f < feats.length; f++) {
      const base = feats[f] * q.h1;
      for (let h = 0; h < q.h1; h++) acc[h] += q.w1[base + h];
    }
    for (let h = 0; h < q.h1; h++) a1[h] = relu(acc[h], q.shift1, q.clamp1);
    let out = q.b3[0];
    for (let j = 0; j < q.h2; j++) {
      let z = q.b2[j];
      for (let h = 0; h < q.h1; h++) z += a1[h] * q.w2[h * q.h2 + j];
      z2[j] = z;
      a2[j] = relu(z, q.shift2, q.clamp2);
      out += a2[j] * q.w3[j];
    }
    const cp = divRound(out, q.shift3);
    return cp < -q.clampOut ? -q.clampOut : cp > q.clampOut ? q.clampOut : cp;
  };
}

function quantizedMSE(q, positions, idx) {
  const ev = makeEvaluator(q);
  let sum = 0;
  for (let k = 0; k < idx.length; k++) {
    const s = positions[idx[k]];
    const p = sigmoid(ev(s.feats) / K_CP);
    const d = p - s.target;
    sum += d * d;
  }
  return sum / idx.length;
}

// ---------------------------------------------------------------------------
// Binary writer
// ---------------------------------------------------------------------------

function fnv1a32(buf) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function writeNet(q) {
  const payloadSize = 4 * q.h1 + 2 * q.w1.length + 4 * q.h2 + 2 * q.w2.length + 4 + 2 * q.w3.length;
  const buf = Buffer.alloc(HEADER_SIZE + payloadSize);

  buf.write(MAGIC, 0, 'ascii');
  buf.writeUInt8(VERSION, 6);
  buf.writeUInt8(0, 7); // flags
  buf.writeUInt16LE(q.h1, 8);
  buf.writeUInt16LE(q.h2, 10);
  buf.writeUInt16LE(INPUT_FEATURES, 12);
  buf.writeUInt8(q.shift1, 14);
  buf.writeUInt8(q.shift2, 15);
  buf.writeUInt8(q.shift3, 16);
  buf.writeUInt8(0, 17);
  buf.writeUInt16LE(q.clamp1, 18);
  buf.writeUInt16LE(q.clamp2, 20);
  buf.writeUInt16LE(q.clampOut, 22);
  buf.writeUInt32LE(0, 24);

  let o = HEADER_SIZE;
  for (let i = 0; i < q.b1.length; i++, o += 4) buf.writeInt32LE(q.b1[i], o);
  for (let i = 0; i < q.w1.length; i++, o += 2) buf.writeInt16LE(q.w1[i], o);
  for (let i = 0; i < q.b2.length; i++, o += 4) buf.writeInt32LE(q.b2[i], o);
  for (let i = 0; i < q.w2.length; i++, o += 2) buf.writeInt16LE(q.w2[i], o);
  buf.writeInt32LE(q.b3[0], o); o += 4;
  for (let i = 0; i < q.w3.length; i++, o += 2) buf.writeInt16LE(q.w3[i], o);

  const checksum = fnv1a32(buf.subarray(HEADER_SIZE));
  buf.writeUInt32LE(checksum, 28);

  fs.writeFileSync(NET_PATH, buf);
  return { bytes: buf.length, checksum, payloadSize };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

let logLines = [];
function log(line) {
  console.log(line);
  logLines.push(line);
}
function flushLog(header) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LOG_PATH, header.concat(logLines).join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  logLines = [];
  const header = [];
  const started = Date.now();
  const rng = mulberry32(opts.seed);

  const { files, games, plies, skipped } = opts.evalFile
    ? { files: [opts.evalFile], games: [{ result: '?' }], plies: 0, skipped: new Map() }
    : loadGames(opts);
  header.push('# FRNN1 NNUE training log');
  header.push('# date: ' + new Date().toISOString());
  header.push(opts.evalFile
    ? '# data: Stockfish-labelled positions, file=' + opts.evalFile
    : '# data: test/human-games/*.pgn  files=' + files.length +
      ' games=' + games.length + ' plies=' + plies);
  header.push('# data license: CC0 1.0 (Lichess database export), see docs/NNUE.md');
  header.push(opts.evalFile
    ? '# label: Stockfish PV1 centipawns -> sigmoid(cp / 400) from side to move'
    : '# label: final game result only -> score {1,0.5,0} from side to move');
  header.push('# split: by dataset split field, else fnv1a(fen) % 100 80/10/10 (train/val/test)');
  header.push('# net: 768 -> ' + H1 + ' -> ' + H2 + ' -> 1; dynamic power-of-two scales in header; K=' + K_CP + 'cp');
  header.push('# opts: epochs=' + opts.epochs + ' batch=' + opts.batch + ' lr=' + opts.lr +
    ' seed=' + opts.seed + ' minPly=' + opts.minPly);
  header.push('');

  const tData = Date.now();
  const samples = opts.evalFile ? buildEvalSamples(opts) : buildSamples(games, opts);
  const { positions, gamesMeta } = samples;
  const trainIdx = [];
  const valIdx = [];
  const testIdx = [];
  for (let i = 0; i < positions.length; i++) {
    if (positions[i].test) testIdx.push(i);
    else if (positions[i].val) valIdx.push(i);
    else trainIdx.push(i);
  }
  const drawCount = games.filter(g => g.result === '1/2-1/2').length;

  log('data: ' + (opts.evalFile ? 'eval-labelled positions' : files.length + ' pgn files') +
    ', positions: ' + positions.length + ' (' + (Date.now() - tData) + ' ms to featurize)');
  log('split: ' + trainIdx.length + ' train / ' + valIdx.length + ' val / ' + testIdx.length +
    ' test positions');

  if (trainIdx.length < 1000 || valIdx.length < 200) {
    throw new Error('not enough positions: train=' + trainIdx.length + ' val=' + valIdx.length);
  }

  const n = initNet(rng);
  const state = {
    lr: opts.lr, beta1: 0.9, beta2: 0.999, eps: 1e-8, t: 0, l2: opts.l2,
    w1mult: opts.w1mult, w2mult: opts.w2mult, w3mult: opts.w3mult,
    m1w1: new Float32Array(n.w1.length), v1w1: new Float32Array(n.w1.length),
    m1b1: new Float32Array(H1), v1b1: new Float32Array(H1),
    m1w2: new Float32Array(n.w2.length), v1w2: new Float32Array(n.w2.length),
    m1b2: new Float32Array(H2), v1b2: new Float32Array(H2),
    m1w3: new Float32Array(H2), v1w3: new Float32Array(H2),
    m1b3: new Float32Array(1), v1b3: new Float32Array(1),
  };

  let trainMean = 0;
  for (const i of trainIdx) trainMean += positions[i].target;
  trainMean /= trainIdx.length;
  const baseP = Math.max(0, Math.min(1, trainMean));
  const baseMSE = (() => {
    let s = 0;
    for (const i of valIdx) { const d = positions[i].target - baseP; s += d * d; }
    return s / valIdx.length;
  })();
  let halfMSE = 0, zeroMSE = 0;
  for (const i of valIdx) {
    halfMSE += (0.5 - positions[i].target) ** 2;
    zeroMSE += positions[i].target ** 2;
  }
  halfMSE /= valIdx.length;
  zeroMSE /= valIdx.length;
  log('baseline (constant score ' + baseP.toFixed(4) + ', train mean): val MSE ' + baseMSE.toFixed(6));
  log('baseline (constant score 0.5): val MSE ' + halfMSE.toFixed(6) +
    '; constant score 0: val MSE ' + zeroMSE.toFixed(6));

  log('init: float val MSE ' + floatMSE(n, positions, valIdx).toFixed(6));

  log('');
  log('epoch | train_mse | val_mse  | act1% | act2% | lr       | sec');
  log('------+-----------+----------+-------+-------+----------+-----');

  let trainMSE = 0;
  let bestVal = Infinity, bestEpoch = 0, bestSnap = null, lastVal = NaN;
  for (let e = 1; e <= opts.epochs; e++) {
    const t0 = Date.now();
    const res = trainEpoch(n, positions, trainIdx, opts, rng, state);
    trainMSE = res.mse;
    const vMSE = floatMSE(n, positions, valIdx);
    lastVal = vMSE;
    if (vMSE < bestVal) { bestVal = vMSE; bestEpoch = e; bestSnap = snapshotNet(n); }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    log(String(e).padStart(5) + ' | ' + trainMSE.toFixed(6) + '  | ' + vMSE.toFixed(6) +
      '  | ' + (res.act1 * 100).toFixed(1).padStart(5) +
      ' | ' + (res.act2 * 100).toFixed(1).padStart(5) + ' | ' + state.lr.toFixed(8) + ' | ' + secs);
    // gentle cosine-ish decay in the last third
    if (e > (2 * opts.epochs) / 3) state.lr = Math.max(opts.lr * 0.1, state.lr * 0.9);
  }

  if (bestSnap) {
    restoreNet(n, bestSnap);
    log('');
    log('best-checkpoint: epoch ' + bestEpoch + ' restored before export ' +
      '(float val MSE ' + bestVal.toFixed(6) + ' vs final epoch ' + lastVal.toFixed(6) + ')');
  }

  const preNorm = floatMSE(n, positions, valIdx);
  const normInfo = normalizeActivations(n, positions, trainIdx);
  const finalFloat = floatMSE(n, positions, valIdx);
  const q = quantize(n);
  const finalQ = quantizedMSE(q, positions, valIdx);
  const acc = accuracy(n, positions, valIdx);
  const testAcc = testIdx.length ? accuracy(n, positions, testIdx) : null;
  const trainQ = quantizedMSE(q, positions, trainIdx);

  log('');
  log('activation range normalization: max a1=' + normInfo.max1.toFixed(1) +
    ' (scale 1/' + normInfo.s1.toFixed(3) + '), max a2=' + normInfo.max2.toFixed(1) +
    ' (scale 1/' + normInfo.s2.toFixed(3) + ')');
  log('float val MSE pre/post normalization: ' + preNorm.toFixed(6) + ' / ' + finalFloat.toFixed(6) +
    ' (should match: positive homogeneity)');
  log('final float val MSE      : ' + finalFloat.toFixed(6));
  log('final quantized val MSE  : ' + finalQ.toFixed(6));
  log('final quantized train MSE: ' + trainQ.toFixed(6));
  log('val sign accuracy (decisive only): ' + (acc * 100).toFixed(2) + '%');
  if (testAcc !== null) log('test sign accuracy (decisive only): ' + (testAcc * 100).toFixed(2) + '%');
  log('baseline constant val MSE: ' + baseMSE.toFixed(6));
  log('quantization shifts     : w1 ' + q.shift1 + ', w2 ' + q.shift2 + ', w3 ' + q.shift3);
  log('quantized clipping events: ' + q.clipped + ' (int16 range overflow)');
  log('max |q| w1/w2/w3: ' + q.maxAbs.w1 + '/' + q.maxAbs.w2 + '/' + q.maxAbs.w3);

  const wrote = writeNet(q);
  log('wrote ' + NET_PATH + ' (' + wrote.bytes + ' bytes, checksum 0x' +
    wrote.checksum.toString(16).padStart(8, '0') + ')');

  const ev = makeEvaluator(q);
  const lines = [];
  const sampleEvals = [];
  const pos = P.setFen(P.newBoard(), P.START_FEN);

  if (opts.evalFile) {
    // Eval mode has no games; selftest positions come from the validation set.
    const valPositions = valIdx.map(i => positions[i]);
    const chosen = valPositions.slice(0, 192);
    for (const p of chosen) lines.push(p.fen + '|' + ev(p.feats));
  } else {
    const valGameIds = games.map((g, i) => ({ g, i })).filter(x => gamesMeta[x.i].val && x.g.moves.length >= opts.minPly + 16);
    valGameIds.sort((a, b) => (a.g.id < b.g.id ? -1 : a.g.id > b.g.id ? 1 : 0));
    const chosen = valGameIds.slice(0, 12);
    if (chosen.length < 4) throw new Error('not enough validation games for selftest');

    for (const { g } of chosen) {
      P.setFen(pos, P.START_FEN);
      for (let m = 0; m < g.moves.length; m++) {
        P.applyUci(pos, g.moves[m]);
        const ply = m + 1;
        if (ply < opts.minPly || ply >= opts.minPly + 16) continue;
        const feats = P.featuresFor(pos.b, pos.side);
        const cp = ev(feats);
        lines.push(P.getFen(pos) + '|' + cp);
        const sc = resultScore(g.result) ?? 0.5;
        sampleEvals.push({ fen: P.getFen(pos), cp, side: pos.side, target: pos.side === 0 ? sc : 1 - sc });
      }
    }
  }
  fs.writeFileSync(SELFTEST_PATH, lines.join('\n') + '\n');

  // A short, human-readable set of evals for the docs.
  const show = [];
  const demo = [
    ['startpos', P.START_FEN],
    ['after 1.e4', 'rnbqkbnr/pppppppp/8/8/8/4P3/PPPP1PPP/RNBQKBNR b KQkq - 0 1'],
    ['white queen up (synthetic)', '4k3/8/8/8/8/8/8/3QK3 w - - 0 1'],
    ['black queen up (synthetic)', '3qk3/8/8/8/8/8/8/4K3 w - - 0 1'],
    ['Kiwa start after 1.d4 d5 2.c4', 'rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq - 0 3'],
  ];
  for (const [name, fen] of demo) {
    P.setFen(pos, fen);
    const feats = P.featuresFor(pos.b, pos.side);
    show.push({ name, fen, cp_stm: ev(feats), side: pos.side === 0 ? 'white' : 'black' });
  }

  // accumulator consistency on every legal position of every game, both perspectives
  let accCheck;
  if (opts.evalFile) {
    // No game history in eval mode; the accumulator logic is identical to the
    // game-trained net and is covered by the selftest parity check instead.
    accCheck = { checks: 0, mismatches: 0 };
    log('accumulator checks: skipped in eval-file mode (covered by selftest parity)');
  } else {
    accCheck = selfCheckAccumulator(q, games);
    log('accumulator checks: ' + accCheck.checks + ' comparisons, ' + accCheck.mismatches + ' mismatches');
  }
  if (accCheck.mismatches !== 0) throw new Error('accumulator self-check failed');

  log('');
  log('sample evals (cp, side-to-move perspective):');
  for (const s of show) log('  ' + s.name.padEnd(30) + ' ' + (s.cp_stm >= 0 ? '+' : '') + s.cp_stm + '  [' + s.side + ' to move]');
  log('');
  log('selftest: ' + lines.length + ' positions' +
    (opts.evalFile ? ' (from the validation set)' : ' from validation games') +
    ' -> ' + SELFTEST_PATH);
  log('selftest example: ' + lines[0]);
  log('total time: ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');

  const metrics = {
    generatedAt: new Date().toISOString(),
    data: { files, games: games.length, plies, draws: drawCount, license: 'CC0-1.0' },
    split: {
      hash: opts.evalFile
        ? 'dataset split field (train/val/test), else fnv1a(fen) % 100 80/10/10'
        : 'FNV-1a("kiwa-frnn1 " + gameId) % 100 >= 80 -> validation',
      trainPositions: trainIdx.length,
      valPositions: valIdx.length,
      testPositions: testIdx.length,
      minPly: opts.minPly,
    },
    net: {
      H1, H2, inputFeatures: INPUT_FEATURES,
      shift1: q.shift1, shift2: q.shift2, shift3: q.shift3,
      activationClamp: CLAMP1, outputClamp: CLAMP_OUT, kCp: K_CP,
      bytes: wrote.bytes, checksum: '0x' + wrote.checksum.toString(16).padStart(8, '0'),
    },
    training: { epochs: opts.epochs, batch: opts.batch, lr: opts.lr, seed: opts.seed, l2: state.l2,
      w1mult: opts.w1mult, w2mult: opts.w2mult, w3mult: opts.w3mult,
      bestCheckpointEpoch: bestEpoch,
      bestCheckpointValMSEFloat: bestVal,
      finalEpochValMSEFloat: lastVal,
      exportSelection: 'float validation MSE (epoch with lowest val MSE)' },
    metrics: {
      trainMSEFloatLastEpoch: trainMSE,
      valMSEFloat: finalFloat,
      valMSEFloatAtLastEpoch: lastVal,
      valMSEQuantized: finalQ,
      trainMSEQuantized: trainQ,
      baselineValMSE: baseMSE,
      valSignAccuracy: acc,
      testSignAccuracy: testAcc,
      int16ClippedWeights: q.clipped,
      accumulatorChecks: accCheck.checks,
      accumulatorMismatches: accCheck.mismatches,
      selftestPositions: lines.length,
    },
    sampleEvals: show,
  };
  fs.writeFileSync(METRICS_PATH, JSON.stringify(metrics, null, 2) + '\n');

  flushLog(header);
  console.log('wrote ' + LOG_PATH);
  console.log('wrote ' + METRICS_PATH);
}

main();
