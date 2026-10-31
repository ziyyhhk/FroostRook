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

check('one repetition cycle is not a threefold draw', () => {
  engine.setFen(engine.START_FEN);
  for (const mv of ['g1f3', 'g8f6', 'f3g1', 'f6g8']) {
    assert.strictEqual(engine.applyUciMove(mv), true, mv);
  }
  // The position repeated once: search may use that to break cycles, but the
  // game is not drawn and the root must not adjudicate it as one.
  assert.strictEqual(engine.isRepetition(), true);
  assert.strictEqual(engine.isThreefold(), false);
  assert.strictEqual(engine.isDraw(), false);
});

check('two repetition cycles are a threefold draw', () => {
  engine.setFen(engine.START_FEN);
  for (const mv of ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']) {
    assert.strictEqual(engine.applyUciMove(mv), true, mv);
  }
  assert.strictEqual(engine.isThreefold(), true);
  assert.strictEqual(engine.isDraw(), true);
});

check('an irreversible pawn move resets the repetition window', () => {
  engine.setFen(engine.START_FEN);
  // One cycle, then a pawn move that can never be undone. It resets both the
  // fifty-move counter and the window used for repetition.
  for (const mv of ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'e2e4']) {
    assert.strictEqual(engine.applyUciMove(mv), true, mv);
  }
  assert.strictEqual(engine.halfmove, 0);
  const cycle = ['g8f6', 'g1f3', 'f6g8', 'f3g1'];
  for (const mv of cycle) assert.strictEqual(engine.applyUciMove(mv), true, mv);
  // The post-pawn position has now occurred twice; the pre-pawn occurrences
  // are behind the irreversible move and must not count.
  assert.strictEqual(engine.isThreefold(), false);
  for (const mv of cycle) assert.strictEqual(engine.applyUciMove(mv), true, mv);
  assert.strictEqual(engine.isThreefold(), true);
});

check('castling rights are part of position identity', () => {
  engine.setFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  // Moving the a-rooks away and back loses the queenside rights, so the
  // position after four plies differs from the initial one.
  const first = ['a1a2', 'a8a7', 'a2a1', 'a7a8'];
  for (const mv of first) assert.strictEqual(engine.applyUciMove(mv), true, mv);
  assert.strictEqual(engine.isThreefold(), false);
  for (const mv of first) assert.strictEqual(engine.applyUciMove(mv), true, mv);
  // Now the rights-less position has occurred twice (plies 4 and 8): still not
  // three times.
  assert.strictEqual(engine.isThreefold(), false);
  for (const mv of first) assert.strictEqual(engine.applyUciMove(mv), true, mv);
  assert.strictEqual(engine.isThreefold(), true);
});

check('an irrelevant en-passant square does not split identical positions', () => {
  // After 1.e4 a FEN usually carries e3, but no black pawn can capture there.
  engine.setFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
  const cycle = ['b8c6', 'g1f3', 'c6b8', 'f3g1'];
  for (let i = 0; i < 2; i++) {
    for (const mv of cycle) assert.strictEqual(engine.applyUciMove(mv), true, mv);
  }
  // With ep normalised away the FEN position and both cycle ends are one
  // identical position, so this is a genuine threefold.
  assert.strictEqual(engine.isThreefold(), true);
  assert.strictEqual(engine.isDraw(), true);
});

check('a legal en-passant capture is recognised, a pinned one is not', () => {
  // Black's d4 pawn really can take on e3 after e2e4.
  engine.setFen('7k/8/8/8/3p4/8/4P3/K2R4 w - - 0 1');
  assert.strictEqual(engine.applyUciMove('e2e4'), true);
  assert.strictEqual(engine.epCapturePossible(engine.BLACK), true);
  // Here d4xe3 would uncover Rd1 and leave the black king on d8 in check, so
  // the ep square must not be treated as a legal-capture option.
  engine.setFen('3k4/8/8/8/3p4/8/4P3/K2R4 w - - 0 1');
  assert.strictEqual(engine.applyUciMove('e2e4'), true);
  assert.strictEqual(engine.epCapturePossible(engine.BLACK), false);
});

check('mate in one is scored as mate at depth 1 (quiescence)', () => {
  engine.setFen('6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1');
  const r = engine.search({ depth: 1 });
  assert.strictEqual(r.bestMoveStr, 'e1e8');
  assert.strictEqual(r.score, 30999, 'expected MATE - 1, got ' + r.score);
});

check('checkmate and stalemate at the root have different scores', () => {
  engine.setFen('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1');
  let r = engine.search({ depth: 3 });
  assert.strictEqual(r.bestMoveStr, '0000');
  assert.strictEqual(r.score, -31000);

  engine.setFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  r = engine.search({ depth: 3 });
  assert.strictEqual(r.bestMoveStr, '0000');
  assert.strictEqual(r.score, 0);
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

  await nativeCase('native stalemate returns bestmove 0000 and score 0', async () => {
    const r = await native.search('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', { depth: 3 });
    assert.ok(r);
    assert.strictEqual(r.bestMoveStr, '0000');
    assert.strictEqual(r.score, 0);
  });

  await nativeCase('native checkmate returns bestmove 0000 and a mate score', async () => {
    const r = await native.search('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1', { depth: 3 });
    assert.ok(r);
    assert.strictEqual(r.bestMoveStr, '0000');
    // UCI 'mate 0' (mated at the root) maps to -30000 in the bridge.
    assert.strictEqual(r.score, -30000);
  });

  await nativeCase('native mate in one at depth 1 scores mate, not -INF', async () => {
    const r = await native.search('6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1', { depth: 1 });
    assert.ok(r);
    assert.strictEqual(r.bestMoveStr, 'e1e8');
    assert.strictEqual(r.score, 29998);
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

  await nativeCase('native one repetition cycle is not a draw', async () => {
    const r = await native.search(
      'startpos moves g1f3 g8f6 f3g1 f6g8', { depth: 3 }
    );
    assert.ok(r);
    assert.notStrictEqual(r.bestMoveStr, '0000');
    // A root draw is answered instantly at depth 1 with zero nodes. A real
    // search must have visited nodes and completed at least two iterations.
    assert.ok(r.nodes > 0, 'nodes = ' + r.nodes);
    assert.ok(r.depth >= 2, 'depth = ' + r.depth);
  });

  await nativeCase('native pawn move resets the repetition window', async () => {
    const r = await native.search(
      'startpos moves g1f3 g8f6 f3g1 f6g8 e2e4 g8f6 g1f3 f6g8 f3g1', { depth: 3 }
    );
    assert.ok(r);
    assert.strictEqual(r.score !== 0 || r.depth >= 2, true, 'draw fast path was taken');
    assert.ok(r.nodes > 0, 'nodes = ' + r.nodes);
  });

  await nativeCase('native castling rights prevent a false threefold', async () => {
    const base = 'fen r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1 moves ';
    const cycle = 'a1a2 a8a7 a2a1 a7a8';
    const once = await native.search(base + cycle, { depth: 3 });
    assert.ok(once && once.nodes > 0, 'first cycle must not be a root draw');

    const twice = await native.search(base + cycle + ' ' + cycle, { depth: 3 });
    assert.ok(twice && twice.nodes > 0, 'two occurrences are still not threefold');

    const thrice = await native.search(base + cycle + ' ' + cycle + ' ' + cycle, { depth: 3 });
    assert.ok(thrice);
    assert.strictEqual(thrice.score, 0);
    assert.strictEqual(thrice.nodes, 0);
  });

  await nativeCase('native ignores an irrelevant en-passant square', async () => {
    const r = await native.search(
      'fen rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1 moves ' +
      'b8c6 g1f3 c6b8 f3g1 b8c6 g1f3 c6b8 f3g1', { depth: 3 }
    );
    assert.ok(r);
    assert.strictEqual(r.score, 0);
    assert.strictEqual(r.nodes, 0);
  });

  native.quit();
}

(async () => {
  await nativeChecks();
  console.log(failures === 0 ? '\nall rules tests passed' : `\n${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
})();
