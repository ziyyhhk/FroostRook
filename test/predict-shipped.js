'use strict';

/*
 * Harness predictor that measures the prediction system Kiwa actually ships:
 * engine.js predict(). Nothing here is re-tuned — it is the honest "before"
 * number for the held-out Lichess split.
 *
 *   node test/predict-accuracy.js --predictor ./test/predict-shipped.js --limit 800
 *
 * engine.predict() blends a per-move search score with hand-written priors and
 * turns the blend into probabilities with a softmax. Depth and the time budget
 * can be overridden with PREDICT_DEPTH / PREDICT_MS in the environment; the
 * defaults are the values uci.js passes for the `predict` command.
 */

const path = require('path');
const e = require(path.join(__dirname, '..', 'engine.js'));

const DEPTH = +(process.env.PREDICT_DEPTH || 4);
const MS = +(process.env.PREDICT_MS || 250);

e.setInfoHandler(() => {});

module.exports = {
  name: `kiwa predict() depth ${DEPTH}, ${MS}ms`,
  init() {
    e.clearTT();
  },
  predict(fen, legal) {
    const r = e.predict({ depth: DEPTH, movetime: MS, top: Math.max(legal.length, 5) });
    if (!r || !r.moves || !r.moves.length) return null;
    return r.moves.map(m => ({ move: m.move, prob: m.prob }));
  },
};
