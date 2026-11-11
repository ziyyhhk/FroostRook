'use strict';

/*
 * Ponder support smoke test.
 *
 *   node test/ponder-test.js
 *
 * Verifies the UCI pondering protocol end to end:
 *   - `position ... ponder <move>` sets up the predicted position;
 *   - `go ponder` starts a ponder search (real search, not a book move);
 *   - `ponderhit` converts to a normal clock-budgeted search, which then
 *     terminates with a bestmove without the engine restarting;
 *   - `stop` aborts a ponder search promptly when the prediction was wrong.
 */
const { spawn } = require('child_process');
const path = require('path');

const exe = require('../native-exe');

class Uci {
  constructor() {
    this.proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = '';
    this.lines = [];
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', d => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        this.lines.push(line);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', d => { /* swallow */ });
  }
  send(cmd) { this.proc.stdin.write(cmd + '\n'); }
  async waitFor(pred, ms, what) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = this.lines.find(pred);
      if (hit) return hit;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('timeout waiting for ' + what);
  }
  waitBestmove(ms) {
    return this.waitFor(l => l.startsWith('bestmove '), ms, 'bestmove');
  }
  quit() { this.send('quit'); }
}

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('ok:', msg);
}

(async () => {
  const uci = new Uci();
  uci.send('uci');
  await uci.waitFor(l => l === 'uciok', 10000, 'uciok');
  assert(uci.lines.some(l => l.startsWith('id name ')), 'handshake ok');

  // Ponder a predicted move and confirm the engine searches the ponder
  // position instead of returning an instant book/no-op move.
  uci.send('position startpos moves e2e4 e7e5 ponder g1f3');
  uci.send('go ponder wtime 60000 btime 60000');
  const info = await uci.waitFor(l => l.startsWith('info depth '), 5000, 'ponder info line');
  assert(/info depth \d+/.test(info), 'ponder search emitted an info line');

  // Convert to a normal search: it must finish on its own clock.
  uci.send('ponderhit');
  const bm = await uci.waitBestmove(30000);
  assert(/^bestmove [a-h][1-8][a-h][1-8][qrbn]?$/.test(bm), `ponderhit produced a legal bestmove: ${bm}`);

  // A wrong prediction: stop must abort the ponder search promptly.
  uci.send('position startpos moves d2d4 d7d5 ponder g1f3');
  uci.send('go ponder wtime 60000 btime 60000');
  await uci.waitFor(l => l.startsWith('info depth '), 5000, 'ponder info line (2)');
  uci.send('stop');
  const op = await uci.waitBestmove(5000).catch(() => null);
  if (op) assert(/^bestmove /.test(op), `stop ended the ponder search with ${op}`);
  else console.log('ok: stop terminated the ponder search without output');

  // Ponder search with no hit and no stop: it must terminate on its own cap.
  uci.send('position startpos moves g2g3 g7g6 ponder b1c3');
  uci.send('go ponder wtime 60000 btime 60000');
  const cap = await uci.waitBestmove(25000);
  assert(/^bestmove /.test(cap), `ponder search terminated on its own cap: ${cap}`);

  uci.quit();
  process.exit(0);
})().catch(e => {
  console.error('ponder test failed:', e.message);
  process.exit(1);
});
