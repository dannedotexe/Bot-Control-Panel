// Konfiguration: ausschließlich aus .env (bzw. Prozess-Umgebung). Keine Secrets im Code.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

function int(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function loadConfig(root, processEnv = process.env) {
  let fileEnv = {};
  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile)) fileEnv = parseEnv(fs.readFileSync(envFile, 'utf8'));
  const env = { ...fileEnv };
  for (const k of Object.keys(processEnv)) {
    if (k.startsWith('BCP_') && processEnv[k] !== undefined) env[k] = processEnv[k];
  }

  const resolve = (p) => (p ? path.resolve(root, p) : '');
  const config = {
    root,
    host: env.BCP_HOST || '0.0.0.0',
    port: int(env.BCP_PORT, 8443, 1, 65535),
    adminUser: env.BCP_ADMIN_USER || 'admin',
    passwordHash: env.BCP_ADMIN_PASSWORD_HASH || '',
    sessionSecret: env.BCP_SESSION_SECRET || '',
    totpSecret: (env.BCP_TOTP_SECRET || '').replace(/\s+/g, ''),
    tlsCert: resolve(env.BCP_TLS_CERT || 'data/tls/cert.pem'),
    tlsKey: resolve(env.BCP_TLS_KEY || 'data/tls/key.pem'),
    // Nur für den Betrieb hinter einem lokalen Reverse-Proxy (Caddy/nginx), der TLS terminiert.
    behindProxy: env.BCP_BEHIND_PROXY === '1',
    selfName: env.BCP_SELF_NAME || 'bot-control-panel',
    pm2Module: env.BCP_PM2_MODULE || '',
    pm2Bin: env.BCP_PM2_BIN || 'pm2',
    sessionIdleMs: int(env.BCP_SESSION_IDLE_MINUTES, 120, 5, 1440) * 60_000,
    sessionMaxMs: int(env.BCP_SESSION_MAX_HOURS, 12, 1, 168) * 3_600_000,
    pollMs: int(env.BCP_POLL_MS, 3000, 1000, 60_000),
    idlePollMs: int(env.BCP_IDLE_POLL_MS, 20_000, 5000, 300_000),
    publicDir: path.join(root, 'public'),
    avatarDir: path.join(root, 'data', 'avatars'),
    limitsFile: path.join(root, 'data', 'limits.json'),
    // .env-Editor: nur Bots, deren Arbeitsverzeichnis unterhalb dieses Ordners liegt
    envRoot: path.resolve(env.BCP_ENV_ROOT || os.homedir()),
    discordStatus: env.BCP_DISCORD_STATUS !== '0',
    discordAvatars: env.BCP_DISCORD_AVATARS !== '0',
  };
  return config;
}

export function validateConfig(config) {
  const errors = [];
  if (!/^scrypt:\d+:\d+:\d+:[\w-]+:[\w-]+$/.test(config.passwordHash)) {
    errors.push('BCP_ADMIN_PASSWORD_HASH fehlt oder ist ungültig (install.sh bzw. scripts/set-password.sh ausführen).');
  }
  if (config.sessionSecret.length < 32) errors.push('BCP_SESSION_SECRET fehlt oder ist zu kurz (mind. 32 Zeichen).');
  if (!/^[\w.-]{1,64}$/.test(config.adminUser)) errors.push('BCP_ADMIN_USER ist ungültig.');
  if (config.totpSecret && !/^[A-Z2-7]{16,}=*$/i.test(config.totpSecret)) errors.push('BCP_TOTP_SECRET ist kein gültiges Base32.');
  if (!config.behindProxy) {
    for (const f of [config.tlsCert, config.tlsKey]) {
      if (!fs.existsSync(f)) errors.push(`TLS-Datei fehlt: ${f}`);
    }
  }
  return errors;
}
