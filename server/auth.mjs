// Authentifizierung: scrypt-Passwort-Hash, TOTP (RFC 6238), signierte Sessions, Login-Sperre.
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// ---------- Passwort ----------
// 16 MB Arbeitsspeicher pro Prüfung – bewusst klein gehalten für Server mit 1 GB RAM.
const SCRYPT = { logN: 14, r: 8, p: 3, keylen: 32 };

function scrypt(password, salt, logN, r, p, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, keylen, { N: 2 ** logN, r, p, maxmem: 256 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.logN, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return `scrypt:${SCRYPT.logN}:${SCRYPT.r}:${SCRYPT.p}:${b64u(salt)}:${b64u(key)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [logN, r, p] = parts.slice(1, 4).map(Number);
  if (!(logN >= 10 && logN <= 18 && r >= 1 && r <= 16 && p >= 1 && p <= 8)) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (typeof password !== 'string' || !expected.length) return false;
  const key = await scrypt(password, salt, logN, r, p, expected.length);
  return crypto.timingSafeEqual(key, expected);
}

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- TOTP ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Ungültiges Base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function totpCode(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const num = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(num).padStart(6, '0');
}

export class TotpVerifier {
  constructor(secret, now = Date.now) {
    this.secret = secret;
    this.now = now;
    this.lastCounter = 0; // Schutz gegen Wiederverwendung desselben Codes
  }

  verify(code) {
    if (!/^\d{6}$/.test(String(code || ''))) return false;
    const current = Math.floor(this.now() / 30_000);
    for (const delta of [0, -1, 1]) {
      const counter = current + delta;
      if (counter <= this.lastCounter) continue;
      if (safeEqual(totpCode(this.secret, counter), code)) {
        this.lastCounter = counter;
        return true;
      }
    }
    return false;
  }
}

// ---------- Sessions ----------
export class SessionStore {
  constructor({ secret, idleMs, maxMs, now = Date.now, maxSessions = 20 }) {
    this.secret = secret;
    this.idleMs = idleMs;
    this.maxMs = maxMs;
    this.now = now;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
  }

  sign(id) {
    return b64u(crypto.createHmac('sha256', this.secret).update(id).digest());
  }

  create(user, ip) {
    this.prune();
    while (this.sessions.size >= this.maxSessions) {
      this.sessions.delete(this.sessions.keys().next().value);
    }
    const id = b64u(crypto.randomBytes(32));
    const t = this.now();
    const session = { id, user, ip, csrf: b64u(crypto.randomBytes(32)), createdAt: t, lastSeen: t };
    this.sessions.set(id, session);
    return { session, cookieValue: `${id}.${this.sign(id)}` };
  }

  // touch=false: Gültigkeit prüfen, ohne die Leerlaufzeit zurückzusetzen (z. B. für SSE).
  get(cookieValue, touch = true) {
    if (typeof cookieValue !== 'string') return null;
    const dot = cookieValue.indexOf('.');
    if (dot < 1) return null;
    const id = cookieValue.slice(0, dot);
    if (!safeEqual(this.sign(id), cookieValue.slice(dot + 1))) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (!this.isAlive(session)) {
      this.sessions.delete(id);
      return null;
    }
    if (touch) session.lastSeen = this.now();
    return session;
  }

  isAlive(session) {
    const t = this.now();
    return this.sessions.has(session.id) && t - session.lastSeen <= this.idleMs && t - session.createdAt <= this.maxMs;
  }

  expiresAt(session) {
    return Math.min(session.lastSeen + this.idleMs, session.createdAt + this.maxMs);
  }

  destroy(session) {
    this.sessions.delete(session.id);
  }

  prune() {
    for (const s of [...this.sessions.values()]) if (!this.isAlive(s)) this.sessions.delete(s.id);
  }
}

// ---------- Login-Sperre ----------
// Pro IP: nach 5 Fehlversuchen gesperrt (15 min, verdoppelt sich bis 24 h).
// Global: nach 40 Fehlversuchen in 15 min sind alle Logins 5 min gesperrt.
export class LoginLimiter {
  constructor({ now = Date.now, maxFails = 5, windowMs = 15 * 60_000, baseLockMs = 15 * 60_000, maxLockMs = 24 * 3_600_000, globalMax = 40, globalLockMs = 5 * 60_000 } = {}) {
    Object.assign(this, { now, maxFails, windowMs, baseLockMs, maxLockMs, globalMax, globalLockMs });
    this.ips = new Map();
    this.globalFails = [];
    this.globalLockedUntil = 0;
  }

  // Liefert verbleibende Sperrzeit in ms (0 = Versuch erlaubt).
  blockedFor(ip) {
    const t = this.now();
    if (this.globalLockedUntil > t) return this.globalLockedUntil - t;
    const e = this.ips.get(ip);
    if (e && e.lockedUntil > t) return e.lockedUntil - t;
    return 0;
  }

  fail(ip) {
    const t = this.now();
    let e = this.ips.get(ip);
    if (!e) {
      if (this.ips.size >= 5000) this.pruneIps(t);
      if (this.ips.size >= 5000) this.ips.delete(this.ips.keys().next().value);
      e = { fails: [], locks: 0, lockedUntil: 0, lastFail: 0 };
      this.ips.set(ip, e);
    }
    e.fails = e.fails.filter((x) => t - x < this.windowMs);
    e.fails.push(t);
    e.lastFail = t;
    let locked = false;
    if (e.fails.length >= this.maxFails) {
      e.lockedUntil = t + Math.min(this.maxLockMs, this.baseLockMs * 2 ** e.locks);
      e.locks += 1;
      e.fails = [];
      locked = true;
    }
    this.globalFails = this.globalFails.filter((x) => t - x < this.windowMs);
    this.globalFails.push(t);
    if (this.globalFails.length >= this.globalMax) {
      this.globalLockedUntil = t + this.globalLockMs;
      this.globalFails = [];
      locked = true;
    }
    return locked;
  }

  success(ip) {
    this.ips.delete(ip);
  }

  pruneIps(t) {
    for (const [ip, e] of this.ips) {
      if (e.lockedUntil < t && t - e.lastFail > 24 * 3_600_000) this.ips.delete(ip);
    }
  }
}
