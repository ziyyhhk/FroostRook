'use strict';

/*
 * Builds Kiwa's opening book from the lichess-org/chess-openings database plus
 * a small curated set of gambit/trap lines.
 *
 * Input:  book-data/{a,b,c,d,e}.tsv  (eco \t name \t pgn)
 *         book-data/traps.tsv        (same columns, optional)
 * Output: book.js — FEN-keyed, weighted, used by the UCI front-end only.
 *
 * A move that hands the opponent mate in one is never stored: the named-line
 * database records both sides of famous miniatures (Fool's Mate, Scholar's
 * Mate), and a book should not reproduce the losing side of a trick.
 *
 * Run with: node test/gen-book.js
 * Refresh data: curl -O https://raw.githubusercontent.com/lichess-org/chess-openings/master/{a,b,c,d,e}.tsv
 */

const fs = require('fs');
const path = require('path');
const e = require('../engine.js');

const DATA = path.join(__dirname, '..', 'book-data');
const OUT = path.join(__dirname, '..', 'book.js');

// --- SAN (as written in the TSV) -> UCI ------------------------------------

function sanToUci(san) {
  let s = String(san).trim().replace(/\s+/g, '');
  s = s.replace(/[+#!?]+$/, '');
  const legal = e.getLegalMoves();
  if (!legal.length) return null;

  if (s === 'O-O' || s === '0-0') {
    for (const mv of legal) {
      const d = e.describeMove(mv);
      if (d.castle && (d.to === 6 || d.to === 118)) return e.moveToStr(mv);
    }
    return null;
  }
  if (s === 'O-O-O' || s === '0-0-0') {
    for (const mv of legal) {
      const d = e.describeMove(mv);
      if (d.castle && (d.to === 2 || d.to === 114)) return e.moveToStr(mv);
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
  let fromFile = -1;
  let fromRank = -1;
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

function tokensOf(pgn) {
  return pgn
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s+/)
    .filter(t => t && !/^\d+\.+$/.test(t));
}

// --- build -----------------------------------------------------------------

function keyOf(fen) {
  // Board + side + castling. En passant is deliberately excluded: most GUIs
  // normalise the ep square to "-", and it only changes the legal moves in a
  // vanishingly small share of opening positions.
  return fen.split(' ').slice(0, 3).join(' ');
}

// True when, after the move already played into `afterFen`, the side to move
// has a checkmating reply. Called once per candidate book move.
function allowsMateInOne(afterFen) {
  e.setFen(afterFen);
  const replies = e.getLegalMoves().map(e.moveToStr);
  for (const r of replies) {
    e.setFen(afterFen);
    e.applyUciMove(r);
    if (e.inCheck() && e.getLegalMoves().length === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Opening personality tags
//
// The named-line database has no style metadata, so each line is classified
// from its family and title. A line can belong to several personalities; the
// tag is a preference, never a claim that the line is good or bad. The search
// still validates questionable choices and the book always falls back to the
// balanced weights when a personality has nothing to offer in a position.
// ---------------------------------------------------------------------------

const MAIN_FAMILIES = [
  'Sicilian Defense', 'Ruy Lopez', 'French Defense', 'Caro-Kann Defense',
  "Queen's Gambit Declined", "Queen's Gambit Accepted", 'Italian Game',
  'English Opening', "King's Indian Defense", 'Nimzo-Indian Defense',
  'Grünfeld Defense', 'Neo-Grünfeld Defense', 'Slav Defense', 'Semi-Slav Defense',
  "Queen's Indian Defense", 'Catalan Opening', 'Scotch Game', 'Four Knights Game',
  'Vienna Game', "Bishop's Opening", "Petrov's Defense", 'Philidor Defense',
  'Alekhine Defense', 'Scandinavian Defense', "King's Gambit Accepted",
  "King's Gambit Declined", 'Dutch Defense', 'Benoni Defense', 'Modern Defense',
  'Pirc Defense', 'Réti Opening', 'Zukertort Opening', 'Bogo-Indian Defense',
  'Tarrasch Defense', "Queen's Pawn Game", "King's Pawn Game", 'Indian Defense',
  'London System', 'Trompowsky Attack', 'Torre Attack', 'Colle System',
  'Benko Gambit', 'Evans Gambit', 'Danish Gambit', 'Scotch Gambit',
  'Budapest Defense', 'Blackmar-Diemer Gambit', 'Two Knights Defense',
  'Nimzowitsch Defense', 'Center Game', 'Bird Opening', 'Nimzo-Larsen Attack',
  'Polish Opening', 'Hungarian Opening', 'Van Geet Opening', 'Ponziani Opening',
  'Three Knights Opening', 'Rubinstein Opening', "King's Pawn Opening",
  "King's Indian Attack", "King's Gambit", "Queen's Gambit",
];

const SOLID_FAMILIES = [
  'Caro-Kann Defense', 'French Defense', "Queen's Gambit Declined", 'Slav Defense',
  'Semi-Slav Defense', 'Catalan Opening', "Queen's Indian Defense",
  'Nimzo-Indian Defense', 'Bogo-Indian Defense', "Petrov's Defense",
  'Philidor Defense', 'Four Knights Game', "Bishop's Opening", 'London System',
  'Colle System', 'Réti Opening', 'English Opening', "King's Indian Attack",
  'Tarrasch Defense', 'Stonewall Attack', 'Symmetrical Defense', 'Hedgehog Defense',
  "Queen's Pawn Game", 'Indian Defense', 'Old Indian Defense', 'Rubinstein Opening',
];

const SHARP_FAMILIES = [
  'Sicilian Defense', "King's Indian Defense", 'Grünfeld Defense', 'Dutch Defense',
  'Benoni Defense', 'Pirc Defense', 'Modern Defense', 'Alekhine Defense',
  "King's Gambit Accepted", "King's Gambit Declined", 'Evans Gambit',
  'Danish Gambit', 'Scotch Game', 'Scotch Gambit', 'Vienna Game',
  'Two Knights Defense', 'Latvian Gambit', 'Elephant Gambit', 'Halloween Gambit',
  'Blackmar-Diemer Gambit', 'Budapest Defense', 'Benko Gambit',
  'Trompowsky Attack', 'Pseudo-Trompowsky Attack', 'Richter-Veresov Attack', 'Center Game', 'Englund Gambit',
  'Nimzowitsch Defense', 'Owen Defense', 'St. George Defense',
  'Pterodactyl Defense', 'Blumenfeld Countergambit', 'Neo-Grünfeld Defense',
  'Lion Defense', 'English Orangutan', 'Amazon Attack',
];

const OFFBEAT_FAMILIES = [
  'Amar Opening', 'Grob Opening', 'Van Geet Opening', "Van't Kruijs Opening",
  'Polish Opening', 'Bird Opening', 'Hungarian Opening', 'Kádas Opening',
  'Ware Opening', 'Ware Defense', 'Barnes Opening', 'Anderssen Opening',
  'Clemenz Opening', 'Sokolsky Opening', 'Mieses Opening', 'Nimzo-Larsen Attack',
  'Pterodactyl Defense', 'Rat Defense', 'Owen Defense', 'English Defense',
  'Global Opening', 'Borg Opening', 'Borg Defense', 'Duras Gambit',
  'Muhring Gambit', 'Saragossa Opening', 'Döry Defense', 'Dunst Opening',
  'Sodium Attack', 'Mikenas Defense', 'Kangaroo Defense', 'Bogoljubow Defense',
  'Tennison Gambit', 'Portuguese Opening', 'Lasker Simul Special', 'Amazon Attack',
  'Marienbad System', 'Mexican Defense', 'Carr Defense', 'Goldsmith Defense',
  'Hippopotamus Defense', 'Formation', 'Rapport-Jobava System',
  'Pseudo-Trompowsky Attack',
  'English Orangutan', 'Polish Defense', 'Zukertort Defense', 'Horwitz Defense',
  'Slav Indian', "Pseudo Queen's Indian Defense", 'Amsterdam Attack',
  'Creepy Crawly Formation', 'Lion Defense',
];

const SHARP_WORDS = /attack|gambit|sacrifice|dragon|najdorf|poisoned|marshall|winawer|sveshnikov|kalashnikov|traxler|liver|halloween|yugoslav|four pawns|sämisch|samisch|averbakh|geller|botvinnik|sharp|storm|benko|alonin|mutkin/i;
const QUIET_WORDS = /closed|quiet|exchange|symmetrical|solid|classical|capablanca|rubinstein|stonewall|hedgehog|berlin|steinitz|petrosian|fortress|positional|maneuver|fianchetto/i;
const GAMBIT_HINT = /gambit|sacrifice|halloween|fried liver|blackburne shilling|stafford|legal trap|englund|latvian|elephant|tennison|nakhmanson|wilkes-barre|rousseau|blackmar-diemer|from's gambit|budapest/i;

// Family names are followed by ':' variations or ', ...' qualifiers, so match
// on a prefix boundary rather than exact equality. Longest match first keeps
// "Queen's Gambit Declined" from being shadowed by a shorter family.
function familyMatch(name, families) {
  let best = null;
  for (const f of families) {
    if (name === f || name.startsWith(f + ':') || name.startsWith(f + ', ') ||
        name.startsWith(f + ' ')) {
      if (!best || f.length > best.length) best = f;
    }
  }
  return best;
}

// Positional play is not the same thing as solid play. Solid marks sturdy
// repertoires; positional marks lines chosen for long-term structure and
// space: closed manoeuvring, exchanges that improve the pawn shape,
// fianchetto systems, space-grabbing English/Réti/Catalan/London setups and
// the quiet main lines of the Ruy Lopez. A line can be both sharp and
// positional (the Maroczy Bind is a good example), and any line with an
// explicit sharp marker loses the positional tag.
const POSITIONAL_FAMILIES = [
  'English Opening', 'Catalan Opening', 'Réti Opening', 'Zukertort Opening',
  'London System', 'Colle System', 'Stonewall Attack', "King's Indian Attack",
  'Nimzo-Indian Defense', "Queen's Indian Defense", 'Bogo-Indian Defense',
  "Queen's Gambit Declined", 'Slav Defense', 'Semi-Slav Defense',
  'Caro-Kann Defense', 'French Defense', 'Ruy Lopez', "Bishop's Opening",
  'Four Knights Game', 'Philidor Defense', 'Hedgehog Defense', 'Tarrasch Defense',
  "Petrov's Defense", 'Nimzo-Larsen Attack', 'Hungarian Opening',
  'Old Indian Defense', "Queen's Pawn Game", 'Indian Game',
];

const POSITIONAL_WORDS = /closed|exchange|fianchetto|classical|positional|maneuver|manoeuvre|bind|hedgehog|blockade|steinitz|berlin|carlsbad|rubinstein|symmetric|quiet|system|main line/i;

const STYLE_COLUMNS = ['balanced', 'mainline', 'aggressive', 'gambit', 'solid', 'surprise', 'positional'];

function classifyLine(name) {
  const n = name.toLowerCase();
  const fam = name.split(':')[0].trim();
  const mainFam = familyMatch(fam, MAIN_FAMILIES);
  const solidFam = familyMatch(fam, SOLID_FAMILIES);
  const sharpFam = familyMatch(fam, SHARP_FAMILIES);
  const offbeatFam = familyMatch(fam, OFFBEAT_FAMILIES);
  const isQueenGambit = /^queen's gambit/i.test(fam);

  const gambit = !isQueenGambit && GAMBIT_HINT.test(n) ? 1 : 0;
  let aggressive = sharpFam ? 1 : 0;
  if (SHARP_WORDS.test(n)) aggressive = 1;
  let solid = solidFam ? 1 : 0;
  if (solid && SHARP_WORDS.test(n)) solid = 0;
  if (solid && QUIET_WORDS.test(n)) solid = 2;
  let mainline = mainFam ? 1 : 0;
  if (offbeatFam) mainline = 0;
  const posFam = familyMatch(fam, POSITIONAL_FAMILIES);
  let positional = posFam || POSITIONAL_WORDS.test(n) ? 1 : 0;
  if (positional && SHARP_WORDS.test(n)) positional = 0;
  if (positional && QUIET_WORDS.test(n)) positional = 2;
  if (positional && gambit && !posFam) positional = 0;
  let surprise = offbeatFam ? 1 : 0;
  if (gambit && !mainline) surprise = 1;
  if (/trap|poisoned|halloween|fried liver|shilling|nakhmanson|wilkes-barre|tennison|saragossa|duras|muhring/i.test(n)) surprise = 1;
  if (!mainline && !solid && !gambit && !aggressive) surprise = 1;
  return {
    balanced: 1,
    mainline,
    aggressive,
    gambit,
    solid,
    surprise,
    positional,
  };
}

const book = new Map(); // FEN-key -> Map(move -> [balanced, mainline, aggressive, gambit, solid, surprise])
let lines = 0;
let plies = 0;
let blunders = 0;
const bad = [];

// A book may be varied, but the first move still has to be a real repertoire
// choice. Novelty first moves (1.g4, 1.Na3, 1.h4, ...) are removed at the
// source; they add nothing but a lost position. Surprise keeps the sound
// offbeat group (b3, g3, b4, f4, Nc3).
const ROOT_FIRST_MOVES = new Set([
  'e2e4', 'd2d4', 'c2c4', 'g1f3', 'b2b3', 'g2g3', 'b2b4', 'f2f4', 'b1c3',
]);

// Sound replies to each normal first move, as full UCI moves. The union is
// baked into the data, so every front-end (native and JS fallback) gets the
// same protection against 1...f6-style novelties. Gambits such as 1.d4 e5 stay
// available to the Gambit personality by including e7e5 here.
const REPLY_MOVES = {
  e2e4: ['e7e5', 'c7c5', 'e7e6', 'c7c6', 'g8f6', 'd7d5', 'b8c6', 'd7d6', 'g7g6', 'b7b6'],
  d2d4: ['g8f6', 'd7d5', 'f7f5', 'g7g6', 'c7c5', 'e7e5', 'e7e6', 'd7d6', 'b8c6', 'c7c6', 'b7b6'],
  c2c4: ['e7e5', 'g8f6', 'e7e6', 'c7c5', 'c7c6', 'f7f5', 'd7d5', 'g7g6'],
  g1f3: ['d7d5', 'g8f6', 'c7c5', 'd7d6', 'f7f5', 'e7e6', 'g7g6', 'b7b6', 'e7e5', 'c7c6'],
  b2b3: ['e7e5', 'd7d5', 'g8f6', 'c7c5', 'e7e6', 'f7f5', 'g7g6', 'c7c6'],
  g2g3: ['d7d5', 'g8f6', 'e7e5', 'c7c5', 'e7e6', 'g7g6', 'c7c6'],
  b2b4: ['e7e5', 'd7d5', 'g8f6', 'c7c5', 'e7e6', 'f7f5', 'g7g6'],
  f2f4: ['d7d5', 'g8f6', 'e7e5', 'c7c5', 'e7e6', 'g7g6', 'c7c6'],
  b1c3: ['d7d5', 'g8f6', 'e7e5', 'c7c5', 'e7e6', 'g7g6', 'c7c6'],
};
const DEFAULT_REPLY_MOVES = [
  'e7e5', 'c7c5', 'e7e6', 'c7c6', 'g8f6', 'd7d5', 'b8c6', 'd7d6', 'g7g6', 'b7b6', 'f7f5',
];
const firstOfKey = new Map(); // key after White's first move -> that move
const START_KEY = keyOf(e.START_FEN);

const FILES = ['a', 'b', 'c', 'd', 'e'];
if (fs.existsSync(path.join(DATA, 'traps.tsv'))) FILES.push('traps');

for (const f of FILES) {
  const file = path.join(DATA, f + '.tsv');
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
  for (const row of rows) {
    const cols = row.split('\t');
    const pgn = cols[2];
    if (!pgn) continue;
    const style = classifyLine(cols[1] || '');
    const tokens = tokensOf(pgn);

    e.setFen(e.START_FEN);
    let ok = true;
    const seen = new Set();
    for (let ti = 0; ti < tokens.length; ti++) {
      const tok = tokens[ti];
      const uci = sanToUci(tok);
      if (!uci) {
        ok = false;
        bad.push(`${cols[0]} ${cols[1]}: ${tok}`);
        break;
      }
      const key = keyOf(e.getFen());
      const dup = seen.has(key); // repeated position inside one line
      seen.add(key);
      if (!e.applyUciMove(uci)) {
        ok = false;
        bad.push(`${cols[0]} ${cols[1]}: ${tok}`);
        break;
      }
      if (ti === 0) firstOfKey.set(keyOf(e.getFen()), uci);
      const afterFen = e.getFen();
      const safe = !allowsMateInOne(afterFen);
      e.setFen(afterFen);
      if (!safe) {
        blunders++;
        continue;
      }
      if (!dup) {
        if (!book.has(key)) book.set(key, new Map());
        const moves = book.get(key);
        let weights = moves.get(uci);
        if (!weights) {
          weights = STYLE_COLUMNS.map(() => 0);
          moves.set(uci, weights);
        }
        for (let s = 0; s < STYLE_COLUMNS.length; s++) {
          weights[s] += style[STYLE_COLUMNS[s]];
        }
        plies++;
      }
    }
    if (ok) lines++;
  }
}

const replyMoveSets = new Map();
for (const [first, moves] of Object.entries(REPLY_MOVES)) {
  replyMoveSets.set(first, new Set(moves));
}
const defaultReplyMoves = new Set(DEFAULT_REPLY_MOVES);

const obj = {};
let entries = 0;
let dropped = 0;
let pruned = 0;
for (const k of [...book.keys()].sort()) {
  // Re-probe with an empty ep square: a stored ep capture is illegal there.
  e.setFen(k + ' - 0 1');
  const legal = new Set(e.getLegalMoves().map(e.moveToStr));
  const moves = book.get(k);
  let allow = null;
  if (k === START_KEY) allow = ROOT_FIRST_MOVES;
  else if (firstOfKey.has(k)) {
    const first = firstOfKey.get(k);
    allow = replyMoveSets.get(first) || defaultReplyMoves;
  }
  // sqrt keeps main lines clearly favoured without burying rare gambits:
  // e4 (~1300 named lines) outweighs a3 (5) by ~16:1, not 260:1.
  const compress = w => Math.max(0, Math.round(Math.sqrt(w) * 10));
  const list = [...moves.entries()]
    .filter(([mv]) => {
      if (!legal.has(mv)) { dropped++; return false; }
      if (allow && !allow.has(mv)) { pruned++; return false; }
      return true;
    })
    .map(([mv, weights]) => {
      const bal = Math.max(1, compress(weights[0]));
      return [mv, bal, ...weights.slice(1).map(compress)];
    })
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (list.length) {
    obj[k] = list;
    entries += list.length;
  }
}

/* eslint-disable */
const src = `'use strict';

/*
 * FroostRook's opening book. Keyed by the first three FEN fields (board, side to
 * move, castling rights), so transpositions share an entry.
 *
 * Each move is stored as [uci, balanced, mainline, aggressive, gambit, solid,
 * surprise, positional]. A personality selects its own weight column; when it
 * has no line in a position the balanced column is used, so the book never
 * gets stuck. pick() draws randomly in proportion to weight and can
 * de-prioritise lines already used in this session (Opening Diversity).
 *
 * Source: lichess-org/chess-openings (CC0) plus curated gambit/trap lines,
 * ${lines} lines. Moves that allow mate in one are excluded. Generated by
 * test/gen-book.js — do not edit by hand.
 *
 * The search itself never consults this book, so perft and WAC are unaffected.
 */

const BOOK = ${JSON.stringify(obj)};

const STYLE_INDEX = { balanced: 0, mainline: 1, aggressive: 2, gambit: 3, solid: 4, surprise: 5, positional: 6 };
const START_KEY = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq';
const ROOT_CORE = new Set(['e2e4', 'd2d4', 'c2c4', 'g1f3']);
const ROOT_GAMBIT = new Set(['e2e4', 'd2d4']);
const ROOT_SURPRISE = new Set(['e2e4', 'd2d4', 'c2c4', 'g1f3', 'b2b3', 'g2g3', 'b2b4', 'f2f4', 'b1c3']);

function keyOf(fen) {
  return fen.split(' ').slice(0, 3).join(' ');
}

function createMemory() {
  const side = () => ({ moves: new Map(), positions: new Map() });
  return { white: side(), black: side() };
}

function clearMemory(memory) {
  if (!memory) return;
  for (const side of ['white', 'black']) {
    memory[side].moves.clear();
    memory[side].positions.clear();
  }
}

// Keeps the session memory but lets recent games dominate. Called once per
// game: keep ~87.5% per game, so a line seen once is still remembered and
// heavily played lines fade slowly instead of collapsing to zero after two
// games (the halving produced a visible "same opening every time" failure).
function ageMemory(memory) {
  if (!memory) return;
  for (const side of ['white', 'black']) {
    for (const map of [memory[side].moves, memory[side].positions]) {
      for (const [k, v] of [...map]) {
        const nv = Math.floor((v * 7 + 3) / 8);
        if (nv > 0) map.set(k, nv); else map.delete(k);
      }
    }
  }
}

function bump(map, key, cap) {
  map.set(key, Math.min(cap, (map.get(key) || 0) + 1));
}

function pick(fen, options = 100) {
  const opts = typeof options === 'number' ? { variety: options } : (options || {});
  const key = keyOf(fen);
  const entry = BOOK[key];
  if (!entry) return null;

  const styleName = String(opts.style || 'balanced').toLowerCase();
  const style = STYLE_INDEX[styleName] || 0;
  const variety = Math.max(0, Math.min(100, opts.variety == null ? 100 : +opts.variety));
  const diversity = Math.max(0, Math.min(100, opts.diversity == null ? 0 : +opts.diversity));
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const memory = opts.memory || null;
  const sideName = +opts.side === 1 ? 'black' : 'white';
  const mem = memory ? memory[sideName] : null;
  const resultKey = typeof opts.resultKey === 'function' ? opts.resultKey : null;
  const rootAllowed = key === START_KEY
    ? (styleName === 'surprise' ? ROOT_SURPRISE : styleName === 'gambit' ? ROOT_GAMBIT : ROOT_CORE)
    : null;

  // Fall back to the balanced column when this personality has no line here.
  let styleTotal = 0;
  for (const row of entry) {
    if (rootAllowed && !rootAllowed.has(row[0])) continue;
    styleTotal += row[1 + style] || 0;
  }
  const col = styleTotal > 0 ? 1 + style : 1;

  const weights = entry.map(row => {
    if (rootAllowed && !rootAllowed.has(row[0])) return 0;
    return Math.max(0, row[col] | 0);
  });
  const maxW = Math.max(...weights);
  const cutoff = maxW * (100 - variety) / 100;
  for (let i = 0; i < weights.length; i++) if (weights[i] < cutoff) weights[i] = 0;

  if (mem && diversity > 0) {
    const factor = 1 + 0.015 * diversity;
    for (let i = 0; i < entry.length; i++) {
      if (!weights[i]) continue;
      const mv = entry[i][0];
      let reps = mem.moves.get(key + ' ' + mv) || 0;
      if (resultKey) {
        const rk = resultKey(mv);
        if (rk) reps += mem.positions.get(rk) || 0;
      }
      if (reps) weights[i] = Math.max(1, Math.floor(weights[i] / Math.pow(factor, reps)));
    }
  }

  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) return entry[0][0];

  let r = rng() * total;
  let chosen = entry[0][0];
  for (let i = 0; i < entry.length; i++) {
    if (r < weights[i]) { chosen = entry[i][0]; break; }
    r -= weights[i];
  }

  if (mem && !opts.dryRun) {
    remember(memory, opts.side, fen, chosen, resultKey);
  }
  return chosen;
}

// Records a move that was actually played. pick() does this itself unless
// dryRun is set, which lets a caller validate the candidate first.
function remember(memory, side, fen, move, resultKey) {
  if (!memory) return;
  const mem = memory[+side === 1 ? 'black' : 'white'];
  const key = keyOf(fen);
  bump(mem.moves, key + ' ' + move, 12);
  if (resultKey) {
    const rk = resultKey(move);
    if (rk) bump(mem.positions, rk, 12);
  }
}

module.exports = { pick, remember, BOOK, STYLE_INDEX, createMemory, clearMemory, ageMemory };
`;
/* eslint-enable */

fs.writeFileSync(OUT, src);
console.log(
  `book.js written: ${Object.keys(obj).length} positions, ${entries} moves, ${dropped} dropped, ` +
  `${pruned} novelty first moves/replies pruned, ${blunders} blunder moves filtered, ` +
  `${lines} lines, ${plies} plies`
);
if (bad.length) {
  console.log(`skipped ${bad.length} lines with unparsed/illegal moves:`);
  for (const b of bad.slice(0, 10)) console.log('  ' + b);
}
