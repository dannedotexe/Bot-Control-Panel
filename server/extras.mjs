// Zusatzfunktionen: .env-Editor (nur schreiben, nie Werte lesen), RAM-Limits,
// Discord-Status und Discord-Profilbilder. Tokens verlassen den Server nie.
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from './config.mjs';

// ---------- .env der Bots ----------
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_ENV_FILE = 64 * 1024;

export class EnvError extends Error {}

// Nur .env-Dateien direkt im Arbeitsverzeichnis eines Bots unterhalb von envRoot, keine Symlinks.
export function envPath(cwd, envRoot) {
  if (!cwd || !path.isAbsolute(cwd)) throw new EnvError('no_cwd');
  const real = fs.realpathSync(cwd);
  const root = fs.realpathSync(envRoot);
  if (real === root || !real.startsWith(root + path.sep)) throw new EnvError('outside_root');
  const file = path.join(real, '.env');
  if (fs.existsSync(file)) {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new EnvError('not_regular');
    if (st.size > MAX_ENV_FILE) throw new EnvError('too_large');
  }
  return file;
}

export function readEnvKeys(cwd, envRoot) {
  const file = envPath(cwd, envRoot);
  if (!fs.existsSync(file)) return { exists: false, keys: [] };
  return { exists: true, keys: Object.keys(parseEnv(fs.readFileSync(file, 'utf8'))).sort() };
}

// Setzt (value = string) oder entfernt (value = null) einen Schlüssel. Kommentare und Reihenfolge bleiben erhalten.
export function writeEnvKey(cwd, envRoot, key, value) {
  if (!ENV_KEY.test(key)) throw new EnvError('invalid_key');
  if (value !== null && (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value))) throw new EnvError('invalid_value');
  const file = envPath(cwd, envRoot);
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = old ? old.split('\n') : [];
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const quoted = value === null ? null : /[\s#"'`$\\]/.test(value) ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
  let found = false;
  const out = [];
  for (const l of lines) {
    if (re.test(l)) {
      if (!found && quoted !== null) out.push(`${key}=${quoted}`);
      found = true;
    } else out.push(l);
  }
  if (!found && quoted !== null) {
    if (out.length && out.at(-1) === '') out.pop();
    out.push(`${key}=${quoted}`, '');
  }
  if (old) fs.writeFileSync(`${file}.bak`, old, { mode: 0o600 });
  const tmp = `${file}.bcp-tmp`;
  fs.writeFileSync(tmp, out.join('\n'), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { created: !old, removed: value === null && found, updated: found && value !== null };
}

// ---------- RAM-Limits (data/limits.json) ----------
export class Limits {
  constructor(file) {
    this.file = file;
    try {
      this.map = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.map = {};
    }
  }

  get(name) {
    return this.map[name] || null;
  }

  set(name, mb) {
    if (mb === null) delete this.map[name];
    else this.map[name] = { memoryMB: mb };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.map, null, 2));
  }
}

// ---------- Discord-Status (discordstatus.com, öffentlich) ----------
export function parseDiscordStatus(summary) {
  const api = (summary.components || []).find((c) => c.name === 'API');
  return {
    indicator: summary.status?.indicator || 'unknown', // none | minor | major | critical
    description: summary.status?.description || 'Unbekannt',
    api: api ? api.status : null, // operational | degraded_performance | partial_outage | major_outage
    incidents: (summary.incidents || []).slice(0, 3).map((i) => ({ name: String(i.name).slice(0, 160), status: i.status, impact: i.impact, updatedAt: i.updated_at })),
    checkedAt: Date.now(),
  };
}

export async function fetchDiscordStatus(fetchImpl = fetch) {
  const res = await fetchImpl('https://discordstatus.com/api/v2/summary.json', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseDiscordStatus(await res.json());
}

// ---------- Discord-Profilbilder ----------
export const TOKEN_KEYS = ['DISCORD_TOKEN', 'BOT_TOKEN', 'DISCORD_BOT_TOKEN', 'TOKEN', 'CLIENT_TOKEN'];

export function findToken(bot, envRoot) {
  const sources = [bot._tokens || {}];
  try {
    const file = envPath(bot._config.cwd, envRoot);
    if (fs.existsSync(file)) sources.unshift(parseEnv(fs.readFileSync(file, 'utf8')));
  } catch {
    /* kein lesbares .env */
  }
  for (const src of sources) for (const k of TOKEN_KEYS) if (typeof src[k] === 'string' && src[k].length > 20) return src[k];
  return null;
}

// Lädt Avatar + Discord-Name über /users/@me. Gibt { username } zurück oder null.
export async function fetchDiscordAvatar(token, file, fetchImpl = fetch) {
  const res = await fetchImpl('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const me = await res.json();
  if (!/^\d{5,25}$/.test(String(me.id))) return null;
  if (me.avatar && /^(a_)?[0-9a-f]{32}$/.test(me.avatar)) {
    const img = await fetchImpl(`https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128`, { signal: AbortSignal.timeout(8000) });
    if (img.ok) {
      const buf = Buffer.from(await img.arrayBuffer());
      if (buf.length < 512 * 1024 && buf.subarray(0, 4).toString('hex') === '89504e47') {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
      }
    }
  }
  return { username: String(me.username || '').slice(0, 64) };
}
