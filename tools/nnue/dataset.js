'use strict';

/*
 * tools/nnue/dataset.js — reproducible game dataset for the experimental
 * FRNN1 NNUE trainer.
 *
 *   node tools/nnue/dataset.js [options]
 *
 * Sources (both CC0 1.0, see docs/NNUE.md):
 *   1. test/human-games/*.pgn  — 8 per-account Lichess API exports already in
 *      the repo (fetched by test/fetch-human-games.js).
 *   2. Lichess standard rated monthly database dumps
 *      https://database.lichess.org/standard/lichess_db_standard_rated_<month>.pgn.zst
 *      (CC0; the site states the exports may be used for anything without
 *      asking permission). Dumps are large, so they are cached *outside* the
 *      repository (default: <os.tmpdir()>/frnn1-dump-cache) and only a small,
 *      deterministic, filtered subset of games is written to data/nnue/games.txt.
 *
 * Selection is deterministic: games are filtered by headers, ranked by
 * FNV-1a32("frnn1-games " + GameId) and the lowest `--max-dump-games` hashes are
 * kept, then written sorted by GameId. Re-running the same command against the
 * same dumps reproduces games.txt byte for byte (the SHA-256 is in
 * data/nnue/dataset.meta.json).
 *
 * Filters for dump games (all documented in the meta file):
 *   Variant=Standard, no SetUp/FEN, Result in {1-0,0-1,1/2-1/2},
 *   Termination=Normal, TimeControl base >= 180 s (blitz or slower),
 *   both ratings >= 1600, at least 40 plies.
 * These drop bullet noise and time-forfeit games (lost on time while winning),
 * which are the two largest sources of label noise for result-trained nets.
 *
 * Output:
 *   data/nnue/games.txt         "#"-prefixed header + one game per line:
 *                               id \t result \t whiteElo \t blackElo \t
 *                               timeControl \t source \t uci moves (space sep)
 *   data/nnue/dataset.meta.json provenance, filters, counts, SHA-256
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const P = require('./pgn.js');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_TXT = path.join(ROOT, 'data', 'nnue', 'games.txt');
const OUT_META = path.join(ROOT, 'data', 'nnue', 'dataset.meta.json');
const LEGACY_DIR = path.join(ROOT, 'test', 'human-games');
const DEFAULT_RAW_DIR = path.join(os.tmpdir(), 'frnn1-dump-cache');

const DUMP_BASE = 'https://database.lichess.org/standard/';
const USER_AGENT = 'FroostRook-nnue-dataset/1.0 (offline research; https://github.com/ziyyhhk/FroostRook)';

const RESULT_SET = new Set(['1-0', '0-1', '1/2-1/2']);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {
    months: ['2013-01', '2013-06'],
    maxDumpGames: 6000,
    minElo: 1600,
    minBaseSeconds: 180,
    minPlies: 40,
    legacy: true,
    rawDir: DEFAULT_RAW_DIR,
    download: true,
    statsOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error('missing value for ' + a);
      return v;
    };
    if (a === '--months') o.months = val().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--max-dump-games') o.maxDumpGames = parseInt(val(), 10);
    else if (a === '--min-elo') o.minElo = parseInt(val(), 10);
    else if (a === '--min-base-seconds') o.minBaseSeconds = parseInt(val(), 10);
    else if (a === '--min-plies') o.minPlies = parseInt(val(), 10);
    else if (a === '--no-legacy') o.legacy = false;
    else if (a === '--raw-dir') o.rawDir = path.resolve(val());
    else if (a === '--no-download') o.download = false;
    else if (a === '--stats-only') o.statsOnly = true;
    else if (a === '--help' || a === '-h') {
      console.log('usage: node tools/nnue/dataset.js [--months 2013-01,2013-06] [--max-dump-games 6000]');
      console.log('       [--min-elo 1600] [--min-base-seconds 180] [--min-plies 40]');
      console.log('       [--no-legacy] [--raw-dir DIR] [--no-download] [--stats-only]');
      process.exit(0);
    } else {
      throw new Error('unknown argument: ' + a);
    }
  }
  return o;
}

// ---------------------------------------------------------------------------
// Hash helpers (identical to the split hash used by train.js)
// ---------------------------------------------------------------------------

function hash32(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Download / decompress
// ---------------------------------------------------------------------------

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects: ' + url));
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(new URL(res.headers.location, url).toString(), dest, redirects + 1)
          .then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      }
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      let bytes = 0;
      res.on('data', c => { bytes += c.length; });
      out.on('error', reject);
      out.on('finish', () => {
        fs.renameSync(tmp, dest);
        resolve(bytes);
      });
      res.pipe(out);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('timeout: ' + url)));
  });
}

async function ensureDump(month, rawDir, allowDownload) {
  const file = path.join(rawDir, 'lichess_db_standard_rated_' + month + '.pgn.zst');
  if (fs.existsSync(file)) {
    const st = fs.statSync(file);
    return { file, bytes: st.size, downloaded: false };
  }
  if (!allowDownload) throw new Error('missing dump (and --no-download): ' + file);
  fs.mkdirSync(rawDir, { recursive: true });
  const url = DUMP_BASE + 'lichess_db_standard_rated_' + month + '.pgn.zst';
  process.stderr.write('downloading ' + url + '\n');
  const bytes = await download(url, file);
  return { file, bytes, downloaded: true };
}

/**
 * Lichess dumps are a skippable zstd frame followed by several concatenated
 * zstd frames (the producer flushes every 32 MiB of output). Node's
 * zstdDecompressSync decodes exactly one frame, so walk the frame structure
 * (RFC 8878) and decode each frame separately. The walk also rejects a corrupt
 * or truncated file instead of silently returning partial data.
 */
function zstdFrameRanges(buf) {
  const ranges = [];
  let p = 0;
  while (p + 4 <= buf.length) {
    const magic = buf.readUInt32LE(p);
    if ((magic & 0xFFFFFFF0) === 0x184D2A50) { // skippable frame
      if (p + 8 > buf.length) throw new Error('truncated skippable frame');
      const n = buf.readUInt32LE(p + 4);
      p += 8 + n;
      if (p > buf.length) throw new Error('skippable frame overrun');
      continue;
    }
    if (magic !== 0xFD2FB528) throw new Error('bad zstd magic at offset ' + p);
    let q = p + 4;
    const fhd = buf[q++];
    if (fhd & 0x18) throw new Error('reserved zstd header bits set');
    const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dict = fhd & 3;
    if (!single) q += 1; // window descriptor
    q += [0, 1, 2, 4, 8][dict];
    q += single ? (fcsFlag === 0 ? 1 : [0, 2, 4, 8][fcsFlag]) : [0, 2, 4, 8][fcsFlag];
    for (;;) {
      if (q + 3 > buf.length) throw new Error('truncated zstd block');
      const bh = buf[q] | (buf[q + 1] << 8) | (buf[q + 2] << 16);
      q += 3;
      const last = bh & 1, type = (bh >> 1) & 3, size = bh >> 3;
      if (type === 3) throw new Error('reserved zstd block type');
      q += type === 1 ? 1 : size; // raw/compressed: size bytes; RLE: 1 byte
      if (q > buf.length) throw new Error('zstd block overrun');
      if (last) break;
    }
    if (checksum) q += 4;
    if (q > buf.length) throw new Error('zstd frame overrun');
    ranges.push([p, q]);
    p = q;
  }
  if (p !== buf.length) throw new Error('trailing bytes after last zstd frame');
  return ranges;
}

function decompressZst(file) {
  const raw = fs.readFileSync(file);
  const ranges = zstdFrameRanges(raw);
  const parts = [];
  let total = 0;
  for (const [s, e] of ranges) {
    const out = zlib.zstdDecompressSync(raw.subarray(s, e), { maxOutputLength: 8 * 1024 ** 3 });
    parts.push(out);
    total += out.length;
  }
  return Buffer.concat(parts, total).toString('utf8');
}

// ---------------------------------------------------------------------------
// Game block scanning (headers only first: replay is the expensive part)
// ---------------------------------------------------------------------------

const EVENT_MARK = '[Event ';

function* blockRanges(text) {
  let start = text.indexOf(EVENT_MARK);
  while (start >= 0) {
    const next = text.indexOf(EVENT_MARK, start + EVENT_MARK.length);
    const end = next < 0 ? text.length : next;
    yield [start, end];
    start = next;
  }
}

function headersOf(text, start, end) {
  // Header section of a PGN block is small; cap the slice so this stays cheap.
  return P.parseGameMeta(text.slice(start, Math.min(end, start + 4000))).headers;
}

function timeControlBase(tc) {
  if (!tc || tc === '-' || tc === '?') return null;
  const m = /^(\d+)(?:\+(\d+(?:\.\d+)?))?$/.exec(tc.trim());
  if (!m) return null;
  return parseInt(m[1], 10);
}

/**
 * Lichess downloads in test/human-games carry a GameId header; the database
 * dumps do not, so the id is the last path segment of the Site URL.
 */
function idOf(h) {
  if (h.GameId) return h.GameId;
  const site = h.Site || '';
  const m = /lichess\.org\/([A-Za-z0-9]+)\s*$/.exec(site);
  return m ? m[1] : '';
}

function dumpFilter(h, o) {
  if ((h.Variant || 'Standard') !== 'Standard') return 'variant';
  if (h.SetUp === '1' || h.FEN) return 'from-position';
  if (!RESULT_SET.has(h.Result)) return 'result';
  if ((h.Termination || 'Normal') !== 'Normal') return 'termination';
  if (!idOf(h)) return 'no-id';
  const base = timeControlBase(h.TimeControl);
  if (base === null) return 'time-control';
  if (base < o.minBaseSeconds) return 'too-fast';
  const we = parseInt(h.WhiteElo || '', 10);
  const be = parseInt(h.BlackElo || '', 10);
  if (!(we >= o.minElo) || !(be >= o.minElo)) return 'low-rated';
  return null;
}

// ---------------------------------------------------------------------------
// Legacy in-repo PGNs
// ---------------------------------------------------------------------------

function loadLegacy(o) {
  if (!o.legacy || !fs.existsSync(LEGACY_DIR)) return { games: [], files: [], plies: 0 };
  const files = fs.readdirSync(LEGACY_DIR).filter(f => f.endsWith('.pgn')).sort();
  if (!files.length) return { games: [], files: [], plies: 0 };
  const texts = files.map(f => fs.readFileSync(path.join(LEGACY_DIR, f), 'utf8'));
  const parsed = P.parseGames(texts);
  const games = parsed.games
    .filter(g => RESULT_SET.has(g.result) && g.moves.length >= o.minPlies)
    .map(g => ({
      id: g.id,
      result: g.result,
      whiteElo: g.whiteElo || 0,
      blackElo: g.blackElo || 0,
      timeControl: g.timeControl || '?',
      source: 'test/human-games',
      moves: g.moves,
    }));
  return { games, files, plies: parsed.plies, skipped: parsed.skipped };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const sources = [];

  // ---- legacy -------------------------------------------------------------
  const legacy = loadLegacy(o);
  sources.push({
    name: 'test/human-games/*.pgn',
    files: legacy.files,
    license: 'CC0-1.0',
    gamesUsed: legacy.games.length,
    pliesParsed: legacy.plies,
    note: 'per-account Lichess API exports already in the repository; no rating/termination filters, min plies ' + o.minPlies,
  });

  // ---- dump months --------------------------------------------------------
  const selected = []; // {id, result, elos, tc, source, month}
  const seen = new Set(legacy.games.map(g => g.id));
  for (const month of o.months) {
    const dl = await ensureDump(month, o.rawDir, o.download);
    const text = decompressZst(dl.file);
    const url = DUMP_BASE + 'lichess_db_standard_rated_' + month + '.pgn.zst';

    const reject = new Map();
    const candidates = [];
    let blocks = 0;
    for (const [start, end] of blockRanges(text)) {
      blocks++;
      const h = headersOf(text, start, end);
      const why = dumpFilter(h, o);
      if (why) {
        reject.set(why, (reject.get(why) || 0) + 1);
        continue;
      }
      candidates.push({
        id: idOf(h),
        hash: hash32('frnn1-games ' + idOf(h)),
        result: h.Result,
        whiteElo: parseInt(h.WhiteElo, 10) || 0,
        blackElo: parseInt(h.BlackElo, 10) || 0,
        timeControl: h.TimeControl || '?',
      });
    }
    candidates.sort((a, b) => a.hash - b.hash || (a.id < b.id ? -1 : 1));
    // Spread the quota evenly over the requested months so a single dump cannot
    // dominate the dataset.
    const quota = Math.max(0, Math.ceil(o.maxDumpGames / o.months.length));
    const picked = candidates.slice(0, quota);
    for (const c of picked) if (!seen.has(c.id)) { seen.add(c.id); selected.push({ ...c, month, source: 'lichess-db/' + month }); }

    if (!o.statsOnly) {
      const want = new Map(picked.map(p => [p.id, p]));
      const found = new Map();
      for (const [start, end] of blockRanges(text)) {
        const h = headersOf(text, start, end);
        const id = idOf(h);
        if (!id || !want.has(id) || found.has(id)) continue;
        const r = P.parseGame(text.slice(start, end));
        if (r.skip) { found.set(id, null); continue; }
        found.set(id, r.game);
      }
      let replayed = 0;
      for (const c of picked) {
        const g = found.get(c.id);
        if (!g || g.moves.length < o.minPlies) continue;
        selected[selected.findIndex(s => s.id === c.id)].moves = g.moves;
        replayed++;
      }
      sources.push({
        name: 'lichess_db_standard_rated_' + month,
        url, license: 'CC0-1.0', bytes: dl.bytes,
        downloadedThisRun: dl.downloaded,
        blocks, candidates: candidates.length, picked: picked.length, replayed,
        rejected: Object.fromEntries([...reject.entries()].sort()),
      });
    } else {
      sources.push({
        name: 'lichess_db_standard_rated_' + month,
        url, license: 'CC0-1.0', bytes: dl.bytes, blocks, candidates: candidates.length,
        picked: picked.length,
        rejected: Object.fromEntries([...reject.entries()].sort()),
      });
    }
    process.stderr.write(month + ': blocks=' + blocks + ' passing filters=' + candidates.length +
      ' picked=' + picked.length + '\n');
  }

  if (o.statsOnly) {
    console.log(JSON.stringify(sources, null, 2));
    return;
  }

  // ---- assemble -----------------------------------------------------------
  const games = legacy.games.concat(selected.filter(g => g.moves && g.moves.length >= o.minPlies));
  games.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const lines = [];
  let plies = 0;
  const resultCounts = { '1-0': 0, '0-1': 0, '1/2-1/2': 0 };
  const splitCounts = { train: 0, val: 0, test: 0 };
  const splitPlies = { train: 0, val: 0, test: 0 };
  let eloSum = 0, eloN = 0;
  for (const g of games) {
    const split = splitOf(g.id);
    resultCounts[g.result]++;
    splitCounts[split]++;
    splitPlies[split] += g.moves.length;
    plies += g.moves.length;
    if (g.whiteElo && g.blackElo) { eloSum += (g.whiteElo + g.blackElo) / 2; eloN++; }
    lines.push([g.id, g.result, g.whiteElo, g.blackElo, g.timeControl, g.source,
      g.moves.join(' ')].join('\t'));
  }

  const header = [
    '# FRNN1 NNUE game dataset (experimental).',
    '# license: CC0 1.0. Sources: Lichess standard rated database dumps and',
    '# test/human-games/*.pgn (Lichess API exports). See data/nnue/dataset.meta.json',
    '# and docs/NNUE.md for provenance, filters and the game-level split.',
    '# fields: id \\t result \\t whiteElo \\t blackElo \\t timeControl \\t source \\t uci moves',
    '# games: ' + games.length + ' plies: ' + plies,
    '# split: FNV-1a32("frnn1-split " + id) % 100 < 70 train, < 85 val, else test',
  ].join('\n');

  const text = header + '\n' + lines.join('\n') + '\n';
  fs.mkdirSync(path.dirname(OUT_TXT), { recursive: true });
  fs.writeFileSync(OUT_TXT, text);

  const meta = {
    schema: 'games.txt: id \\t result \\t whiteElo \\t blackElo \\t timeControl \\t source \\t uci moves',
    license: 'CC0 1.0 Universal (public domain dedication)',
    licenseSource: 'https://database.lichess.org/ — "Database exports are released under the Creative Commons CC0 license. Use them for research, commercial purpose, publication, anything you like ... without asking for permission."',
    generatedAt: new Date().toISOString(),
    generator: 'tools/nnue/dataset.js',
    command: 'node tools/nnue/dataset.js ' + process.argv.slice(2).join(' '),
    filters: {
      dumpGames: {
        variant: 'Standard',
        setUpFen: 'rejected',
        result: [...RESULT_SET],
        termination: 'Normal',
        timeControlBaseSeconds: '>= ' + o.minBaseSeconds,
        bothRatings: '>= ' + o.minElo,
        minPlies: o.minPlies,
      },
      legacyGames: { minPlies: o.minPlies, note: 'no rating/termination filter (all standard games in the repo exports)' },
      selection: 'lowest FNV-1a32("frnn1-games " + GameId) among games passing the filters, capped at --max-dump-games per run',
    },
    sources,
    totals: {
      games: games.length,
      plies,
      avgPlies: +(plies / games.length).toFixed(1),
      results: resultCounts,
      draws: resultCounts['1/2-1/2'],
      avgRating: eloN ? Math.round(eloSum / eloN) : null,
      splitRule: 'FNV-1a32("frnn1-split " + id) % 100 < 70 -> train, < 85 -> val, else test (game level, no leakage)',
      splitGames: splitCounts,
      splitPlies,
    },
    output: {
      file: path.relative(ROOT, OUT_TXT).replace(/\\/g, '/'),
      bytes: fs.statSync(OUT_TXT).size,
      sha256: sha256(text),
    },
    elapsedSeconds: +((Date.now() - started) / 1000).toFixed(1),
  };
  fs.writeFileSync(OUT_META, JSON.stringify(meta, null, 2) + '\n');

  console.log('games: ' + games.length + ' plies: ' + plies + ' (avg ' + meta.totals.avgPlies + ')');
  console.log('split games: train ' + splitCounts.train + ' / val ' + splitCounts.val + ' / test ' + splitCounts.test);
  console.log('split plies: train ' + splitPlies.train + ' / val ' + splitPlies.val + ' / test ' + splitPlies.test);
  console.log('results: ' + resultCounts['1-0'] + ' white wins, ' + resultCounts['0-1'] +
    ' black wins, ' + resultCounts['1/2-1/2'] + ' draws; avg rating ' + meta.totals.avgRating);
  console.log('wrote ' + OUT_TXT + ' (' + meta.output.bytes + ' bytes, sha256 ' + meta.output.sha256.slice(0, 16) + '…)');
  console.log('wrote ' + OUT_META);
}

function splitOf(id) {
  const h = hash32('frnn1-split ' + id) % 100;
  return h < 70 ? 'train' : h < 85 ? 'val' : 'test';
}

main().catch(err => {
  console.error('dataset: ' + err.message);
  process.exit(1);
});
