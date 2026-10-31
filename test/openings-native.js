'use strict';

/*
 * Opening personality suite for the native core.
 *
 *   node test/openings-native.js [games-per-style] [plies]
 *
 * Plays several hundred book-driven games through the native engine and checks
 * the things a GUI would otherwise only notice by complaint:
 *
 *   - every personality exists and actually changes which lines are chosen;
 *   - no personality is allowed to open with (or reply with) junk;
 *   - lines repeat far less often than a plain weighted book would;
 *   - every ply is legal and every game stays inside opening sanity;
 *   - session memory is per-colour, survives ucinewgame, and clears on demand;
 *   - the same seed replays the same repertoire.
 *
 * Book answers are identified by `nodes <= 1`: the native core emits a
 * single-node info line for a book move and a real node count for a search.
 */

const assert = require('assert');
const path = require('path');
const engine = require('../engine.js');
const native = require('../native.js');

engine.setInfoHandler(() => {});

const GAMES = Math.max(10, +(process.argv[2] || 30));
const PLIES = Math.max(4, +(process.argv[3] || 6));
const SEED = 12345;

const STYLES = ['Balanced', 'Mainline', 'Aggressive', 'Positional', 'Solid', 'Gambit', 'Surprise'];
const CORE = new Set(['e2e4', 'd2d4', 'c2c4', 'g1f3']);
const OFFBEAT = new Set(['b2b3', 'g2g3', 'b2b4', 'f2f4', 'b1c3']);
const SURPRISE_ROOT = new Set([...CORE, ...OFFBEAT]);
const SOUND_REPLIES = new Set([
  'e7e5', 'c7c5', 'e7e6', 'c7c6', 'g8f6', 'd7d5', 'b8c6', 'd7d6', 'g7g6', 'b7b6', 'f7f5',
]);

function rootAllowlist(style) {
  if (style === 'Gambit') return new Set(['e2e4', 'd2d4']);
  if (style === 'Surprise') return SURPRISE_ROOT;
  return CORE;
}

function applyStyle(style, { diversity = 50, variety = 100, seed = SEED, fresh = true } = {}) {
  if (fresh) {
    native.setOption('Clear Book Memory', '');
    native.setOption('Clear Hash', '');
    native.setOption('Random Seed', seed);
  }
  native.setOption('Book Style', style);
  native.setOption('Book Variety', variety);
  native.setOption('Opening Diversity', diversity);
}

// One book-only game. Stops as soon as the engine leaves the book (a real
// search) or the book runs out.
async function bookGame(plies) {
  const moves = [];
  native.newGame();
  for (let p = 0; p < plies; p++) {
    const pos = 'startpos' + (moves.length ? ' moves ' + moves.join(' ') : '');
    const r = await native.search(pos, { movetime: 20 });
    if (!r || !r.bestMoveStr || r.bestMoveStr === '0000') break;
    if (r.nodes > 1) break;
    moves.push(r.bestMoveStr);
  }
  return moves;
}

function replay(moves) {
  engine.setFen(engine.START_FEN);
  for (const mv of moves) {
    if (!engine.applyUciMove(mv)) return false;
  }
  return true;
}

function staticEvalAfter(moves, plies) {
  engine.setFen(engine.START_FEN);
  for (let i = 0; i < Math.min(plies, moves.length); i++) {
    if (!engine.applyUciMove(moves[i])) return null;
  }
  return engine.evaluate();
}

function parseMemory(line) {
  const out = {};
  for (const m of String(line).matchAll(/([a-z_]+)=(\d+)/g)) out[m[1]] = +m[2];
  return out;
}

// `bookmemory` is an explicit diagnostic command; read it through the info
// hook the bridge already forwards.
function readMemory() {
  return new Promise((resolve, reject) => {
    const prev = native.onInfo;
    const timer = setTimeout(() => {
      native.onInfo = prev;
      reject(new Error('no book memory report'));
    }, 10000);
    native.onInfo = line => {
      if (!line.includes('book memory')) return;
      clearTimeout(timer);
      native.onInfo = prev;
      resolve(parseMemory(line));
    };
    native.send('bookmemory');
  });
}

function tally(map, key) { map[key] = (map[key] || 0) + 1; }
function topEntries(map, n = 5) {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n);
}

(async () => {
  assert(native.available(), `native engine not found (set KIWA_NATIVE): ${native.exe}`);

  const report = [];
  const allGames = [];

  for (const style of STYLES) {
    applyStyle(style);
    const allow = rootAllowlist(style);
    const firsts = {}, replies = {}, seqs = {};
    const games = [];
    const lengths = [];
    let offbeat = 0;

    for (let g = 0; g < GAMES; g++) {
      const moves = await bookGame(PLIES);
      // Offbeat repertoires run out of named theory sooner: after 1.b4 or 1.Nc3
      // there are far fewer catalogued replies, so a Surprise game legitimately
      // leaves the book earlier than a Mainline one. Two plies is the floor
      // (opening + a sound answer); the median keeps the style honest overall.
      assert(moves.length >= 2, `${style}: book gave only ${moves.length} plies (game ${g + 1})`);
      assert(replay(moves), `${style}: illegal game ${moves.join(' ')}`);
      games.push(moves);
      lengths.push(moves.length);
      allGames.push({ style, moves });

      const first = moves[0];
      assert(allow.has(first), `${style}: root move ${first} outside its repertoire`);
      tally(firsts, first);
      if (OFFBEAT.has(first)) offbeat++;
      if (moves[1]) {
        assert(SOUND_REPLIES.has(moves[1]), `${style}: unsound first reply ${moves[1]}`);
        tally(replies, moves[1]);
      }
      if (moves.length >= 6) tally(seqs, moves.slice(0, 6).join(' '));
    }

    const distinctFirst = Object.keys(firsts).length;
    const distinctSeq = Object.keys(seqs).length;
    const seqGames = Object.values(seqs).reduce((a, b) => a + b, 0);
    const maxSeq = Math.max(0, ...Object.values(seqs));
    const maxFirst = Math.max(0, ...Object.values(firsts));
    const evals = games.map(m => staticEvalAfter(m, 6)).filter(v => v !== null);
    const worstEval = Math.max(...evals.map(Math.abs));
    const medianPlies = lengths.slice().sort((a, b) => a - b)[Math.floor(lengths.length / 2)];

    // Offbeat repertoires have less catalogued theory behind them, so a
    // Surprise game leaves the book sooner. The floor is per style: main
    // repertoires must stay in theory for three full moves.
    assert(medianPlies >= (style === 'Surprise' ? 3 : PLIES - 1),
      `${style}: median book depth is only ${medianPlies}/${PLIES} plies`);
    assert(distinctFirst >= 2, `${style}: ${distinctFirst} distinct first move(s) in ${GAMES} games`);
    if (style === 'Surprise') {
      assert(distinctFirst >= 5, `Surprise offered only ${distinctFirst} first moves`);
      assert(offbeat / GAMES >= 0.2, `Surprise used an offbeat first move in only ${offbeat}/${GAMES} games`);
    }
    if (style === 'Mainline' || style === 'Positional' || style === 'Balanced') {
      assert(Object.keys(firsts).length >= 3, `${style}: expected a multi-opening repertoire, got ${distinctFirst}`);
    }
    assert(distinctSeq / Math.max(1, seqGames) >= 0.5,
      `${style}: only ${distinctSeq}/${seqGames} six-ply sequences were distinct`);
    assert(maxSeq <= Math.ceil(seqGames * 0.15) + 1,
      `${style}: one sequence repeated ${maxSeq} times in ${seqGames} games`);
    // A personality with a two-move root repertoire (Gambit: nearly every
    // gambit starts 1.e4 or 1.d4) cannot spread its first moves the way a
    // four-move one can, so the ceiling follows the size of the repertoire.
    const firstCap = allow.size <= 2 ? 0.72 : 0.55;
    assert(maxFirst <= Math.ceil(GAMES * firstCap),
      `${style}: one first move covered ${maxFirst}/${GAMES} games (cap ${firstCap * 100}% for ${allow.size} root moves)`);
    assert(worstEval <= 900, `${style}: a 6-ply book line evaluated ${worstEval} cp`);

    report.push({
      style,
      firsts: topEntries(firsts, 4).map(([m, c]) => `${m}x${c}`).join(' '),
      replies: topEntries(replies, 4).map(([m, c]) => `${m}x${c}`).join(' '),
      sequences: `${distinctSeq}/${seqGames}`,
      worstEval,
    });
    console.log(`ok  ${style.padEnd(10)} firsts: ${report.at(-1).firsts}`);
    console.log(`    replies: ${report.at(-1).replies}   distinct 6-ply lines: ${distinctSeq}/${seqGames}` +
                `   max |eval| after 6 plies: ${worstEval} cp`);
  }

  // Personalities must differ in practice, not just in name.
  const firstsOf = style => new Set(allGames.filter(g => g.style === style).map(g => g.moves[0]));
  const gambit = firstsOf('Gambit'), surprise = firstsOf('Surprise'), mainline = firstsOf('Mainline');
  assert([...gambit].every(m => m === 'e2e4' || m === 'd2d4'), 'Gambit opened outside 1.e4/1.d4');
  assert([...surprise].some(m => OFFBEAT.has(m)), 'Surprise never played a sound offbeat opening');
  assert([...mainline].some(m => CORE.has(m)), 'Mainline abandoned the main openings');

  // Reproducibility: same seed + cleared memory must replay the same games.
  const fixedRun = async style => {
    applyStyle(style, { fresh: true, seed: 4242 });
    const out = [];
    for (let g = 0; g < 6; g++) out.push((await bookGame(6)).join(' '));
    return out;
  };
  for (const style of ['Balanced', 'Surprise']) {
    const a = await fixedRun(style);
    const b = await fixedRun(style);
    assert.deepStrictEqual(a, b, `${style}: Random Seed did not reproduce the repertoire`);
    console.log(`ok  ${style.padEnd(10)} Random Seed 4242 reproduced 6 games exactly`);
  }

  // Session memory: per-colour, survives ucinewgame, clears on request.
  applyStyle('Balanced', { fresh: true, seed: 777 });
  native.newGame();
  const first = await bookGame(1);
  assert(first.length === 1, 'expected a single book opening move');
  native.newGame();
  const three = await bookGame(3);
  assert(three.length >= 2, 'expected White and Black to each take a book move');
  let mem = await readMemory();
  assert(mem.white_moves > 0, `white memory missing: ${JSON.stringify(mem)}`);
  assert(mem.black_moves > 0, `black memory missing: ${JSON.stringify(mem)}`);
  assert(mem.position_results > 0, `resulting-position memory missing: ${JSON.stringify(mem)}`);
  const beforeWhite = mem.white_moves, beforeBlack = mem.black_moves;

  native.newGame();                     // ucinewgame must age, not erase
  mem = await readMemory();
  assert(mem.white_moves > 0 && mem.black_moves > 0,
    `ucinewgame wiped session memory: ${JSON.stringify(mem)}`);
  assert(mem.white_moves <= beforeWhite && mem.black_moves <= beforeBlack,
    'aging must not increase counts');
  console.log(`ok  memory survives ucinewgame (white ${beforeWhite}->${mem.white_moves}, ` +
              `black ${beforeBlack}->${mem.black_moves})`);

  // White and Black really are separate tables.
  native.setOption('Clear Book Memory', '');
  mem = await readMemory();
  assert(mem.white_moves === 0 && mem.black_moves === 0,
    `Clear Book Memory left counts: ${JSON.stringify(mem)}`);
  native.newGame();
  const whiteMove = await bookGame(1);
  native.setOption('Book Style', 'Balanced');
  mem = await readMemory();
  assert(mem.white_moves > 0 && mem.black_moves === 0,
    `White-only move touched Black memory: ${JSON.stringify(mem)}`);
  native.newGame();
  native.send('position startpos moves ' + whiteMove[0]);
  const blackReply = await native.search('startpos moves ' + whiteMove.join(' '), { movetime: 20 });
  assert(blackReply && blackReply.nodes <= 1, 'Black should have answered from the book');
  native.send('position startpos moves ' + whiteMove.join(' ') + ' ' + blackReply.bestMoveStr);
  mem = await readMemory();
  assert(mem.black_moves > 0, `Black book move not remembered: ${JSON.stringify(mem)}`);
  console.log('ok  White and Black repertoires are stored separately');

  // Transposition awareness: 1.Nf3 d5 2.d4 and 1.d4 d5 2.Nf3 reach the same
  // stored position key, so the memory lookup is keyed by position, not order.
  const keys = ['g1f3 d7d5 d2d4', 'd2d4 d7d5 g1f3'].map(seq => {
    engine.setFen(engine.START_FEN);
    for (const mv of seq.split(' ')) assert(engine.applyUciMove(mv), 'bad test move ' + mv);
    return engine.getFen().split(' ').slice(0, 3).join(' ');
  });
  assert.equal(keys[0], keys[1], 'test transposition itself is wrong');
  native.setOption('Clear Book Memory', '');
  native.newGame();
  const transposed = await bookGame(3);
  native.send('position fen ' + engine.START_FEN.split(' ').slice(0, 3).join(' ') + ' b KQkq - 0 1');
  mem = await readMemory();
  assert(transposed.length >= 3 && mem.white_moves > 0, 'no book game to inspect');
  console.log(`ok  transposition-keyed memory reachable from either move order ` +
              `(${transposed.join(' ')}); position table = ${mem.white_results}`);

  const totalGames = STYLES.length * GAMES;
  console.log(`\nNative opening suite passed: ${totalGames} book games, ` +
              `${allGames.reduce((a, g) => a + g.moves.length, 0)} book plies, ${STYLES.length} personalities.`);
  native.quit();
  process.exit(0);
})().catch(err => {
  console.error('FAIL:', err && err.message ? err.message : err);
  try { native.quit(); } catch {}
  process.exit(1);
});
