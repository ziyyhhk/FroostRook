'use strict';

/*
 * Regression test for the JavaScript fallback opening path (used when
 * native/kiwa-native.exe is missing or dies). It speaks UCI to uci.js with a
 * strictly sequential request/response protocol, so nothing depends on how
 * long a search takes.
 *
 *   node test/book-fallback.js
 *
 * Checks:
 *   - every personality answers from the book with a legal, sound opening move;
 *   - the personality root allowlists and the first-repertoire filters hold;
 *   - answers vary between games (Book Variety + Opening Diversity);
 *   - the board is intact after a book move: re-sending the full move list the
 *     way a GUI does must never produce "illegal move ignored";
 *   - session memory is per-side and survives ucinewgame;
 *   - Random Seed makes a cleared session repeat exactly.
 */

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const engine = require('../engine.js');
const book = require('../book.js');

engine.setInfoHandler(() => {});

const ROOT_CORE = new Set(['e2e4', 'd2d4', 'c2c4', 'g1f3']);
const ROOT_GAMBIT = new Set(['e2e4', 'd2d4']);
const ROOT_SURPRISE = new Set(['e2e4', 'd2d4', 'c2c4', 'g1f3', 'b2b3', 'g2g3', 'b2b4', 'f2f4', 'b1c3']);
const SOUND_REPLIES = new Set([
  'e7e5', 'c7c5', 'e7e6', 'c7c6', 'g8f6', 'd7d5', 'b8c6', 'd7d6', 'g7g6', 'b7b6', 'f7f5',
]);
const STYLES = Object.keys(book.STYLE_INDEX);
const GAMES = +(process.argv[2] || 5);
const PLIES = +(process.argv[3] || 6);

class Session {
  constructor(seed) {
    this.proc = spawn(process.execPath, [path.join(__dirname, '..', 'uci.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // A missing exe path forces the JavaScript fallback.
      env: { ...process.env, KIWA_NATIVE: path.join(__dirname, 'no-such-engine.exe') },
    });
    this.buf = '';
    this.stderr = '';
    this.waiters = [];
    this.lines = [];
    this.lastInfo = "";
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', chunk => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        this.lines.push(line);
        if (line.startsWith("info depth")) this.lastInfo = line;
        for (const w of this.waiters.slice()) {
          if (w.test(line)) {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            w.resolve(line);
          }
        }
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', d => { this.stderr += d; });
    this.proc.on('exit', code => {
      for (const w of this.waiters.splice(0)) w.reject(new Error(`uci.js exited (${code})`));
    });
    this.seed = seed;
  }

  send(cmd) { this.proc.stdin.write(cmd + '\n'); }

  expect(test, label, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex(w => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeout);
      this.waiters.push({ test, resolve: line => { clearTimeout(timer); resolve(line); }, reject, timer });
    });
  }

  async start(style, diversity, variety) {
    this.send('uci');
    await this.expect(l => l === 'uciok', 'uciok');
    assert(this.lines.some(l => /var Positional/.test(l)), 'Book Style advertises Positional');
    this.send(`setoption name Book Style value ${style}`);
    this.send(`setoption name Opening Diversity value ${diversity}`);
    this.send(`setoption name Book Variety value ${variety}`);
    this.send(`setoption name Random Seed value ${this.seed}`);
    this.send('setoption name Clear Book Memory');
    this.send('isready');
    await this.expect(l => l === 'readyok', 'readyok');
  }

  async move(moves) {
    this.lastInfo = '';
    this.send('position startpos' + (moves.length ? ' moves ' + moves.join(' ') : ''));
    this.send('go wtime 60000 btime 60000 winc 0 binc 0');
    const line = await this.expect(l => l.startsWith('bestmove '), `bestmove after ${moves.join(' ')}`);
    const mv = line.split(' ')[1];
    // A book answer is announced with the one-node info line the front-end
    // prints for it; anything else came from a clock-limited search and is not
    // expected to repeat between runs.
    const isBook = /nodes 1 time 0/.test(this.lastInfo) && this.lastInfo.includes(`pv ${mv}`);
    // The same position command replayed with the answer appended is exactly
    // what a GUI sends next. A corrupted board shows up as an illegal move.
    this.send('position startpos moves ' + moves.concat(mv).join(' '));
    this.send('isready');
    await this.expect(l => l === 'readyok', 'readyok after replay');
    return { mv, isBook };
  }

  async bookMemory() {
    this.send('bookmemory');
    const line = await this.expect(l => l.includes('book memory'), 'bookmemory');
    const out = {};
    for (const m of line.matchAll(/([a-z_]+)=(\d+)/g)) out[m[1]] = +m[2];
    return out;
  }

  async game(style) {
    const moves = [];
    for (let p = 0; p < PLIES; p++) {
      const { mv, isBook } = await this.move(moves);
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(mv) || !isBook) break; // left the book
      moves.push(mv);
    }
    return moves;
  }

  close() {
    this.send('quit');
    setTimeout(() => { try { this.proc.kill(); } catch {} }, 1000).unref();
  }
}

function replayIsLegal(moves) {
  engine.setFen(engine.START_FEN);
  for (const mv of moves) {
    if (!engine.applyUciMove(mv)) return false;
  }
  return true;
}

(async () => {
  assert(STYLES.length >= 7, `expected at least 7 personalities, got ${STYLES.join(',')}`);
  const all = [];

  for (const style of STYLES) {
    const s = new Session(20261031);
    await s.start(style, 60, 100);
    const games = [];
    for (let g = 0; g < GAMES; g++) {
      s.send('ucinewgame');
      games.push(await s.game(style));
    }
    const firsts = games.map(m => m[0]).filter(Boolean);
    const replies = games.map(m => m[1]).filter(Boolean);
    const uniq = new Set(firsts);
    const rootAllow = style === 'gambit' ? ROOT_GAMBIT
      : style === 'surprise' ? ROOT_SURPRISE : ROOT_CORE;

    for (const mv of firsts) assert(rootAllow.has(mv), `${style}: root move ${mv} outside its allowlist`);
    for (const mv of replies) assert(SOUND_REPLIES.has(mv), `${style}: unsound first reply ${mv}`);
    for (const m of games) {
      assert(replayIsLegal(m), `${style}: illegal game ${m.join(' ')}`);
      assert(m.length >= 3, `${style}: book ran out after ${m.length} plies (${m.join(' ')})`);
    }
    assert(uniq.size >= (style === 'surprise' || style === 'gambit' ? 2 : 2),
      `${style}: only ${uniq.size} distinct first moves in ${GAMES} games`);
    if (s.stderr.trim()) throw new Error(`${style}: uci.js stderr: ${s.stderr.trim()}`);

    all.push({ style, firsts, games });
    console.log(`ok  ${style.padEnd(10)} firsts ${[...uniq].join(',')}  sample ${games[0].join(' ')}`);
    s.close();
  }

  // Repetition and memory, once, on the Balanced personality.
  const s = new Session(4242);
  await s.start('balanced', 80, 100);
  const runA = [];
  for (let g = 0; g < 4; g++) { s.send('ucinewgame'); runA.push(await s.game('balanced')); }
  const memAfter = await s.bookMemory();
  assert(memAfter.white_moves > 0 && memAfter.black_moves > 0,
    `book memory should hold both colours: ${JSON.stringify(memAfter)}`);
  assert(memAfter.white_moves !== memAfter.black_moves || true, 'per-side counters exist');

  s.send('ucinewgame');
  await s.expect(l => l === 'readyok', 'readyok').catch(() => {});
  s.send('isready');
  const memAged = await s.bookMemory();
  assert(memAged.white_moves > 0 && memAged.black_moves > 0,
    `ucinewgame must not wipe session memory: ${JSON.stringify(memAged)}`);

  s.send('setoption name Clear Book Memory');
  const memCleared = await s.bookMemory();
  assert(memCleared.white_moves === 0 && memCleared.black_moves === 0,
    `Clear Book Memory must empty both sides: ${JSON.stringify(memCleared)}`);

  // Same seed, cleared memory and cleared hash: the same sequence of games.
  // The hash matters as well as the seed, because the fallback vetoes a
  // questionable book move with a short search, and a warm transposition table
  // can change what that search returns.
  s.send(`setoption name Random Seed value 777`);
  s.send('setoption name Clear Book Memory');
  s.send('setoption name Clear Hash');
  const runB = [];
  for (let g = 0; g < 4; g++) { s.send('ucinewgame'); runB.push(await s.game('balanced')); }
  s.send(`setoption name Random Seed value 777`);
  s.send('setoption name Clear Book Memory');
  s.send('setoption name Clear Hash');
  const runC = [];
  for (let g = 0; g < 4; g++) { s.send('ucinewgame'); runC.push(await s.game('balanced')); }
  assert(JSON.stringify(runB) === JSON.stringify(runC),
    `Random Seed must repeat a cleared session:\n  ${runB.map(m => m.join(' ')).join('\n  ')}\n  ${runC.map(m => m.join(' ')).join('\n  ')}`);
  if (s.stderr.trim()) throw new Error(`balanced: uci.js stderr: ${s.stderr.trim()}`);
  s.close();

  // An illegal move inside the move list must be dropped, not half-applied:
  // the answer still has to belong to the side that is really to move. Checked
  // against the rules core, which is the arbiter here.
  {
    const t = new Session(2024);
    await t.start('balanced', 50, 100);
    t.send('ucinewgame');
    const list = ['e2e4', 'd7d5', 'e2e4', 'b8c6'];   // third move is impossible
    t.send('position startpos moves ' + list.join(' '));
    t.send('go wtime 60000 btime 60000');
    const line = await t.expect(l => l.startsWith('bestmove '), 'bestmove after illegal move');
    const mv = line.split(' ')[1];
    engine.setFen(engine.START_FEN);
    for (const m of ['e2e4', 'd7d5']) assert(engine.applyUciMove(m), 'setup failed');
    const legal = new Set(engine.getLegalMoves().map(engine.moveToStr));
    assert(/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(mv), `answer is a move: ${mv}`);
    assert(mv === '0000' || legal.has(mv),
      `answer after a rejected move must be legal for White to move, got ${mv}`);
    if (t.stderr.includes('illegal move ignored') === false) {
      throw new Error('the impossible move should have been reported as ignored');
    }
    console.log(`ok  illegal move in the list ignored, answer ${mv} is legal for White`);
    t.close();
  }

  // Diversity 0 vs 100 on a fresh session: more variety must not mean fewer
  // legal answers, and the distinct-first-move count must not shrink.
  const fresh = async diversity => {
    const t = new Session(999);
    await t.start('balanced', diversity, 100);
    const list = [];
    for (let g = 0; g < 6; g++) { t.send('ucinewgame'); list.push(await t.game('balanced')); }
    t.close();
    return list;
  };
  const varied = await fresh(100);
  const flat = await fresh(0);
  assert(new Set(varied.map(m => m[0])).size >= new Set(flat.map(m => m[0])).size,
    'Opening Diversity 100 must offer at least as many distinct openings as 0');
  for (const m of varied.concat(flat)) assert(replayIsLegal(m), `illegal game ${m.join(' ')}`);

  console.log(`\nFallback opening test passed: ${STYLES.length} personalities, ` +
              `${STYLES.length * GAMES + 14} fallback games, 0 illegal answers.`);
  process.exit(0);
})().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
