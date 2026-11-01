'use strict';

/*
 * Benchmarks: speed, tactical sanity, and matches against baseline bots.
 * Usage: node test/bench.js [speed|match|all]
 */

const engine = require('../engine.js');
engine.setInfoHandler(() => {});

const START = engine.START_FEN;

function speed() {
  console.log('\n=== speed ===');
  engine.setFen(START);
  engine.clearTT();
  const r = engine.search({ depth: 12 });
  console.log(`depth ${r.depth}  score ${r.score}  nodes ${r.nodes}  time ${r.time}ms  nps ${Math.round(r.nodes * 1000 / Math.max(1, r.time))}`);
  console.log(`best ${r.bestMoveStr}  pv ${r.pv.join(' ')}`);
}

function mates() {
  console.log('\n=== forced mates ===');
  const tests = [
    ['6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', 'a1a8', 1],
    ['r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 0 1', 'f3f7', 1],
    ['6k1/5ppp/8/8/8/8/5PPP/1R4K1 w - - 0 1', 'b1b8', 1],
    ['7k/6pp/8/8/8/8/5PPP/R5K1 w - - 0 1', 'a1a8', 1],
  ];
  let pass = 0;
  for (const [fen, want, mateIn] of tests) {
    engine.setFen(fen);
    const r = engine.search({ movetime: 1000 });
    const ok = r.bestMoveStr === want && r.score > 30000;
    if (ok) pass++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${want}  got ${r.bestMoveStr}  score ${r.score}`);
  }
  return `${pass}/${tests.length}`;
}

function playGame(engineSide, opponent, ms) {
  engine.setFen(START);
  engine.clearTT();

  for (let ply = 0; ply < 300; ply++) {
    const legal = engine.getLegalMoves();
    if (legal.length === 0) {
      if (engine.inCheck()) {
        return engine.side === engineSide ? 0 : 1;
      }
      return 0.5;
    }
    if (engine.halfmove >= 100) return 0.5;

    if (engine.side === engineSide) {
      const r = engine.search({ movetime: ms });
      if (!r.bestMoveStr || r.bestMoveStr === '0000') return 0;
      engine.applyUciMove(r.bestMoveStr);
    } else {
      const mv = opponent === 'random' ? engine.randomMove() : engine.greedyMove();
      if (!mv) return 0.5;
      engine.applyMoveInt(mv);
    }
  }
  return 0.5;
}

function match(opponent, games, ms) {
  console.log(`\n=== FroostRook ${ms}ms/move vs ${opponent} (${games} games) ===`);
  let score = 0;
  let wins = 0, draws = 0, losses = 0;
  for (let i = 0; i < games; i++) {
    const engineSide = i % 2 === 0 ? engine.WHITE : engine.BLACK;
    const res = playGame(engineSide, opponent, ms);
    score += res;
    if (res === 1) wins++;
    else if (res === 0.5) draws++;
    else losses++;
    console.log(`game ${i + 1}: ${res === 1 ? 'win' : res === 0.5 ? 'draw' : 'loss'}`);
  }
  console.log(`score ${score}/${games}  (+${wins} =${draws} -${losses})`);
  return { score, wins, draws, losses };
}

const mode = process.argv[2] || 'all';

if (mode === 'speed' || mode === 'all') speed();
if (mode === 'match' || mode === 'all') {
  const m = mates();
  console.log(`mate suite: ${m}`);
  match('random', 6, 50);
  match('greedy', 6, 100);
}
