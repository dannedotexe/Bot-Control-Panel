// Integrationstests der HTTP-Schicht mit pm2-Attrappe.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';
import { hashPassword, totpCode, base32Encode } from '../server/auth.mjs';
import { createFakePm2, FAKE_TOKEN } from './helpers/fake-pm2.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'test-passwort-123';
const quiet = { info() {}, warn() {}, error() {} };
const hash = await hashPassword(PASSWORD);

async function setup(t, { totp = '' } = {}) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcp-app-'));
  const pm2 = createFakePm2({ logDir });
  const config = { ...loadConfig(root, {}), passwordHash: hash, sessionSecret: 'x'.repeat(48), adminUser: 'admin', totpSecret: totp, pollMs: 1000, discordStatus: false, discordAvatars: false, envRoot: logDir, limitsFile: path.join(logDir, 'limits.json') };
  for (const p of pm2.procs) {
    p.pm2_env.pm_cwd = path.join(logDir, p.name);
    fs.mkdirSync(p.pm2_env.pm_cwd, { recursive: true });
  }
  const app = createApp({ config, pm2, log: quiet, version: 'test' });
  await app.start();
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    app.stop();
    server.closeAllConnections();
    server.close();
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  const client = { cookie: '', csrf: '' };
  client.req = async (p, { method = 'GET', body, headers = {}, raw = false } = {}) => {
    const h = { ...headers };
    if (client.cookie) h.Cookie = client.cookie;
    if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (method !== 'GET' && client.csrf && h['X-CSRF-Token'] === undefined) h['X-CSRF-Token'] = client.csrf;
    const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) client.cookie = set.split(';')[0];
    if (raw) return res;
    return { status: res.status, headers: res.headers, data: await res.json().catch(() => null) };
  };
  client.login = async (extra = {}) => {
    const r = await client.req('/api/login', { method: 'POST', body: { username: 'admin', password: PASSWORD, ...extra } });
    if (r.status === 200) client.csrf = r.data.csrf;
    return r;
  };
  return { app, pm2, client, base, logDir };
}

test('Ohne Login sind alle API-Routen gesperrt', async (t) => {
  const { client } = await setup(t);
  for (const p of ['/api/stream', '/api/panel', '/api/bots/0', '/api/bots/0/errors', '/api/logs/stream', '/avatars/x.png']) {
    assert.equal((await client.req(p)).status, 401, p);
  }
  assert.equal((await client.req('/api/bots/0/action', { method: 'POST', body: { action: 'restart', name: 'gambino-bot' } })).status, 401);
  assert.equal((await client.req('/api/logout', { method: 'POST', body: {} })).status, 401);
  const s = await client.req('/api/session');
  assert.deepEqual(s.data, { authenticated: false, twoFactor: false });
  const cookieForged = await fetch(`${(await setup(t)).base}/api/panel`, { headers: { Cookie: '__Host-bcp_session=abc.def' } });
  assert.equal(cookieForged.status, 401);
});

test('Statische Dateien, Sicherheits-Header, kein Pfad-Ausbruch', async (t) => {
  const { client } = await setup(t);
  const res = await client.req('/', { raw: true });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<div id="app">/);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  for (const p of ['/../.env', '/%2e%2e/.env', '/..%2f.env', '/.env', '/js/../../package.json', '/server/app.mjs']) {
    assert.equal((await client.req(p)).status, 404, p);
  }
  assert.equal((await client.req('/js/main.js', { raw: true })).status, 200);
  assert.equal((await client.req('/', { method: 'POST', body: {} })).status, 405);
});

test('Login: Cookie-Attribute, Session, Logout', async (t) => {
  const { client } = await setup(t);
  assert.equal((await client.req('/api/login', { method: 'POST', body: { username: 'admin', password: 'falsch' } })).status, 401);
  assert.equal((await client.req('/api/login', { method: 'POST', body: { username: 'root', password: PASSWORD } })).status, 401);
  assert.equal((await client.req('/api/login', { method: 'POST', body: 'username=admin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await client.req('/api/login', { method: 'POST', body: { username: ['a'], password: {} } })).status, 400);
  assert.equal((await client.req('/api/login', { method: 'POST', body: '{kaputt' })).status, 400);
  assert.equal((await client.req('/api/login', { method: 'POST', body: { username: 'a', password: 'x'.repeat(20000) } })).status, 413);

  const res = await client.req('/api/login', { method: 'POST', body: { username: 'admin', password: PASSWORD }, raw: true });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /^__Host-bcp_session=[\w-]+\.[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
  const body = await res.json();
  assert.equal(body.user, 'admin');
  client.csrf = body.csrf;

  assert.equal((await client.req('/api/panel')).status, 200);
  assert.equal((await client.req('/api/session')).data.authenticated, true);
  assert.equal((await client.req('/api/logout', { method: 'POST', body: {}, headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await client.req('/api/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await client.req('/api/panel')).status, 401);
});

test('Login-Sperre nach 5 Fehlversuchen (auch mit richtigem Passwort)', async (t) => {
  const { client } = await setup(t);
  for (let i = 0; i < 5; i++) {
    assert.equal((await client.req('/api/login', { method: 'POST', body: { username: 'admin', password: `falsch${i}` } })).status, 401);
  }
  const locked = await client.login();
  assert.equal(locked.status, 429);
  assert.equal(locked.data.error, 'locked');
  assert.ok(locked.data.retryAfter > 800);
  assert.ok(Number(locked.headers.get('retry-after')) > 800);
});

test('2FA: Code erforderlich, falscher Code zählt als Fehlversuch', async (t) => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const { client } = await setup(t, { totp: secret });
  assert.equal((await client.req('/api/session')).data.twoFactor, true);
  const r1 = await client.login();
  assert.equal(r1.status, 401);
  assert.equal(r1.data.error, 'totp_required');
  assert.equal((await client.login({ code: '000000' })).data.error, 'invalid_credentials');
  // falsches Passwort verrät nicht, dass 2FA aktiv ist
  assert.equal((await client.req('/api/login', { method: 'POST', body: { username: 'admin', password: 'falsch' } })).data.error, 'invalid_credentials');
  const ok = await client.login({ code: totpCode(secret, Math.floor(Date.now() / 30_000)) });
  assert.equal(ok.status, 200);
});

test('Aktionen: nur Whitelist, CSRF, Herkunft, nur bestehende Prozesse, Selbstschutz', async (t) => {
  const { client, pm2 } = await setup(t);
  await client.login();
  const act = (id, body, headers) => client.req(`/api/bots/${id}/action`, { method: 'POST', body, headers });

  assert.equal((await act(0, { action: 'restart', name: 'gambino-bot' }, { 'X-CSRF-Token': 'falsch' })).data.error, 'bad_csrf');
  assert.equal((await act(0, { action: 'restart', name: 'gambino-bot' }, { Origin: 'https://evil.example' })).data.error, 'bad_origin');
  assert.equal((await act(0, { action: 'restart', name: 'gambino-bot' }, { 'Sec-Fetch-Site': 'cross-site' })).data.error, 'bad_origin');
  for (const action of ['delete', 'reload', 'kill', 'exec', 'start; rm -rf /', '', null, ['restart']]) {
    assert.equal((await act(0, { action, name: 'gambino-bot' })).data.error, 'invalid_action', String(action));
  }
  assert.equal((await act(99, { action: 'restart', name: 'gibts-nicht' })).status, 404);
  assert.equal((await act('0;ls', { action: 'restart', name: 'x' })).status, 404);
  assert.equal((await act(0, { action: 'restart', name: 'chud-bot' })).data.error, 'name_mismatch');
  assert.equal((await act(0, { action: 'start', name: 'gambino-bot' })).data.error, 'already_running');
  assert.equal((await act(5, { action: 'stop', name: 'bot-control-panel' })).data.error, 'self_protected');
  assert.deepEqual(pm2.calls, [], 'bis hier darf pm2 nicht aufgerufen worden sein');

  const stop = await act(1, { action: 'stop', name: 'chud-bot' });
  assert.equal(stop.status, 200);
  assert.equal(stop.data.bot.status, 'stopped');
  assert.equal((await act(1, { action: 'stop', name: 'chud-bot' })).data.error, 'already_stopped');
  const start = await act(1, { action: 'start', name: 'chud-bot' });
  assert.equal(start.data.bot.status, 'online');
  assert.equal((await act(3, { action: 'restart', name: 'hugopredict' })).status, 200);
  assert.deepEqual(pm2.calls, [['stop', 1], ['start', 1], ['restart', 3]]);
});

test('Bot-Details und Stream enthalten keine Secrets', async (t) => {
  const { client, logDir } = await setup(t);
  await client.login();
  fs.appendFileSync(path.join(logDir, 'gambino-bot-out.log'), `2025-01-01T10:00:00Z: Ready\n2025-01-01T10:00:01Z: client.login(${FAKE_TOKEN})\n`);
  fs.appendFileSync(path.join(logDir, 'gambino-bot-error.log'), `2025-01-01T10:00:02Z: Error: Invalid token ${FAKE_TOKEN}\n`);

  const detail = await client.req('/api/bots/0');
  assert.equal(detail.status, 200);
  const text = JSON.stringify(detail.data);
  assert.ok(!text.includes(FAKE_TOKEN) && !text.includes('hunter2secret') && !text.includes('ghp_'));
  assert.equal(detail.data.config.script, '/home/ubuntu/gambino-bot/index.js');
  assert.deepEqual(detail.data.config.env.find((e) => e.name === 'DISCORD_TOKEN'), { name: 'DISCORD_TOKEN', value: null });

  const errors = await client.req('/api/bots/0/errors');
  assert.equal(errors.data.lines.length, 1);
  assert.equal(errors.data.lines[0].level, 'ERROR');
  assert.ok(!JSON.stringify(errors.data).includes(FAKE_TOKEN));

  // SSE: init-Ereignis des Zustands-Streams
  const res = await client.req('/api/stream', { raw: true });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  let buf = '';
  while (!buf.includes('event: init') || !buf.includes('\n\n', buf.indexOf('event: init'))) buf += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.ok(!buf.includes(FAKE_TOKEN));
  const init = JSON.parse(/event: init\ndata: (.*)\n/.exec(buf)[1]);
  assert.equal(init.state.bots.length, 6);
  assert.ok(init.state.system.mem.total > 0);
  assert.ok(!('_config' in init.state.bots[0]) && !('_outLog' in init.state.bots[0]));
});

test('Live-Logs: Historie und neue Zeilen per SSE, maskiert', async (t) => {
  const { client, logDir } = await setup(t);
  await client.login();
  const out = path.join(logDir, 'chud-bot-out.log');
  fs.appendFileSync(out, 'alte zeile\n');
  const res = await client.req('/api/logs/stream?bot=1&lines=50', { raw: true });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const waitFor = async (needle) => {
    while (!buf.includes(needle)) buf += dec.decode((await reader.read()).value);
  };
  await waitFor('alte zeile');
  assert.match(buf, /event: history/);
  fs.appendFileSync(out, `[WARN] neue zeile password=geheim1234\n`);
  await waitFor('neue zeile');
  await reader.cancel();
  assert.match(buf, /event: lines/);
  assert.match(buf, /"level":"WARN"/);
  assert.ok(!buf.includes('geheim1234'));
  assert.equal((await client.req('/api/logs/stream?bot=77')).status, 404);
  assert.equal((await client.req('/api/logs/stream?bot=abc')).status, 400);
});

test('Monitor meldet Statuswechsel und pm2-Ausfall', async (t) => {
  const { app, pm2 } = await setup(t);
  pm2.procs[0].pm2_env.status = 'errored';
  await app.monitor.tick();
  pm2.procs[1].pm2_env.restart_time += 1;
  await app.monitor.tick();
  pm2.failList = true;
  await app.monitor.tick();
  pm2.failList = false;
  await app.monitor.tick();
  const titles = app.monitor.notifications.map((n) => `${n.level}:${n.title}`);
  assert.deepEqual(titles, ['error:gambino-bot ist abgestürzt', 'warn:chud-bot wurde neu gestartet', 'error:pm2 nicht erreichbar', 'info:pm2 wieder erreichbar']);
  assert.equal(app.monitor.state().pm2Ok, true);
});

test('.env-Editor: nur Namen lesen, schreiben nur mit Passwort, Werte nie zurück', async (t) => {
  const { client, logDir } = await setup(t);
  await client.login();
  const envFile = path.join(logDir, 'gambino-bot', '.env');
  fs.writeFileSync(envFile, `# Kommentar\nDISCORD_TOKEN=${FAKE_TOKEN}\nPREFIX=!\n`);
  const read = await client.req('/api/bots/0/env');
  assert.deepEqual(read.data, { exists: true, keys: ['DISCORD_TOKEN', 'PREFIX'] });
  assert.ok(!JSON.stringify(read.data).includes(FAKE_TOKEN));

  const post = (body, headers) => client.req('/api/bots/0/env', { method: 'POST', body, headers });
  assert.equal((await post({ key: 'NEU', value: 'x', password: PASSWORD }, { 'X-CSRF-Token': 'falsch' })).data.error, 'bad_csrf');
  assert.equal((await post({ key: 'NEU', value: 'x', password: 'falsch' })).data.error, 'wrong_password');
  assert.equal((await post({ key: 'NEU', value: 'x' })).status, 400);
  assert.equal((await post({ key: '../x', value: 'x', password: PASSWORD })).data.error, 'invalid_key');
  assert.equal((await post({ key: 'A', value: 'a\nB=b', password: PASSWORD })).data.error, 'invalid_value');
  assert.equal((await client.req('/api/bots/5/env', { method: 'POST', body: { key: 'A', value: 'b', password: PASSWORD } })).data.error, 'self_protected');

  assert.equal((await post({ key: 'DISCORD_TOKEN', value: 'neuer token mit leerzeichen', password: PASSWORD })).status, 200);
  assert.equal((await post({ key: 'NEU', value: 'wert', password: PASSWORD })).status, 200);
  assert.equal((await post({ key: 'PREFIX', remove: true, password: PASSWORD })).status, 200);
  assert.equal(fs.readFileSync(envFile, 'utf8'), '# Kommentar\nDISCORD_TOKEN="neuer token mit leerzeichen"\nNEU=wert\n');
  assert.equal((fs.statSync(envFile).mode & 0o777).toString(8), '600');
  assert.ok(fs.existsSync(`${envFile}.bak`));
});

test('.env-Editor: kein Zugriff außerhalb von envRoot und keine Symlinks', async (t) => {
  const { client, pm2, logDir, app } = await setup(t);
  await client.login();
  pm2.procs[1].pm2_env.pm_cwd = os.tmpdir();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bcp-out-'));
  fs.writeFileSync(path.join(outside, 'secret'), 'x');
  fs.symlinkSync(path.join(outside, 'secret'), path.join(logDir, 'hugosmp-bot', '.env'));
  await app.monitor.tick();
  assert.equal((await client.req('/api/bots/1/env')).data.error, 'env_outside_root');
  assert.equal((await client.req('/api/bots/2/env')).data.error, 'env_not_regular');
  assert.equal((await client.req('/api/bots/2/env', { method: 'POST', body: { key: 'A', value: 'b', password: PASSWORD } })).data.error, 'env_not_regular');
  assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'x');
  fs.rmSync(outside, { recursive: true });
});

test('RAM-Limit: Validierung und Neustart nach dreimaliger Überschreitung', async (t) => {
  const { client, app, pm2 } = await setup(t);
  await client.login();
  const set = (id, memoryMB) => client.req(`/api/bots/${id}/limit`, { method: 'POST', body: { memoryMB } });
  assert.equal((await set(0, 5)).data.error, 'invalid_limit');
  assert.equal((await set(0, '256')).data.error, 'invalid_limit');
  assert.equal((await set(5, 256)).data.error, 'self_protected');
  assert.equal((await set(0, 64)).status, 200);
  pm2.procs[0].monit.memory = 90 * 1048576;
  for (let i = 0; i < 3; i++) await app.monitor.tick();
  assert.deepEqual(pm2.calls.at(-1), ['restart', 0]);
  assert.ok(app.monitor.notifications.some((n) => n.title.includes('RAM-Limit')));
  assert.equal(app.monitor.state().bots[0].memoryLimitMB, 64);
  assert.equal((await set(0, null)).status, 200);
  assert.equal(app.monitor.state().bots[0].memoryLimitMB, null);
});
