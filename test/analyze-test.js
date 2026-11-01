'use strict';

/*
 * Automated tests for analyze.js.
 *
 *   node test/analyze-test.js
 *
 * Uses the native engine in native/kiwa-native.exe with a tiny node budget so
 * the whole file stays fast.  Prints PASS/FAIL lines and exits non-zero if any
 * assertion fails.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ANALYZE = path.join(ROOT, 'analyze.js');
const ENGINE = require('../native-exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwa-analyze-test-'));

let passCount = 0;
let failCount = 0;

function check(name, condition, detail) {
  if (condition) {
    passCount++;
    console.log('PASS: ' + name);
    return true;
  }
  failCount++;
  process.exitCode = 1;
  console.error('FAIL: ' + name + (detail ? ' -- ' + detail : ''));
  return false;
}

function writeTemp(name, text) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runCli(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [ANALYZE, ...args], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch (e) { /* ignore */ }
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        stdout,
        stderr,
        ms: Date.now() - started,
      });
    });
  });
}

const MATE_PGN = `[Event "Synthetic mate"]
[Site "local"]
[Date "2026.11.01"]
[Round "1"]
[White "Synthetic White"]
[Black "Synthetic Black"]
[Result "0-1"]

1. f3 e5 2. g4 Qh4# 0-1
`;

const SPECIAL_PGN = `[Event "Castling en passant promotion"]
[Site "local"]
[Date "2026.11.01"]
[Round "1"]
[White "Synthetic White"]
[Black "Synthetic Black"]
[Result "1-0"]

1. e4 {king pawn {nested comment braces are ignored}} e5
(1... d5 2. exd5 Qxd5 (2... Nf6) {a nested variation}) 2. Nc3 $1 Nc6
3. Bc4 Bc5 4. d3 Nf6 5. Be3 Qe7 6. Qd2 O-O 7. O-O-O a6
8. f4 Re8 9. fxe5 d5 10. exd6 e.p. h5 11. d7 Qe6 12. d8=Q 1-0
`;

const SPECIAL_UCIS = [
  'e2e4', 'e7e5',
  'b1c3', 'b8c6',
  'f1c4', 'f8c5',
  'd2d3', 'g8f6',
  'c1e3', 'd8e7',
  'd1d2', 'e8g8',
  'e1c1', 'a7a6',
  'f2f4', 'f8e8',
  'f4e5', 'd7d5',
  'e5d6', 'h7h5',
  'd6d7', 'e7e6',
  'd7d8q',
];

const THREEFOLD_PGN = `[Event "Synthetic threefold"]
[Site "local"]
[Date "2026.11.01"]
[Round "1"]
[White "Synthetic White"]
[Black "Synthetic Black"]
[Result "1/2-1/2"]

1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 1/2-1/2
`;

const FIFTY_PGN = `[Event "Synthetic fifty move"]
[Site "local"]
[Date "2026.11.01"]
[Round "1"]
[White "Synthetic White"]
[Black "Synthetic Black"]
[Result "1/2-1/2"]
[SetUp "1"]
[FEN "4k3/8/8/8/8/8/8/R3K3 w - - 99 80"]

80. Ra2 Kd8 81. Ra1 Ke8 1/2-1/2
`;

const BARE_KINGS_PGN = `[Event "Synthetic dead position"]
[Site "local"]
[Date "2026.11.01"]
[Round "1"]
[White "Synthetic White"]
[Black "Synthetic Black"]
[Result "1/2-1/2"]
[SetUp "1"]
[FEN "4k3/8/8/8/8/8/8/4K3 w - - 0 1"]

1/2-1/2
`;

async function testMateGame() {
  const pgn = writeTemp('mate.pgn', MATE_PGN);
  const json = path.join(TMP, 'mate.json');
  const result = await runCli([
    '--pgn', pgn,
    '--nodes', '20000',
    '--json', json,
    '--quiet',
  ]);

  if (!check('mate game: CLI exits 0',
    result.code === 0,
    `code=${result.code} signal=${result.signal} stderr=${result.stderr.trim()}`)) {
    return;
  }
  check('mate game: --quiet leaves stdout empty', result.stdout.trim() === '', `stdout=${JSON.stringify(result.stdout)}`);

  let doc;
  try {
    doc = readJson(json);
  } catch (e) {
    check('mate game: JSON file is readable', false, e.message);
    return;
  }

  const game = doc.games[0];
  check('mate game: one game in output', doc.games.length === 1);
  check('mate game: all four moves parsed', game.moves.length === 4, `got ${game.moves.length}`);
  check('mate game: UCI sequence',
    game.moves.map((m) => m.uci).join(' ') === 'f2f3 e7e5 g2g4 d8h4',
    game.moves.map((m) => m.uci).join(' '));
  check('mate game: final position is checkmate', game.finalStatus === 'checkmate', game.finalStatus);
  check('mate game: final move is terminal checkmate', game.moves[3].terminalAfter === 'checkmate', game.moves[3].terminalAfter);

  const g4 = game.moves[2];
  check('mate game: 2.g4 was analyzed', g4.analyzed === true);
  check('mate game: 2.g4 is a bad-move label',
    ['inaccuracy', 'mistake', 'blunder'].includes(g4.label),
    `label=${g4.label}`);
  check('mate game: 2.g4 loss reflects mate margin', g4.loss >= 9000, `loss=${g4.loss}`);

  const last = game.moves[3];
  check('mate game: Qh4# is best', last.label === 'best', `label=${last.label}`);
  check('mate game: Qh4# after-eval is terminal mate',
    last.evalAfter && last.evalAfter.terminal === 'checkmate' && last.evalAfter.mateIn === 0,
    JSON.stringify(last.evalAfter));

  const labels = new Set();
  for (const g of doc.games) {
    for (const m of g.moves) if (m.analyzed) labels.add(m.label);
  }
  check('mate game: no invented labels', [...labels].every((l) => [
    'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder', 'missed mate', 'missed win',
  ].includes(l)), [...labels].join(','));
  check('mate game: brilliant is not claimed', !labels.has('brilliant'));

  const analyzedMoves = game.moves.filter((m) => m.analyzed);
  check('mate game: default candidate-line count is 3', doc.options.multipv === 3, doc.options.multipv);
  check('mate game: every analyzed move has candidates',
    analyzedMoves.every((m) => Array.isArray(m.candidates) && m.candidates.length >= 1),
    analyzedMoves.map((m) => (m.candidates || []).length).join(','));
  check('mate game: candidate ranks are ordered from 1',
    analyzedMoves.every((m) => m.candidates.every((c, i) => c.rank === i + 1)),
    analyzedMoves.map((m) => m.candidates.map((c) => c.rank).join('.')).join(' '));
  check('mate game: rank-1 candidate is the reported best move',
    analyzedMoves.every((m) => m.candidates[0].bestUci === m.bestUci),
    analyzedMoves.map((m) => `${m.candidates[0].bestUci}/${m.bestUci}`).join(','));
  check('mate game: draw state is attached to every move',
    game.moves.every((m) => m.drawBefore && m.drawAfter &&
      typeof m.drawBefore.known === 'boolean' && typeof m.drawAfter.known === 'boolean'));
}

async function testSpecialMoves() {
  const pgn = writeTemp('special.pgn', SPECIAL_PGN);
  const json = path.join(TMP, 'special.json');
  const result = await runCli([
    '--pgn', pgn,
    '--nodes', '20000',
    '--max-plies', '1',
    '--json', json,
    '--quiet',
  ]);

  if (!check('special moves: CLI exits 0',
    result.code === 0,
    `code=${result.code} stderr=${result.stderr.trim()}`)) {
    return;
  }

  let doc;
  try {
    doc = readJson(json);
  } catch (e) {
    check('special moves: JSON file is readable', false, e.message);
    return;
  }

  const game = doc.games[0];
  check('special moves: comments/variations did not add moves', game.moves.length === SPECIAL_UCIS.length,
    `got ${game.moves.length}, expected ${SPECIAL_UCIS.length}`);
  check('special moves: parsed UCI sequence matches',
    game.moves.map((m) => m.uci).join(' ') === SPECIAL_UCIS.join(' '),
    '\n  got:      ' + game.moves.map((m) => m.uci).join(' ') +
    '\n  expected: ' + SPECIAL_UCIS.join(' '));

  const bySan = new Map(game.moves.map((m) => [m.san, m.uci]));
  check('special moves: white O-O-O parsed', bySan.get('O-O-O') === 'e1c1', bySan.get('O-O-O'));
  check('special moves: black O-O parsed', bySan.get('O-O') === 'e8g8', bySan.get('O-O'));
  check('special moves: en passant parsed', bySan.get('exd6') === 'e5d6', bySan.get('exd6'));
  check('special moves: promotion parsed', bySan.get('d8=Q') === 'd7d8q', bySan.get('d8=Q'));
  check('special moves: comment braces ignored', game.moves.every((m) => !m.san.includes('comment')));

  // Additional SAN form coverage (no engine needed).
  const A = require(ANALYZE);
  const promoA = A.parseSan('e8=Q+');
  const promoB = A.parseSan('e8Q');
  const promoCap = A.parseSan('exd8=Q+');
  check('special moves: e8=Q+ SAN form', promoA.promo === 'Q' && promoA.to === 'e8');
  check('special moves: e8Q SAN form', promoB.promo === 'Q' && promoB.to === 'e8');
  check('special moves: exd8=Q+ SAN form', promoCap.promo === 'Q' && promoCap.capture === true && promoCap.fromFile === 'e');
  check('special moves: 0-0-0 SAN form', A.parseSan('0-0-0').kind === 'castle' && A.parseSan('0-0-0').side === 'q');
}

async function testRealGame() {
  const pgn = path.join(ROOT, 'test', 'human-games', 'Ayaan-07.pgn');
  if (!check('real game: PGN fixture exists', fs.existsSync(pgn), pgn)) return;

  // Parse-only assertion: this file has many games.
  const A = require(ANALYZE);
  let parsed;
  try {
    parsed = A.parsePgn(fs.readFileSync(pgn, 'utf8'), pgn);
  } catch (e) {
    check('real game: PGN parses without error', false, e.message);
    return;
  }
  check('real game: multiple games found', parsed.length >= 2, `found ${parsed.length}`);

  const json = path.join(TMP, 'real.json');
  const result = await runCli([
    '--pgn', pgn,
    '--game', '1',
    '--nodes', '20000',
    '--max-plies', '10',
    '--json', json,
    '--quiet',
  ], 180000);

  if (!check('real game: CLI exits 0',
    result.code === 0,
    `code=${result.code} stderr=${result.stderr.trim()}`)) {
    return;
  }

  let doc;
  try {
    doc = readJson(json);
  } catch (e) {
    check('real game: JSON file is readable', false, e.message);
    return;
  }

  const game = doc.games[0];
  check('real game: only --game 1 selected', doc.games.length === 1);
  check('real game: tags preserved',
    game.tags.White === 'greg_st' && game.tags.Black === 'Ayaan-07',
    `${game.tags.White} vs ${game.tags.Black}`);
  check('real game: full game was parsed', game.moves.length > 50, `moves=${game.moves.length}`);
  const analyzed = game.moves.filter((m) => m.analyzed);
  check('real game: exactly 10 plies analyzed', analyzed.length === 10, `analyzed=${analyzed.length}`);
  check('real game: five moves for each player',
    game.summary.white.moves === 5 && game.summary.black.moves === 5,
    `white=${game.summary.white.moves} black=${game.summary.black.moves}`);
  check('real game: ACL has a sample for every analyzed move',
    game.summary.white.aclMoves + game.summary.black.aclMoves === 10,
    `white=${game.summary.white.aclMoves} black=${game.summary.black.aclMoves}`);
  check('real game: ACL is numeric',
    typeof game.summary.white.acl === 'number' && typeof game.summary.black.acl === 'number',
    `white=${game.summary.white.acl} black=${game.summary.black.acl}`);
  check('real game: per-player counts present',
    game.summary.white.counts && game.summary.black.counts &&
    typeof game.summary.white.counts.blunder === 'number');
  check('real game: worst moves capped at three',
    game.summary.white.worst.length <= 3 && game.summary.black.worst.length <= 3);

  console.log(`INFO: real-game test took ${(result.ms / 1000).toFixed(2)} s (${analyzed.length} plies at nodes 20000)`);
}

async function testDrawRecognition() {
  // Threefold: the final position occurred at the start and after 2...Ng8.
  const repeatPgn = writeTemp('threefold.pgn', THREEFOLD_PGN);
  const repeatJson = path.join(TMP, 'threefold.json');
  const repeat = await runCli([
    '--pgn', repeatPgn,
    '--nodes', '10000',
    '--multipv', '2',
    '--max-plies', '1',
    '--json', repeatJson,
    '--quiet',
  ]);
  if (!check('draws: threefold CLI exits 0',
    repeat.code === 0,
    `code=${repeat.code} stderr=${repeat.stderr.trim()}`)) return;

  const repeatGame = readJson(repeatJson).games[0];
  check('draws: threefold final status',
    repeatGame.finalStatus === 'draw-threefold', repeatGame.finalStatus);
  check('draws: threefold is claimable and claimed by the score sheet',
    repeatGame.finalDraw && repeatGame.finalDraw.claimable === true &&
    repeatGame.finalDraw.claimed === true && repeatGame.finalDraw.drawn === true,
    JSON.stringify(repeatGame.finalDraw));
  check('draws: threefold result matches the score sheet',
    repeatGame.resultConsistency === 'match', repeatGame.resultConsistency);
  const repeatLast = repeatGame.moves[repeatGame.moves.length - 1];
  check('draws: repetition is detected after the last move',
    repeatLast.drawAfter.status === 'draw-threefold' &&
    repeatLast.drawAfter.reasons.includes('threefold-repetition'),
    JSON.stringify(repeatLast.drawAfter));
  check('draws: repetition was not claimed before the last move',
    repeatLast.drawBefore.known === false, JSON.stringify(repeatLast.drawBefore));
  const repeatAnalyzed = repeatGame.moves.filter((m) => m.analyzed);
  check('draws: a draw does not produce a missed win or mate label',
    repeatAnalyzed.every((m) => m.label !== 'missed win' && m.label !== 'missed mate'),
    repeatAnalyzed.map((m) => m.label).join(','));

  // Fifty-move rule: the FEN starts at halfmove 99, so the final position is
  // claimable at 100+ halfmoves.  The result token records the claim.
  const fiftyPgn = writeTemp('fifty.pgn', FIFTY_PGN);
  const fiftyJson = path.join(TMP, 'fifty.json');
  const fifty = await runCli([
    '--pgn', fiftyPgn,
    '--nodes', '10000',
    '--multipv', '1',
    '--max-plies', '1',
    '--json', fiftyJson,
    '--quiet',
  ]);
  if (!check('draws: fifty-move CLI exits 0',
    fifty.code === 0,
    `code=${fifty.code} stderr=${fifty.stderr.trim()}`)) return;
  const fiftyGame = readJson(fiftyJson).games[0];
  check('draws: fifty-move final status',
    fiftyGame.finalStatus === 'draw-fifty-move', fiftyGame.finalStatus);
  check('draws: fifty-move is claimable and claimed',
    fiftyGame.finalDraw.claimable === true && fiftyGame.finalDraw.claimed === true,
    JSON.stringify(fiftyGame.finalDraw));

  // Dead position: bare kings must be recognised without any search.
  const deadPgn = writeTemp('dead.pgn', BARE_KINGS_PGN);
  const deadJson = path.join(TMP, 'dead.json');
  const dead = await runCli([
    '--pgn', deadPgn,
    '--nodes', '10000',
    '--json', deadJson,
    '--quiet',
  ]);
  if (!check('draws: dead-position CLI exits 0',
    dead.code === 0,
    `code=${dead.code} stderr=${dead.stderr.trim()}`)) return;
  const deadGame = readJson(deadJson).games[0];
  check('draws: bare kings are an automatic draw',
    deadGame.finalStatus === 'draw-insufficient-material' &&
    deadGame.finalDraw.automatic === true && deadGame.finalDraw.drawn === true,
    JSON.stringify(deadGame.finalDraw));
  check('draws: dead position has no moves to analyze',
    deadGame.moves.length === 0 && deadGame.analysisRange.analyzedPlies === 0,
    `moves=${deadGame.moves.length}`);
}

async function testMalformedPgn() {
  const pgn = writeTemp('malformed.pgn', `[Event "Malformed"]
[Result "*"]

1. e4 e5 2. Qz9 3. Nf3 *
`);
  const result = await runCli(['--pgn', pgn, '--nodes', '20000', '--quiet']);
  check('malformed PGN: CLI exits non-zero', result.code !== 0, `code=${result.code}`);
  check('malformed PGN: error names the bad SAN and ply',
    /Qz9/.test(result.stderr) && /ply 3/.test(result.stderr),
    result.stderr.trim());
}

async function testMutuallyExclusiveBudget() {
  const pgn = writeTemp('budget.pgn', MATE_PGN);
  const result = await runCli([
    '--pgn', pgn,
    '--depth', '5',
    '--nodes', '20000',
    '--quiet',
  ]);
  check('budget flags: --depth plus --nodes is rejected', result.code === 2, `code=${result.code}`);
  check('budget flags: error says mutually exclusive',
    /mutually exclusive/.test(result.stderr),
    result.stderr.trim());

  const badMulti = await runCli([
    '--pgn', pgn,
    '--multipv', '9',
    '--quiet',
  ]);
  check('multipv: out-of-range value is rejected', badMulti.code === 2, `code=${badMulti.code}`);
  check('multipv: error states the valid range',
    /between 1 and 8/.test(badMulti.stderr), badMulti.stderr.trim());
}

async function run() {
  console.log('analyze.js tests (engine: ' + ENGINE + ')');
  console.log('temp directory: ' + TMP);
  console.log('');
  try {
    await testMateGame();
    await testSpecialMoves();
    await testRealGame();
    await testDrawRecognition();
    await testMalformedPgn();
    await testMutuallyExclusiveBudget();
  } finally {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch (e) {
      console.error('WARN: could not remove temp directory ' + TMP + ': ' + e.message);
    }
  }
  console.log('');
  console.log(`SUMMARY: PASS ${passCount}, FAIL ${failCount}`);
  if (failCount) process.exitCode = 1;
}

run().catch((err) => {
  failCount++;
  process.exitCode = 1;
  console.error('FAIL: unexpected test runner error -- ' + (err && err.stack ? err.stack : err));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (e) { /* ignore */ }
  console.log('');
  console.log(`SUMMARY: PASS ${passCount}, FAIL ${failCount}`);
});
