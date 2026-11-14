'use strict';

/*
 * Downloads licensed human games from Lichess and turns them into a compact
 * JSON dataset for human-move prediction research.
 *
 *   node test/fetch-human-games.js               # fetch (if missing) then parse
 *   node test/fetch-human-games.js --parse-only  # never touch the network
 *   node test/fetch-human-games.js --offline     # same as --parse-only
 *   node test/fetch-human-games.js --fetch       # force refetch (rate limited!)
 *
 * LICENSE / PROVENANCE
 *   Lichess database exports are CC0:
 *   "Database exports are released under the Creative Commons CC0 license. Use
 *    them for research, commercial purpose, publication, anything you like...
 *    without asking for permission."  (https://database.lichess.org/)
 *   Nothing else is used here. No credentials, no logged-in account, no scraping
 *   of pages that forbid it. Requests are throttled (>= 4 s apart) and the whole
 *   run stays under the ~15 requests Lichess asks a single script to make.
 *
 * POLITY
 *   - one request per account, `max` games per request, small
 *   - descriptive User-Agent, required by Lichess' API etiquette
 *   - only Variant "Standard"; games started from a custom FEN are dropped
 *
 * OUTPUT
 *   test/human-games/*.pgn          raw exports kept on disk (one file/account)
 *   test/data/human-games.json      parsed games  {id,url,...,moves:[uci]}
 *   test/data/human-games.meta.json provenance + the deterministic train/eval split
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const e = require(path.join(ROOT, 'engine.js'));

const PGN_DIR = path.join(__dirname, 'human-games');
const DATA_DIR = path.join(__dirname, 'data');
const OUT_JSON = path.join(DATA_DIR, 'human-games.json');
const OUT_META = path.join(DATA_DIR, 'human-games.meta.json');

const USER_AGENT = 'KiwaChess-training/1.0 (offline research dataset builder; https://github.com/)';
const SECONDS_BETWEEN_REQUESTS = 5;
const REQUEST_TIMEOUT_MS = 90000;

// --- accounts ---------------------------------------------------------------
//
// Chosen for spread of rating and style, NOT volume from one player. Every
// account below is a public Lichess player; elo shown is the rating observed in
// the games that were exported (see `observedElo` in the meta file).
const ACCOUNTS = [
  { username: 'german11', max: 300, why: 'low-rated amateur (~1100 blitz), very active, casual style' },
  { username: 'aalex2025', max: 300, why: 'amateur (~1250 blitz)' },
  { username: 'challenger555', max: 300, why: 'amateur (~1300-1500 blitz)' },
  { username: 'Ayaan-07', max: 300, why: 'amateur (~1400-1600 blitz)' },
  { username: 'khaire_Mourad', max: 300, why: 'amateur (~1500 blitz)' },
  { username: 'Yansoon', max: 300, why: 'club level (~1550-1650 blitz)' },
  { username: 'Bondar_Evgeniy', max: 300, why: 'strong club (~1750-1800 blitz)' },
  { username: 'penguingm1', max: 300, why: 'titled master (GM/2500+), sharp modern opening repertoire' },
];

// --- fetching ---------------------------------------------------------------

function get(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/x-chess-pgn', 'Accept-Encoding': 'identity' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`)));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timeout after ' + REQUEST_TIMEOUT_MS + 'ms')));
    req.on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchAll(force) {
  fs.mkdirSync(PGN_DIR, { recursive: true });
  const results = [];
  let requests = 0;
  for (const acct of ACCOUNTS) {
    const file = path.join(PGN_DIR, `${acct.username}.pgn`);
    if (fs.existsSync(file) && fs.statSync(file).size > 200 && !force) {
      results.push({ username: acct.username, cached: true, file: path.relative(ROOT, file) });
      continue;
    }
    if (requests > 0) await sleep(SECONDS_BETWEEN_REQUESTS * 1000);
    const url = `https://lichess.org/api/games/user/${encodeURIComponent(acct.username)}`
      + `?max=${acct.max}&pgnInJson=false&clocks=false&evals=false&opening=false&moves=true&tags=true&sort=DateDesc`;
    process.stderr.write(`[fetch] ${acct.username} (max=${acct.max}) ...\n`);
    requests++;
    try {
      const body = await get(url);
      fs.writeFileSync(file, body, 'utf8');
      process.stderr.write(`[fetch] ${acct.username}: ${(body.length / 1024).toFixed(1)} KB\n`);
      results.push({ username: acct.username, cached: false, bytes: body.length, url, file: path.relative(ROOT, file) });
    } catch (err) {
      process.stderr.write(`[fetch] ${acct.username} FAILED: ${err.message}\n`);
      results.push({ username: acct.username, cached: false, error: String(err.message || err), url });
    }
  }
  return { results, requests };
}

// --- PGN parsing ------------------------------------------------------------

// PGN: a tag block, blank line(s), move text, then one blank line between games.
// Blank lines inside a game (very common between the tags and the moves) must
// NOT end the game, so a game only ends at a blank line that follows move text.
function splitGames(text) {
  const games = [];
  let cur = [];
  let hasMoveText = false;
  const flush = () => { if (cur.length) games.push(cur.join('\n')); cur = []; hasMoveText = false; };
  for (const rawLine of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    if (line === '') {
      if (hasMoveText) flush();
      continue;
    }
    if (hasMoveText && /^\[\s*Event\b/.test(line.trim())) flush(); // no blank line between games
    cur.push(line);
    if (!/^\[/.test(line.trim())) hasMoveText = true;
  }
  flush();
  return games.filter(g => /^\[\s*(Event|White)\b/m.test(g) && /\d+\./.test(g));
}

function parseHeaders(block) {
  const headers = {};
  const re = /^\[\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]$/;
  let m;
  const lines = block.split('\n');
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\[/.test(line.trim())) break;
    m = re.exec(line.trim());
    if (m) headers[m[1]] = m[2].replace(/\\(["\\])/g, '$1');
  }
  return { headers, movetext: lines.slice(i).join('\n') };
}

function stripVariations(mt) {
  let out = mt;
  for (;;) {
    const next = out.replace(/\([^()]*\)/g, ' ');
    if (next === out) return next;
    out = next;
  }
}

function tokenize(movetext) {
  let mt = movetext.replace(/\{[^}]*\}/g, ' ');
  mt = stripVariations(mt);
  mt = mt.replace(/\$\d+/g, ' ');
  const toks = [];
  for (let t of mt.split(/\s+/)) {
    if (!t) continue;
    if (/^\d+\.+$/.test(t)) {
      // "3." or "3..." prefixes glued to a move, e.g. "3.e4"
      const rest = t.replace(/^\d+\.+/, '');
      if (rest) toks.push(rest);
      continue;
    }
    toks.push(t);
  }
  return toks;
}

// SAN -> UCI against the current engine position (same approach as gen-book.js).
function sanToUci(san) {
  let s = String(san).trim().replace(/\s+/g, '');
  s = s.replace(/[+#!?]+$/, '');
  if (!s) return null;
  const legal = e.getLegalMoves();
  if (!legal.length) return null;

  if (/^O-?O-?O$|^0-?0-?0$/i.test(s)) {
    for (const mv of legal) {
      const d = e.describeMove(mv);
      if (d.castle && (d.to === 2 || d.to === 114)) return e.moveToStr(mv);
    }
    return null;
  }
  if (/^O-?O$|^0-?0$/i.test(s)) {
    for (const mv of legal) {
      const d = e.describeMove(mv);
      if (d.castle && (d.to === 6 || d.to === 118)) return e.moveToStr(mv);
    }
    return null;
  }

  const m = s.match(/([a-h][1-8])(?:=?([QRBN]))?$/);
  if (!m) return null;
  const toStr = m[1];
  const promoChar = m[2] || '';
  const to = (toStr.charCodeAt(1) - 49) * 16 + (toStr.charCodeAt(0) - 97);
  const destIdx = s.lastIndexOf(toStr);
  let prefix = s.slice(0, destIdx);
  let pieceType = 1; // pawn
  const PIECE_FROM_SAN = { K: 6, Q: 5, R: 4, B: 3, N: 2 };
  if (/^[KQRBN]/.test(prefix)) {
    pieceType = PIECE_FROM_SAN[prefix[0]];
    prefix = prefix.slice(1);
  }
  prefix = prefix.replace(/x/g, '');
  let fromFile = -1, fromRank = -1;
  for (const ch of prefix) {
    if (ch >= 'a' && ch <= 'h') fromFile = ch.charCodeAt(0) - 97;
    else if (ch >= '1' && ch <= '8') fromRank = ch.charCodeAt(0) - 49;
  }
  const isCapture = s.includes('x');
  const promo = promoChar ? ' PNBRQ'.indexOf(promoChar) : 0;

  for (const mv of legal) {
    const d = e.describeMove(mv);
    if (d.piece !== pieceType || d.to !== to) continue;
    if (fromFile >= 0 && (d.from & 7) !== fromFile) continue;
    if (fromRank >= 0 && (d.from >> 4) !== fromRank) continue;
    if (isCapture && !d.cap) continue;
    if (promo && d.promo !== promo) continue;
    return e.moveToStr(mv);
  }
  return null;
}

const RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '*']);

// Returns {game} or {skip: reason}
function decodeGame(block) {
  const { headers, movetext } = parseHeaders(block);
  const variant = headers.Variant || 'Standard';
  if (variant !== 'Standard') return { skip: 'variant:' + variant };
  if (headers.SetUp === '1' || headers.FEN) return { skip: 'from-position (custom FEN start)' };
  const result = headers.Result || '*';
  if (headers.Termination === 'Aborted') return { skip: 'aborted' };

  const toks = tokenize(movetext);
  const moves = [];
  let lastSeenResult = null;
  for (const t of toks) {
    if (RESULTS.has(t)) { lastSeenResult = t; continue; }
    if (/^\{/.test(t)) continue;
    const uci = sanToUci(t);
    if (!uci) return { skip: 'unparsable SAN token "' + t + '" at ply ' + (moves.length + 1) };
    if (!e.applyUciMove(uci)) return { skip: 'illegal after ' + uci };
    moves.push(uci);
  }
  if (!moves.length) return { skip: 'no moves' };
  if (lastSeenResult !== null && lastSeenResult !== result && result !== '*') {
    return { skip: 'result mismatch ' + result + ' vs ' + lastSeenResult };
  }
  const id = headers.GameId || (headers.Site || '').split('/').pop() || '';
  if (!id) return { skip: 'no game id' };
  return {
    game: {
      id,
      url: headers.Site || `https://lichess.org/game/${id}`,
      white: headers.White || '?',
      black: headers.Black || '?',
      whiteElo: headers.WhiteElo ? +headers.WhiteElo : null,
      blackElo: headers.BlackElo ? +headers.BlackElo : null,
      utcDate: (headers.UTCDate || headers.Date || '?') + (headers.UTCTime ? 'T' + headers.UTCTime.replace(/:/g, '-') : ''),
      result,
      timeControl: headers.TimeControl || '?',
      termination: headers.Termination || '?',
      moves,
    },
  };
}

function gamesFromPgnFiles(files) {
  const out = [];
  const skipped = new Map();
  const seenIds = new Set();
  let plies = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    let n = 0;
    e.setFen(e.START_FEN);
    for (const block of splitGames(text)) {
      n++;
      e.setFen(e.START_FEN); // decodeGame walks the game forward; start every game fresh
      const r = decodeGame(block);
      if (r.skip) {
        const key = r.skip.split(/["0-9]/)[0].trim().slice(0, 28);
        skipped.set(key, (skipped.get(key) || 0) + 1);
        continue;
      }
      if (seenIds.has(r.game.id)) { skipped.set('duplicate-game', (skipped.get('duplicate-game') || 0) + 1); continue; }
      seenIds.add(r.game.id);
      // sanity: replay from the start position and confirm the move list is legal
      e.setFen(e.START_FEN);
      let ok = true;
      for (const mv of r.game.moves) if (!e.applyUciMove(mv)) { ok = false; break; }
      if (!ok) { skipped.set('replay-failed', (skipped.get('replay-failed') || 0) + 1); continue; }
      out.push(r.game);
      plies += r.game.moves.length;
    }
    process.stderr.write(`[parse] ${path.basename(file)}: ${n} games read\n`);
  }
  return { games: out, plies, skipped };
}

// --- split ------------------------------------------------------------------
//
// Deterministic: seed a string into a 32-bit hash per game id. Same games in,
// same split out, no matter the array order. 25% of the games go to eval.
function hash32(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 15;
  return h >>> 0;
}

const SPLIT_SEED = 'kiwa-human-games-v1';
const EVAL_FRACTION_THRESHOLD = 1 << 30; // ~25% of the 2^32 hash space

function splitFor(id) {
  return (hash32(SPLIT_SEED + ' ' + id) % 1000) < 250 ? 'eval' : 'train';
}

// --- main -------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const parseOnly = argv.includes('--parse-only') || argv.includes('--offline') || argv.includes('--no-fetch');
  const force = argv.includes('--fetch');

  fs.mkdirSync(PGN_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let fetchInfo = { results: [], requests: 0, skipped: true };
  if (!parseOnly) {
    const info = await fetchAll(force);
    fetchInfo = { ...info, skipped: false };
  }

  const files = fs.readdirSync(PGN_DIR).filter(f => f.endsWith('.pgn')).sort().map(f => path.join(PGN_DIR, f));
  if (!files.length) {
    console.error('No PGN files in test/human-games/ and fetching is disabled. Nothing to parse.');
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`[parse] ${files.length} PGN file(s)\n`);
  const { games, plies, skipped } = gamesFromPgnFiles(files);

  // stable order: newest first, then by id, so the split never shuffles
  games.sort((a, b) => (b.utcDate < a.utcDate ? -1 : b.utcDate > a.utcDate ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const train = [], eval_ = [];
  for (const g of games) (splitFor(g.id) === 'eval' ? eval_ : train).push(g);

  const observedElo = {};
  for (const acct of ACCOUNTS) {
    const elos = [];
    for (const g of games) {
      if (g.white === acct.username && g.whiteElo) elos.push(g.whiteElo);
      if (g.black === acct.username && g.blackElo) elos.push(g.blackElo);
    }
    if (elos.length) observedElo[acct.username] = {
      games: elos.length, min: Math.min(...elos), max: Math.max(...elos),
      median: elos.sort((x, y) => x - y)[elos.length >> 1],
    };
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify({ games }), 'utf8');

  // Re-parsing offline must not rewrite history: keep the real fetch date and
  // request log from the first download that produced this dataset.
  let prior = {};
  try { prior = JSON.parse(fs.readFileSync(OUT_META, 'utf8')); } catch { /* first build */ }
  const preserved = fetchInfo.skipped && prior.fetchDate ? {
    fetchDate: prior.fetchDate,
    requestsMade: prior.requestsMade,
    perFetchLog: prior.perFetchLog,
    accounts: prior.accounts || undefined,
    reparsedAt: new Date().toISOString(),
  } : { fetchDate: new Date().toISOString(), requestsMade: fetchInfo.requests, perFetchLog: fetchInfo.results };

  const meta = {
    dataset: 'human-games',
    schema: 'games: [{id,url,white,black,whiteElo,blackElo,utcDate,result,timeControl,moves:[uci]}] in human-games.json',
    license: 'CC0 1.0 Universal (public domain dedication)',
    licenseSource: 'https://database.lichess.org/ - "Database exports are released under the Creative Commons CC0 license. Use them for research, commercial purpose, publication, anything you like ... without asking for permission."',
    upstream: 'Lichess game export API, https://lichess.org/api/games/user/{username} (public games, no auth, no credentials used)',
    fetchedWith: 'test/fetch-human-games.js',
    userAgent: USER_AGENT,
    secondsBetweenRequests: SECONDS_BETWEEN_REQUESTS,
    ...preserved,
    accounts: preserved.accounts || ACCOUNTS.map(a => ({ username: a.username, requestedMax: a.max, why: a.why, observedElo: observedElo[a.username] || null, files: `test/human-games/${a.username}.pgn` })),
    requestsSkippedBecauseCached: fetchInfo.skipped,
    observedEloThisParse: observedElo,
    totals: {
      games: games.length,
      plies: plies,
      avgPliesPerGame: +(plies / Math.max(1, games.length)).toFixed(2),
      trainGames: train.length,
      evalGames: eval_.length,
      trainPlies: train.reduce((s, g) => s + g.moves.length, 0),
      evalPlies: eval_.reduce((s, g) => s + g.moves.length, 0),
    },
    dropped: Object.fromEntries(skipped),
    dropRules: [
      'Variant other than Standard',
      'games with SetUp/FEN (started from a non-standard position: ply numbers would not mean the same thing)',
      'Termination "Aborted"',
      'games whose SAN fails to map onto a legal engine move at any ply (whole game dropped, no partial plies kept)',
      'games whose replay from the start position does not end legally',
      'duplicate GameId',
      'result tag disagreeing with the moves',
      'empty move list - in this download those were all Termination "Abandoned" games where the player left before move 1, i.e. no human moves exist to learn from',
    ],
    split: {
      method: 'FNV-1a hash32 of "' + SPLIT_SEED + ' <gameId>" mod 1000 < 250  =>  eval, else train',
      seed: SPLIT_SEED,
      evalShareTarget: '25%',
      note: 'split by GAME, never by ply, so no two plies of one game straddle the sets',
      evalGameIds: eval_.map(g => g.id),
      trainGameIds: train.map(g => g.id),
    },
    caveats: [
      'Lichess blitz/bullet games from amateur accounts contain blunders; they teach what typical club humans play, not what is good.',
      'One account is a titled master, so the rating pool is wide; a rating-conditioned prior is a later refinement.',
      'Move lists are complete games; a ply of one side is one human decision.',
    ],
  };
  fs.writeFileSync(OUT_META, JSON.stringify(meta, null, 2), 'utf8');

  console.log(`\ngames: ${games.length}  plies: ${plies}  (train ${train.length}/${train.reduce((s, g) => s + g.moves.length, 0)} plies, eval ${eval_.length}/${eval_.reduce((s, g) => s + g.moves.length, 0)} plies)`);
  console.log(`dropped: ${JSON.stringify(Object.fromEntries(skipped))}`);
  console.log(`wrote ${path.relative(ROOT, OUT_JSON)} (${(fs.statSync(OUT_JSON).size / 1024).toFixed(1)} KB)`);
  console.log(`wrote ${path.relative(ROOT, OUT_META)}`);
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });

module.exports = { decodeGame, splitGames, tokenize, sanToUci, gamesFromPgnFiles, ACCOUNTS, hash32, splitFor };
