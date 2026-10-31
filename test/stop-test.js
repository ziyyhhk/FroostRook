// Verifies that the native engine answers `stop` and `quit` in every
// threading mode, and that a normal timed search still terminates.
const { spawn } = require('child_process');
const path = require('path');

const EXE = path.join(__dirname, '..', 'native', 'kiwa-native.exe');

function run({ threads, goCmd, stopAfter, label }) {
  return new Promise((resolve) => {
    const p = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const t0 = Date.now();

    const finish = (verdict, extra) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { p.kill(); } catch {}
      resolve({ label, verdict, ms: Date.now() - t0, extra, out: out.slice(-400), err: err.slice(-400) });
    };

    p.stdout.on('data', (d) => {
      out += d.toString();
      if (/^bestmove /m.test(out)) finish('bestmove', RegExp.lastMatch || '');
    });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => finish('spawn-error', e.message));

    const send = (s) => { p.stdin.write(s + '\n'); };

    send('uci');
    send('setoption name Threads value ' + threads);
    send('setoption name OwnBook value false');
    send('position startpos');
    send('isready');

    setTimeout(() => send(goCmd), 100);
    if (stopAfter) {
      setTimeout(() => send('stop'), 100 + stopAfter);
    }

    const timer = setTimeout(() => {
      // Give the process a chance to answer `quit`; if that also fails it is a real hang.
      send('quit');
      setTimeout(() => finish('TIMEOUT (no bestmove, quit also stuck)'), 3000);
    }, 12000);
  });
}

(async () => {
  const cases = [];
  for (const threads of [1, 2, 4]) {
    cases.push(run({ threads, goCmd: 'go infinite', stopAfter: 1200, label: `threads=${threads} go infinite + stop@1.2s` }));
  }
  for (const threads of [1, 2, 4]) {
    cases.push(run({ threads, goCmd: 'go movetime 5000', stopAfter: 800, label: `threads=${threads} go movetime 5000 + stop@0.8s` }));
  }
  cases.push(run({ threads: 4, goCmd: 'go movetime 400', stopAfter: 0, label: 'threads=4 go movetime 400 (natural finish)' }));

  for (const r of await Promise.all(cases)) {
    console.log(`${r.verdict.padEnd(12)} ${String(r.ms).padStart(6)}ms  ${r.label}`);
    if (r.verdict !== 'bestmove') {
      if (r.out) console.log('  stdout tail:', JSON.stringify(r.out));
      if (r.err) console.log('  stderr tail:', JSON.stringify(r.err));
    }
  }
})();
