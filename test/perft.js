'use strict';

/* Standard perft suite — verifies move generation against known node counts. */

const engine = require('../engine.js');
engine.setInfoHandler(() => {});

const CASES = [
  ['startpos', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197281, 4865609]],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862, 4085603]],
  ['position 3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238, 674624]],
  ['position 4', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467, 422333]],
  ['position 5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379, 2103487]],
  ['position 6', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890, 3894594]],
];

let failures = 0;
for (const [name, fen, expected] of CASES) {
  engine.setFen(fen);
  expected.forEach((want, i) => {
    const got = engine.perft(i + 1);
    const ok = got === want;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} d${i + 1}: ${got}${ok ? '' : ' (want ' + want + ')'}`);
  });
}
console.log(failures === 0 ? '\nall perft tests passed' : `\n${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
