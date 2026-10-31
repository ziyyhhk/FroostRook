'use strict';

/*
 * Rules coverage: checkmate, stalemate, en passant, castling (including
 * castling through check), promotion/underpromotion, threefold repetition,
 * the fifty-move rule and insufficient material.
 *
 *   node test/rules.js
 */

const assert = require('assert');
const engine = require('../engine.js');

engine.setInfoHandler(() => {});
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log('PASS  ' + name);
  } catch (err) {
    failures++;
    console.log('FAIL  ' + name + '\n      ' + err.message);
  }
}

// --- JavaScript core -------------------------------------------------------

check('checkmate is not stalemate or a material draw', () => {
  engine.setFen('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1');
  assert.strictEqual(engine.getLegalMoves().length, 0);
  assert.strictEqual(engine.inCheck(), true);
  assert.strictEqual(engine.isCheckmate(), true);
  assert.strictEqual(engine.isStalemate(), false);
  assert.strictEqual(engine.isDraw(), false);
});

check('stalemate is a draw', () => {
  engine.setFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.strictEqual(engine.getLegalMoves().length, 0);
  assert.strictEqual(engine.inCheck(), false);
  assert.strictEqual(engine.isStalemate(), true);
  assert.strictEqual(engine.isCheckmate(), false);
  assert.strictEqual(engine.isDraw(), true);
});

check('insufficient material: bare kings, one minor, same-coloured bishops', () => {
  for (const fen of [
    '8/8/8/8/8/8/8/K6k w - - 0 1',       // K vs K
    '8/8/8/8/8/8/8/KB5k w - - 0 1',      // K+B vs K
    '8/8/8/8/8/8/8/KN5k w - - 0 1',      // K+N vs K
    '8/8/8/8/8/8/8/KB1b3k w - - 0 1',    // K+B vs K+B, both on light squares
  ]) {
    engine.setFen(fen);
    assert.strictEqual(engine.isInsufficientMaterial(), true, fen);
    assert.strictEqual(engine.isDraw(), true, fen);
  }
});

check('material that can still mate is not an automatic draw', () => {
  for (const fen of [
    '8/8/8/8/8/8/8/K1Bb3k w - - 0 1',    // bishops on opposite colours
    '8/8/8/8/8/8/8/KN4nk w - - 0 1',     // K+N vs K+N (helpmate exists)
    '8/8/8/8/8/8/8/KNN4k w - - 0 1',     // K+NN vs K (mate is possible)
    '8/8/8/8/8/8/7k/K1R5 w - - 0 1',      // rook wins
  ]) {
    engine.setFen(fen);
    assert.strictEqual(engine.isInsufficientMaterial(), false, fen);
    assert.strictEqual(engine.isDraw(), false, fen);
  }
});

check('fifty-move rule', () => {
  engine.setFen('8/8/8/8/8/8/7k/K1R5 w - - 100 80');
  assert.strictEqual(engine.isDraw(), true);
});

check('threefold repetition', () => {
  engine.setFen(engine.START_FEN);
  for (const mv of ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']) {
    assert.strictEqual(engine.applyUciMove(mv), true, mv);
  }
  assert.strictEqual(engine.isDraw(), true);
});

check('en passant capture is generated and removes the passed pawn', () => {
  engine.setFen('rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 3');
  const ep = engine.getLegalMoves().find(mv => engine.moveToStr(mv) === 'd4e3');
  assert.ok(ep, 'd4e3 en passant not generated');
  assert.strictEqual(engine.describeMove(ep).ep, true);
  engine.applyUciMove('d4e3');
  assert.strictEqual(
    engine.getFen().split(' ')[0],
    'rnbqkbnr/ppp1pppp/8/8/8/4p3/PPPP1PPP/RNBQKBNR'
  );
});

check('castling moves king and rook, and is illegal through check', () => {
  engine.setFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const castle = engine.getLegalMoves().find(mv => engine.moveToStr(mv) === 'e1g1');
  assert.ok(castle);
  assert.strictEqual(engine.describeMove(castle).castle, true);
  engine.applyUciMove('e1g1');
  assert.strictEqual(engine.getFen().split(' ')[0], 'r3k2r/8/8/8/8/8/8/R4RK1');

  engine.setFen('r3k2r/8/8/8/5r2/8/8/R3K2R w KQkq - 0 1');
  const moves = engine.getLegalMoves().map(engine.moveToStr);
  assert.ok(!moves.includes('e1g1'), 'castling through an attacked f1 must be illegal');

  engine.setFen('r3k2r/8/8/8/3r4/8/8/R3K2R w KQkq - 0 1');
  const queenside = engine.getLegalMoves().map(engine.moveToStr);
  assert.ok(!queenside.includes('e1c1'), 'castling through an attacked d1 must be illegal');
});

check('promotion and underpromotion', () => {
  engine.setFen('8/P7/8/8/8/8/8/k6K w - - 0 1');
  const moves = engine.getLegalMoves().map(engine.moveToStr);
  for (const mv of ['a7a8q', 'a7a8r', 'a7a8b', 'a7a8n']) {
    assert.ok(moves.includes(mv), mv + ' missing');
  }
  engine.applyUciMove('a7a8n');
  assert.ok(engine.getFen().startsWith('N7'), 'knight should stand on a8: ' + engine.getFen());
});

// --- native core ------------------------------------------------------------

async function nativeChecks() {
  const native = require('../native.js');
  if (!native.available()) {
    console.log('SKIP  native rules checks (native/kiwa-native.exe not found)');
    return;
  }

  async function nativeCase(label, fn) {
    try {
      await fn();
      console.log('PASS  ' + label);
    } catch (err) {
      failures++;
      console.log('FAIL  ' + label + '\n      ' + err.message);
    }
  }

  await nativeCase('native stalemate returns bestmove 0000', async () => {
    const r = await native.search('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', { depth: 3 });
    assert.ok(r);
    assert.strictEqual(r.bestMoveStr, '0000');
  });

  await nativeCase('native checkmate returns bestmove 0000', async () => {
    const r = await native.search('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1', { depth: 3 });
    assert.ok(r);
    assert.strictEqual(r.bestMoveStr, '0000');
  });

  await nativeCase('native K+B vs K scores 0', async () => {
    const r = await native.search('8/8/8/8/8/8/8/KB5k w - - 0 1', { depth: 4 });
    assert.ok(r);
    assert.notStrictEqual(r.bestMoveStr, '0000');
    assert.strictEqual(r.score, 0);
  });

  await nativeCase('native fifty-move score is 0', async () => {
    const r = await native.search('8/8/8/8/8/8/7k/K1R5 w - - 100 80', { depth: 4 });
    assert.ok(r);
    assert.notStrictEqual(r.bestMoveStr, '0000');
    assert.strictEqual(r.score, 0);
  });

  await nativeCase('native threefold score is 0', async () => {
    const r = await native.search(
      'startpos moves g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8', { depth: 4 }
    );
    assert.ok(r);
    assert.strictEqual(r.score, 0);
  });

  native.quit();
}

(async () => {
  await nativeChecks();
  console.log(failures === 0 ? '\nall rules tests passed' : `\n${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
})();
