'use strict';

/*
 * Builds an NNUE training set from a Lichess standard PGN dump (CC0).
 *
 *   node tools/nnue/build-eval-dataset.js --in .build/standard-oct.pgn.zst \
 *        --out .build/positions.jsonl [--max-games N] [--max-positions N] \
 *        [--min-ply 4] [--top-n 4] [--min-elo 1600] [--stride 1]
 *
 * --top-n: positions are sampled evenly across plies, keeping at most this
 *   many positions per game (spread across the whole game, not the opening).
 * --min-ply: skip plies this small (tiny opening positions teach nothing).
 * --stride: keep every Nth position instead of even spread.
 * --min-elo: both players must rate this or more (skip bullet junk).
 *
 * Output lines: {fen, game, result, whiteElo, blackElo, ply, split}
 * split is assigned by game id (fnv1a) into train/validation/test (80/10/10),
 * so no game appears in more than one split and there is no leakage.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const P = require('./pgn.js');

function parseArgs(argv) {
  const opts = { in: null, out: null, maxGames: Infinity, maxPositions: Infinity, minPly: 4, topN: 4, minElo: 1600, stride: 0 };
  for (let i = 0; i < argv.length; i++) {
    const val = () => argv[++i];
    if (argv[i] === '--in') opts.in = val();
    else if (argv[i] === '--out') opts.out = val();
    else if (argv[i] === '--max-games') opts.maxGames = +val();
    else if (argv[i] === '--max-positions') opts.maxPositions = +val();
    else if (argv[i] === '--min-ply') opts.minPly = +val();
    else if (argv[i] === '--top-n') opts.topN = +val();
    else if (argv[i] === '--min-elo') opts.minElo = +val();
    else if (argv[i] === '--stride') opts.stride = +val();
    else throw new Error('unknown arg ' + argv[i]);
  }
  if (!opts.in || !opts.out) throw new Error('need --in and --out');
  return opts;
}

function fnv1a32(s) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function splitOf(id) {
  const h = fnv1a32('frnn1-split ' + id) % 100;
  if (h < 80) return 'train';
  if (h < 90) return 'val';
  return 'test';
}

const opts = parseArgs(process.argv.slice(2));

function* gameBlocksFromFile(filePath) {
  // Multi-frame zstd: split the file at each zstd frame magic and decode each
  // frame independently. The first skippable marker (if any) is dropped by
  // starting the scan at every position of either magic.
  const buf = fs.readFileSync(filePath);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);   // zstd frame magic
  const skipMagic = Buffer.from([0x50, 0x2a, 0x4d, 0x18]); // skippable frame magic
  let text = '';
  // Plain PGN files are fed through unchanged; .zst dumps are frame-split.
  const head = buf.subarray(0, 16).toString('latin1');
  if (head.startsWith('[Event') || !buf.subarray(0, 4).equals(magic) && !buf.subarray(0, 4).equals(skipMagic)) {
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
        try {
          text += zlib.zstdDecompressSync(buf.subarray(a, end)).toString('utf8');
        } catch { /* truncated frame at the end of range */ }
        pos = end;
      } else {
        const sz = buf.readUInt32LE(b + 4);
        pos = b + 8 + sz;
      }
    }
  }
  // Normalize line endings once; dumps mix LF and CRLF depending on source.
  text = text.replace(/\r\n/g, '\n');
  // Yield game blocks separated by blank lines before [Event.
  let bufText = text;
  let idx;
  const out = [];
  while ((idx = bufText.indexOf('\n\n[Event ')) >= 0) {
    out.push(bufText.slice(0, idx));
    bufText = bufText.slice(idx + 2);
  }
  if (bufText.trim()) out.push(bufText);
  for (const block of out) yield block;
}

(async () => {
  if (!fs.existsSync(opts.in)) {
    console.error('no such input: ' + opts.in);
    process.exit(1);
  }
  const out = fs.createWriteStream(opts.out);
  let gamesSeen = 0, gamesKept = 0, positionsKept = 0, plies = 0;
  const skipped = new Map();
  const splitCounts = { train: 0, val: 0, test: 0 };
  const t0 = Date.now();

  for (const block of gameBlocksFromFile(opts.in)) {
    if (gamesKept >= opts.maxGames || positionsKept >= opts.maxPositions) break;
    const r = P.parseGame(block);
    if (r.skip) { const k = r.skip.split(':')[0]; skipped.set(k, (skipped.get(k) || 0) + 1); continue; }
    gamesSeen++;
    const g = r.game;
    if (opts.minElo > 0 && ((g.whiteElo || 0) < opts.minElo || (g.blackElo || 0) < opts.minElo)) {
      skipped.set('low-elo', (skipped.get('low-elo') || 0) + 1);
      continue;
    }

    // Replay the game and pick positions.
    const totalPlies = g.moves.length;
    const minPly = opts.minPly;
    let positions = [];
    if (opts.stride > 0) {
      const pos = P.setFen(P.newBoard(), P.START_FEN);
      for (let m = 0; m < g.moves.length; m++) {
        if (!P.applyUci(pos, g.moves[m])) break;
        const ply = m + 1;
        if (ply < minPly || ply % opts.stride !== 0) continue;
        positions.push({ fen: P.getFen(pos), ply });
      }
    } else {
      const pos = P.setFen(P.newBoard(), P.START_FEN);
      const plies = [];
      for (let m = 0; m < g.moves.length; m++) {
        if (!P.applyUci(pos, g.moves[m])) break;
        const ply = m + 1;
        if (ply >= minPly) plies.push({ fen: P.getFen(pos), ply });
      }
      if (plies.length <= opts.topN) {
        positions = plies;
      } else {
        // Evenly spaced selection across the game.
        for (let k = 0; k < opts.topN; k++) {
          const i = Math.floor((k + 0.5) * plies.length / opts.topN);
          positions.push(plies[i]);
        }
      }
    }
    if (!positions.length) continue;

    gamesKept++;
    plies += totalPlies;
    const split = splitOf(g.id);
    for (const p of positions) {
      if (positionsKept >= opts.maxPositions) break;
      const rec = { fen: p.fen, game: g.id, result: g.result, whiteElo: g.whiteElo, blackElo: g.blackElo, ply: p.ply, split };
      out.write(JSON.stringify(rec) + '\n');
      positionsKept++;
      splitCounts[split]++;
    }
    if (gamesKept % 2000 === 0) {
      console.log(`games=${gamesKept} positions=${positionsKept} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  }
  out.end();
  console.log(`\ngames seen: ${gamesSeen}, kept: ${gamesKept}, plies: ${plies}, positions: ${positionsKept}`);
  console.log('split:', JSON.stringify(splitCounts));
  console.log('skipped:', JSON.stringify([...skipped.entries()]));
})().catch(e => { console.error(e); process.exit(1); });
