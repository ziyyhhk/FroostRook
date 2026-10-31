'use strict';

/*
 * UCI front-end for Kiwa.
 * Usage: node uci.js
 *
 * Extra commands (not standard UCI):
 *   predict [depth N] [movetime MS]  -> ranked human-move predictions
 *   eval                             -> static evaluation
 *   d                                -> print board
 */

const readline = require('readline');
const engine = require('./engine.js');
const book = require('./book.js');
const native = require('./native.js');

engine.setInfoHandler(line => process.stdout.write(line + '\n'));

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

// Full position command kept in sync so the native core can replay the same
// move history. Without it the native search cannot see repetitions or the
// 50-move rule — a FEN alone carries neither.
let posBase = 'startpos';
let posMoves = [];

// Fallback-only book settings. When the native core is present it owns the
// book and these are simply forwarded to it.
let ownBook = true;
let bookDepth = 24;   // plies
let bookVariety = 100;

function handlePosition(tokens) {
  let i = 1;
  if (tokens[i] === 'startpos') {
    engine.setFen(engine.START_FEN);
    posBase = 'startpos';
    posMoves = [];
    i++;
  } else if (tokens[i] === 'fen') {
    const fen = tokens.slice(i + 1, i + 7).join(' ');
    engine.setFen(fen);
    posBase = 'fen ' + fen;
    posMoves = [];
    i += 7;
  } else {
    return;
  }
  if (tokens[i] === 'moves') {
    for (let j = i + 1; j < tokens.length; j++) {
      if (engine.applyUciMove(tokens[j])) {
        posMoves.push(tokens[j]);
      } else {
        process.stderr.write(`illegal move ignored: ${tokens[j]}\n`);
      }
    }
  }
}

function positionCommand() {
  return posBase + (posMoves.length ? ' moves ' + posMoves.join(' ') : '');
}

function handleSetOption(tokens) {
  const rest = tokens.slice(1).join(' ');
  const m = rest.match(/^name\s+(.+?)(?:\s+value\s+(.+))?$/i);
  if (!m) return;
  const name = m[1].trim();
  const value = m[2] ? m[2].trim() : '';
  const key = name.toLowerCase();
  if (key === 'clear hash') engine.clearTT();
  else if (key === 'ownbook') ownBook = !/^(false|0|off|no)$/i.test(value);
  else if (key === 'book depth') bookDepth = Math.max(0, Math.min(60, +value || 0));
  else if (key === 'book variety') bookVariety = Math.max(0, Math.min(100, +value || 0));
  if (native.available()) native.setOption(name, value);
}

function handleGo(tokens) {
  const opts = {};
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t) {
      case 'wtime': opts.wtime = +tokens[++i]; break;
      case 'btime': opts.btime = +tokens[++i]; break;
      case 'winc': opts.winc = +tokens[++i]; break;
      case 'binc': opts.binc = +tokens[++i]; break;
      case 'movestogo': opts.movestogo = +tokens[++i]; break;
      case 'depth': opts.depth = +tokens[++i]; break;
      case 'nodes': opts.nodes = +tokens[++i]; break;
      case 'movetime': opts.movetime = +tokens[++i]; break;
      case 'infinite': opts.infinite = true; break;
      default: break;
    }
  }

  // Opening book: instant replies for the first moves. When the native core
  // is present it owns the book (OwnBook / Book Depth / Book Variety are
  // forwarded to it), so the same move is not selected twice. The JS path
  // below only runs as a fallback. Analysis searches never use the book.
  const fen = engine.getFen();
  const bookEligible =
    !native.available() && ownBook && bookDepth > 0 && posBase === 'startpos' &&
    posMoves.length < bookDepth && !opts.infinite && !opts.depth && !opts.nodes;
  if (bookEligible) {
    const bookMove = book.pick(fen, bookVariety);
    if (bookMove && engine.getLegalMoves().some(m => engine.moveToStr(m) === bookMove)) {
      process.stdout.write(`info depth 1 score cp 20 nodes 1 time 0 pv ${bookMove}\n`);
      process.stdout.write(`bestmove ${bookMove}\n`);
      return;
    }
  }

  // Native core when available; JS search otherwise (also if the exe dies).
  if (native.available()) {
    native
      .search(positionCommand(), opts, line => process.stdout.write(line + '\n'))
      .then(r => {
        if (r) { process.stdout.write(`bestmove ${r.bestMoveStr}\n`); return; }
        const fallback = engine.search(opts);
        process.stdout.write(`bestmove ${fallback.bestMoveStr}\n`);
      });
    return;
  }

  const r = engine.search(opts);
  process.stdout.write(`bestmove ${r.bestMoveStr}\n`);
}

function handlePredict(tokens) {
  const opts = {};
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === 'depth') opts.depth = +tokens[++i];
    else if (tokens[i] === 'movetime') opts.movetime = +tokens[++i];
  }
  const r = engine.predict(opts);
  r.moves.forEach((m, i) => {
    process.stdout.write(
      `prediction rank ${i + 1} move ${m.move} prob ${m.prob.toFixed(4)} score ${m.score}\n`
    );
  });
  process.stdout.write(
    `info string predicted ${r.best} with ${(r.confidence * 100).toFixed(1)}% confidence (depth ${r.depth}, ${r.time}ms)\n`
  );
}

rl.on('line', line => {
  const tokens = line.trim().split(/\s+/);
  const cmd = tokens[0];
  if (!cmd) return;

  switch (cmd) {
    case 'uci':
      process.stdout.write('id name KiwaChess 2.2.0\n');
      process.stdout.write('id author Kiwa\n');
      process.stdout.write(`id string core ${native.available() ? 'C++ native' : 'JavaScript (fallback)'}\n`);
      process.stdout.write('option name Threads type spin default 1 min 1 max 8\n');
      process.stdout.write('option name Hash type spin default 64 min 1 max 512\n');
      process.stdout.write('option name OwnBook type check default true\n');
      process.stdout.write('option name Book Depth type spin default 24 min 0 max 60\n');
      process.stdout.write('option name Book Variety type spin default 100 min 0 max 100\n');
      process.stdout.write('option name Move Overhead type spin default 30 min 0 max 1000\n');
      process.stdout.write('option name Clear Hash type button\n');
      process.stdout.write('uciok\n');
      break;
    case 'setoption':
      handleSetOption(tokens);
      break;
    case 'isready':
      process.stdout.write('readyok\n');
      break;
    case 'ucinewgame':
      engine.clearTT();
      posBase = 'startpos';
      posMoves = [];
      native.newGame();
      break;
    case 'position':
      handlePosition(tokens);
      break;
    case 'go':
      handleGo(tokens);
      break;
    case 'stop':
      native.stop();
      break;
    case 'predict':
      handlePredict(tokens);
      break;
    case 'eval':
      process.stdout.write(`info string eval ${engine.evaluate()} cp\n`);
      break;
    case 'd':
      process.stdout.write(engine.boardAscii() + '\n');
      break;
    case 'quit':
      native.quit();
      process.exit(0);
      break;
    default:
      break;
  }
});
