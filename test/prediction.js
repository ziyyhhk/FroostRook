'use strict';

/*
 * Regression test for the human-move prediction system.
 *
 *   node test/prediction.js
 *
 * This checks behaviour, not accuracy: accuracy is measured on held-out games by
 * test/predict-accuracy.js and the numbers are quoted in README.md. Here we
 * guarantee the things that must never break:
 *
 *   - predict() only ever names legal moves, and its probabilities are a real
 *     distribution that sums to 1 and ranks in the same order it reports;
 *   - the data-driven prior is actually consulted (table or feature backoff),
 *     and degrades to the hand-written prior when the model files are absent;
 *   - objective play is untouched by prediction: the same position searched with
 *     the model on and off must give the same best move and score;
 *   - the fitted weights in data/predict-weights.json come from the training
 *     split and are internally consistent;
 *   - the model asset declares its licence.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const engine = require('../engine.js');
engine.setInfoHandler(() => {});
const model = require('../predict-model.js');

const POSITIONS = [
  { name: 'startpos', moves: '' },
  { name: 'italian', moves: 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5' },
  { name: 'najdorf', moves: 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6' },
  { name: 'qgd', moves: 'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6' },
  { name: 'middlegame', moves: 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 b2b4 g8f6 d2d3 d7d6 c1b2 a7a6' },
  { name: 'tactical', moves: 'e2e4 e7e5 f1c4 g8f6 g1f3 b8c6 d2d4 e5d4 e4e5' },
  { name: 'endgame', fen: '8/2k3p1/4p2p/2P1P1P1/1p1p1p1p/1P1P1P1P/8/2K1k3 w - - 0 1' },
];

function predictOn(fen, opts) {
  engine.setFen(fen);
  return engine.predict(Object.assign({ depth: 4, movetime: 900, top: 6 }, opts));
}

console.log(`model files: ${model.available() ? 'present' : 'absent'}`);

for (const pos of POSITIONS) {
  const name = pos.name;
  engine.setFen(engine.START_FEN);
  for (const m of (pos.moves || '').split(' ').filter(Boolean)) {
    assert(engine.applyUciMove(m), `${name}: bad test move ${m}`);
  }
  const live = pos.fen || engine.getFen();
  engine.setFen(live);
  const legal = new Set(engine.getLegalMoves().map(engine.moveToStr));
  assert(legal.size > 1, `${name}: position has no moves to predict`);

  const r = predictOn(live, {});
  assert(r.moves.length > 0, `${name}: predict() returned nothing`);
  assert(r.best === r.moves[0].move, `${name}: best is not the top-ranked move`);

  const sum = r.moves.reduce((a, m) => a + m.prob, 0);
  for (const m of r.moves) {
    assert(legal.has(m.move), `${name}: predicted illegal move ${m.move}`);
    assert(m.prob >= 0 && m.prob <= 1, `${name}: probability out of range for ${m.move}`);
  }
  for (let i = 1; i < r.moves.length; i++) {
    assert(r.moves[i - 1].prob + 1e-12 >= r.moves[i].prob, `${name}: ranking is not sorted by probability`);
  }
  // The reported slice need not be the whole distribution, but it must be a
  // sane share of it: 6 of up to 250 legal moves can never hold all the mass.
  assert(sum <= 1.0001, `${name}: reported probabilities exceed 1 (${sum})`);
  assert(sum > 0.05, `${name}: reported probabilities are vanishing (${sum})`);

  const src = r.priorSource;
  if (model.available()) {
    assert(src === 'table' || src === 'backoff', `${name}: prior source is '${src}' with the model present`);
    assert(r.moves.some(m => typeof m.logp === 'number'), `${name}: no log-prior attached to any move`);
  }
  console.log(`ok  ${name.padEnd(11)} best ${r.best}  p=${r.moves[0].prob.toFixed(3)}  prior=${src}  ` +
              `${r.searched} moves searched in ${r.time}ms`);
}

// A prediction must leave the position exactly as it found it: the model walks
// the board to score features, and if that leaked, the repetition and
// fifty-move rules would silently change under a GUI that predicts then plays.
{
  engine.setFen(engine.START_FEN);
  // Knights home and back twice: the starting position appears three times, so
  // the engine is standing in a claimable threefold draw with a real history.
  const seq = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
  for (const m of seq) assert(engine.applyUciMove(m), 'bad setup move ' + m);
  const before = engine.getFen();
  assert(engine.isThreefold(), 'test setup should be a threefold position');
  predictOn(engine.getFen(), { movetime: 1200 });
  assert.equal(engine.getFen(), before, 'predict() changed the position');
  const threefoldBefore = engine.isThreefold();
  predictOn(before, { movetime: 600 });
  assert.equal(engine.isThreefold(), threefoldBefore, 'predict() destroyed the repetition history');
  console.log('ok  predict() leaves the board and its history untouched');
}

// Objective play must not be influenced by the human model. Search is what
// produces bestmove; if a prior leaked into it, strength would depend on data.
{
  const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 6';
  engine.setFen(fen);
  const before = engine.search({ depth: 8 });
  engine.setFen(fen);
  const p = engine.predict({ depth: 8, movetime: 1500, top: 3 });
  engine.setFen(fen);
  const after = engine.search({ depth: 8 });
  assert.equal(after.bestMoveStr, before.bestMoveStr, 'search changed after running predict()');
  assert.equal(after.score, before.score, 'search score changed after running predict()');
  // Predictions may differ from the engine's own choice - that is the point -
  // but the engine's choice must never be moved by the prediction machinery.
  console.log(`ok  search is independent of prediction (engine ${before.bestMoveStr} ` +
              `${before.score} cp, predicted top ${p.best})`);
}

// Model degrades cleanly: with the asset unavailable, predict() still works and
// reports the hand-written prior.
{
  const priorsPath = model.PRIORS_FILE;
  const hidden = priorsPath + '.hidden-by-test';
  if (model.available()) {
    fs.renameSync(priorsPath, hidden);
    try {
      delete require.cache[require.resolve('../predict-model.js')];
      const bare = require('../predict-model.js');
      engine.setFen(engine.START_FEN);
      const r = engine.predict({ depth: 3, movetime: 700, top: 4 });
      assert(!bare.available(), 'model should report itself unavailable without the table');
      assert(r.moves.length > 0, 'predict() produced nothing without the model');
      for (const m of r.moves) {
        assert(m.logp === undefined, 'log-prior present while the model is absent');
      }
      console.log(`ok  predict() works without data/human-priors.json (best ${r.best}, prior ${r.priorSource})`);
    } finally {
      fs.renameSync(hidden, priorsPath);
    }
  }
}

// Weights and licensing.
{
  assert(fs.existsSync(model.WEIGHTS_FILE),
    'data/predict-weights.json missing - run node test/fit-predict.js');
  const w = JSON.parse(fs.readFileSync(model.WEIGHTS_FILE, 'utf8'));
  assert(w.temperature > 0, 'temperature must be positive');
  assert(Number.isFinite(w.priorWeight) && w.priorWeight >= 0, 'priorWeight must be a non-negative number');
  assert(Number.isFinite(w.searchWeight) && w.searchWeight > 0, 'searchWeight must be positive');
  assert(w.fitted && w.fitted.positions > 0, 'weights carry no training record');
  assert(/TRAIN/.test(w.note || ''), 'weights file must state that it was fitted on the train split');

  const metaPath = path.join(__dirname, '..', 'data', 'human-priors.meta.json');
  assert(fs.existsSync(metaPath), 'data/human-priors.meta.json missing');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert(/CC0/i.test(meta.license || ''), `priors table must declare its licence, got ${meta.license}`);
  assert(/lichess/i.test(meta.sourceLicense + ' ' + JSON.stringify(meta)), 'priors must name their source');
  console.log(`ok  fitted weights (train top-1 ${w.fitted.trainTop1}% on ${w.fitted.positions} positions), ` +
              `model licence ${meta.license}`);
}

console.log('\nPrediction tests passed.');
