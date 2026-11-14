'use strict';

/*
 * Terminal play mode with move prediction.
 *   node play.js            -> you are White
 *   node play.js black      -> you are Black
 *
 * Commands: e2e4 (UCI move), hint, predict, moves, undo, new, depth N, quit
 */

const readline = require('readline');
const engine = require('./engine.js');
const book = require('./book.js');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
engine.setInfoHandler(() => {});

const WHITE = engine.WHITE;
const BLACK = engine.BLACK;

let humanColor = process.argv[2] === 'black' ? BLACK : WHITE;
let searchMs = 1000;
let predictDepth = 5;
let history = [];

function ask(q) {
  return new Promise(resolve => rl.question(q, resolve));
}

function rebuild() {
  engine.setFen(engine.START_FEN);
  for (const m of history) engine.applyUciMove(m);
}

function render() {
  const b = engine.boardAscii();
  const turn = engine.side === WHITE ? 'White' : 'Black';
  console.log('\n' + b);
  console.log(`${turn} to move${engine.inCheck() ? ' (in check)' : ''}   eval ${engine.evaluate()} cp`);
}

function gameOver() {
  const legal = engine.getLegalMoves();
  if (legal.length === 0) {
    if (engine.inCheck()) {
      const loser = engine.side === WHITE ? 'White' : 'Black';
      console.log(`\nCheckmate. ${loser} loses.`);
    } else {
      console.log('\nStalemate. Draw.');
    }
    return true;
  }
  if (engine.halfmove >= 100) {
    console.log('\nDraw by fifty-move rule.');
    return true;
  }
  return false;
}

function showPrediction() {
  const r = engine.predict({ depth: predictDepth, movetime: 2500 });
  console.log(`\nLikely replies for ${engine.side === WHITE ? 'White' : 'Black'}:`);
  r.moves.slice(0, 3).forEach((m, i) => {
    console.log(`  ${i + 1}. ${m.move}  ${(m.prob * 100).toFixed(1)}%   (eval ${(m.score / 100).toFixed(2)})`);
  });
  console.log(`  predicted: ${r.best} (${(r.confidence * 100).toFixed(1)}% confidence)`);
}

function engineTurn() {
  // Opening book first, so the engine does not open with an offbeat move.
  const candidate = history.length < 24 ? book.pick(engine.getFen()) : null;
  const bookMove = candidate && engine.getLegalMoves().some(m => engine.moveToStr(m) === candidate)
    ? candidate
    : null;
  if (bookMove) {
    console.log(`\nEngine plays ${bookMove}  (book)`);
    engine.applyUciMove(bookMove);
    history.push(bookMove);
    return;
  }

  const r = engine.search({ movetime: searchMs });
  if (!r.bestMoveStr || r.bestMoveStr === '0000') {
    console.log('Engine has no legal move.');
    return;
  }
  console.log(`\nEngine plays ${r.bestMoveStr}  (depth ${r.depth}, ${r.score} cp)`);
  engine.applyUciMove(r.bestMoveStr);
  history.push(r.bestMoveStr);
}

async function main() {
  console.log('FroostRook 1.0.5 Beta — chess engine with human-move prediction');
  console.log(`You are ${humanColor === WHITE ? 'White' : 'Black'}. Engine: ${searchMs}ms/move.`);
  console.log('Type UCI moves (e.g. e2e4, e7e8q). Commands: hint, predict, moves, undo, new, depth N, quit.\n');

  rebuild();
  render();

  if (engine.side !== humanColor) {
    engineTurn();
    render();
    if (gameOver()) { rl.close(); return; }
    showPrediction();
  }

  while (true) {
    const input = (await ask('\n> ')).trim();
    if (!input) continue;

    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === 'quit' || cmd === 'exit') break;

    if (cmd === 'new') {
      history = [];
      rebuild();
      console.log('\nNew game.');
      render();
      if (engine.side !== humanColor) {
        engineTurn();
        render();
        if (gameOver()) break;
        showPrediction();
      }
      continue;
    }

    if (cmd === 'undo') {
      if (history.length < 2) { console.log('Nothing to undo.'); continue; }
      history.pop();
      history.pop();
      rebuild();
      render();
      continue;
    }

    if (cmd === 'depth') {
      const n = parseInt(parts[1], 10);
      if (n >= 1 && n <= 30) {
        searchMs = n * 150;
        console.log(`Engine thinks ~${searchMs}ms/move.`);
      }
      continue;
    }

    if (cmd === 'moves') {
      const legal = engine.getLegalMoves().map(m => engine.moveToStr(m));
      console.log(legal.join(' '));
      continue;
    }

    if (cmd === 'hint') {
      const r = engine.search({ movetime: 800 });
      console.log(`Engine suggestion: ${r.bestMoveStr} (${r.score} cp)`);
      continue;
    }

    if (cmd === 'predict') {
      showPrediction();
      continue;
    }

    if (engine.side !== humanColor) {
      console.log('Not your turn.');
      continue;
    }

    if (!engine.applyUciMove(cmd)) {
      console.log('Illegal move. Type "moves" to see legal moves.');
      continue;
    }
    history.push(cmd);
    render();

    if (gameOver()) break;

    engineTurn();
    render();

    if (gameOver()) break;

    showPrediction();
  }

  rl.close();
  console.log('Game over.');
}

main();
