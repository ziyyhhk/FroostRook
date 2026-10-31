'use strict';

/*
 * Builds a position-based human-move PRIOR TABLE from the TRAIN split only.
 *
 *   node test/train-priors.js [--ply-cap 40] [--out test/data/human-priors.json]
 *
 * Reads   test/data/human-games.json + human-games.meta.json (train/eval split)
 * Writes  test/data/human-priors.json + human-priors.meta.json
 *
 * Key = first three FEN fields (board, side to move, castling rights) exactly
 * like book.js, so transpositions share an entry. En passant is left out of the
 * key for the same reason book.js gives: it almost never changes the legal set
 * and GUIs normalise it away. Every stored move is re-checked for legality with
 * the ep field cleared before it is written, so a table read can never hand back
 * an illegal move.
 *
 * Nothing from the EVAL split is used here. Coverage/baselines that follow are
 * measured on eval only.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const e = require(path.join(ROOT, 'engine.js'));
const book = require(path.join(ROOT, 'book.js'));

const DATA = path.join(__dirname, 'data');
const GAMES = path.join(DATA, 'human-games.json');
const GAMES_META = path.join(DATA, 'human-games.meta.json');
// The prior table is a runtime asset: engine.js loads it for `predict`, so it
// lives in data/ next to the book rather than in test/.
const MODEL = path.join(ROOT, 'data');
let OUT = path.join(MODEL, 'human-priors.json');
let OUT_META = path.join(MODEL, 'human-priors.meta.json');
let PLY_CAP = 40;

// --- feature definitions ----------------------------------------------------
// Every feature is a deterministic predicate on (position, move) except
// `recapture`, which also needs the previous ply; it is counted per observation
// rather than assumed, so transpositions stay honest.
//
// `hanging` means: after the move, the moved piece can still be captured right
// away by an enemy piece worth at most as much as it (i.e. a plain loss).
// `safe` is its complement among moves that put a piece on an attacked square.
const FEATURES = [
  'capture', 'castling', 'check', 'queenTrade', 'centralPawn', 'develop',
  'recapture', 'kingZone', 'hanging', 'inBook', 'quiet', 'queenMove',
];
const VAL = [0, 100, 320, 330, 500, 900, 20000]; // index by engine piece type 1..6

function keyOf(fen) { return fen.split(' ').slice(0, 3).join(' '); }
function sqName(s) { return String.fromCharCode(97 + (s & 7)) + String.fromCharCode(49 + (s >> 4)); }
function chebyshev(a, b) { return Math.max(Math.abs((a & 7) - (b & 7)), Math.abs((a >> 4) - (b >> 4))); }

function pieceCountsFromFen(fen) {
  const board = fen.split(' ')[0];
  const counts = {};
  for (const ch of board) if (/[pnbrqkPNBRQK]/.test(ch)) counts[ch.toLowerCase()] = (counts[ch.toLowerCase()] || 0) + 1;
  return counts;
}

function capturedType(beforeFen, afterFen, moverIsPromoting) {
  const a = pieceCountsFromFen(beforeFen), b = pieceCountsFromFen(afterFen);
  for (const p of ['q', 'r', 'b', 'n', 'p']) {
    const lost = (a[p] || 0) - (b[p] || 0);
    if (lost > 0) return p;
  }
  if (moverIsPromoting) return null;
  return null;
}

// Flags for one (position, move) observation. Caller has already put the engine
// on `beforeFen`. Returns a plain object of booleans.
function featureFlags(beforeFen, uci, prev, legalInts) {
  const flags = Object.fromEntries(FEATURES.map(f => [f, false]));
  let mvInt = 0;
  for (const mv of legalInts) if (e.moveToStr(mv) === uci) { mvInt = mv; break; }
  if (!mvInt) return null;
  const d = e.describeMove(mvInt);
  const moverVal = VAL[d.piece] || 100;

  flags.capture = !!(d.cap || d.ep);
  flags.castling = !!d.castle;
  flags.quiet = !flags.capture && !d.castle && !d.promo;
  flags.queenMove = d.piece === 5;

  e.applyUciMove(uci);
  const afterFen = e.getFen();
  flags.check = e.inCheck();

  // what was actually captured (compare piece counts; promotion safe because the
  // loop walks the types in q,r,b,n,p order)
  const capType = capturedType(beforeFen, afterFen, !!d.promo);
  if (capType === 'q') flags.queenTrade = true;

  // central pawn push
  const center = new Set(['d4', 'e4', 'd5', 'e5']);
  if (d.piece === 1 && (center.has(sqName(d.to)) || (Math.abs((d.to >> 4) - (d.from >> 4)) === 2 && (d.to & 7) >= 2 && (d.to & 7) <= 5))) {
    flags.centralPawn = true;
  }

  // minor-piece development out of the back rank
  // engine square index = rank*16 + file, rank 0 is the FIRST rank (a1 = 0x00)
  const homeRank = d.color === e.WHITE ? 0 : 7;
  if ((d.piece === 2 || d.piece === 3) && (d.from >> 4) === homeRank && (d.to >> 4) !== homeRank) flags.develop = true;

  // recapture: this ply captures on the square the opponent's last move landed on
  if (prev && prev.cap && flags.capture && prev.to === d.to) flags.recapture = true;

  // attacking the opponent king zone: destination inside the 5x5 box around the
  // enemy king
  const enemyKing = e.kingSq[e.side]; // after the move, `side` is the victim
  if (enemyKing !== undefined && chebyshev(d.to, enemyKing) <= 2) flags.kingZone = true;

  // hanging: the moved piece can be taken at once by something worth <= it
  const replies = e.getLegalMoves();
  let minAttackerVal = Infinity;
  let queenRecapture = false;
  for (const r of replies) {
    const rd = e.describeMove(r);
    if (!rd.cap || rd.to !== d.to) continue;
    const v = VAL[rd.piece] || 100;
    if (v < minAttackerVal) minAttackerVal = v;
    if (rd.piece === 5) queenRecapture = true;
  }
  if (minAttackerVal <= moverVal && !flags.check) flags.hanging = true;
  if (d.piece === 5 && (queenRecapture || (flags.capture && capType === 'q'))) flags.queenTrade = true;

  e.setFen(beforeFen); // rewind: the walk continues from the recorded position
  return flags;
}

// --- main -------------------------------------------------------------------

function main() {
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--ply-cap') PLY_CAP = +process.argv[++i];
    else if (process.argv[i] === '--out') OUT = path.resolve(process.argv[++i]);
  }
  if (!fs.existsSync(GAMES)) { console.error('Missing ' + GAMES + ' - run node test/fetch-human-games.js first'); process.exit(1); }

  const { games } = JSON.parse(fs.readFileSync(GAMES, 'utf8'));
  const meta = JSON.parse(fs.readFileSync(GAMES_META, 'utf8'));
  const evalIds = new Set(meta.split.evalGameIds);
  const train = games.filter(g => !evalIds.has(g.id));
  const evalGames = games.filter(g => evalIds.has(g.id));
  if (!train.length) { console.error('Train split is empty.'); process.exit(1); }

  const table = new Map();      // key -> Map(uci -> {n, feats:{}, bookW})
  const featStats = {};         // feature -> {human, legal} counts over sampled plies
  for (const f of FEATURES) featStats[f] = { human: 0, legal: 0 };
  const globalMoveType = {};    // "<piece>:<quiet|capture|castle>" -> count
  const rootCounts = { white: {}, black: {} }; // first-move marginals
  let trainPlies = 0, trainPliesCapped = 0, legalSum = 0, samplesLegal = 0, legalObsTotal = 0;

  for (const g of train) {
    e.setFen(e.START_FEN);
    let prev = null;
    for (let ply = 0; ply < g.moves.length; ply++) {
      const beforeFen = e.getFen();
      const key = keyOf(beforeFen);
      const legalInts = e.getLegalMoves();
      if (!legalInts.length) break;
      const actual = g.moves[ply];
      const side = e.side;
      trainPlies++;
      if (ply >= PLY_CAP) { prev = null; e.applyUciMove(actual); continue; }
      trainPliesCapped++;
      legalSum += legalInts.length; samplesLegal++;

      const flags = featureFlags(beforeFen, actual, prev, legalInts);
      if (!flags) { prev = null; e.applyUciMove(actual); continue; }

      const bookEntry = book.BOOK[key];
      let bookW = 0;
      if (bookEntry) {
        const row = bookEntry.find(r => r[0] === actual);
        if (row) { bookW = row[1] | 0; flags.inBook = true; }
      }
      for (const f of FEATURES) if (flags[f]) featStats[f].human++;

      if (!table.has(key)) table.set(key, new Map());
      const ent = table.get(key);
      let rec = ent.get(actual);
      if (!rec) { rec = { n: 0, feats: {}, bookW: 0 }; ent.set(actual, rec); }
      rec.n++;
      if (bookW) rec.bookW = bookW;
      for (const f of FEATURES) if (flags[f]) rec.feats[f] = (rec.feats[f] || 0) + 1;

      const d = (() => { for (const mv of legalInts) if (e.moveToStr(mv) === actual) return e.describeMove(mv); return null; })();
      if (d) {
        const kind = flags.castling ? 'castle' : flags.capture ? 'capture' : 'quiet';
        const k2 = `${d.piece}:${kind}`;
        globalMoveType[k2] = (globalMoveType[k2] || 0) + 1;
        if (ply === 0) {
          const w = side === 0 ? 'white' : 'black';
          rootCounts[w][actual] = (rootCounts[w][actual] || 0) + 1;
        }
      }

      prev = d;
      e.applyUciMove(actual);
    }
  }

  // legal-move marginals: one pass over the same positions, counting how often
  // each feature holds across ALL legal moves, so P(feature|human)/P(feature|legal)
  // is an odds ratio a later logistic fit can use directly.
  for (const g of train) {
    e.setFen(e.START_FEN);
    for (let ply = 0; ply < g.moves.length; ply++) {
      if (ply >= PLY_CAP) break;
      const beforeFen = e.getFen();
      const legalInts = e.getLegalMoves();
      if (!legalInts.length) break;
      for (const mv of legalInts) {
        const uci = e.moveToStr(mv);
        const f = featureFlagsLite(beforeFen, uci, mv, legalInts);
        for (const k of FEATURES) if (f[k]) featStats[k].legal++;
        legalObsTotal++;
      }
      e.applyUciMove(g.moves[ply]);
    }
  }

  // --- serialise -----------------------------------------------------------
  const positions = {};
  let storedMoves = 0;
  for (const [key, ent] of [...table.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    // legality re-check with ep cleared (book.js does the same)
    e.setFen(key + ' - 0 1');
    const legalSet = new Set(e.getLegalMoves().map(m => e.moveToStr(m)));
    const rows = [...ent.entries()]
      .filter(([uci]) => legalSet.has(uci))
      .sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))
      .map(([uci, r]) => {
        storedMoves++;
        return [uci, r.n, FEATURES.map(f => r.feats[f] || 0), r.bookW || 0];
      });
    if (rows.length) positions[key] = rows;
  }

  const nPos = Object.keys(positions).length;

  // coverage of the eval split by this table (eval is never used to build it)
  let evalPlyCount = 0, evalCapped = 0, moveCovered = 0, posCovered = 0, naiveTop1 = 0, naiveN = 0;
  for (const g of evalGames) {
    e.setFen(e.START_FEN);
    for (let ply = 0; ply < g.moves.length; ply++) {
      const beforeFen = e.getFen();
      const key = keyOf(beforeFen);
      const legalInts = e.getLegalMoves();
      if (!legalInts.length) break;
      const actual = g.moves[ply];
      evalPlyCount++;
      if (ply >= PLY_CAP) { e.applyUciMove(actual); continue; }
      evalCapped++;
      const ent = positions[key];
      if (ent) posCovered++;
      const hit = ent && ent.find(r => r[0] === actual);
      if (hit) moveCovered++;
      if (ent && ent[0]) { naiveN++; if (ent[0][0] === actual) naiveTop1++; }
      e.applyUciMove(actual);
    }
  }

  const out = {
    features: FEATURES,
    plyCap: PLY_CAP,
    positions,
    featureStats: FEATURES.reduce((acc, f) => (acc[f] = {
      humanObservations: featStats[f].human,
      legalObservations: featStats[f].legal,
      humanRate: +(featStats[f].human / Math.max(1, trainPliesCapped)).toFixed(4),
      legalRate: +(featStats[f].legal / Math.max(1, legalObsTotal)).toFixed(4),
      oddsRatio: f === 'recapture' ? null
        : +((featStats[f].human / Math.max(1, trainPliesCapped)) / Math.max(1e-9, featStats[f].legal / Math.max(1, legalObsTotal))).toFixed(3),
      ...(f === 'recapture' ? { note: 'no legal-move marginal: recapture depends on the previous ply, which the position key does not carry' } : {}),
    }, acc), {}),
    moveTypeCounts: globalMoveType,
    legalObservationsTotal: legalObsTotal,
    rootFirstMove: rootCounts,
  };
  fs.writeFileSync(OUT, JSON.stringify(out), 'utf8');

  const metaOut = {
    dataset: 'human-priors',
    derivedFrom: 'test/data/human-games.json (TRAIN split only)',
    sourceLicense: meta.license,
    license: 'CC0 1.0 Universal (public domain dedication) - derived from CC0 Lichess exports',
    generatedWith: 'test/train-priors.js',
    generatedAt: new Date().toISOString(),
    keyScheme: 'first three FEN fields (board, side to move, castling); en passant excluded like book.js; every stored move re-verified legal with ep cleared',
    rowFormat: '[uci, count, featureCounts in `features` order, bookBalancedWeight]',
    features: FEATURES,
    featureDefinitions: {
      capture: 'move takes something (including en passant)',
      castling: 'O-O or O-O-O',
      check: 'opponent king is attacked after the move',
      queenTrade: 'a queen is captured, or the queen moves to a square where it can be taken at once',
      centralPawn: 'pawn moves to d4/e4/d5/e5, or a two-square push onto ranks 4/5 of files c-f',
      develop: 'knight or bishop leaves the back rank',
      recapture: 'captures on the square the opponent just landed on (needs the previous ply, so it is counted, not inferred)',
      kingZone: 'destination inside the 5x5 box around the enemy king',
      hanging: 'the moved piece can be captured immediately by a piece worth at most as much (and the move gives no check)',
      inBook: 'the human move is present in Kiwa\'s opening book entry for this key',
      quiet: 'not a capture, not castling, not a promotion',
      queenMove: 'the moved piece is a queen',
    },
    totals: {
      trainGames: train.length,
      evalGames: evalGames.length,
      trainPliesWalked: trainPlies,
      trainPliesStored: trainPliesCapped,
      evalPliesWalked: evalPlyCount,
      evalPliesWithinPlyCap: evalCapped,
      distinctPositions: nPos,
      storedMoveRows: storedMoves,
      avgMovesPerPosition: +(storedMoves / Math.max(1, nPos)).toFixed(2),
      avgLegalMovesPerStoredPosition: +(legalSum / Math.max(1, samplesLegal)).toFixed(2),
      legalMoveFeatureObservations: legalObsTotal,
    },
    evalCoverage: {
      note: 'measured on the EVAL split only; this table was fit on TRAIN only',
      positionsPresent: posCovered,
      positionCoveragePct: +(100 * posCovered / Math.max(1, evalCapped)).toFixed(2),
      movesPresent: moveCovered,
      moveCoveragePct: +(100 * moveCovered / Math.max(1, evalCapped)).toFixed(2),
      naiveTop1MostFrequentStoredMove: { hits: naiveTop1, n: naiveN, pct: +(100 * naiveTop1 / Math.max(1, naiveN)).toFixed(2) },
    },
    caveats: [
      'Counts come from Lichess blitz/bullet games of mostly amateur players.',
      'A position seen once has count 1: the table is noisy at the tail, which is what the smoothing/backoff in the harness is for.',
      'Feature marginals over all legal moves are computed on the same train positions (denominator = sum of legal move counts).',
    ],
  };
  fs.writeFileSync(OUT_META, JSON.stringify(metaOut, null, 2), 'utf8');

  console.log(`positions: ${nPos}   move rows: ${storedMoves}   train plies stored: ${trainPliesCapped}`);
  console.log(`eval position coverage: ${(100 * posCovered / Math.max(1, evalCapped)).toFixed(2)}%   move coverage: ${(100 * moveCovered / Math.max(1, evalCapped)).toFixed(2)}%`);
  console.log(`naive most-frequent-stored-move top-1 on EVAL: ${naiveTop1}/${naiveN} (${(100 * naiveTop1 / Math.max(1, naiveN)).toFixed(2)}%)`);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
  console.log(`wrote ${path.relative(ROOT, OUT_META)}`);
}

// Cheap legal-side feature probe used for the null-model marginals. Same rules
// as featureFlags but without the previous-ply context (recapture is only
// meaningful for the move actually played).
function featureFlagsLite(beforeFen, uci, mvInt, legalInts) {
  const flags = Object.fromEntries(FEATURES.map(f => [f, false]));
  const d = e.describeMove(mvInt);
  flags.capture = !!(d.cap || d.ep);
  flags.castling = !!d.castle;
  flags.quiet = !flags.capture && !d.castle && !d.promo;
  flags.queenMove = d.piece === 5;
  const center = new Set(['d4', 'e4', 'd5', 'e5']);
  if (d.piece === 1 && (center.has(sqName(d.to)) || (Math.abs((d.to >> 4) - (d.from >> 4)) === 2 && (d.to & 7) >= 2 && (d.to & 7) <= 5))) flags.centralPawn = true;
  const homeRank = d.color === e.WHITE ? 0 : 7; // rank 0 == first rank (a1 = 0x00)
  if ((d.piece === 2 || d.piece === 3) && (d.from >> 4) === homeRank && (d.to >> 4) !== homeRank) flags.develop = true;
  e.applyUciMove(uci);
  const afterFen = e.getFen();
  flags.check = e.inCheck();
  const capType = capturedType(beforeFen, afterFen, !!d.promo);
  const enemyKing = e.kingSq[e.side]; // after the move, `side` is the victim
  if (enemyKing !== undefined && chebyshev(d.to, enemyKing) <= 2) flags.kingZone = true;
  const moverVal = VAL[d.piece] || 100;
  let minAttackerVal = Infinity;
  let queenRecapture = false;
  for (const r of e.getLegalMoves()) {
    const rd = e.describeMove(r);
    if (!rd.cap || rd.to !== d.to) continue;
    const v = VAL[rd.piece] || 100;
    if (v < minAttackerVal) minAttackerVal = v;
    if (rd.piece === 5) queenRecapture = true;
  }
  if (minAttackerVal <= moverVal && !flags.check) flags.hanging = true;
  // same definition as featureFlags: a queen is taken, or the queen lands where
  // the opponent can take it straight away
  if (capType === 'q' || (d.piece === 5 && queenRecapture)) flags.queenTrade = true;
  if (book.BOOK[keyOf(beforeFen)]) {
    const row = book.BOOK[keyOf(beforeFen)].find(r => r[0] === uci);
    if (row) flags.inBook = true;
  }
  e.setFen(beforeFen);
  return flags;
}

if (require.main === module) main();

module.exports = { FEATURES, keyOf, featureFlags, featureFlagsLite };
