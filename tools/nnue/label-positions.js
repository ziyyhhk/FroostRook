'use strict';

/*
 * Stockfish position labeler for the FRNN pipeline.
 *
 *   node tools/nnue/label-positions.js --in positions.jsonl --out labels.jsonl \
 *        [--sf <stockfish.exe>] [--depth 10] [--nodes N] [--jobs 2] [--limit N]
 *
 * Input  lines: JSON objects with a "fen" field. Output lines: the same
 * object plus {cp|mate, depth, nodes, nps} (cp is from the side-to-move
 * perspective; mate is present instead of cp when a forced mate is found).
 * Reruns are incremental: FENs already in the output file are skipped.
 * Each worker is an independent Stockfish searched at a fixed depth.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const opts = {
    in: null, out: null, depth: 10, nodes: 0, jobs: 2, limit: Infinity,
    sf: process.env.STOCKFISH || path.join(__dirname, '..', '..', '.build', 'sf', 'stockfish', 'stockfish-windows-x86-64-avx2.exe'),
  };
  for (let i = 0; i < argv.length; i++) {
    const val = () => argv[++i];
    if (argv[i] === '--in') opts.in = val();
    else if (argv[i] === '--out') opts.out = val();
    else if (argv[i] === '--sf') opts.sf = val();
    else if (argv[i] === '--depth') opts.depth = +val();
    else if (argv[i] === '--nodes') opts.nodes = +val();
    else if (argv[i] === '--jobs') opts.jobs = Math.max(1, +val());
    else if (argv[i] === '--limit') opts.limit = +val();
    else throw new Error('unknown arg ' + argv[i]);
  }
  if (!opts.in || !opts.out) throw new Error('need --in and --out');
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (!fs.existsSync(opts.sf)) {
  console.error('Stockfish not found: ' + opts.sf);
  process.exit(1);
}

class Worker {
  constructor(sfPath) {
    this.sfPath = sfPath;
    this.proc = null;
    this.buf = '';
    this.lastInfo = null;
    this.handshake = null;     // { match, resolve, timer } | null
    this.bestmoveWaiter = null; // { resolve, timer } | null
    this.closing = false;
  }

  _spawn() {
    this.proc = spawn(this.sfPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', d => this._onData(d));
    this.proc.on('exit', (code) => {
      if (this.closing) return;
      console.error('stockfish exited early (code ' + code + '); restarting');
      this.buf = '';
      this.lastInfo = null;
      this._failAll(new Error('stockfish process exited'));
      this._spawn();
    });
  }

  _failAll(err) {
    if (this.handshake) { clearTimeout(this.handshake.timer); this.handshake.resolve = null; this.handshake = null; }
    if (this.bestmoveWaiter) { clearTimeout(this.bestmoveWaiter.timer); this.bestmoveWaiter.resolve = null; this.bestmoveWaiter = null; }
  }

  _send(cmd) {
    if (this.proc) this.proc.stdin.write(cmd + '\n');
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      this._handleLine(line);
    }
  }

  _handleLine(line) {
    if (this.handshake && this.handshake.match(line)) {
      const h = this.handshake; this.handshake = null;
      clearTimeout(h.timer);
      h.resolve(line);
      return;
    }
    if (line.startsWith('info depth ')) {
      const m = line.match(/info depth (\d+)\b.*?\bscore (cp|mate) (-?\d+).*?\bnodes (\d+)(?:.*?\bnps (\d+))?/);
      if (m) this.lastInfo = { depth: +m[1], kind: m[2], value: +m[3], nodes: +m[4], nps: m[5] ? +m[5] : 0 };
      return;
    }
    if (line.startsWith('bestmove ') && this.bestmoveWaiter) {
      const w = this.bestmoveWaiter; this.bestmoveWaiter = null;
      clearTimeout(w.timer);
      w.resolve(line);
    }
  }

  _armHandshake(match, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handshake = null;
        reject(new Error('stockfish handshake timed out'));
      }, timeoutMs);
      this.handshake = { match, resolve: line => { clearTimeout(timer); resolve(line); }, timer };
    });
  }

  _armBestmove(timeoutMs = 180000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.bestmoveWaiter = null;
        reject(new Error('stockfish search timed out'));
      }, timeoutMs);
      this.bestmoveWaiter = { resolve, timer };
    });
  }

  async init() {
    const wait = this._armHandshake(l => l === 'uciok');
    this._spawn();
    this._send('uci');
    await wait;
    this._send('setoption name Threads value 1');
    this._send('setoption name Hash value 32');
    const ready = this._armHandshake(l => l === 'readyok');
    this._send('isready');
    await ready;
  }

  async evalPosition(fen, depth, nodes) {
    this.lastInfo = null;
    const wait = this._armBestmove();
    this._send('ucinewgame');
    this._send('position fen ' + fen);
    this._send(nodes > 0 ? 'go nodes ' + nodes : 'go depth ' + depth);
    await wait;
    return this.lastInfo;
  }

  close() {
    this.closing = true;
    this._send('quit');
    try { this.proc.stdin.end(); } catch {}
  }
}

(async () => {
  const lines = [];
  const rl = readline.createInterface({ input: fs.createReadStream(opts.in), crlfDelay: Infinity });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    lines.push(s);
    if (lines.length >= opts.limit) break;
  }
  console.log('positions in input:', lines.length);

  const done = new Set();
  if (fs.existsSync(opts.out)) {
    const prev = readline.createInterface({ input: fs.createReadStream(opts.out), crlfDelay: Infinity });
    for await (const l of prev) { const s = l.trim(); if (s) { try { done.add(JSON.parse(s).fen); } catch {} } }
  }
  const todo = lines.filter(l => !done.has(JSON.parse(l).fen));
  console.log('already labeled:', lines.length - todo.length, '| to label:', todo.length);

  const workers = await Promise.all(
    Array.from({ length: opts.jobs }, async () => { const w = new Worker(opts.sf); await w.init(); return w; })
  );
  const out = fs.createWriteStream(opts.out, { flags: 'a' });
  const slices = Array.from({ length: opts.jobs }, () => []);
  todo.forEach((l, i) => slices[i % opts.jobs].push(l));

  let completed = 0, failed = 0;
  const t0 = Date.now();
  await Promise.all(slices.map(async (slice, wi) => {
    const w = workers[wi];
    for (const line of slice) {
      const obj = JSON.parse(line);
      try {
        const info = await w.evalPosition(obj.fen, opts.depth, opts.nodes);
        if (info) {
          const rec = { ...obj,
            ...(info.kind === 'cp' ? { cp: info.value } : { mate: info.value }),
            depth: info.depth, nodes: info.nodes, nps: info.nps };
          out.write(JSON.stringify(rec) + '\n');
        } else failed++;
      } catch (e) {
        failed++;
        if (failed < 5) console.error('label failed:', e.message);
      }
      completed++;
      if (completed % 500 === 0) {
        const rate = completed / ((Date.now() - t0) / 1000);
        console.log(`labeled ${completed}/${todo.length} (${rate.toFixed(1)}/s, eta ${((todo.length - completed) / Math.max(rate, 1e-9) / 60).toFixed(1)} min)`);
      }
    }
  }));
  for (const w of workers) w.close();
  out.end(() => console.log(`done. failed=${failed}`));
})().catch(e => { console.error(e); process.exit(1); });
