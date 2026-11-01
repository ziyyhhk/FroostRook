'use strict';

/*
 * Strength measurement with two modes.
 *
 * 1. Anchored (default): Kiwa vs Stockfish at `UCI_LimitStrength` /
 *    `UCI_Elo <anchor>`. Both engines get the same fixed movetime.
 *      node test/elo.js --anchor 2000 --ms 100 --pairs 5
 *                         [--stockfish <path>] [--pgn <file>] [--kiwa <exe>]
 *
 * 2. Duel: two engine binaries against each other, used to measure an
 *    old-vs-new difference under identical conditions.
 *      node test/elo.js --pairs 50 --ms 100 --book false \
 *                         --kiwa /tmp/kiwa-new.exe --opp /tmp/kiwa-old.exe
 *
 * Each opening is played twice with the colours swapped, so the result is a
 * paired sample. Performance Elo = anchor + 400*log10(score/(1-score)); the
 * difference between two engines is 400*log10(p/(1-p)). The 1-sigma error is
 * 173.7 / sqrt(n * p * (1-p)) and covers sampling noise only. Stockfish's own
 * UCI_Elo calibration is a separate, dominant unknown, so an anchored number
 * means "roughly this strong on this scale", not a CCRL rating.
 *
 * Openings are reused in cycles when --pairs exceeds the built-in list; the
 * colour swap stays per pair, so the sample stays paired.
 *
 * Adjudication is deliberately boring: checkmate, stalemate, threefold,
 * 50-move rule, dead-material draw, or a 300-ply cap (draw).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const engine = require('../engine.js');

engine.setInfoHandler(() => {});

const OPENINGS = [
  ['e2e4', 'e7e5'],
  ['d2d4', 'd7d5', 'c2c4'],
  ['e2e4', 'c7c5'],
  ['d2d4', 'g8f6', 'c2c4', 'g7g6'],
  ['e2e4', 'e7e6'],
  ['e2e4', 'c7c6'],
  ['c2c4', 'e7e5'],
  ['d2d4', 'g8f6', 'c2c4', 'e7e6'],
  ['g1f3', 'd7d5'],
  ['d2d4', 'f7f5'],
  ['e2e4', 'd7d5'],
  ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'],
];

const MAX_PLIES = 300;
const SEARCH_TIMEOUT_MS = 20000;

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

const ANCHOR = Math.max(1320, Math.min(3190, +(arg('anchor', 2000))));
const MS = Math.max(10, +(arg('ms', 100)));
const PAIRS = Math.max(1, Math.min(120, +(arg('pairs', 5))));
const SF_EXE = arg('stockfish', process.env.STOCKFISH || 'stockfish');
const PGN_FILE = arg('pgn', null);
const KIWA_EXE = arg('kiwa', require('../native-exe'));
// --opp makes this a duel between two binaries instead of an anchored match.
const OPP_EXE = arg('opp', process.env.OPP_NATIVE || null);
const DUEL = !!OPP_EXE;
// Books hide search differences. Default a duel to no books; an anchored
// measurement keeps the book because that is how the engine actually plays.
const USE_BOOK = !/^(false|0|off|no)$/i.test(arg('book', DUEL ? 'false' : 'true'));

class UciEngine {
  constructor(label, exe) {
    this.label = label;
    this.exe = exe;
    this.proc = null;
    this.buf = '';
    this.name = label;
    this.lineWaiters = [];
    this.searchWaiters = [];
    this.lastInfo = null;
    this.closing = false;
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdin.setDefaultEncoding('utf8');
    this.proc.stdout.on('data', d => this._onData(d));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', d => {
      const s = d.trim();
      if (s && /error|crash|exception/i.test(s)) process.stderr.write(`[${this.label}] ${s}\n`);
    });
    this.proc.on('error', err => this._fail(err));
    this.proc.on('exit', code => {
      if (!this.closing) this._fail(new Error(`${this.label} exited abruptly (code ${code})`));
    });
  }

  _fail(err) {
    this.proc = null;
    const lw = this.lineWaiters.splice(0);
    for (const w of lw) { clearTimeout(w.timer); w.reject(err); }
    const sw = this.searchWaiters.splice(0);
    for (const w of sw) { clearTimeout(w.timer); w.reject(err); }
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      this._onLine(line);
    }
  }

  _onLine(line) {
    if (line.startsWith('id name ')) this.name = line.slice(8).trim();
    if (line.startsWith('info depth ')) {
      const d = line.match(/info depth (\d+)/);
      const n = line.match(/nodes (\d+)/);
      // Keep the deepest reported iteration; that is the one the bestmove
      // comes from. No claim about the engine internals beyond what it sent.
      if (d) {
        const depth = +d[1];
        if (!this.lastInfo || depth >= this.lastInfo.depth) {
          this.lastInfo = { depth, nodes: n ? +n[1] : 0 };
        }
      }
    }
    if (line.startsWith('bestmove')) {
      const w = this.searchWaiters.shift();
      if (w) {
        clearTimeout(w.timer);
        w.resolve(line.split(/\s+/)[1] || '0000');
      }
      return;
    }
    for (let i = 0; i < this.lineWaiters.length; i++) {
      if (this.lineWaiters[i].match(line)) {
        const w = this.lineWaiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(line);
        break;
      }
    }
  }

  send(cmd) {
    if (!this.proc) this.start();
    this.proc.stdin.write(cmd + '\n');
  }

  waitLine(match, ms, what) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.lineWaiters.findIndex(w => w.timer === timer);
        if (i >= 0) this.lineWaiters.splice(i, 1);
        reject(new Error(`${this.label}: timed out waiting for ${what}`));
      }, ms);
      this.lineWaiters.push({ match, resolve, reject, timer });
    });
  }

  async handshake(options) {
    this.start();
    const uciok = this.waitLine(l => l === 'uciok', 10000, 'uciok');
    this.send('uci');
    await uciok;
    for (const [k, v] of Object.entries(options)) {
      this.send(`setoption name ${k} value ${v}`);
    }
    const ready = this.waitLine(l => l === 'readyok', 10000, 'readyok');
    this.send('isready');
    await ready;
  }

  async newGame() {
    this.send('ucinewgame');
    const ready = this.waitLine(l => l === 'readyok', 10000, 'readyok');
    this.send('isready');
    await ready;
  }

  search(position, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.searchWaiters.findIndex(w => w.timer === timer);
        if (i >= 0) this.searchWaiters.splice(i, 1);
        reject(new Error(`${this.label}: no bestmove after ${ms} ms`));
      }, ms + SEARCH_TIMEOUT_MS);
      this.lastInfo = null;
      this.searchWaiters.push({ resolve, reject, timer });
      this.send('position ' + position);
      this.send('go movetime ' + ms);
    });
  }

  close() {
    this.closing = true;
    try {
      if (this.proc) {
        this.send('quit');
        this.proc.stdin.end();
        setTimeout(() => { try { if (this.proc) this.proc.kill(); } catch {} }, 500).unref();
      }
    } catch {}
    this.proc = null;
  }
}

function fenKey(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

function sqName(sq) {
  return String.fromCharCode(97 + (sq & 7)) + String.fromCharCode(49 + (sq >> 4));
}

/* SAN for the move currently on the board (call before applying it). */
function sanBase(mv) {
  const info = engine.describeMove(mv);
  if (info.castle) return (info.to & 7) === 6 ? 'O-O' : 'O-O-O';
  const dest = sqName(info.to);
  if (info.piece === 1) {
    let s = info.cap ? sqName(info.from)[0] + 'x' + dest : dest;
    if (info.promo) s += '=' + ' PNBRQK'[info.promo];
    return s;
  }
  let dis = '';
  if (info.piece !== 6) {
    const rivals = engine.getLegalMoves()
      .filter(m => m !== mv)
      .map(m => engine.describeMove(m))
      .filter(o => o.piece === info.piece && o.to === info.to);
    if (rivals.length) {
      const sameFile = rivals.some(o => (o.from & 7) === (info.from & 7));
      const sameRank = rivals.some(o => (o.from >> 4) === (info.from >> 4));
      if (!sameFile) dis = sqName(info.from)[0];
      else if (!sameRank) dis = sqName(info.from)[1];
      else dis = sqName(info.from);
    }
  }
  return ' PNBRQK'[info.piece] + dis + (info.cap ? 'x' : '') + dest;
}

/* Call after applying: + or # when the opponent is in check / mated. */
function sanSuffix() {
  if (!engine.inCheck()) return '';
  return engine.getLegalMoves().length ? '+' : '#';
}

function deadMaterial(fen) {
  const board = fen.split(' ')[0];
  const pieces = board.replace(/[^a-zA-Z]/g, '');
  if (/[PpRrQq]/.test(pieces)) return false;
  const white = pieces.replace(/[a-z]/g, '').length;
  const black = pieces.replace(/[A-Z]/g, '').length;
  return white <= 2 && black <= 2;
}

async function playGame(kiwa, sf, opening, kiwaIsWhite, gameNo) {
  engine.setFen(engine.START_FEN);
  kiwa.newGame();
  sf.newGame();

  const moves = [];
  const sanMoves = [];
  const seen = new Map();
  let key = fenKey(engine.getFen());
  seen.set(key, 1);

  for (const mv of opening) {
    const legal = engine.getLegalMoves();
    const mvInt = legal.find(m => engine.moveToStr(m) === mv);
    if (mvInt === undefined) throw new Error('illegal opening move ' + mv);
    const san = sanBase(mvInt);
    engine.applyUciMove(mv);
    sanMoves.push(san + sanSuffix());
    moves.push(mv);
    key = fenKey(engine.getFen());
    seen.set(key, (seen.get(key) || 0) + 1);
  }

  let result = null;   // 1 Kiwa win, 0.5 draw, 0 Kiwa loss
  let reason = '';
  const t0 = Date.now();
  // Search depth/nodes as reported by each engine itself, per side.
  const stats = {
    kiwa: { depths: [], nodes: 0, moves: 0 },
    opp: { depths: [], nodes: 0, moves: 0 },
  };

  for (let ply = 0; ply < MAX_PLIES; ply++) {
    const legal = engine.getLegalMoves();
    if (!legal.length) {
      if (!engine.inCheck()) {
        result = 0.5; reason = 'stalemate';
      } else {
        const kiwaToMove = (engine.side === engine.WHITE) === kiwaIsWhite;
        result = kiwaToMove ? 0 : 1;
        reason = 'checkmate';
      }
      break;
    }
    if (engine.halfmove >= 100) { result = 0.5; reason = '50-move rule'; break; }
    if ((seen.get(fenKey(engine.getFen())) || 0) >= 3) { result = 0.5; reason = 'threefold repetition'; break; }
    if (deadMaterial(engine.getFen())) { result = 0.5; reason = 'dead material'; break; }
    if (ply === MAX_PLIES - 1) { result = 0.5; reason = `${MAX_PLIES}-ply cap`; break; }

    const kiwaToMove = (engine.side === engine.WHITE) === kiwaIsWhite;
    const mover = kiwaToMove ? kiwa : sf;
    const desc = 'startpos moves ' + moves.join(' ');
    let mv;
    try {
      mv = await mover.search(desc, MS);
    } catch (e) {
      result = kiwaToMove ? 0 : 1;
      reason = `${mover.label} failure: ${e.message}`;
      break;
    }
    const sideStats = kiwaToMove ? stats.kiwa : stats.opp;
    sideStats.moves++;
    if (mover.lastInfo) {
      sideStats.depths.push(mover.lastInfo.depth);
      sideStats.nodes += mover.lastInfo.nodes;
    }
    const mvInt = mv && mv !== '0000'
      ? engine.getLegalMoves().find(m => engine.moveToStr(m) === mv)
      : undefined;
    if (mvInt === undefined) {
      result = kiwaToMove ? 0 : 1;
      reason = `${mover.label} illegal move (${mv})`;
      break;
    }
    const san = sanBase(mvInt);
    engine.applyUciMove(mv);
    sanMoves.push(san + sanSuffix());
    moves.push(mv);
    key = fenKey(engine.getFen());
    seen.set(key, (seen.get(key) || 0) + 1);
  }

  if (result === null) { result = 0.5; reason = 'unfinished'; }
  return {
    result, reason, moves, sanMoves, stats,
    plies: moves.length,
    seconds: (Date.now() - t0) / 1000,
    kiwaIsWhite,
    pgnResult: result === 1 ? (kiwaIsWhite ? '1-0' : '0-1')
             : result === 0 ? (kiwaIsWhite ? '0-1' : '1-0') : '1/2-1/2',
  };
}

// Filled in after the handshake so the PGN names the real engines.
const NAMES = { kiwa: 'FroostRook 1 Beta', opp: 'Opponent' };

function movesToPgn(game, openingName) {
  const list = game.sanMoves || game.moves;
  const body = [];
  for (let i = 0; i < list.length; i += 2) {
    const n = i / 2 + 1;
    const white = list[i];
    const black = list[i + 1];
    body.push(`${n}. ${white}${black ? ' ' + black : ''}`);
  }
  return `[Event "${DUEL ? 'FroostRook engine duel' : 'FroostRook Elo measurement'}"]\n[Site "local"]\n` +
         `[White "${game.kiwaIsWhite ? NAMES.kiwa : NAMES.opp}"]\n` +
         `[Black "${game.kiwaIsWhite ? NAMES.opp : NAMES.kiwa}"]\n` +
         `[Result "${game.pgnResult}"]\n[Opening "${openingName}"]\n` +
         `[TimeControl "${MS}/1 (movetime)"]\n[Termination "${game.reason}"]\n\n` +
         body.join(' ') + ' ' + game.pgnResult + '\n';
}

(async () => {
  if (!fs.existsSync(KIWA_EXE)) throw new Error(`engine binary not found: ${KIWA_EXE}`);
  if (DUEL && !fs.existsSync(OPP_EXE)) throw new Error(`opponent binary not found: ${OPP_EXE}`);
  if (!DUEL && !fs.existsSync(SF_EXE) && !/stockfish/i.test(path.basename(SF_EXE))) {
    throw new Error('Stockfish not found: ' + SF_EXE + ' (use --stockfish PATH or STOCKFISH env)');
  }

  const kiwa = new UciEngine('FroostRook', KIWA_EXE);
  const sf = new UciEngine(DUEL ? 'Opponent' : 'Stockfish', DUEL ? OPP_EXE : SF_EXE);

  await kiwa.handshake(Object.assign({ Hash: 64, 'Move Overhead': 30 },
                                     USE_BOOK ? {} : { OwnBook: 'false' }));
  if (DUEL) {
    await sf.handshake({ Hash: 64, 'Move Overhead': 30, ...(USE_BOOK ? {} : { OwnBook: 'false' }) });
  } else {
    await sf.handshake({
      Threads: 1,
      Hash: 16,
      UCI_LimitStrength: 'true',
      UCI_Elo: ANCHOR,
    });
  }
  NAMES.kiwa = kiwa.name;
  NAMES.opp = sf.name;

  console.log(DUEL ? 'FroostRook engine duel' : 'FroostRook Elo measurement');
  console.log(`engine     ${kiwa.name}  (${KIWA_EXE})`);
  console.log(`opponent   ${sf.name}  (${OPP_EXE || SF_EXE})` +
              (DUEL ? '' : `, UCI_LimitStrength, UCI_Elo ${ANCHOR}`));
  console.log(`book       ${USE_BOOK ? 'on' : 'off'}`);
  console.log(`format     ${PAIRS} opening pairs = ${PAIRS * 2} games, ${MS} ms/move, colours swapped`);
  console.log('');

  const games = [];
  const pgns = [];
  let score = 0, wins = 0, draws = 0, losses = 0;

  for (let p = 0; p < PAIRS; p++) {
    const opening = OPENINGS[p % OPENINGS.length];
    const cycle = Math.floor(p / OPENINGS.length);
    const name = opening.join(' ') + (cycle ? ` (cycle ${cycle + 1})` : '');
    console.log(`pair ${p + 1}: ${name}`);
    for (let k = 0; k < 2; k++) {
      const kiwaIsWhite = k === 0;
      const gameNo = games.length + 1;
      const g = await playGame(kiwa, sf, opening, kiwaIsWhite, gameNo);
      games.push(g);
      pgns.push(movesToPgn(g, name));
      score += g.result;
      if (g.result === 1) wins++;
      else if (g.result === 0.5) draws++;
      else losses++;
      const tag = g.result === 1 ? 'WIN ' : g.result === 0.5 ? 'DRAW' : 'LOSS';
      console.log(`  game ${gameNo}: FroostRook ${kiwaIsWhite ? 'white' : 'black'} ${tag}  ` +
                  `${g.reason}, ${g.plies} plies, ${g.seconds.toFixed(1)}s`);
    }
  }

  const n = games.length;
  const pct = (100 * score / n).toFixed(1);
  console.log('');
  console.log(`FroostRook score ${score}/${n}  (+${wins} =${draws} -${losses}) = ${pct}%`);

  const asWhite = games.filter(g => g.kiwaIsWhite);
  const asBlack = games.filter(g => !g.kiwaIsWhite);
  const half = (list, label) => {
    if (!list.length) return;
    const s = list.reduce((a, g) => a + g.result, 0);
    const w = list.filter(g => g.result === 1).length;
    const d = list.filter(g => g.result === 0.5).length;
    const l = list.filter(g => g.result === 0).length;
    console.log(`  as ${label.padEnd(5)} ${s}/${list.length} (${(100 * s / list.length).toFixed(1)}%)  +${w} =${d} -${l}`);
  };
  half(asWhite, 'White');
  half(asBlack, 'Black');

  const mean = list => (list.reduce((a, b) => a + b, 0) / (list.length || 1));
  const summary = (s, label) => {
    if (!s.moves) return;
    console.log(`  ${label}: mean reported depth ${mean(s.depths).toFixed(1)}, ` +
                `${Math.round(mean([s.nodes / s.moves])).toLocaleString()} nodes/move over ${s.moves} moves`);
  };
  const agg = { kiwa: { depths: [], nodes: 0, moves: 0 }, opp: { depths: [], nodes: 0, moves: 0 } };
  for (const g of games) {
    agg.kiwa.depths.push(...g.stats.kiwa.depths);
    agg.kiwa.nodes += g.stats.kiwa.nodes;
    agg.kiwa.moves += g.stats.kiwa.moves;
    agg.opp.depths.push(...g.stats.opp.depths);
    agg.opp.nodes += g.stats.opp.nodes;
    agg.opp.moves += g.stats.opp.moves;
  }
  summary(agg.kiwa, NAMES.kiwa);
  summary(agg.opp, NAMES.opp);
  const reasons = {};
  for (const g of games) reasons[g.reason] = (reasons[g.reason] || 0) + 1;
  console.log(`  outcomes: ${Object.entries(reasons).map(([k, v]) => `${k} x${v}`).join(', ')}`);
  console.log(`  mean game length ${(mean(games.map(g => g.plies))).toFixed(1)} plies, ` +
              `${mean(games.map(g => g.seconds)).toFixed(1)} s wall (this machine was under other load)`);

  if (score > 0 && score < n) {
    const p = score / n;
    const err = 173.7 / Math.sqrt(n * p * (1 - p));
    if (DUEL) {
      const diff = 400 * Math.log10(p / (1 - p));
      console.log(`Elo difference vs ${NAMES.opp}: ${diff >= 0 ? '+' : ''}${Math.round(diff)} ` +
                  `(±${Math.round(err)} 1σ sampling, n=${n})`);
    } else {
      const elo = ANCHOR + 400 * Math.log10(p / (1 - p));
      console.log(`performance Elo ${Math.round(elo)} vs anchor ${ANCHOR}  ` +
                  `(±${Math.round(err)} 1σ sampling, n=${n})`);
      console.log(`difference vs the anchor itself: ${Math.round(elo - ANCHOR)} (same ±${Math.round(err)})`);
      console.log('Note: the anchor\'s own calibration and this fast time control are not included in the error.');
    }
  } else {
    console.log(`Score is ${score === n ? 'perfect' : 'zero'} — engine is at least ${score === n ? 'above' : 'below'} the opponent; rerun with a ${score === n ? 'stronger' : 'weaker'} opponent or more pairs.`);
  }

  if (PGN_FILE) {
    fs.writeFileSync(PGN_FILE, pgns.join('\n'), 'utf8');
    console.log(`PGN written to ${PGN_FILE}`);
  }

  kiwa.close();
  sf.close();
  process.exit(0);
})().catch(err => {
  console.error('elo match failed:', err.message);
  process.exit(1);
});
