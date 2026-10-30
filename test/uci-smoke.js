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
  assert(lines.some(l => l.startsWith('id name Kiwa')), 'engine identifies itself');

  send('isready');
  await waitFor(l => l === 'readyok');

  // Opening book must answer move one instantly with a real first move.
  send('ucinewgame');
  send('position startpos');
  const t0 = Date.now();
  send('go wtime 60000 btime 60000 winc 0 binc 0');
  const bm = await waitFor(l => l.startsWith('bestmove '));
  const first = bm.split(' ')[1];
  const book = require('../book.js');
  const startMoves = book.BOOK['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq'].map(r => r[0]);
  assert(startMoves.includes(first), `book opening: ${first}`);
  assert(Date.now() - t0 < 2000, `book answered fast (${Date.now() - t0} ms)`);

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
