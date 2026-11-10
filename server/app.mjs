// HTTP-Schicht: statische Dateien, Login, API, SSE. Alle /api-Routen außer Login/Session
// erfordern eine gültige Session; alle schreibenden Routen zusätzlich ein CSRF-Token.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyPassword, safeEqual, SessionStore, LoginLimiter, TotpVerifier } from './auth.mjs';
import { ACTIONS, publicBot } from './pm2.mjs';
import { Monitor } from './monitor.mjs';
import * as logs from './logs.mjs';
import { readEnvKeys, writeEnvKey, EnvError, ENV_KEY } from './extras.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const MAX_BODY = 8 * 1024;
const MAX_STREAMS = 12;

class HttpError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function loadStatic(dir) {
  const files = new Map();
  const walk = (d, prefix) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else if (TYPES[path.extname(entry.name)]) {
        const buf = fs.readFileSync(full);
        files.set(`/${prefix}${entry.name}`, {
          buf,
          type: TYPES[path.extname(entry.name)],
          etag: `"${crypto.createHash('sha1').update(buf).digest('base64url')}"`,
        });
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return files;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      req.resume();
      return reject(new HttpError(415, 'unsupported_media_type'));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) reject(new HttpError(413, 'payload_too_large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('kein Objekt');
        resolve(data);
      } catch {
        reject(new HttpError(400, 'invalid_json'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'bad_request')));
  });
}

export function createApp({ config, pm2, log = console, now = Date.now, version = '0.0.0', tlsInfo = null, fetchImpl = globalThis.fetch }) {
  const statics = loadStatic(config.publicDir);
  const sessions = new SessionStore({ secret: config.sessionSecret, idleMs: config.sessionIdleMs, maxMs: config.sessionMaxMs, now });
  const limiter = new LoginLimiter({ now });
  const totp = config.totpSecret ? new TotpVerifier(config.totpSecret, now) : null;
  const monitor = new Monitor({ pm2, config, log, fetchImpl });
  const cookieName = '__Host-bcp_session';
  const streams = new Set();
  let verifyQueue = Promise.resolve(); // scrypt-Prüfungen nacheinander (begrenzt RAM/CPU)

  function clientIp(req) {
    const remote = req.socket.remoteAddress || 'unknown';
    if (config.behindProxy && /^(::1|127\.|::ffff:127\.)/.test(remote)) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1].slice(0, 64);
    }
    return remote;
  }

  function baseHeaders(res) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }

  function json(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  function setSessionCookie(res, value, maxAgeSec) {
    res.setHeader('Set-Cookie', `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`);
  }

  function getSession(req, touch = true) {
    return sessions.get(parseCookies(req.headers.cookie)[cookieName], touch);
  }

  function requireSession(req, touch = true) {
    const session = getSession(req, touch);
    if (!session) throw new HttpError(401, 'unauthorized');
    return session;
  }

  // Schreibende Anfragen: gleiche Herkunft + CSRF-Token der Session.
  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {
        /* ungültig */
      }
      if (!host || host !== req.headers.host) throw new HttpError(403, 'bad_origin');
    }
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'bad_origin');
  }

  function requireCsrf(req, session) {
    checkOrigin(req);
    const token = req.headers['x-csrf-token'];
    if (typeof token !== 'string' || !safeEqual(token, session.csrf)) throw new HttpError(403, 'bad_csrf');
  }

  function sessionInfo(session) {
    return { authenticated: true, user: session.user, csrf: session.csrf, expiresAt: sessions.expiresAt(session), twoFactor: Boolean(totp) };
  }

  function botFromParam(raw) {
    if (!/^\d{1,6}$/.test(raw)) throw new HttpError(400, 'invalid_id');
    return Number(raw);
  }

  function openStream(req, res, session) {
    if (streams.size >= MAX_STREAMS) throw new HttpError(503, 'too_many_streams');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    const cleanups = [];
    const stream = {
      send(event, data) {
        if (res.writableEnded || res.destroyed) return;
        if (!sessions.isAlive(session)) {
          res.write('event: expired\ndata: {}\n\n');
          stream.close();
          return;
        }
        // Langsame Clients nicht unbegrenzt puffern
        if (res.writableLength > 2 * 1024 * 1024) return stream.close();
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      },
      onClose(fn) {
        cleanups.push(fn);
      },
      close() {
        if (!streams.delete(stream)) return;
        clearInterval(heartbeat);
        for (const fn of cleanups) fn();
        res.end();
      },
    };
    const heartbeat = setInterval(() => {
      if (!sessions.isAlive(session)) return stream.send('expired', {});
      res.write(': ping\n\n');
    }, 25_000);
    heartbeat.unref?.();
    streams.add(stream);
    req.on('close', () => stream.close());
    return stream;
  }

  // ---------- Routen ----------
  async function login(req, res) {
    checkOrigin(req);
    const ip = clientIp(req);
    const blocked = limiter.blockedFor(ip);
    if (blocked > 0) {
      res.setHeader('Retry-After', Math.ceil(blocked / 1000));
      throw new HttpError(429, 'locked', { retryAfter: Math.ceil(blocked / 1000) });
    }
    const body = await readJson(req);
    const { username, password, code } = body;
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 128 || password.length > 1024 || (code !== undefined && typeof code !== 'string')) {
      throw new HttpError(400, 'invalid_input');
    }
    const check = verifyQueue.then(() => verifyPassword(password, config.passwordHash).catch(() => false));
    verifyQueue = check;
    const passOk = await check;
    const userOk = safeEqual(username, config.adminUser);
    let ok = passOk && userOk;
    if (ok && totp) {
      if (!code) return json(res, 401, { error: 'totp_required' });
      ok = totp.verify(code);
    }
    if (!ok) {
      const locked = limiter.fail(ip);
      log.warn(`[auth] Fehlgeschlagener Login von ${ip}${locked ? ' – gesperrt' : ''}`);
      if (locked) monitor.notify('warn', 'Login gesperrt', `Zu viele Fehlversuche von ${ip}.`);
      throw new HttpError(401, 'invalid_credentials');
    }
    limiter.success(ip);
    const { session, cookieValue } = sessions.create(config.adminUser, ip);
    setSessionCookie(res, cookieValue, Math.floor(config.sessionMaxMs / 1000));
    log.info(`[auth] Login von ${ip}`);
    json(res, 200, sessionInfo(session));
  }

  async function botAction(req, res, session, id) {
    requireCsrf(req, session);
    const body = await readJson(req);
    const action = body.action;
    if (typeof action !== 'string' || !ACTIONS.has(action)) throw new HttpError(400, 'invalid_action');
    // Nur bereits in pm2 vorhandene Prozesse – frisch abgefragt, Name muss zur ID passen.
    const list = await pm2.list();
    const bot = list.find((b) => b.id === id);
    if (!bot) throw new HttpError(404, 'not_found');
    if (typeof body.name !== 'string' || body.name !== bot.name) throw new HttpError(409, 'name_mismatch');
    if (bot.self && action !== 'restart') throw new HttpError(409, 'self_protected');
    if (action === 'start' && bot.status === 'online') throw new HttpError(409, 'already_running');
    if (action === 'stop' && bot.status === 'stopped') throw new HttpError(409, 'already_stopped');
    monitor.expect(id);
    log.info(`[audit] ${session.user}@${clientIp(req)}: ${action} ${bot.name} (id ${id})`);
    if (bot.self) {
      // Antwort senden, bevor sich das Panel selbst neu startet
      json(res, 200, { ok: true, self: true });
      setTimeout(() => pm2.act('restart', id).catch((err) => log.error(`[pm2] ${err.message}`)), 300);
      return;
    }
    try {
      await pm2.act(action, id);
    } catch (err) {
      log.error(`[pm2] ${action} ${bot.name}: ${err.message}`);
      throw new HttpError(502, 'pm2_failed');
    }
    await monitor.tick();
    json(res, 200, { ok: true, bot: monitor.findBot(id) ? publicBot(monitor.findBot(id)) : null });
  }

  // Erneute Passwortabfrage für besonders sensible Aktionen (Schreiben in .env der Bots).
  async function confirmPassword(req, password) {
    const ip = clientIp(req);
    const blocked = limiter.blockedFor(ip);
    if (blocked > 0) throw new HttpError(429, 'locked', { retryAfter: Math.ceil(blocked / 1000) });
    if (typeof password !== 'string' || password.length > 1024) throw new HttpError(400, 'invalid_input');
    const check = verifyQueue.then(() => verifyPassword(password, config.passwordHash).catch(() => false));
    verifyQueue = check;
    if (!(await check)) {
      limiter.fail(ip);
      throw new HttpError(403, 'wrong_password');
    }
  }

  function envErr(err) {
    if (err instanceof EnvError) return new HttpError(409, `env_${err.message}`);
    if (err?.code === 'ENOENT') return new HttpError(409, 'env_no_cwd');
    return err;
  }

  async function api(req, res, url) {
    const p = url.pathname;
    const method = req.method;

    if (p === '/api/session' && method === 'GET') {
      const session = getSession(req, false);
      return json(res, 200, session ? sessionInfo(session) : { authenticated: false, twoFactor: Boolean(totp) });
    }
    if (p === '/api/login' && method === 'POST') return login(req, res);

    // Ab hier nur mit Session. Streams setzen die Leerlaufzeit nicht zurück.
    const isStream = p === '/api/stream' || p === '/api/logs/stream';
    const session = requireSession(req, !isStream);

    if (p === '/api/logout' && method === 'POST') {
      requireCsrf(req, session);
      sessions.destroy(session);
      setSessionCookie(res, '', 0);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/stream' && method === 'GET') {
      const stream = openStream(req, res, session);
      stream.send('init', monitor.snapshot());
      stream.onClose(monitor.subscribe(stream.send));
      return undefined;
    }

    if (p === '/api/logs/stream' && method === 'GET') {
      const botParam = url.searchParams.get('bot') || 'all';
      const lines = Math.min(1000, Math.max(10, Number.parseInt(url.searchParams.get('lines') || '200', 10) || 200));
      let targets;
      if (botParam === 'all') targets = monitor.bots;
      else {
        const bot = monitor.findBot(botFromParam(botParam));
        if (!bot) throw new HttpError(404, 'not_found');
        targets = [bot];
      }
      const stream = openStream(req, res, session);
      stream.send('history', logs.history(targets, { lines }));
      stream.onClose(logs.follow(targets, (batch) => stream.send('lines', batch)));
      return undefined;
    }

    if (p === '/api/panel' && method === 'GET') {
      return json(res, 200, {
        version,
        user: session.user,
        twoFactor: Boolean(totp),
        session: { createdAt: session.createdAt, expiresAt: sessions.expiresAt(session), idleMinutes: config.sessionIdleMs / 60_000, maxHours: config.sessionMaxMs / 3_600_000 },
        port: config.port,
        behindProxy: config.behindProxy,
        pm2: { mode: pm2.mode, version: pm2.version || null },
        node: process.version,
        memory: process.memoryUsage().rss,
        uptime: Math.round(process.uptime()),
        pollMs: config.pollMs,
        tls: tlsInfo,
      });
    }

    if (p === '/api/discord' && method === 'GET') return json(res, 200, { discord: monitor.discord });

    const m = /^\/api\/bots\/(\d+)(\/action|\/errors|\/env|\/limit)?$/.exec(p);
    if (m) {
      const id = botFromParam(m[1]);
      if (m[2] === '/action' && method === 'POST') return botAction(req, res, session, id);
      const bot = monitor.findBot(id);
      if (!bot) throw new HttpError(404, 'not_found');
      if (!m[2] && method === 'GET') {
        return json(res, 200, { bot: publicBot(bot), config: bot._config, history: monitor.botHistory.get(id) || [] });
      }
      if (m[2] === '/env' && method === 'GET') {
        try {
          return json(res, 200, readEnvKeys(bot._config.cwd, config.envRoot));
        } catch (err) {
          throw envErr(err);
        }
      }
      if (m[2] === '/env' && method === 'POST') {
        requireCsrf(req, session);
        const body = await readJson(req);
        const { key, value, remove, password } = body;
        if (typeof key !== 'string' || !ENV_KEY.test(key)) throw new HttpError(400, 'invalid_key');
        if (!remove && (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value))) throw new HttpError(400, 'invalid_value');
        if (bot.self) throw new HttpError(409, 'self_protected');
        await confirmPassword(req, password);
        let result;
        try {
          result = writeEnvKey(bot._config.cwd, config.envRoot, key, remove ? null : value);
        } catch (err) {
          throw envErr(err);
        }
        // Nur Schlüsselname protokollieren, nie den Wert
        log.info(`[audit] ${session.user}@${clientIp(req)}: .env ${remove ? 'entfernt' : 'gesetzt'} ${key} bei ${bot.name}`);
        monitor.notify('info', `${bot.name}: .env geändert`, `${key} ${remove ? 'entfernt' : 'gesetzt'} – wirksam nach Neustart.`);
        return json(res, 200, { ok: true, ...result });
      }
      if (m[2] === '/limit' && method === 'POST') {
        requireCsrf(req, session);
        const { memoryMB } = await readJson(req);
        if (memoryMB !== null && !(Number.isInteger(memoryMB) && memoryMB >= 32 && memoryMB <= 65536)) throw new HttpError(400, 'invalid_limit');
        if (bot.self) throw new HttpError(409, 'self_protected');
        monitor.limits.set(bot.name, memoryMB);
        log.info(`[audit] ${session.user}@${clientIp(req)}: RAM-Limit ${bot.name} = ${memoryMB ?? 'keins'}`);
        return json(res, 200, { ok: true, memoryMB });
      }
      if (m[2] === '/errors' && method === 'GET') {
        const tail = bot._errLog && bot._errLog !== '/dev/null' ? logs.readTail(bot._errLog, 80).lines : [];
        return json(res, 200, {
          lines: tail.filter((l) => l.trim() !== '').map((l) => logs.parseLine(l, { stream: 'err', bot: bot.name, botId: bot.id })),
        });
      }
    }
    throw new HttpError(404, 'not_found');
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
    let p = url.pathname;
    const avatar = /^\/avatars\/([\w.-]{1,64})\.png$/.exec(p);
    if (avatar) {
      requireSession(req, false);
      let file = path.join(config.avatarDir, `${avatar[1]}.png`);
      if (!fs.existsSync(file)) file = path.join(config.avatarDir, 'auto', `${avatar[1]}.png`);
      if (!path.resolve(file).startsWith(config.avatarDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).size > 512 * 1024) throw new HttpError(404, 'not_found');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' });
      return res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(file));
    }
    if (p === '/') p = '/index.html';
    const file = statics.get(p);
    if (!file) throw new HttpError(404, 'not_found');
    if (req.headers['if-none-match'] === file.etag) {
      res.writeHead(304, { ETag: file.etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.buf.length, ETag: file.etag, 'Cache-Control': 'no-cache' });
    return res.end(req.method === 'HEAD' ? undefined : file.buf);
  }

  async function handler(req, res) {
    baseHeaders(res);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else serveStatic(req, res, url);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) {
        if (err.status === 413) {
          // Antwort senden, dann die Verbindung beenden statt den Rest zu lesen
          res.setHeader('Connection', 'close');
          res.once('finish', () => req.destroy());
        }
        return json(res, err.status, { error: err.code, ...err.extra });
      }
      log.error(`[http] ${err?.stack || err}`);
      return json(res, 500, { error: 'internal_error' });
    }
    return undefined;
  }

  return {
    handler,
    monitor,
    sessions,
    limiter,
    start: () => monitor.start(),
    stop() {
      monitor.stop();
      for (const s of [...streams]) s.close();
      pm2.close();
    },
  };
}
