import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, totpCode, TotpVerifier, base32Encode, base32Decode, SessionStore, LoginLimiter } from '../server/auth.mjs';

test('Passwort-Hash: korrekt/falsch, Salt ist zufällig', async () => {
  const a = await hashPassword('korrekt-pferd-batterie');
  const b = await hashPassword('korrekt-pferd-batterie');
  assert.match(a, /^scrypt:14:8:3:[\w-]+:[\w-]+$/);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('korrekt-pferd-batterie', a), true);
  assert.equal(await verifyPassword('korrekt-pferd-batteriE', a), false);
  assert.equal(await verifyPassword('x', 'kaputt'), false);
  assert.equal(await verifyPassword('x', 'scrypt:99:8:1:AAAA:AAAA'), false);
});

test('TOTP: RFC-6238-Testvektoren (SHA-1)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  assert.equal(totpCode(secret, Math.floor(59 / 30)), '287082');
  assert.equal(totpCode(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(totpCode(secret, Math.floor(1234567890 / 30)), '005924');
});

test('TOTP: Zeitfenster ±1 und kein Wiederverwenden', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  let t = 1_700_000_000_000;
  const v = new TotpVerifier(secret, () => t);
  const c = Math.floor(t / 30_000);
  assert.equal(v.verify('abc'), false);
  assert.equal(v.verify(totpCode(secret, c - 3)), false);
  assert.equal(v.verify(totpCode(secret, c)), true);
  assert.equal(v.verify(totpCode(secret, c)), false, 'Code darf nur einmal gelten');
  t += 30_000;
  assert.equal(v.verify(totpCode(secret, c + 1)), true);
});

test('Sessions: Signatur, Leerlauf- und Maximaldauer, Logout', () => {
  let t = 1000;
  const store = new SessionStore({ secret: 's'.repeat(40), idleMs: 1000, maxMs: 5000, now: () => t });
  const { session, cookieValue } = store.create('admin', '1.2.3.4');
  assert.equal(store.get(cookieValue).user, 'admin');
  assert.equal(store.get(`${session.id}.falsch`), null);
  assert.equal(store.get('unsinn'), null);
  const other = new SessionStore({ secret: 'x'.repeat(40), idleMs: 1000, maxMs: 5000, now: () => t });
  assert.equal(other.get(cookieValue), null);
  t += 900;
  assert.ok(store.get(cookieValue));
  t += 900;
  assert.ok(store.get(cookieValue, false), 'noch innerhalb der Leerlaufzeit');
  t += 1100;
  assert.equal(store.get(cookieValue), null, 'Leerlauf abgelaufen');

  const s2 = store.create('admin', 'ip');
  for (let i = 0; i < 6; i++) {
    t += 900;
    store.get(s2.cookieValue);
  }
  assert.equal(store.get(s2.cookieValue), null, 'Maximaldauer abgelaufen');

  const s3 = store.create('admin', 'ip');
  store.destroy(s3.session);
  assert.equal(store.get(s3.cookieValue), null);
});

test('Login-Sperre: pro IP mit Verdopplung, global', () => {
  let t = 0;
  const lim = new LoginLimiter({ now: () => t, maxFails: 3, baseLockMs: 1000, globalMax: 8, globalLockMs: 500 });
  assert.equal(lim.blockedFor('a'), 0);
  lim.fail('a');
  lim.fail('a');
  assert.equal(lim.blockedFor('a'), 0);
  assert.equal(lim.fail('a'), true);
  assert.equal(lim.blockedFor('a'), 1000);
  assert.equal(lim.blockedFor('b'), 0, 'andere IP nicht betroffen');
  t += 1001;
  assert.equal(lim.blockedFor('a'), 0);
  lim.fail('a');
  lim.fail('a');
  lim.fail('a');
  assert.equal(lim.blockedFor('a'), 2000, 'zweite Sperre doppelt so lang');
  // global: 6 Fehlversuche bisher, zwei weitere von anderen IPs lösen die globale Sperre aus
  lim.fail('c');
  assert.equal(lim.fail('d'), true);
  assert.equal(lim.blockedFor('zzz'), 500);
  lim.success('a');
});
