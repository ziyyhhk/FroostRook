'use strict';

/*
 * A/B harness for two engine binaries: speed and tactical accuracy, measured
 * side by side so the machine's load affects both.
 *
 *   node test/eval-ab.js .build/base220.exe .build/cur3.exe
 *   node test/eval-ab.js a.exe b.exe --ms 400 --nodes 100000 --reps 3
 *
 * Prints, for each build: depth-12 bench nodes/time/nodes-per-second (median of
 * --reps runs), WAC solved at a fixed node budget (deterministic, load-proof) and
 * WAC solved at a fixed time per move (what actually matters when it plays).
 *
 * For playing strength use the duel mode of test/elo.js:
 *   node test/elo.js --pairs 30 --ms 100 --book false --kiwa B.exe --opp A.exe
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flag = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? +process.argv[i + 1] : def;
};

const A = args[0];
const B = args[1];
if (!A || !B) {
  console.error('usage: node test/eval-ab.js <exe-a> <exe-b> [--reps 3] [--ms 400] [--nodes 100000]');
  process.exit(2);
}
for (const exe of [A, B]) if (!fs.existsSync(exe)) { console.error('no such binary: ' + exe); process.exit(1); }

const REPS = Math.max(1, flag('reps', 3));
const MS = Math.max(50, flag('ms', 400));
const NODES = Math.max(1000, flag('nodes', 100000));

function bench(exe) {
  const rows = [];
  for (let i = 0; i < REPS; i++) {
    const out = execFileSync(exe, ['bench'], { encoding: 'utf8' }).trim().split('\n').pop();
    const nodes = +(out.match(/nodes (\d+)/) || [])[1];
    const time = +(out.match(/time (\d+)ms/) || [])[1];
    const nps = +(out.match(/nps (\d+)/) || [])[1];
    rows.push({ nodes, time, nps });
  }
  const med = key => rows.map(r => r[key]).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  return { nodes: med('nodes'), time: med('time'), nps: med('nps'), runs: rows };
}

function wac(exe, mode, budget) {
  const arg = mode === 'nodes' ? `nodes=${budget}` : String(budget);
  const out = execFileSync(process.execPath, [path.join(ROOT, 'test', 'wac-native.js'), arg, '300'], {
    encoding: 'utf8',
    env: { ...process.env, KIWA_NATIVE: path.resolve(exe) },
    maxBuffer: 64 * 1024 * 1024,
  });
  const m = out.match(/WAC native @ .*?: (\d+)\/(\d+)/);
  if (!m) throw new Error('WAC run produced no summary:\n' + out.slice(-400));
  return { solved: +m[1], total: +m[2] };
}

function line(name, b, wn, wt) {
  console.log(`${name.padEnd(12)} bench: ${String(b.nodes).padStart(7)} nodes in ${String(b.time).padStart(5)} ms ` +
              `= ${Math.round(b.nps).toLocaleString()} n/s   |   ` +
              `WAC @${NODES} nodes: ${wn.solved}/${wn.total} (${(100 * wn.solved / wn.total).toFixed(1)}%)   ` +
              `WAC @${MS} ms: ${wt.solved}/${wt.total} (${(100 * wt.solved / wt.total).toFixed(1)}%)`);
}

console.log(`A/B measurement on this machine (${REPS} bench repeats, WAC 300 positions)`);
console.log('WAC at a fixed node budget is load-proof; WAC at a fixed time shows what the speed costs or buys.\n');

const ba = bench(A), bb = bench(B);
const wa = { nodes: wac(A, 'nodes', NODES), ms: wac(A, 'ms', MS) };
const wb = { nodes: wac(B, 'nodes', NODES), ms: wac(B, 'ms', MS) };

line('A ' + path.basename(A), ba, wa.nodes, wa.ms);
line('B ' + path.basename(B), bb, wb.nodes, wb.ms);

const dNps = (100 * (bb.nps - ba.nps) / ba.nps).toFixed(1);
console.log(`\nB vs A: nodes/s ${dNps > 0 ? '+' : ''}${dNps}%, ` +
            `WAC @${NODES} nodes ${wb.nodes.solved - wa.nodes.solved > 0 ? '+' : ''}${wb.nodes.solved - wa.nodes.solved}, ` +
            `WAC @${MS} ms ${wb.ms.solved - wa.ms.solved > 0 ? '+' : ''}${wb.ms.solved - wa.ms.solved} positions`);
console.log('WAC differences of a few positions are inside run-to-run noise; use the Elo duel for strength.');
