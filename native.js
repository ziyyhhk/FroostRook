'use strict';

/*
 * UCI client for the native FroostRook engine (native/FroostRook.exe).
 * One long-lived process; one search at a time.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXE = require('./native-exe');

class NativeEngine {
  constructor(exe = EXE) {
    this.exe = exe;
    this.proc = null;
    this.buf = '';
    this.info = null;
    this.onInfo = null;
    this.waiters = [];
    this.queries = [];
    this.broken = false;
  }

  available() {
    return !this.broken && fs.existsSync(this.exe);
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', d => this._onData(d));
    // A missing/incompatible exe must degrade to the JS engine, not hang the GUI.
    this.proc.on('error', () => {
      this.broken = true;
      this.proc = null;
      this._flush(null);
    });
    this.proc.on('exit', () => {
      this.proc = null;
      this._flush(null);
    });
    this.send('uci');
  }

  _flush(value) {
    const ws = this.waiters.splice(0);
    for (const w of ws) w(value);
    const qs = this.queries.splice(0);
    for (const q of qs) { clearTimeout(q.timer); q.resolve(null); }
  }

  send(cmd) {
    if (!this.proc) this.start();
    this.proc.stdin.write(cmd + '\n');
  }

  // Send a command that is answered by a line rather than by a search, and
  // resolve with the first line that starts with `prefix`. Used for the
  // diagnostic commands so the front-end reports the engine that is actually
  // playing. Resolves null if the engine is unavailable or does not answer.
  query(cmd, prefix, timeoutMs = 5000) {
    return new Promise(resolve => {
      try {
        if (!this.proc) this.start();
      } catch {
        resolve(null);
        return;
      }
      if (!this.proc) { resolve(null); return; }
      const entry = { prefix, resolve };
      entry.timer = setTimeout(() => {
        const i = this.queries.indexOf(entry);
        if (i >= 0) this.queries.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      this.queries.push(entry);
      this.send(cmd);
    });
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
    for (let i = 0; i < this.queries.length; i++) {
      const q = this.queries[i];
      if (line.startsWith(q.prefix)) {
        this.queries.splice(i, 1);
        clearTimeout(q.timer);
        q.resolve(line);
        return;
      }
    }
    if (line.startsWith('info ')) {
      const m = line.match(/^info depth (\d+) score (cp|mate) (-?\d+) nodes (\d+) nps (\d+) time (\d+)(?: pv (.*))?$/);
      if (m) {
        this.info = {
          depth: +m[1],
          score: m[2] === 'mate' ? (+m[3] > 0 ? 30000 - +m[3] * 2 : -30000 - +m[3] * 2) : +m[3],
          mate: m[2] === 'mate' ? +m[3] : null,
          nodes: +m[4],
          time: +m[6],
          pv: m[7] ? m[7].split(' ') : [],
        };
      }
      if (this.onInfo) this.onInfo(line);
    } else if (line.startsWith('bestmove')) {
      const mv = line.split(/\s+/)[1] || '0000';
      const w = this.waiters.shift();
      if (w) {
        const info = this.info || {};
        w({ bestMoveStr: mv, score: info.score || 0, depth: info.depth || 0,
            nodes: info.nodes || 0, time: info.time || 0, pv: info.pv || [] });
      }
    }
  }

  /**
   * Run one search. `pos` is a plain FEN or a full position descriptor
   * ("startpos moves ..." / "fen <fen> moves ..."); the latter preserves
   * move history, so the search sees repetitions and the 50-move rule.
   * Resolves with { bestMoveStr, score, depth, nodes, time, pv }.
   */
  search(pos, opts = {}, onInfo = null) {
    return new Promise(resolve => {
      try {
        if (!this.proc) this.start();
      } catch {
        this.broken = true;
      }
      if (!this.proc) { resolve(null); return; } // spawn failed; caller falls back
      this.waiters.push(resolve);
      this.info = null;
      this.onInfo = onInfo;
      const isDescriptor = pos === 'startpos' || pos.startsWith('startpos ') || pos.startsWith('fen ');
      this.send(isDescriptor ? 'position ' + pos : 'position fen ' + pos);
      let go = 'go';
      if (opts.movetime) go += ' movetime ' + opts.movetime;
      if (opts.depth) go += ' depth ' + opts.depth;
      if (opts.nodes) go += ' nodes ' + opts.nodes;
      if (opts.wtime !== undefined) {
        go += ` wtime ${opts.wtime} btime ${opts.btime}`;
        if (opts.winc || opts.binc) go += ` winc ${opts.winc || 0} binc ${opts.binc || 0}`;
        if (opts.movestogo) go += ` movestogo ${opts.movestogo}`;
      }
      if (opts.infinite) go += ' infinite';
      this.send(go);
    });
  }

  /** Forward a UCI option to the native core (starts it if needed). */
  setOption(name, value) {
    const cmd = 'setoption name ' + name + (value === '' || value === undefined ? '' : ' value ' + value);
    this.send(cmd);
  }

  stop() {
    if (this.proc) this.send('stop');
  }

  newGame() {
    if (this.proc) this.send('ucinewgame');
  }

  quit() {
    if (this.proc) {
      this.send('quit');
      this.proc.stdin.end();
      this.proc = null;
    }
  }
}

module.exports = new NativeEngine();
