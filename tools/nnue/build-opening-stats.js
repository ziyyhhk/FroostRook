'use strict';

/*
 * Builds opening-move statistics from a Lichess standard PGN dump (CC0).
 * For every position reached from the start position on plies 0..PLY-1,
 * counts how often each move was played and how the game ended.
 *
 *   node tools/nnue/build-opening-stats.js --in .build/standard-oct.pgn.zst \
 *        --out .build/opening-stats.json [--ply 12] [--max-games N] [--min-elo 1800]
 *
 * Output JSON: { "key": { fen, side, moves: { uci: {n, white, draw, black} } } }
 * where "key" is the same "board side castling" string the engine's book
 * uses (no ep field), so stats can be merged with the named book.
 */
const fs = require('fs');
const path = require('path');
const P = require('./pgn.js');

function parseArgs(argv) {
  const opts = { in: null, out: null, ply: 12, maxGames: Infinity, minElo: 1800 };
  for (let i = 0; i < argv.length; i++) {
    const val = () => argv[++i];
    if (argv[i] === '--in') opts.in = val();
    else if (argv[i] === '--out') opts.out = val();
    else if (argv[i] === '--ply') opts.ply = +val();
    else if (argv[i] === '--max-games') opts.maxGames = +val();
    else if (argv[i] === '--min-elo') opts.minElo = +val();
    else throw new Error('unknown arg ' + argv[i]);
  }
  if (!opts.in || !opts.out) throw new Error('need --in and --out');
  return opts;
}

// Same key as book.js / native bookPositionKey(): board + side + castling, no ep.
function positionKey(pos) {
  let s = '';
  const pieceChars = ' PNBRQK';
  for (let r = 7; r >= 0; r--) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = pos.b[r * 16 + f];
      if (!p) { empty++; continue; }
      if (empty) { s += empty; empty = 0; }
      const c = pieceChars[p & 7];
      s += (p >> 3) === 0 ? c : c.toLowerCase();
    }
    if (empty) s += empty;
    if (r) s += '/';
  }
  s += pos.side === 0 ? ' w ' : ' b ';
  let castling = '';
  // pgn.js board object: does it expose castling rights? Use castling variable.
  // The pgn board tracks castling as a bitmask in pos.castling.
  const c = pos.castling;
  if (c & 1) castling += 'K';
  if (c & 2) castling += 'Q';
  if (c & 4) castling += 'k';
  if (c & 8) castling += 'q';
  s += castling || '-';
  return s;
}

const opts = parseArgs(process.argv.slice(2));

(async () => {
  const buf = fs.readFileSync(opts.in);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const skipMagic = Buffer.from([0x50, 0x2a, 0x4d, 0x18]);
  let text = '';
  const head = buf.subarray(0, 16).toString('latin1');
  if (head.startsWith('[Event')) {
    text = buf.toString('utf8');
  } else {
    let pos = 0;
    while (pos < buf.length) {
      const a = buf.indexOf(magic, pos);
      const b = buf.indexOf(skipMagic, pos);
      if (a < 0 && b < 0) break;
      if (a >= 0 && (b < 0 || a < b)) {
        const next = buf.indexOf(magic, a + 4);
        const end = next >= 0 ? next : buf.length;
        try { text += require('zlib').zstdDecompressSync(buf.subarray(a, end)).toString('utf8'); } catch {}
        pos = end;
      } else {
        const sz = buf.readUInt32LE(b + 4);
        pos = b + 8 + sz;
      }
    }
  }
  text = text.replace(/\r\n/g, '\n');

  // Split into game blocks, replay openings, accumulate stats.
  const stats = new Map(); // key -> { fen, side, moves: Map uci -> {n, white, draw, black} }
  let games = 0, seen = 0, skipped = 0;
  const t0 = Date.now();
  let idx = 0;
  const gameBoundary = '\n\n[Event ';
  while ((idx = text.indexOf(gameBoundary)) >= 0 || idx === -1) {
    if (idx === -1) { idx = text.length; }
    const block = text.slice(0, idx);
    text = text.slice(idx + 2);
    if (!block.trim()) break;
    seen++;
    if (seen > opts.maxGames) break;

    const r = P.parseGame(block);
    if (r.skip) { skipped++; continue; }
    const g = r.game;
    if (opts.minElo > 0 && ((g.whiteElo || 0) < opts.minElo || (g.blackElo || 0) < opts.minElo)) { skipped++; continue; }

    const result = g.result; // '1-0' | '0-1' | '1/2-1/2' | '*'
    const pos = P.setFen(P.newBoard(), P.START_FEN);
    for (let m = 0; m < g.moves.length && m < opts.ply; m++) {
      const key = positionKey(pos);
      // Find the move's UCI (need it before making the move; SAN would re-derive it).
      // pgn.js stores moves as UCI strings.
      const uci = g.moves[m];
      if (!stats.has(key)) stats.set(key, { fen: P.getFen(pos), side: pos.side, moves: new Map() });
      const entry = stats.get(key);
      if (!entry.moves.has(uci)) entry.moves.set(uci, { n: 0, white: 0, draw: 0, black: 0 });
      const agg = entry.moves.get(uci);
      agg.n++;
      if (result === '1-0') agg.white++;
      else if (result === '0-1') agg.black++;
      else if (result === '1/2-1/2') agg.draw++;
      if (!P.applyUci(pos, uci)) break;
    }
    games++;
    if (games % 20000 === 0) {
      console.log(`games=${games} positions=${stats.size} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  }

  const out = {};
  for (const [key, entry] of stats) {
    if (entry.moves.size === 0) continue;
    out[key] = {
      fen: entry.fen,
      side: entry.side,
      moves: Object.fromEntries(entry.moves),
    };
  }
  fs.writeFileSync(opts.out, JSON.stringify(out));
  console.log(`\ngames used: ${games}  positions covered: ${Object.keys(out).length}  skipped: ${skipped}`);
})().catch(e => { console.error(e); process.exit(1); });
