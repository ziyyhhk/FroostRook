'use strict';

/*
 * Threads scaling benchmark for the native UCI engine.
 *
 *   node test/thread-bench.js            # default thread list: 1 2 4 8
 *   node test/thread-bench.js 1,2,4      # or space separated: 1 2 4
 *   KIWA_NATIVE=/tmp/kiwa-book.exe node test/thread-bench.js
 *
 * Every run uses a fresh engine process, so the transposition table is always
 * empty; "Clear Hash" is also sent explicitly. "Threads" is set immediately
 * before "go". Three workloads are measured, each repeated three times:
 *
 *   depth14        fixed depth 14 from startpos
 *   nodes-tactical fixed 300000 node budget, Italian middlegame
 *   nodes-open     fixed 300000 node budget, open centre with queens
 *
 * Wall time is measured from sending "go" to reading "bestmove". "Nodes" is
 * what the engine reports for the search whose move it returned (the other
 * helper threads' nodes are not included), so the aggregate work of an
 * N-thread run is roughly N times that number.
 *
 * Exits non-zero if a search fails, times out, crashes the engine, returns an
 * empty move, or returns a move that the JavaScript rules core rejects.
 *
 * Env: KIWA_NATIVE (engine exe), KIWA_BENCH_REPS (default 3),
 *      KIWA_BENCH_TIMEOUT (ms per search, default 120000),
 *      KIWA_BENCH_HASH (default 64).
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const rules = require('../engine.js');

const EXE = process.env.KIWA_NATIVE || path.join(__dirname, '..', 'native', 'kiwa-native.exe');
const REPS = Math.max(1, parseInt(process.env.KIWA_BENCH_REPS, 10) || 3);
const TIMEOUT = Math.max(1000, parseInt(process.env.KIWA_BENCH_TIMEOUT, 10) || 120000);
const HASH_MB = Math.max(1, parseInt(process.env.KIWA_BENCH_HASH, 10) || 64);

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const TACTICAL_FEN = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 6';
// Open centre (d/e pawns traded), all pieces developed, queens off.
const OPEN_FEN = 'r4rk1/ppp2ppp/2n2n2/8/8/2N2N2/PPP2PPP/R4RK1 w - - 0 12';

const WORKLOADS = [
  { id: 'depth14', name: 'A depth 14 startpos', fen: START_FEN, go: 'depth 14' },
  { id: 'nodes-tactical', name: 'B 300k nodes tactical', fen: TACTICAL_FEN, go: 'nodes 300000' },
  { id: 'nodes-open', name: 'B 300k nodes open', fen: OPEN_FEN, go: 'nodes 300000' },
];

function parseThreads(argv) {
  const raw = argv.join(' ').split(/[\s,]+/).filter(Boolean);
  const list = raw.map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n >= 1 && n <= 8);
  return list.length ? [...new Set(list)] : [1, 2, 4, 8];
}

function legalMoves(fen) {
  rules.setFen(fen);
  return new Set(rules.getLegalMoves().map(m => rules.moveToStr(m)));
}

const INFO_RE = /^info depth (\d+) score (cp|mate) (-?\d+) nodes (\d+)(?: nps (\d+))? time (\d+)(?: pv (.*))?$/;
const MOVE_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/**
 * One search in a fresh process (empty TT). Resolves { ok, ... }, never rejects.
 * Wall time covers "go" -> "bestmove" only, so process startup is excluded;
 * Threads is written immediately before "go".
 */
function runOnce(exe, threads, wl) {
  return new Promise(resolve => {
    const proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    let last = null;
    let goAt = 0;
    let done = false;
    let timer = null;

    const finish = res => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* already gone */ }
      if (!res.ok) resolve(res);
      else resolve(Object.assign({ wallMs: Number(process.hrtime.bigint() - goAt) / 1e6 }, res));
    };

    timer = setTimeout(() => finish({ ok: false, error: 'timeout after ' + TIMEOUT + 'ms' }), TIMEOUT);

    proc.on('error', e => finish({ ok: false, error: 'spawn failed: ' + e.message }));
    proc.on('exit', code => {
      if (!done) finish({ ok: false, error: 'engine exited early (code ' + code + ')' + (err ? ' stderr: ' + err.trim() : '') });
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', d => { err += d; });

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.startsWith('bestmove')) {
          const mv = line.split(/\s+/)[1] || '';
          const info = last || {};
          finish({
            ok: true,
            bestmove: mv,
            nodes: info.nodes || 0,
            engineTime: info.time || 0,
            engineNps: info.nps || 0,
            depth: info.depth || 0,
            score: info.score || '',
          });
        } else if (line.startsWith('info ')) {
          const m = line.match(INFO_RE);
          if (m) last = { depth: +m[1], score: m[2] + ' ' + m[3], nodes: +m[4], nps: m[5] ? +m[5] : 0, time: +m[6] };
        } else if (line === 'uciok') {
          proc.stdin.write([
            'setoption name OwnBook value false',
            'setoption name Hash value ' + HASH_MB,
            'setoption name Clear Hash',
            'position ' + (wl.fen === START_FEN ? 'startpos' : 'fen ' + wl.fen),
            'isready',
          ].join('\n') + '\n');
        } else if (line === 'readyok') {
          goAt = process.hrtime.bigint();
          proc.stdin.write('setoption name Threads value ' + threads + '\ngo ' + wl.go + '\n');
        }
      }
    });

    proc.stdin.write('uci\n');
  });
}

const median = xs => {
  const s = xs.slice().sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const fmt = (x, d = 0) => x.toFixed(d);

async function main() {
  const threadList = parseThreads(process.argv.slice(2));
  if (!fs.existsSync(EXE)) {
    console.error('engine not found: ' + EXE);
    process.exit(2);
  }

  console.log('thread-bench: ' + EXE);
  console.log(`reps=${REPS} hash=${HASH_MB}MB timeout=${TIMEOUT}ms threads=${threadList.join(',')}`);
  console.log('');

  const failures = [];
  const results = new Map(); // workload id -> Map(threads -> {runs, bestmoves})

  for (const wl of WORKLOADS) {
    const perThread = new Map(threadList.map(t => [t, []]));
    const legal = legalMoves(wl.fen);

    // Repetitions are interleaved across thread counts so that thermal drift
    // and background load hit every configuration roughly equally.
    for (let r = 0; r < REPS; r++) {
      for (const threads of threadList) {
        const res = await runOnce(EXE, threads, wl);
        const tag = `${wl.id} T=${threads} rep ${r + 1}`;
        if (!res.ok) { failures.push(`${tag}: ${res.error}`); continue; }
        if (!res.bestmove || res.bestmove === '0000') { failures.push(`${tag}: empty bestmove`); continue; }
        if (!MOVE_RE.test(res.bestmove) || !legal.has(res.bestmove)) {
          failures.push(`${tag}: illegal move "${res.bestmove}"`);
          continue;
        }
        perThread.get(threads).push(res);
      }
    }
    results.set(wl.id, { wl, perThread });
  }

  // --- report --------------------------------------------------------------
  for (const { wl, perThread } of results.values()) {
    console.log(wl.name + '  [' + wl.go + ']  fen: ' + wl.fen);
    console.log('  T  runs  median_ms  min..max      median_nodes  Mnps  total_Mnps  vs_T1  depth  bestmove');
    const base = perThread.has(1) && perThread.get(1).length
      ? median(perThread.get(1).map(r => r.wallMs))
      : Math.min(...threadList.filter(t => perThread.get(t).length).map(t => median(perThread.get(t).map(r => r.wallMs))));
    for (const threads of threadList) {
      const runs = perThread.get(threads);
      if (!runs.length) { console.log(`  ${threads}  FAILED`); continue; }
      const ms = median(runs.map(r => r.wallMs));
      const nodes = median(runs.map(r => r.nodes));
      const nps = median(runs.map(r => (r.nodes * 1000) / r.wallMs));
      const depth = median(runs.map(r => r.depth));
      const mv = [...new Set(runs.map(r => r.bestmove))].join('/');
      const sp = base / ms;
      const lo = Math.min(...runs.map(r => r.wallMs)), hi = Math.max(...runs.map(r => r.wallMs));
      console.log(
        '  ' + String(threads).padEnd(2) + '  ' + String(runs.length).padEnd(4) + '  ' +
        String(fmt(ms)).padStart(10) + '  ' + (fmt(lo) + '..' + fmt(hi)).padEnd(13) + '  ' +
        String(fmt(nodes)).padStart(12) + '  ' +
        fmt(nps / 1e6, 2).padStart(4) + '  ' + fmt((threads * nodes * 1000) / ms / 1e6, 2).padStart(10) + '  ' +
        (sp.toFixed(2) + 'x').padStart(6) + '  ' + String(depth).padStart(5) + '  ' + mv
      );
    }
    const distinct = new Set();
    for (const runs of perThread.values()) for (const r of runs) distinct.add(r.bestmove);
    if (distinct.size > 1) {
      const byThread = [...perThread.entries()].map(([t, rs]) => `${t}T=${[...new Set(rs.map(r => r.bestmove))].join('/')}`);
      console.log('  bestmove differs by thread count: ' + byThread.join('  '));
    } else {
      console.log('  bestmove identical for all thread counts and runs: ' + [...distinct][0]);
    }
    console.log('');
  }

  console.log('columns: Mnps = returned search nodes / wall; total_Mnps = T * nodes / wall,');
  console.log('an estimate of aggregate engine throughput (each helper repeats the full search).');
  console.log('');

  if (failures.length) {
    console.error('FAILURES (' + failures.length + '):');
    for (const f of failures) console.error('  ' + f);
    process.exitCode = 1;
  } else {
    console.log('all searches completed with legal, non-empty moves; no crashes or hangs');
  }
}

main().catch(e => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
