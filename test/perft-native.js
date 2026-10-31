'use strict';

/*
 * Verifies the native engine's move generation against the standard perft suite.
 *   node test/perft-native.js
 */

const { spawn } = require('child_process');
const path = require('path');

const EXE = process.env.KIWA_NATIVE || path.join(__dirname, '..', 'native', 'kiwa-native.exe');

const CASES = [
  ['startpos', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197281, 4865609]],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862, 4085603]],
  ['position 3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238, 674624]],
  ['position 4', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467, 422333]],
  ['position 5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379, 2103487]],
  ['position 6', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890, 3894594]],
  ['en passant', 'rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 3', [30, 865, 25743, 750449]],
  ['castling rights', 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', [26, 568, 13744, 314346]],
  ['underpromotion', '8/P7/8/8/8/8/8/k6K w - - 0 1', [7, 19, 212, 1099, 16036]],
];

const proc = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const waits = [];

proc.stdout.on('data', d => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    const w = waits[0];
    if (w && line.startsWith(w.prefix)) {
      waits.shift();
      w.resolve(line);
    }
  }
});

function ask(cmd, prefix) {
  return new Promise(resolve => {
    waits.push({ prefix, resolve });
    proc.stdin.write(cmd + '\n');
  });
}

(async () => {
  let failures = 0;
  for (const [name, fen, expected] of CASES) {
    proc.stdin.write(`position fen ${fen}\n`);
    for (let d = 1; d <= expected.length; d++) {
      const line = await ask(`perft ${d}`, 'perft ');
      const got = +line.split(/\s+/)[2];
      const ok = got === expected[d - 1];
      if (!ok) failures++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} d${d}: ${got}${ok ? '' : ' (want ' + expected[d - 1] + ')'}`);
    }
  }
  console.log(failures === 0 ? '\nall native perft tests passed' : `\n${failures} failures`);
  proc.stdin.write('quit\n');
  proc.on('exit', () => process.exit(failures === 0 ? 0 : 1));
})();
