// Liest pm2-Logdateien (Historie + Live-Verfolgung). Dateien werden nur gelesen, solange
// jemand zuschaut. Jede Zeile wird vor der Auslieferung maskiert.
import fs from 'node:fs';
import { redact } from './redact.mjs';

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]/g;
const TS = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:Z| ?[+-]\d{2}:?\d{2})?)\]?(?: [|-]|:)? ?/;
const LEVEL_PREFIX = /^\[?(?:INFO|WARN(?:ING)?|ERROR|DEBUG|TRACE|FATAL)\]?:?\s+(?=\S)/;
const MAX_LINE = 4000;

let seq = 0;

export function detectLevel(text, stream) {
  const head = text.slice(0, 300);
  if (/\b(?:ERROR|ERR|FATAL|CRITICAL|SEVERE)\b|\b(?:\w*Error|Exception):|\bUnhandled(?:Promise)?Rejection|\buncaught\b/i.test(head)) return 'ERROR';
  if (/\bWARN(?:ING)?\b|\bDeprecationWarning\b/i.test(head)) return 'WARN';
  if (/\b(?:DEBUG|TRACE|VERBOSE)\b/.test(head)) return 'DEBUG';
  if (/\bINFO\b/i.test(head)) return 'INFO';
  return stream === 'err' ? 'ERROR' : 'INFO';
}

export function parseLine(raw, { stream, bot, botId, live = false }) {
  let text = raw.replace(ANSI, '').replace(/\s+$/, '');
  if (text.length > MAX_LINE) text = `${text.slice(0, MAX_LINE)} … [gekürzt]`;
  text = redact(text);
  let ts = null;
  const m = TS.exec(text);
  if (m) {
    const parsed = Date.parse(m[1].replace(',', '.').replace(/^(\S+) (\d{2}:)/, '$1T$2').replace(/ ([+-])/, '$1'));
    if (Number.isFinite(parsed)) {
      ts = parsed;
      text = text.slice(m[0].length);
    }
  }
  if (ts === null && live) ts = Date.now();
  const level = detectLevel(text, stream);
  // Das Level wird in einer eigenen Spalte gezeigt – führendes Kürzel nicht doppelt ausgeben.
  return { n: ++seq, ts, bot, botId, stream, level, text: text.replace(LEVEL_PREFIX, '') };
}

// Letzte Zeilen einer Datei (liest höchstens maxBytes vom Ende).
export function readTail(file, maxLines = 200, maxBytes = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift(); // angeschnittene erste Zeile verwerfen
    if (lines.at(-1) === '') lines.pop();
    return { lines: lines.slice(-maxLines), size };
  } catch {
    return { lines: [], size: 0 };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

class FileFollower {
  constructor(file, meta) {
    this.file = file;
    this.meta = meta;
    this.offset = this.size();
    this.partial = '';
  }

  size() {
    try {
      return fs.statSync(this.file).size;
    } catch {
      return 0;
    }
  }

  poll() {
    const size = this.size();
    if (size < this.offset) {
      // Datei wurde geleert oder rotiert
      this.offset = 0;
      this.partial = '';
    }
    if (size === this.offset) return [];
    const maxChunk = 256 * 1024;
    let start = this.offset;
    let skipped = false;
    if (size - start > maxChunk) {
      start = size - maxChunk;
      skipped = true;
      this.partial = '';
    }
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(size - start);
      const read = fs.readSync(fd, buf, 0, buf.length, start);
      this.offset = start + read;
      const parts = (this.partial + buf.toString('utf8', 0, read)).split('\n');
      this.partial = parts.pop() ?? '';
      if (skipped) parts.shift();
      return parts.filter((l) => l.trim() !== '').map((l) => parseLine(l, { ...this.meta, live: true }));
    } catch {
      return [];
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}

export function history(bots, { lines = 200 } = {}) {
  const out = [];
  const per = bots.length > 1 ? Math.max(20, Math.ceil(lines / bots.length)) : lines;
  for (const bot of bots) {
    for (const [stream, file] of [
      ['out', bot._outLog],
      ['err', bot._errLog],
    ]) {
      if (!file || file === '/dev/null') continue;
      for (const l of readTail(file, per).lines) {
        if (l.trim() !== '') out.push(parseLine(l, { stream, bot: bot.name, botId: bot.id }));
      }
    }
  }
  // Mit Zeitstempel chronologisch sortieren; Zeilen ohne Zeitstempel behalten ihre Dateireihenfolge.
  if (out.length && out.every((l) => l.ts !== null)) out.sort((a, b) => a.ts - b.ts || a.n - b.n);
  return out.slice(-Math.max(lines, 1) * 2);
}

// Verfolgt die Logdateien der übergebenen Bots und ruft onLines mit neuen Zeilen auf.
export function follow(bots, onLines, intervalMs = 1000) {
  const followers = [];
  for (const bot of bots) {
    for (const [stream, file] of [
      ['out', bot._outLog],
      ['err', bot._errLog],
    ]) {
      if (file && file !== '/dev/null') followers.push(new FileFollower(file, { stream, bot: bot.name, botId: bot.id }));
    }
  }
  const timer = setInterval(() => {
    const batch = [];
    for (const f of followers) {
      for (const line of f.poll()) batch.push(line);
    }
    if (batch.length) onLines(batch.slice(-500));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
