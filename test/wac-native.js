'use strict';

/*
 * Scores the native engine on the Win at Chess (WAC) suite.
 * Uses the JS engine only to convert WAC's SAN "bm" to UCI moves.
 *   node test/wac-native.js [ms-per-position] [limit]
 */

const fs = require('fs');
const path = require('path');
const engine = require('../engine.js');
const native = require('../native');

engine.setInfoHandler(() => {});

const ms = +(process.argv[2] || 300);
const limit = +(process.argv[3] || 300);

// Same SAN matcher as test/wac.js (needs the JS engine's legal move list).
function sanToUci(san) {
  let s = String(san).trim().replace(/\s+/g, '');
  s = s.replace(/[+#!?]+$/, '').replace(/e\.p\./i, '');
  const legal = engine.getLegalMoves();
  if (!legal.length) return null;

  if (s === 'O-O' || s === '0-0') {
    for (const mv of legal) {
      const d = engine.describeMove(mv);
      if (d.castle && (d.to === 6 || d.to === 118)) return engine.moveToStr(mv);
    }
    return null;
  }
  if (s === 'O-O-O' || s === '0-0-0') {
    for (const mv of legal) {
      const d = engine.describeMove(mv);
      if (d.castle && (d.to === 2 || d.to === 114)) return engine.moveToStr(mv);
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
    const d = engine.describeMove(mv);
    if (d.piece !== pieceType || d.to !== to) continue;
    if (fromFile >= 0 && (d.from & 7) !== fromFile) continue;
    if (fromRank >= 0 && (d.from >> 4) !== fromRank) continue;
    if (isCapture && !d.cap) continue;
    if (promo && d.promo !== promo) continue;
    return engine.moveToStr(mv);
  }
  return null;
}

async function main() {
  const file = path.join(__dirname, '..', 'wacnew.epd');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(0, limit);

  let solved = 0, tested = 0, unparsed = 0;
  const misses = [];
  const start = Date.now();

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const fen = line.split(' bm ')[0].trim();
    const bmMatch = line.match(/bm\s+([^;]+)/);
    if (!bmMatch) continue;
    const bm = bmMatch[1].trim().split(/\s+/)[0];

    engine.setFen(fen);
    const want = sanToUci(bm);
    if (!want) { unparsed++; continue; }

    const r = await native.search(fen, { movetime: ms });
    tested++;
    if (r.bestMoveStr === want) solved++;
    else misses.push({ id: idx + 1, bm, want, got: r.bestMoveStr, score: r.score });

    if ((idx + 1) % 50 === 0) {
      const el = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`... ${idx + 1}/${lines.length}  solved ${solved}/${tested}  (${el}s)`);
    }
  }

  console.log(`\nWAC native @ ${ms}ms/move: ${solved}/${tested} = ${(100 * solved / tested).toFixed(1)}%`);
  console.log(`unparsed positions: ${unparsed}`);
  console.log('misses (first 15):');
  for (const m of misses.slice(0, 15)) {
    console.log(`  #${m.id} bm ${m.bm} (${m.want})  got ${m.got}  score ${m.score}`);
  }
  native.quit();
}

main();
