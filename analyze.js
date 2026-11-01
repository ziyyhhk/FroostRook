#!/usr/bin/env node
'use strict';

/*
 * analyze.js -- PGN game analysis against the native FroostRook UCI engine.
 *
 * No dependencies.  Reuses engine.js only for legal move generation and for
 * replaying moves (castling rights, en passant, halfmove clock, repetition
 * history).  SAN parsing and the UCI session live here.
 *
 * Usage:
 *   node analyze.js --pgn path.pgn [--game N] [--depth 12] [--nodes 100000]
 *                   [--engine path] [--json out.json] [--quiet]
 *                   [--start-ply N] [--max-plies N]
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const rules = require('./engine.js');

const MATE_CP = 10000;
const DEFAULT_DEPTH = 12;
const DEFAULT_ENGINE = require('./native-exe');
const SEARCH_TIMEOUT_MS = 5 * 60 * 1000;
const HANDSHAKE_TIMEOUT_MS = 30 * 1000;
const LABELS = ['best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder', 'missed mate', 'missed win'];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

class PgnError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PgnError';
  }
}

class EngineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EngineError';
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function isResultToken(t) {
  return t === '1-0' || t === '0-1' || t === '1/2-1/2' || t === '*';
}

function lineColAt(text, pos) {
  let line = 1;
  let col = 1;
  const n = Math.min(pos, text.length);
  for (let i = 0; i < n; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

function fenParts(fen) {
  return String(fen).trim().split(/\s+/);
}

function parseSquare(sq) {
  if (!/^[a-h][1-8]$/.test(sq)) return -1;
  return (sq.charCodeAt(1) - 49) * 8 + (sq.charCodeAt(0) - 97);
}

function squareName(idx) {
  return String.fromCharCode(97 + (idx & 7)) + String.fromCharCode(49 + (idx >> 3));
}

function pieceColor(ch) {
  return ch === ch.toUpperCase() ? 'w' : 'b';
}

function pieceType(ch) {
  return ch.toUpperCase();
}

function boardFromFen(fen) {
  const board = new Array(64).fill(null);
  const ranks = fenParts(fen)[0].split('/');
  if (ranks.length !== 8) throw new PgnError('malformed FEN board: ' + fen);
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of ranks[r]) {
      if (ch >= '1' && ch <= '8') {
        file += ch.charCodeAt(0) - 48;
      } else {
        if (file > 7) throw new PgnError('malformed FEN rank: ' + ranks[r]);
        board[(7 - r) * 8 + file] = ch;
        file++;
      }
    }
    if (file !== 8) throw new PgnError('malformed FEN rank: ' + ranks[r]);
  }
  return board;
}

function epSquareFromFen(fen) {
  const ep = fenParts(fen)[3];
  if (!ep || ep === '-') return -1;
  return parseSquare(ep);
}

function normalizeFen(fen, context) {
  const raw = String(fen || '').trim();
  const parts = raw.split(/\s+/);
  if (parts.length < 4) {
    throw new PgnError(`${context}: FEN needs at least 4 fields: "${raw}"`);
  }
  if (parts.length > 6) {
    throw new PgnError(`${context}: FEN has too many fields: "${raw}"`);
  }
  while (parts.length < 6) parts.push(parts.length === 4 ? '0' : '1');

  const [boardField, turn, castling, ep, half, full] = parts;

  // Board: eight ranks, each exactly eight squares.
  const ranks = boardField.split('/');
  if (ranks.length !== 8) throw new PgnError(`${context}: FEN board must have 8 ranks: "${boardField}"`);
  for (const rank of ranks) {
    let count = 0;
    for (const ch of rank) {
      if (ch >= '1' && ch <= '8') count += ch.charCodeAt(0) - 48;
      else if (/[pnbrqkPNBRQK]/.test(ch)) count++;
      else throw new PgnError(`${context}: bad FEN board character "${ch}"`);
    }
    if (count !== 8) throw new PgnError(`${context}: FEN rank "${rank}" does not contain 8 squares`);
  }

  if (!/^[wb]$/.test(turn)) throw new PgnError(`${context}: bad FEN side to move "${turn}"`);
  if (!/^(-|[KQkq]{1,4})$/.test(castling)) throw new PgnError(`${context}: bad FEN castling field "${castling}"`);
  if (castling !== '-') {
    const seen = new Set();
    for (const ch of castling) {
      if (seen.has(ch)) throw new PgnError(`${context}: duplicate FEN castling flag "${ch}"`);
      seen.add(ch);
    }
  }
  if (!/^(-|[a-h][36])$/.test(ep)) throw new PgnError(`${context}: bad FEN en passant square "${ep}"`);
  if (!/^\d+$/.test(half)) throw new PgnError(`${context}: bad FEN halfmove clock "${half}"`);
  if (!/^\d+$/.test(full) || Number(full) < 1) throw new PgnError(`${context}: bad FEN fullmove number "${full}"`);

  const board = boardFromFen(parts.join(' '));
  let whiteKings = 0, blackKings = 0;
  for (const ch of board) {
    if (ch === 'K') whiteKings++;
    else if (ch === 'k') blackKings++;
  }
  if (whiteKings !== 1 || blackKings !== 1) {
    throw new PgnError(`${context}: FEN must contain exactly one king per side`);
  }

  // engine.js generates castling from the rights field, so reject rights that
  // do not have the required king and rook at home.  This prevents invented
  // castling moves in malformed setup positions.
  const at = (sq) => board[parseSquare(sq)];
  if (castling.includes('K') && !(at('e1') === 'K' && at('h1') === 'R')) {
    throw new PgnError(`${context}: FEN claims K-side castling but e1/h1 are not K/R`);
  }
  if (castling.includes('Q') && !(at('e1') === 'K' && at('a1') === 'R')) {
    throw new PgnError(`${context}: FEN claims Q-side castling but e1/a1 are not K/R`);
  }
  if (castling.includes('k') && !(at('e8') === 'k' && at('h8') === 'r')) {
    throw new PgnError(`${context}: FEN claims k-side castling but e8/h8 are not k/r`);
  }
  if (castling.includes('q') && !(at('e8') === 'k' && at('a8') === 'r')) {
    throw new PgnError(`${context}: FEN claims q-side castling but e8/a8 are not k/r`);
  }

  const normalized = parts.join(' ');
  try {
    rules.setFen(normalized);
    return rules.getFen();
  } catch (e) {
    throw new PgnError(`${context}: engine.js rejected FEN "${normalized}": ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// PGN parsing
// ---------------------------------------------------------------------------

function newGameRecord() {
  return {
    tags: Object.create(null),
    tagOrder: [],
    moves: [],
    result: null,
  };
}

function tagValue(tags, name) {
  if (Object.prototype.hasOwnProperty.call(tags, name)) return tags[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(tags)) {
    if (key.toLowerCase() === lower) return tags[key];
  }
  return undefined;
}

function readTagPair(text, start) {
  let i = start;
  const { line, col } = lineColAt(text, i);
  if (text[i] !== '[') throw new PgnError(`internal: tag parse at ${line}:${col} does not start with "["`);
  i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  const nameStart = i;
  while (i < text.length && !/[\s\]]/.test(text[i])) i++;
  const name = text.slice(nameStart, i);
  if (!name) throw new PgnError(`empty tag name at line ${line}, column ${col}`);
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '"') {
    throw new PgnError(`tag [${name}] is missing an opening quote at line ${line}`);
  }
  i++;
  let value = '';
  let closed = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === '"' || next === '\\') {
        value += next;
        i += 2;
      } else if (next === undefined) {
        i++;
      } else {
        value += next;
        i += 2;
      }
    } else if (ch === '"') {
      closed = true;
      i++;
      break;
    } else {
      value += ch;
      i++;
    }
  }
  if (!closed) throw new PgnError(`tag [${name}] has an unterminated value at line ${line}`);
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== ']') {
    throw new PgnError(`tag [${name}] is missing its closing "]" at line ${line}`);
  }
  i++;
  return { name, value, next: i };
}

function skipComment(text, start) {
  let i = start;
  const { line } = lineColAt(text, i);
  let depth = 0;
  while (i < text.length) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  throw new PgnError(`unterminated comment starting at line ${line}`);
}

function skipVariation(text, start) {
  let i = start;
  const { line } = lineColAt(text, i);
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') {
      i = skipComment(text, i);
      continue;
    }
    if (ch === ';') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  throw new PgnError(`unterminated variation starting at line ${line}`);
}

function normalizeMoveToken(token) {
  let t = String(token);
  // NAGs are sometimes glued to the move (e4$1).
  t = t.replace(/\$\d+/g, '');
  // Annotation glyphs and check/mate suffixes are not part of matching.
  t = t.replace(/[!?]+$/g, '');

  // Move numbers can be attached (1.e4, 1...e5, 34...Nf6).  Strip repeated
  // number/dot prefixes; "..." alone becomes empty.
  for (;;) {
    const next = t.replace(/^\d+\.+/, '');
    if (next === t) break;
    t = next;
  }
  t = t.replace(/^\.+/, '');
  t = t.trim();
  if (!t) return '';
  if (/^e\.?p\.?$/i.test(t)) return '';
  if (/^[!?]+$/.test(t)) return '';
  return t;
}

function finalizeGame(game, index, source) {
  const tags = game.tags;
  const fenTag = tagValue(tags, 'FEN');
  const setUpTag = tagValue(tags, 'SetUp');
  let startFen = rules.START_FEN;

  if (fenTag !== undefined) {
    if (String(fenTag).trim() === '') {
      throw new PgnError(`${source}: game ${index} has an empty FEN tag`);
    }
    startFen = normalizeFen(fenTag, `${source} game ${index}`);
  } else if (setUpTag !== undefined && String(setUpTag).trim() === '1') {
    throw new PgnError(`${source}: game ${index} sets SetUp "1" without a FEN tag`);
  }

  const tagResult = tagValue(tags, 'Result');
  const result = game.result || (tagResult !== undefined ? String(tagResult) : '*');
  return {
    index,
    tags: Object.assign({}, tags),
    tagOrder: game.tagOrder.slice(),
    startFen,
    moves: game.moves.slice(),
    result,
  };
}

function parsePgn(text, source = '<pgn>') {
  const s = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const games = [];
  let game = newGameRecord();
  let inMovetext = false;
  let i = 0;

  function finishGame() {
    if (game.tagOrder.length || game.moves.length || game.result !== null) {
      games.push(finalizeGame(game, games.length + 1, source));
    }
    game = newGameRecord();
    inMovetext = false;
  }

  function addMoveText(token) {
    const san = normalizeMoveToken(token);
    if (!san) return;
    if (san === '--' || san === 'Z0' || san === '0000') {
      const { line } = lineColAt(s, i);
      throw new PgnError(`${source}: null moves are not supported (line ${line}, token "${token}")`);
    }
    game.moves.push({ san, raw: token });
    inMovetext = true;
  }

  function addResult(token) {
    if (!isResultToken(token)) {
      throw new PgnError(`${source}: internal bad result token "${token}"`);
    }
    game.result = token;
    finishGame();
  }

  function handleToken(token) {
    // A result may be glued to the final move, e.g. "Qh4#1-0".
    const attached = /^(.*?)(1-0|0-1|1\/2-1\/2|\*)$/.exec(token);
    if (attached && attached[1]) {
      addMoveText(attached[1]);
      addResult(attached[2]);
      return;
    }
    if (isResultToken(token)) {
      addResult(token);
      return;
    }
    addMoveText(token);
  }

  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\v') {
      i++;
      continue;
    }
    if (ch === '{') {
      i = skipComment(s, i);
      continue;
    }
    if (ch === '(') {
      i = skipVariation(s, i);
      continue;
    }
    if (ch === ';') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (ch === '%' && (i === 0 || s[i - 1] === '\n')) {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (ch === '[') {
      const tag = readTagPair(s, i);
      if (inMovetext) finishGame();
      game.tags[tag.name] = tag.value;
      game.tagOrder.push(tag.name);
      i = tag.next;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const { line, col } = lineColAt(s, i);
      throw new PgnError(`${source}: unexpected "${ch}" at line ${line}, column ${col}`);
    }

    const start = i;
    while (i < s.length && !/[\s{}()\[\];]/.test(s[i])) i++;
    const token = s.slice(start, i);
    if (!token) {
      i++;
      continue;
    }
    handleToken(token);
  }

  finishGame();
  return games;
}

// ---------------------------------------------------------------------------
// SAN -> UCI
// ---------------------------------------------------------------------------

function stripSanSuffixes(san) {
  let t = san;
  for (;;) {
    const next = t.replace(/[!?+#]+$/g, '');
    if (next === t) break;
    t = next;
  }
  return t;
}

function parseSan(san) {
  let t = stripSanSuffixes(String(san).trim());
  if (!t) throw new PgnError('empty SAN token');
  if (t.includes('@')) throw new PgnError(`drops are not supported: "${san}"`);

  // Long algebraic / UCI-style fallback: e2e4, e2-e4, e7e8q.
  let long = t.replace(/-/g, '');
  if (/^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/.test(long)) {
    return { kind: 'uci', uci: long.toLowerCase() };
  }

  // Castling, including the zero spelling 0-0 / 0-0-0.
  if (/^[oO0]-[oO0](-[oO0])?$/.test(t)) {
    const norm = t.replace(/0/g, 'O').replace(/o/g, 'O');
    if (norm === 'O-O-O') return { kind: 'castle', side: 'q' };
    if (norm === 'O-O') return { kind: 'castle', side: 'k' };
    throw new PgnError(`bad castling token "${san}"`);
  }

  const pieceMatch = /^([KQRBN])([a-h]?)([1-8]?)(x?)([a-h][1-8])$/.exec(t);
  if (pieceMatch) {
    return {
      kind: 'piece',
      piece: pieceMatch[1],
      fromFile: pieceMatch[2] || null,
      fromRank: pieceMatch[3] || null,
      capture: pieceMatch[4] === 'x',
      to: pieceMatch[5],
    };
  }

  const pawnMatch = /^([a-h]?)(x?)([a-h][1-8])(?:=)?([QRBNqrbn])?$/.exec(t);
  if (pawnMatch) {
    const fromFile = pawnMatch[1] || null;
    const capture = pawnMatch[2] === 'x';
    const promo = pawnMatch[4] ? pawnMatch[4].toUpperCase() : '';
    if (fromFile && !capture) {
      // SAN pawn captures must use the "exd5" form.  A stray file with no x
      // would silently accept malformed movetext.
      throw new PgnError(`bad pawn move syntax "${san}"`);
    }
    if (capture && !fromFile) {
      throw new PgnError(`pawn capture "${san}" is missing its origin file`);
    }
    return { kind: 'pawn', fromFile, capture, to: pawnMatch[3], promo };
  }

  throw new PgnError(`unrecognised SAN token "${san}"`);
}

function moveAttributes(uci, board, epIdx) {
  const from = parseSquare(uci.slice(0, 2));
  const to = parseSquare(uci.slice(2, 4));
  const moving = board[from];
  if (!moving) return null;
  const promo = uci.length > 4 ? uci[4].toUpperCase() : '';
  const isCastle = pieceType(moving) === 'K' && Math.abs((from & 7) - (to & 7)) === 2;
  const isCapture = !!board[to] ||
    (pieceType(moving) === 'P' && to === epIdx && (from & 7) !== (to & 7));
  return {
    uci,
    from,
    to,
    fromFile: String.fromCharCode(97 + (from & 7)),
    fromRank: String.fromCharCode(49 + (from >> 3)),
    piece: pieceType(moving),
    color: pieceColor(moving),
    promo,
    isCastle,
    isCapture,
  };
}

function sanToUci(san, fen, legalUcis) {
  const spec = parseSan(san);
  const board = boardFromFen(fen);
  const epIdx = epSquareFromFen(fen);
  const candidates = legalUcis
    .map((uci) => moveAttributes(uci, board, epIdx))
    .filter(Boolean);

  let matched = [];

  if (spec.kind === 'uci') {
    matched = candidates.filter((c) => c.uci.toLowerCase() === spec.uci);
  } else if (spec.kind === 'castle') {
    const toFile = spec.side === 'k' ? 6 : 2;
    matched = candidates.filter((c) => c.isCastle && (c.to & 7) === toFile);
  } else if (spec.kind === 'piece') {
    matched = candidates.filter((c) => {
      if (c.piece !== spec.piece) return false;
      if (c.isCastle) return false; // castling must be written O-O / O-O-O
      if (c.uci.slice(2, 4) !== spec.to) return false;
      if (c.promo) return false;
      if (c.isCapture !== spec.capture) return false;
      if (spec.fromFile && c.fromFile !== spec.fromFile) return false;
      if (spec.fromRank && c.fromRank !== spec.fromRank) return false;
      return true;
    });
  } else {
    matched = candidates.filter((c) => {
      if (c.piece !== 'P') return false;
      if (c.isCastle) return false;
      if (c.uci.slice(2, 4) !== spec.to) return false;
      if (c.promo !== spec.promo) return false;
      if (c.isCapture !== spec.capture) return false;
      if (spec.fromFile && c.fromFile !== spec.fromFile) return false;
      return true;
    });
  }

  if (matched.length === 1) return matched[0].uci;
  if (matched.length === 0) {
    throw new PgnError(`no legal move matches SAN "${san}"`);
  }
  throw new PgnError(`ambiguous SAN "${san}" (matches ${matched.map((c) => c.uci).join(', ')})`);
}

// ---------------------------------------------------------------------------
// Replay and position status
// ---------------------------------------------------------------------------

function examinePosition() {
  const legal = rules.getLegalMoves();
  const inCheck = rules.inCheck();
  let terminal = null;
  if (legal.length === 0) terminal = inCheck ? 'checkmate' : 'stalemate';
  return { legal, inCheck, terminal };
}

function finalStatusAfterReplay(terminal, result) {
  if (terminal) return terminal;
  if (rules.isInsufficientMaterial()) return 'draw-insufficient-material';
  if (rules.halfmove >= 100) return 'draw-fifty-move';
  if (rules.isThreefold()) return 'draw-threefold';
  if (result === '1-0' || result === '0-1') return result;
  if (result === '1/2-1/2') return 'draw';
  return 'unfinished';
}

function replayGame(game) {
  let before;
  try {
    rules.setFen(game.startFen);
    before = examinePosition();
  } catch (e) {
    throw new PgnError(`game ${game.index}: cannot load start FEN "${game.startFen}": ${e.message}`);
  }

  const moves = [];
  let stoppedAtPly = null;
  let stoppedEarly = false;

  for (let idx = 0; idx < game.moves.length; idx++) {
    const ply = idx + 1;
    if (before.terminal === 'checkmate' || before.terminal === 'stalemate') {
      stoppedAtPly = ply;
      stoppedEarly = true;
      break;
    }

    const fenBefore = rules.getFen();
    const parts = fenParts(fenBefore);
    const color = parts[1] === 'b' ? 'b' : 'w';
    const moveNumber = Number(parts[5]) || 1;
    const legalUcis = before.legal.map((mv) => rules.moveToStr(mv));
    const san = game.moves[idx].san;

    let uci;
    try {
      uci = sanToUci(san, fenBefore, legalUcis);
    } catch (e) {
      const side = color === 'w' ? 'White' : 'Black';
      throw new PgnError(
        `game ${game.index}, move ${moveNumber} (ply ${ply}, ${side}) ` +
        `SAN "${san}": ${e.message} [FEN "${fenBefore}"]`
      );
    }

    if (!rules.applyUciMove(uci)) {
      throw new PgnError(
        `game ${game.index}, move ${moveNumber} (ply ${ply}) SAN "${san}" ` +
        `mapped to ${uci}, but engine.js rejected it [FEN "${fenBefore}"]`
      );
    }

    const after = examinePosition();
    moves.push({
      ply,
      moveNumber,
      color,
      san,
      raw: game.moves[idx].raw,
      uci,
      fenBefore,
      fenAfter: rules.getFen(),
      statusBefore: before.terminal,
      statusAfter: after.terminal,
    });
    before = after;
  }

  // The final position is whatever rules state we reached.  If the loop
  // stopped because the position was already terminal, that is the status.
  const finalStatus = finalStatusAfterReplay(before.terminal, game.result);

  return {
    index: game.index,
    tags: game.tags,
    tagOrder: game.tagOrder,
    startFen: game.startFen,
    result: game.result,
    moves,
    finalStatus,
    stoppedAtPly,
    stoppedEarly,
  };
}

// ---------------------------------------------------------------------------
// UCI engine session
// ---------------------------------------------------------------------------

function parseInfoLine(line) {
  if (!line.startsWith('info ')) return null;
  const t = line.split(/\s+/);
  if (t[1] === 'string') return null;
  const info = {
    depth: null,
    seldepth: null,
    multipv: null,
    score: null,
    nodes: null,
    nps: null,
    time: null,
    pv: [],
  };
  for (let i = 1; i < t.length; i++) {
    const key = t[i];
    if (key === 'depth') info.depth = Number(t[++i]);
    else if (key === 'seldepth') info.seldepth = Number(t[++i]);
    else if (key === 'multipv') info.multipv = Number(t[++i]);
    else if (key === 'nodes') info.nodes = Number(t[++i]);
    else if (key === 'nps') info.nps = Number(t[++i]);
    else if (key === 'time') info.time = Number(t[++i]);
    else if (key === 'score') {
      const kind = t[++i];
      const value = Number(t[++i]);
      if ((kind === 'cp' || kind === 'mate') && Number.isFinite(value)) {
        info.score = { type: kind, value };
      }
    } else if (key === 'pv') {
      const rest = [];
      for (let j = i + 1; j < t.length; j++) {
        if (/^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/.test(t[j])) rest.push(t[j].toLowerCase());
      }
      info.pv = rest;
      i = t.length;
    }
  }
  return info;
}

function chooseBestInfo(infos) {
  const scored = infos.filter((x) => x && x.score);
  if (!scored.length) return null;
  // Prefer the PV/rank-1 line when the engine emits MultiPV; otherwise all
  // scored info lines are candidates.  Deeper wins, and on a tie the later
  // line wins (iterative deepening may report the same depth twice).
  const preferred = scored.filter((x) => x.multipv === null || x.multipv === 1);
  const pool = preferred.length ? preferred : scored;
  let best = null;
  for (const info of pool) {
    if (!best) {
      best = info;
      continue;
    }
    const d = info.depth === null ? -1 : info.depth;
    const bd = best.depth === null ? -1 : best.depth;
    if (d >= bd) best = info;
  }
  return best;
}

function scoreToEval(score) {
  if (score.type === 'cp') {
    return { cp: score.value, mateIn: null, terminal: null, source: 'search' };
  }
  const n = score.value;
  if (n === 0) {
    // The engine uses "mate 0" for a mated side to move.  No search is needed
    // in that case (terminal positions are handled by the rules), but keep a
    // defensible sign if it ever appears.
    return { cp: -MATE_CP, mateIn: 0, terminal: 'checkmate', source: 'search' };
  }
  const safeN = Math.min(Math.abs(n), MATE_CP - 1);
  const sign = n > 0 ? 1 : -1;
  return {
    cp: sign * (MATE_CP - safeN),
    mateIn: sign * safeN,
    terminal: null,
    source: 'search',
  };
}

function terminalEval(status) {
  if (status === 'checkmate') {
    return {
      cp: -MATE_CP,
      mateIn: 0,
      terminal: 'checkmate',
      source: 'terminal',
      pov: 'side-to-move',
      pv: [],
    };
  }
  if (status === 'stalemate') {
    return {
      cp: 0,
      mateIn: null,
      terminal: 'stalemate',
      source: 'terminal',
      pov: 'side-to-move',
      pv: [],
    };
  }
  throw new EngineError(`internal: terminalEval called with status "${status}"`);
}

class UciEngine {
  constructor(exePath) {
    this.exePath = exePath;
    this.proc = null;
    this.buffer = '';
    this.lines = [];
    this.consumed = 0;
    this.waiters = [];
    this.stderr = '';
    this.closed = false;
    this.exitInfo = null;
    this.id = { name: null, author: null, lines: [] };
  }

  start() {
    if (!fs.existsSync(this.exePath)) {
      throw new EngineError(`engine not found: ${this.exePath}`);
    }
    if (!fs.statSync(this.exePath).isFile()) {
      throw new EngineError(`engine path is not a file: ${this.exePath}`);
    }

    this.proc = spawn(this.exePath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.on('data', (chunk) => {
      this.stderr += chunk;
      if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-20000);
    });
    this.proc.on('error', (err) => this.failAll(new EngineError(`engine process error: ${err.message}`)));
    this.proc.on('exit', (code, signal) => {
      this.closed = true;
      this.exitInfo = { code, signal };
      this.failAll(new EngineError(
        `engine exited unexpectedly (code ${code}, signal ${signal || 'none'})` +
        (this.stderr ? `\nengine stderr: ${this.stderr.trim()}` : '')
      ));
    });

    return this.handshake();
  }

  async handshake() {
    this.send('uci');
    await this.waitFor((line) => line === 'uciok', HANDSHAKE_TIMEOUT_MS, 'uciok');
    const seen = this.lines.slice(0, this.consumed);
    for (const line of seen) {
      if (line.startsWith('id name ')) this.id.name = line.slice('id name '.length).trim();
      else if (line.startsWith('id author ')) this.id.author = line.slice('id author '.length).trim();
      if (line.startsWith('id ')) this.id.lines.push(line);
    }

    this.send('setoption name OwnBook value false');
    this.send('setoption name Hash value 32');
    this.send('isready');
    await this.waitFor((line) => line === 'readyok', HANDSHAKE_TIMEOUT_MS, 'readyok');
    return this.id;
  }

  onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf('\n');
      if (idx < 0) break;
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length) {
        this.lines.push(line);
        this.dispatch();
      }
    }
  }

  dispatch() {
    for (;;) {
      let progress = false;
      for (let w = 0; w < this.waiters.length; w++) {
        const waiter = this.waiters[w];
        while (waiter.cursor < this.lines.length) {
          const line = this.lines[waiter.cursor++];
          if (waiter.onLine) {
            try {
              waiter.onLine(line);
            } catch (e) {
              clearTimeout(waiter.timer);
              this.waiters.splice(w, 1);
              waiter.reject(e);
              progress = true;
              break;
            }
          }
          if (waiter.match(line)) {
            clearTimeout(waiter.timer);
            this.waiters.splice(w, 1);
            this.consumed = Math.max(this.consumed, waiter.cursor);
            waiter.resolve(line);
            progress = true;
            break;
          }
        }
        if (progress) break;
      }
      if (!progress) break;
    }
  }

  waitFor(match, timeoutMs, label, onLine) {
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        onLine,
        cursor: this.consumed,
        resolve,
        reject,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        const pos = this.waiters.indexOf(waiter);
        if (pos >= 0) this.waiters.splice(pos, 1);
        reject(new EngineError(
          `timeout after ${timeoutMs} ms waiting for ${label || 'engine output'}` +
          (this.stderr ? `\nengine stderr: ${this.stderr.trim()}` : '')
        ));
      }, timeoutMs);
      this.waiters.push(waiter);
      this.dispatch();
    });
  }

  failAll(error) {
    for (const waiter of this.waiters.slice()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters = [];
  }

  send(command) {
    if (!this.proc || this.closed || !this.proc.stdin.writable) {
      throw new EngineError('cannot send command: engine is not running');
    }
    this.proc.stdin.write(command + '\n');
  }

  async newGame() {
    this.send('ucinewgame');
    // ucinewgame clears the hash in the native core.  Re-assert the options
    // that affect analysis in case a future engine build resets them too.
    this.send('setoption name OwnBook value false');
    this.send('isready');
    await this.waitFor((line) => line === 'readyok', HANDSHAKE_TIMEOUT_MS, 'readyok after ucinewgame');
  }

  positionCommand(startFen, moves) {
    const suffix = moves.length ? ' moves ' + moves.join(' ') : '';
    if (startFen === rules.START_FEN) return 'position startpos' + suffix;
    return 'position fen ' + startFen + suffix;
  }

  async search(startFen, moves, budget) {
    this.send(this.positionCommand(startFen, moves));
    this.send('isready');
    await this.waitFor((line) => line === 'readyok', HANDSHAKE_TIMEOUT_MS, 'readyok before go');

    const infos = [];
    this.send(budget.mode === 'depth' ? `go depth ${budget.value}` : `go nodes ${budget.value}`);
    const bestLine = await this.waitFor(
      (line) => line.startsWith('bestmove '),
      SEARCH_TIMEOUT_MS,
      'bestmove',
      (line) => {
        if (line.startsWith('info ')) {
          const parsed = parseInfoLine(line);
          if (parsed) infos.push(parsed);
        }
      }
    );

    const tokens = bestLine.split(/\s+/);
    const bestmove = tokens[1] || null;
    const info = chooseBestInfo(infos);
    if (!info) {
      throw new EngineError(
        `engine returned "${bestLine}" without a usable score info line` +
        (this.stderr ? `\nengine stderr: ${this.stderr.trim()}` : '')
      );
    }
    if (bestmove === '0000') {
      throw new EngineError(
        `engine reported bestmove 0000 in a non-terminal position [FEN "${startFen}" moves "${moves.join(' ')}"]`
      );
    }

    const evalScore = scoreToEval(info.score);
    const pv = info.pv.slice();
    const pvFirst = pv.length ? pv[0] : null;
    return {
      cp: evalScore.cp,
      mateIn: evalScore.mateIn,
      terminal: evalScore.terminal,
      source: evalScore.source,
      pv,
      bestUci: pvFirst || (bestmove !== '0000' ? bestmove : null),
      depth: info.depth,
      nodes: info.nodes,
      multipv: info.multipv,
      bestmove,
    };
  }

  async quit() {
    if (!this.proc || this.closed) return;
    try {
      this.proc.stdin.write('quit\n');
    } catch (e) {
      // Ignore a broken pipe; the process is about to be stopped anyway.
    }
    const exited = new Promise((resolve) => {
      if (this.closed) return resolve();
      const timer = setTimeout(() => {
        try { this.proc.kill(); } catch (e) { /* ignore */ }
        resolve();
      }, 3000);
      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await exited;
  }
}

// ---------------------------------------------------------------------------
// Classification and summaries
// ---------------------------------------------------------------------------

function clampLoss(beforeMoverCp, afterMoverCp) {
  // The played move can be better than the engine's best at the same budget.
  // Mate scores are already bounded by MATE_CP, so this subtraction cannot
  // overflow; there is deliberately no upper cap because the documented rule
  // is exactly max(0, before - after).
  return Math.max(0, beforeMoverCp - afterMoverCp);
}

function classifyMove({ playedUci, bestUci, evalBefore, evalAfter, loss }) {
  const beforeMoverCp = evalBefore.cp;
  const afterMoverCp = -evalAfter.cp;
  const beforeMateForMover = evalBefore.mateIn !== null && evalBefore.mateIn > 0;
  // evalAfter is the opponent's point of view.  Negative mate / terminal
  // checkmate there means the mover has mate after the played move.
  const afterLeadsToMoverMate = evalAfter.mateIn !== null && (
    evalAfter.mateIn < 0 ||
    (evalAfter.mateIn === 0 && evalAfter.cp < 0)
  );

  const missedMate = beforeMateForMover && !afterLeadsToMoverMate;
  const beforeWinning = beforeMoverCp >= 200 || beforeMateForMover;
  const missedWin = !missedMate && beforeWinning && afterMoverCp < 50 && loss >= 150;

  let label;
  if (missedMate) label = 'missed mate';
  else if (missedWin) label = 'missed win';
  else if (bestUci && playedUci === bestUci) label = 'best';
  else if (loss <= 10) label = 'excellent';
  else if (loss <= 50) label = 'good';
  else if (loss <= 100) label = 'inaccuracy';
  else if (loss <= 250) label = 'mistake';
  else label = 'blunder';

  return { label, missedMate, missedWin, beforeMateForMover, afterLeadsToMoverMate };
}

function buildSummary(moves) {
  const emptyCounts = () => {
    const c = Object.create(null);
    for (const label of LABELS) c[label] = 0;
    return c;
  };

  function playerSummary(color) {
    const own = moves.filter((m) => m.color === color);
    const counts = emptyCounts();
    let aclSum = 0;
    let aclMoves = 0;
    for (const m of own) {
      counts[m.label]++;
      if (m.aclSample) {
        aclSum += m.loss;
        aclMoves++;
      }
    }
    const worst = own
      .slice()
      .sort((a, b) => (b.loss - a.loss) || (a.ply - b.ply))
      .slice(0, 3)
      .map((m) => ({
        ply: m.ply,
        moveNumber: m.moveNumber,
        color: m.color,
        san: m.san,
        played: m.uci,
        best: m.bestUci,
        loss: m.loss,
        label: m.label,
      }));

    return {
      color: color === 'w' ? 'White' : 'Black',
      moves: own.length,
      acl: aclMoves ? Math.round((aclSum / aclMoves) * 100) / 100 : null,
      aclMoves,
      counts,
      // A missed mate is a blunder-equivalent for aggregate reporting, kept
      // separate from the exact "blunder" count above.
      blunderCategory: counts.blunder + counts['missed mate'],
      worst,
    };
  }

  return {
    white: playerSummary('w'),
    black: playerSummary('b'),
  };
}

function flipEval(e) {
  return {
    cp: -e.cp,
    mateIn: e.mateIn === null ? null : -e.mateIn,
    terminal: e.terminal,
    source: e.source,
    pv: e.pv ? e.pv.slice() : [],
  };
}

// ---------------------------------------------------------------------------
// Game analysis
// ---------------------------------------------------------------------------

async function analyzeReplay(replay, opts, engine, engineId) {
  const endPly = opts.maxPlies == null ? Infinity : opts.startPly + opts.maxPlies - 1;
  const movesOut = [];

  for (let i = 0; i < replay.moves.length; i++) {
    const m = replay.moves[i];
    const base = {
      ply: m.ply,
      moveNumber: m.moveNumber,
      color: m.color,
      san: m.san,
      uci: m.uci,
      analyzed: false,
    };
    const inRange = m.ply >= opts.startPly && m.ply <= endPly;
    if (!inRange) {
      movesOut.push(base);
      continue;
    }

    const prior = replay.moves.slice(0, i).map((x) => x.uci);

    let evalBefore;
    let bestUci = null;
    if (m.statusBefore === 'checkmate' || m.statusBefore === 'stalemate') {
      evalBefore = terminalEval(m.statusBefore);
    } else {
      const beforeResult = await engine.search(replay.startFen, prior, opts.budget);
      evalBefore = {
        cp: beforeResult.cp,
        mateIn: beforeResult.mateIn,
        terminal: beforeResult.terminal,
        source: beforeResult.source,
        pov: 'side-to-move',
        pv: beforeResult.pv,
      };
      bestUci = beforeResult.bestUci;
    }

    let evalAfter;
    if (m.statusAfter === 'checkmate' || m.statusAfter === 'stalemate') {
      evalAfter = terminalEval(m.statusAfter);
    } else {
      const afterResult = await engine.search(
        replay.startFen,
        prior.concat(m.uci),
        opts.budget
      );
      evalAfter = {
        cp: afterResult.cp,
        mateIn: afterResult.mateIn,
        terminal: afterResult.terminal,
        source: afterResult.source,
        pov: 'side-to-move',
        pv: afterResult.pv,
      };
    }

    const moverCpBefore = evalBefore.cp;
    const moverCpAfter = -evalAfter.cp;
    const loss = clampLoss(moverCpBefore, moverCpAfter);
    const classification = classifyMove({
      playedUci: m.uci,
      bestUci,
      evalBefore,
      evalAfter,
      loss,
    });
    const aclSample = evalBefore.mateIn === null &&
      evalAfter.mateIn === null &&
      !m.statusBefore &&
      !m.statusAfter;

    movesOut.push(Object.assign(base, {
      analyzed: true,
      bestUci,
      evalBefore,
      evalAfter,
      moverCpBefore,
      moverCpAfter,
      loss,
      label: classification.label,
      aclSample,
      terminalBefore: m.statusBefore,
      terminalAfter: m.statusAfter,
    }));
  }

  const analyzedMoves = movesOut.filter((m) => m.analyzed);
  return {
    index: replay.index,
    tags: replay.tags,
    tagOrder: replay.tagOrder,
    startFen: replay.startFen,
    result: replay.result,
    finalStatus: replay.finalStatus,
    stoppedEarly: replay.stoppedEarly,
    stoppedAtPly: replay.stoppedAtPly,
    analysisRange: {
      startPly: opts.startPly,
      maxPlies: opts.maxPlies,
      analyzedPlies: analyzedMoves.length,
      totalPlies: replay.moves.length,
    },
    moves: movesOut,
    summary: buildSummary(analyzedMoves),
    engine: engineId ? { name: engineId.name, author: engineId.author } : null,
  };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatEval(e) {
  if (!e) return '-';
  if (e.terminal === 'checkmate') return e.cp < 0 ? '-MATE' : '+MATE';
  if (e.terminal === 'stalemate') return '0.00';
  if (e.mateIn !== null && e.mateIn !== undefined) {
    if (e.mateIn > 0) return '+M' + e.mateIn;
    if (e.mateIn < 0) return '-M' + (-e.mateIn);
    return e.cp < 0 ? '-MATE' : '+MATE';
  }
  const pawns = e.cp / 100;
  return (pawns >= 0 ? '+' : '') + pawns.toFixed(2);
}

function moveLabel(m) {
  return String(m.moveNumber) + (m.color === 'w' ? '.' : '...');
}

function padded(value, width) {
  const s = String(value == null ? '' : value);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function padLeft(value, width) {
  const s = String(value == null ? '' : value);
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function renderGameHuman(game) {
  const lines = [];
  const tags = game.tags;
  const white = tags.White || '?';
  const black = tags.Black || '?';
  const event = tags.Event || '';
  const date = tags.Date || '';
  const site = tags.Site || '';
  lines.push(`Game ${game.index}: ${white} vs ${black} | Result: ${game.result}`);
  if (event || date || site) {
    lines.push(`Event: ${event || '?'} | Date: ${date || '?'} | Site: ${site || '?'}`);
  }
  lines.push(`Start: ${game.startFen === rules.START_FEN ? 'standard start position' : game.startFen}`);
  const rangeEnd = game.analysisRange.analyzedPlies
    ? game.analysisRange.startPly + game.analysisRange.analyzedPlies - 1
    : game.analysisRange.startPly - 1;
  lines.push(
    `Analyzed plies ${game.analysisRange.startPly}-${rangeEnd} ` +
    `of ${game.analysisRange.totalPlies} | Final status: ${game.finalStatus}`
  );
  if (game.stoppedEarly) {
    lines.push(`Stopped early at ply ${game.stoppedAtPly}: the position was already terminal.`);
  }
  lines.push('');
  lines.push(
    padded('ply', 4) + padded('move', 7) + padded('SAN', 11) +
    padded('played', 7) + padded('best', 7) +
    padded('eval before', 13) + padded('eval after', 13) +
    padLeft('loss', 5) + '  label'
  );
  lines.push('-'.repeat(90));

  const analyzed = game.moves.filter((m) => m.analyzed);
  if (!analyzed.length) {
    lines.push('(no moves analyzed in the selected range)');
  }
  for (const m of analyzed) {
    // Both eval columns are from the player-to-move's point of view.  The
    // "after" value is flipped out of the opponent's reporting POV.
    const afterMoverPov = flipEval(m.evalAfter);
    lines.push(
      padLeft(m.ply, 4) + ' ' +
      padded(moveLabel(m), 7) +
      padded(m.san, 11) +
      padded(m.uci, 7) +
      padded(m.bestUci || '-', 7) +
      padded(formatEval(m.evalBefore), 13) +
      padded(formatEval(afterMoverPov), 13) +
      padLeft(m.loss, 5) + '  ' + m.label
    );
  }

  lines.push('');
  for (const side of [game.summary.white, game.summary.black]) {
    lines.push(
      `${side.color}: ${side.moves} analyzed move(s) | ` +
      `ACL ${side.acl === null ? 'n/a' : side.acl.toFixed(2) + ' cp'} ` +
      `over ${side.aclMoves} cp sample(s)`
    );
    const c = side.counts;
    lines.push(
      `  best ${c.best} | excellent ${c.excellent} | good ${c.good} | ` +
      `inaccuracy ${c.inaccuracy} | mistake ${c.mistake} | blunder ${c.blunder} | ` +
      `missed mate ${c['missed mate']} | missed win ${c['missed win']}`
    );
    lines.push(`  blunders incl. missed mate: ${side.blunderCategory}`);
    if (side.worst.length) {
      lines.push('  worst moves:');
      for (const w of side.worst) {
        lines.push(
          `    ply ${w.ply} (${moveLabel(w)} ${w.san}): loss ${w.loss} cp, ` +
          `label ${w.label}, played ${w.played}, engine ${w.best || '-'}`
        );
      }
    }
  }
  return lines.join('\n');
}

function renderHuman(doc, opts) {
  const chunks = [];
  chunks.push(`Engine: ${doc.engine.name || '(unknown)'} | Budget: ${doc.budget.mode} ${doc.budget.value}`);
  chunks.push(`PGN: ${doc.options.pgn}`);
  if (doc.options.startPly !== 1 || doc.options.maxPlies !== null) {
    chunks.push(`Range: start-ply ${doc.options.startPly}, max-plies ${doc.options.maxPlies == null ? 'all' : doc.options.maxPlies}`);
  }
  chunks.push('');
  for (let i = 0; i < doc.games.length; i++) {
    if (i > 0) chunks.push('', '='.repeat(90), '');
    chunks.push(renderGameHuman(doc.games[i]));
  }
  return chunks.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
  'Usage:',
  '  node analyze.js --pgn path.pgn [--game N] [--depth 12] [--nodes 100000]',
  '                  [--engine path] [--json out.json] [--quiet]',
  '                  [--start-ply N] [--max-plies N]',
  '',
  'Options:',
  '  --pgn PATH        PGN file to analyze (required)',
  '  --game N          analyze only game N (1-based; default: all games)',
  '  --depth N         search depth (default 12)',
  '  --nodes N         node budget; mutually exclusive with --depth',
  '  --engine PATH     UCI engine executable (default: native/FroostRook.exe,',
  '                    or FROOSTROOK_ENGINE if set)',
  '  --json PATH       write structured JSON to PATH (not printed)',
  '  --quiet           suppress the human-readable stdout report',
  '  --start-ply N     first ply to analyze (1-based, default 1)',
  '  --max-plies N     maximum number of plies to analyze',
  '  --help, -h        show this help',
].join('\n');

function parsePositiveInt(value, flag) {
  if (!/^\d+$/.test(String(value))) {
    throw new UsageError(`${flag} expects a positive integer, got "${value}"`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new UsageError(`${flag} expects a positive integer, got "${value}"`);
  }
  return n;
}

function parseArgs(argv) {
  const opts = {
    pgn: null,
    game: null,
    depth: null,
    nodes: null,
    engine: null,
    json: null,
    quiet: false,
    startPly: 1,
    maxPlies: null,
    help: false,
  };
  let depthGiven = false;
  let nodesGiven = false;

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inlineValue = null;
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }

    const takeValue = () => {
      if (inlineValue !== null) return inlineValue;
      if (i + 1 >= argv.length) throw new UsageError(`${arg} expects a value`);
      return argv[++i];
    };

    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--quiet') {
      opts.quiet = true;
    } else if (arg === '--pgn') {
      opts.pgn = takeValue();
    } else if (arg === '--game') {
      opts.game = parsePositiveInt(takeValue(), '--game');
    } else if (arg === '--depth') {
      opts.depth = parsePositiveInt(takeValue(), '--depth');
      depthGiven = true;
    } else if (arg === '--nodes') {
      opts.nodes = parsePositiveInt(takeValue(), '--nodes');
      nodesGiven = true;
    } else if (arg === '--engine') {
      opts.engine = takeValue();
    } else if (arg === '--json') {
      opts.json = takeValue();
    } else if (arg === '--start-ply' || arg === '--start-plies') {
      opts.startPly = parsePositiveInt(takeValue(), '--start-ply');
    } else if (arg === '--max-plies') {
      opts.maxPlies = parsePositiveInt(takeValue(), '--max-plies');
    } else {
      throw new UsageError(`unknown option "${argv[i]}"`);
    }
  }

  if (opts.help) return opts;
  if (!opts.pgn) throw new UsageError('--pgn is required');
  if (depthGiven && nodesGiven) {
    throw new UsageError('--depth and --nodes are mutually exclusive; pass exactly one');
  }
  if (!depthGiven && !nodesGiven) opts.depth = DEFAULT_DEPTH;
  if (opts.depth === null && opts.nodes === null) opts.depth = DEFAULT_DEPTH;

  const envEngine = process.env.FROOSTROOK_ENGINE && process.env.FROOSTROOK_ENGINE.trim()
    ? process.env.FROOSTROOK_ENGINE
    : null;
  if (opts.engine) {
    opts.engine = path.resolve(process.cwd(), opts.engine);
  } else if (envEngine) {
    opts.engine = path.resolve(process.cwd(), envEngine);
  } else {
    opts.engine = DEFAULT_ENGINE;
  }
  opts.pgn = path.resolve(process.cwd(), opts.pgn);
  opts.json = opts.json ? path.resolve(process.cwd(), opts.json) : null;
  opts.budget = opts.nodes !== null
    ? { mode: 'nodes', value: opts.nodes }
    : { mode: 'depth', value: opts.depth };

  return opts;
}

function writeJsonFile(file, doc) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`analyze: ${e.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw e;
  }
  if (opts.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }

  try {
    if (!fs.existsSync(opts.pgn)) {
      throw new PgnError(`PGN file not found: ${opts.pgn}`);
    }
    if (!fs.statSync(opts.pgn).isFile()) {
      throw new PgnError(`PGN path is not a file: ${opts.pgn}`);
    }
    const text = fs.readFileSync(opts.pgn, 'utf8');
    const games = parsePgn(text, opts.pgn);
    if (!games.length) throw new PgnError(`no PGN games found in ${opts.pgn}`);

    // Replay/validate every game before spawning the engine.  A malformed SAN
    // move therefore fails fast, without a native process.
    const replays = games.map((game) => replayGame(game));

    let selected;
    if (opts.game !== null) {
      if (opts.game < 1 || opts.game > replays.length) {
        throw new UsageError(
          `--game ${opts.game} is out of range: ${opts.pgn} contains ${replays.length} game(s)`
        );
      }
      selected = [replays[opts.game - 1]];
    } else {
      selected = replays;
    }

    const engine = new UciEngine(opts.engine);
    const gameDocs = [];
    let engineId = null;
    try {
      engineId = await engine.start();
      for (let i = 0; i < selected.length; i++) {
        if (i > 0) await engine.newGame();
        gameDocs.push(await analyzeReplay(selected[i], opts, engine, engineId));
      }
    } finally {
      await engine.quit();
    }

    const doc = {
      format: 'kiwa-pgn-analysis',
      version: 1,
      generatedAt: new Date().toISOString(),
      engine: {
        path: opts.engine,
        name: engineId ? engineId.name : null,
        author: engineId ? engineId.author : null,
      },
      budget: opts.budget,
      options: {
        pgn: opts.pgn,
        game: opts.game,
        startPly: opts.startPly,
        maxPlies: opts.maxPlies,
      },
      games: gameDocs,
    };

    if (opts.json) writeJsonFile(opts.json, doc);
    if (!opts.quiet) {
      process.stdout.write(renderHuman(doc, opts) + '\n');
    }
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`analyze: ${e.message}\n\n${USAGE}\n`);
      return 2;
    }
    process.stderr.write(`analyze: ${e.message}\n`);
    if (process.env.ANALYZE_DEBUG) process.stderr.write(e.stack + '\n');
    return 1;
  }
}

module.exports = {
  MATE_CP,
  LABELS,
  USAGE,
  parseArgs,
  parsePgn,
  normalizeFen,
  parseSan,
  sanToUci,
  replayGame,
  examinePosition,
  classifyMove,
  clampLoss,
  buildSummary,
  analyzeReplay,
  formatEval,
  UciEngine,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`analyze: unexpected failure: ${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 1;
    }
  );
}
