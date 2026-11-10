// End-to-End-Lauf mit echtem HTTPS (selbst signiert), pm2-Attrappe und Chromium (Playwright).
// Prüft Login, Navigation, Aktionen, Live-Logs und erzeugt Screenshots (Desktop + Handy).
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createApp } from '../../server/app.mjs';
import { loadConfig } from '../../server/config.mjs';
import { hashPassword } from '../../server/auth.mjs';
import { createFakePm2, FAKE_TOKEN } from '../helpers/fake-pm2.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'docs', 'screenshots');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bcp-e2e-'));
const PASSWORD = 'e2e-passwort-nur-lokal';
const SCALE = Number(process.env.SHOT_SCALE || 2);

execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=e2e', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem')], { stdio: 'ignore' });

const pm2 = createFakePm2({ logDir: tmp });
const config = { ...loadConfig(root, {}), passwordHash: await hashPassword(PASSWORD), sessionSecret: 'e'.repeat(48), pollMs: 1000 };
const app = createApp({ config, pm2, version: '1.0.0', log: { info() {}, warn() {}, error: console.error }, tlsInfo: { fingerprint256: 'AB:CD:…(Beispiel)', validTo: 'Feb  1 12:00:00 2029 GMT' } });

// Etwas Leben: schwankende Werte und laufende Log-Ausgabe
const SAMPLES = [
  ['out', 'INFO  Shard 0 bereit – 14 Guilds, 3.212 Nutzer'],
  ['out', 'INFO  Slash-Command /balance von 482913…'],
  ['out', 'DEBUG Heartbeat bestätigt (41 ms)'],
  ['out', 'INFO  Datenbank-Sync abgeschlossen (112 ms)'],
  ['err', 'WARN  Rate-Limit erreicht: POST /channels/:id/messages, Wiederholung in 1.2 s'],
  ['out', 'INFO  Interaktion verarbeitet: button:blackjack_hit'],
  ['err', `ERROR DiscordAPIError[50013]: Missing Permissions (token=${FAKE_TOKEN})`],
  ['err', '    at SequentialHandler.runRequest (/home/ubuntu/gambino-bot/node_modules/@discordjs/rest/dist/index.js:933:15)'],
  ['out', 'INFO  Cache bereinigt: 38 Einträge entfernt'],
];
let n = 0;
const write = () => {
  const bot = pm2.procs[n % 3 === 0 ? 0 : n % 3 === 1 ? 4 : 1];
  const [stream, text] = SAMPLES[n % SAMPLES.length];
  fs.appendFileSync(stream === 'out' ? bot.pm2_env.pm_out_log_path : bot.pm2_env.pm_err_log_path, `${new Date().toISOString()}: ${text}\n`);
  n += 1;
};
for (let i = 0; i < 60; i++) write();
fs.appendFileSync(pm2.procs[3].pm2_env.pm_err_log_path, `${new Date().toISOString()}: Error: connect ECONNREFUSED 127.0.0.1:5432\n${new Date().toISOString()}:     at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1595:16)\n`);
const life = setInterval(() => {
  write();
  for (const p of pm2.procs) {
    if (p.pm2_env.status !== 'online') continue;
    p.monit.cpu = Math.max(0, Math.round((p.monit.cpu + (Math.random() - 0.5) * 1.5) * 10) / 10);
    p.monit.memory = Math.max(30e6, p.monit.memory + Math.round((Math.random() - 0.5) * 2e6));
  }
}, 400);

await app.start();
app.monitor.notify('warn', 'yamamoto-bot wurde neu gestartet', 'Neustart Nr. 2 (nicht über das Panel ausgelöst).');
app.monitor.notify('error', 'hugopredict ist abgestürzt', 'Status: errored – pm2 hat die Neustarts eingestellt.');
const server = https.createServer({ key: fs.readFileSync(path.join(tmp, 'key.pem')), cert: fs.readFileSync(path.join(tmp, 'cert.pem')) }, app.handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `https://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const problems = [];
let failed = false;

async function run(label, contextOptions, fn) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'de-DE', colorScheme: 'dark', ...contextOptions });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${label}] console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[${label}] pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().endsWith('/api/login')) problems.push(`[${label}] HTTP ${r.status()} ${r.url()}`);
  });
  const shot = async (name) => {
    await page.waitForTimeout(250); // Übergänge abwarten
    return page.screenshot({ path: path.join(shots, `${label}-${name}.png`) });
  };
  try {
    await fn(page, shot, context);
    console.log(`ok   ${label}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${label}: ${err.stack}`);
    await page.screenshot({ path: path.join(tmp, `${label}-fehler.png`) }).catch(() => {});
  }
  await context.close();
}

async function login(page) {
  await page.goto(base);
  await page.fill('#user', 'admin');
  await page.fill('#pass', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('.shell .stat .value');
}

async function tour(page, shot, mobile) {
  await page.goto(base);
  await page.waitForSelector('.login-card');
  await shot('01-login');
  // falsches Passwort → Fehlermeldung, kein Zugang
  await page.fill('#user', 'admin');
  await page.fill('#pass', 'falsch');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.querySelector('.form-error')?.textContent.includes('falsch'));
  assert.equal(await page.locator('.shell').count(), 0);
  await login(page);
  await page.waitForTimeout(2500); // ein paar Messpunkte sammeln
  assert.equal(await page.locator('.stat .value').first().textContent(), '6');
  await shot('02-overview');

  await page.click('.nav a[href="#/bots"]');
  await page.waitForSelector('.bot-row');
  assert.equal(await page.locator('.bot-row').count(), 6);
  await shot('03-bots');

  // Stop mit Rückfrage, danach wieder Start (echte Aktion über die pm2-Attrappe)
  const row = page.locator('.bot-row', { hasText: 'chud-bot' });
  await row.locator('button[title="Stoppen"]').click();
  await page.waitForSelector('.dialog');
  if (!mobile) await shot('04-bestaetigung');
  await page.click('.dialog .btn.danger-solid');
  await page.waitForFunction(() => [...document.querySelectorAll('.bot-row')].find((r) => r.textContent.includes('chud-bot'))?.textContent.includes('Gestoppt'));
  assert.deepEqual(pm2.calls.at(-1), ['stop', 1]);
  assert.equal(await row.locator('button[title="Stoppen"]').isDisabled(), true);
  await row.locator('button[title="Starten"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.bot-row')].find((r) => r.textContent.includes('chud-bot'))?.textContent.includes('Online'));
  assert.deepEqual(pm2.calls.at(-1), ['start', 1]);
  // Panel selbst: Stop ist gesperrt
  assert.equal(await page.locator('.bot-row', { hasText: 'bot-control-panel' }).locator('button[title="Stoppen"]').isDisabled(), true);

  await page.locator('.bot-row', { hasText: 'gambino-bot' }).locator('button[title="Details"]').click();
  await page.waitForSelector('.detail-head');
  await page.waitForSelector('.log-line');
  await page.waitForTimeout(1500);
  await shot('05-bot-detail');
  await page.click('.tabs button:has-text("Konfiguration")');
  await page.waitForSelector('.kv');
  const cfg = await page.locator('#content').textContent();
  assert.ok(cfg.includes('/home/ubuntu/gambino-bot/index.js'));
  assert.ok(cfg.includes('DISCORD_TOKEN') && cfg.includes('verborgen'));
  assert.ok(!cfg.includes(FAKE_TOKEN) && !cfg.includes('hunter2secret') && !cfg.includes('ghp_'));
  await page.evaluate(() => document.querySelector('.tabs').scrollIntoView());
  await shot('06-bot-konfiguration');
  await page.click('.tabs button:has-text("Letzte Fehler")');
  await page.waitForSelector('.log-view');

  await page.click('.nav a[href="#/server"]');
  await page.waitForSelector('.spark path.line');
  await shot('07-server');

  await page.click('.nav a[href="#/logs"]');
  await page.waitForSelector('.log-line');
  const before = await page.locator('.log-line').count();
  await page.waitForFunction((c) => document.querySelectorAll('.log-line').length > c, before); // Live-Zeilen kommen ohne Reload
  const all = await page.locator('.log-view').textContent();
  assert.ok(!all.includes(FAKE_TOKEN), 'Token muss in den Logs maskiert sein');
  assert.ok(all.includes('[REDACTED'));
  await shot('08-logs');
  // Filter: nur ERROR + Suche
  await page.click('.seg button:has-text("INFO")');
  await page.click('.seg button:has-text("WARN")');
  await page.waitForFunction(() => document.querySelectorAll('.log-line').length > 0 && [...document.querySelectorAll('.log-line')].every((l) => l.classList.contains('ERROR')));
  await page.fill('.log-tools input[type=search]', 'Missing Permissions');
  await page.waitForSelector('.log-line mark');
  assert.ok((await page.locator('.log-line').count()) > 0);
  await shot('09-logs-filter');
  // Bot-Auswahl
  await page.selectOption('.page-head select', '4');
  await page.waitForFunction(() => location.hash === '#/logs/4');
  await page.waitForSelector('.log-line');

  await page.click('.nav a[href="#/settings"]');
  await page.waitForFunction(() => document.querySelector('#content')?.textContent.includes('pm2-API'));
  await shot('10-settings');

  if (!mobile) {
    await page.click('button[title="Benachrichtigungen"]');
    await page.waitForSelector('.menu .note');
    await shot('11-benachrichtigungen');
    await page.keyboard.press('Escape');
    // helles Farbschema
    await page.click('.seg button:has-text("Hell")');
    await page.click('.nav a[href="#/overview"]');
    await page.waitForSelector('.stat .value');
    await shot('12-overview-hell');
    await page.click('.nav a[href="#/settings"]');
    await page.click('.seg button:has-text("Dunkel")');
  }

  // Kein horizontales Scrollen
  for (const hash of ['#/overview', '#/bots', '#/bots/0', '#/server', '#/logs', '#/settings']) {
    await page.goto(`${base}/${hash}`);
    await page.waitForSelector('#content > div');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `horizontales Scrollen auf ${hash}: ${overflow}px`);
  }

  // Logout → API wieder gesperrt
  await page.click('.user-btn');
  await page.click('.menu .item:has-text("Abmelden")');
  await page.waitForSelector('.login-card');
  const status = await page.evaluate(() => fetch('/api/panel').then((r) => r.status));
  assert.equal(status, 401);
}

await run('desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: SCALE }, (page, shot) => tour(page, shot, false));
await run('mobil', { ...devices['iPhone 13'] }, (page, shot) => tour(page, shot, true));

clearInterval(life);
await browser.close();
app.stop();
server.closeAllConnections();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });

const real = problems.filter((p) => !/401.*\/api\/(panel|session)/.test(p) && !/Failed to load resource.*401/.test(p));
if (real.length) {
  console.error('Probleme im Browser:\n' + real.join('\n'));
  failed = true;
}
console.log(failed ? 'E2E FEHLGESCHLAGEN' : 'E2E OK');
process.exit(failed ? 1 : 0);
