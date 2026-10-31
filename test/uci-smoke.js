'use strict';

/*
 * Speaks to uci.js like a real GUI would: handshake, book move on move one,
 * a normal search, and a mate score. Exits non-zero on failure.
 *
 *   node test/uci-smoke.js
 */

const { spawn } = require('child_process');
const path = require('path');

const proc = spawn(process.execPath, [path.join(__dirname, '..', 'uci.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const lines = [];
const waiters = [];
let consumed = 0;   // index of the first line no waiter has claimed yet

proc.stdout.setEncoding('utf8');
proc.stdout.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    lines.push(line);
    for (const w of waiters.slice()) {
      if (w.match(line)) {
        waiters.splice(waiters.indexOf(w), 1);
        consumed = lines.length;
        w.resolve(line);
      }
    }
  }
});

function send(cmd) {
  proc.stdin.write(cmd + '\n');
}

function waitFor(match, timeoutMs = 15000, label = '') {
  return new Promise((resolve, reject) => {
    // Replies that already arrived (a book move answers in ~1 ms, faster than
    // this promise can be armed) must be found in the backlog, not missed.
    for (let i = consumed; i < lines.length; i++) {
      if (match(lines[i])) {
        consumed = i + 1;
        return resolve(lines[i]);
      }
    }
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + (label || match))), timeoutMs);
    waiters.push({ match, resolve: line => { clearTimeout(timer); resolve(line); } });
  });
}

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    proc.kill();
    process.exit(1);
  }
  console.log('ok:', msg);
}

(async () => {
  send('uci');
  await waitFor(l => l === 'uciok', 15000, 'uciok');
  assert(lines.some(l => l.startsWith('id name KiwaChess 2.3.0')), 'engine identifies itself');
  for (const opt of ['Threads', 'Hash', 'OwnBook', 'Book Depth', 'Book Variety', 'Book Style',
                     'Opening Diversity', 'Random Seed', 'Clear Book Memory', 'Move Overhead', 'Clear Hash']) {
    assert(lines.some(l => l.startsWith(`option name ${opt} `)), `advertises ${opt}`);
  }

  send('isready');
  await waitFor(l => l === 'readyok');

  // The Threads option must reach the native core and still answer.
  send('setoption name Threads value 2');
  send('position fen r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 6');
  send('go movetime 300');
  const mt = await waitFor(l => l.startsWith('bestmove '), 15000);
  assert(/^bestmove [a-h][1-8][a-h][1-8][qrbn]?$/.test(mt), `2-thread search returned a move: ${mt}`);
  send('setoption name Threads value 1');

  // Book Variety 0 must return the most popular book move.
  send('setoption name Book Variety value 0');
  send('ucinewgame');
  send('position startpos');
  const t0 = Date.now();
  send('go wtime 60000 btime 60000 winc 0 binc 0');
  const bm = await waitFor(l => l.startsWith('bestmove '));
  const first = bm.split(' ')[1];
  assert(first === 'e2e4', `Book Variety 0 opens e2e4: ${first}`);
  assert(Date.now() - t0 < 2000, `book answered fast (${Date.now() - t0} ms)`);

  // At full variety the first move should not be hard-wired.
  send('setoption name Book Variety value 100');
  const starts = new Set();
  for (let i = 0; i < 12; i++) {
    send('ucinewgame');
    send('position startpos');
    send('go wtime 60000 btime 60000 winc 0 binc 0');
    const line = await waitFor(l => l.startsWith('bestmove '));
    starts.add(line.split(' ')[1]);
  }
  assert(starts.size >= 2, `book variety produced ${starts.size} distinct first moves: ${[...starts].join(',')}`);

  // Diagnostics must report the engine that is actually playing. Before 2.3.0
  // the front-end answered `bookmemory`/`eval` from its own JavaScript state
  // even when the native core owned the book, which printed all-zero memory.
  send('setoption name Book Style value Surprise');
  send('setoption name Random Seed value 7');
  // Both spellings of a button have to work: the UCI spec form, and the
  // trailing bare `value` some GUIs send. The second one used to swallow the
  // word "value" into the option name, so nothing was cleared.
  for (const form of ['setoption name Clear Book Memory value', 'setoption name Clear Book Memory']) {
    send(form);
    send('ucinewgame');
    send('position startpos');
    send('go wtime 60000 btime 60000');
    await waitFor(l => l.startsWith('bestmove '));
    send('position startpos');
    send('bookmemory');
    const after = await waitFor(l => l.includes('book memory'), 10000, 'bookmemory after clear');
    const counts = {};
    for (const m of after.matchAll(/([a-z_]+)=(\d+)/g)) counts[m[1]] = +m[2];
    assert(counts.white_moves === 1, `${form} clears the memory then records one move: ${after}`);
  }
  send('setoption name Clear Book Memory');
  send('position startpos');
  send('bookmemory');
  const mem = await waitFor(l => l.includes('book memory'), 10000, 'bookmemory');
  const nums = {};
  for (const m of mem.matchAll(/([a-z_]+)=(\d+)/g)) nums[m[1]] = +m[2];
  assert(nums.white_moves === 0, `bookmemory reports zero after an explicit clear: ${mem}`);
  send('setoption name Book Style value Surprise');
  send('setoption name Random Seed value 7');
  send('ucinewgame');
  send('position startpos');
  send('go wtime 60000 btime 60000');
  await waitFor(l => l.startsWith('bestmove '));
  send('position startpos');
  send('bookmemory');
  const played = await waitFor(l => l.includes('book memory'), 10000, 'bookmemory');
  const playedNums = {};
  for (const m of played.matchAll(/([a-z_]+)=(\d+)/g)) playedNums[m[1]] = +m[2];
  assert(playedNums.white_moves > 0, `bookmemory reports the played book move: ${played}`);
  send('eval');
  const ev = await waitFor(l => l.startsWith('info string eval '), 10000, 'eval');
  assert(/info string eval -?\d+ cp/.test(ev), `eval prints a centipawn score: ${ev}`);
  send('setoption name Book Style value Balanced');

  // The requested repertoire must be reachable through setoption, including the
  // personalities that have no data of their own in a given position.
  for (const style of ['Mainline', 'Aggressive', 'Positional', 'Solid', 'Gambit', 'Surprise']) {
    send(`setoption name Book Style value ${style}`);
    send('ucinewgame');
    send('position startpos');
    const t = Date.now();
    send('go wtime 60000 btime 60000');
    const line = await waitFor(l => l.startsWith('bestmove '));
    const mv = line.split(' ')[1];
    assert(/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(mv), `${style}: legal opening move ${mv}`);
    assert(Date.now() - t < 4000, `${style}: answered from the book (${Date.now() - t} ms)`);
  }

  // A middlegame position must be searched, not booked.
  send('position fen r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 6');
  send('go movetime 400');
  const bm2 = await waitFor(l => l.startsWith('bestmove '), 15000);
  assert(/^bestmove [a-h][1-8][a-h][1-8][qrbn]?$/.test(bm2), `search returned a move: ${bm2}`);

  // Back-rank mate in one: Re8#.
  send('position fen 6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1');
  send('go movetime 600');
  const bm3 = await waitFor(l => l.startsWith('bestmove '), 15000);
  assert(bm3.split(' ')[1] === 'e1e8', `finds Re8#: ${bm3}`);

  send('quit');
  console.log('\nUCI smoke test passed.');
  process.exit(0);
})().catch(err => {
  console.error('FAIL:', err.message);
  proc.kill();
  process.exit(1);
});
