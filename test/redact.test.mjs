import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, describeEnv } from '../server/redact.mjs';
import { parseLine, detectLevel, readTail } from '../server/logs.mjs';
import { normalize, publicBot } from '../server/pm2.mjs';
import { createFakePm2, FAKE_TOKEN } from './helpers/fake-pm2.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('Maskierung: Tokens, Webhooks, Header, URLs, key=value', () => {
  const cases = [
    `Login mit ${FAKE_TOKEN} ok`,
    'POST https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abc',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
    'headers { authorization: "Bot abcdefghijklmnopqrstuvwxyz123456" }',
    'mongodb://admin:SuperGeheim123@localhost:27017/db',
    'DISCORD_TOKEN=abc123def456ghi789',
    '{"clientSecret":"s3cr3t-value-xyz","password": "hunter2hunter2"}',
    'api_key: sk-abcdefghijklmnopqrstuvwxyz',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'clone https://ghp_abcdefghijklmnopqrstuvwxyz012345@github.com/x/y.git',
  ];
  const secrets = [FAKE_TOKEN, 'AbCdEfGhIjKlMnOpQrStUvWxYz', 'abcdefghijklmnopqrstuvwxyz123456', 'SuperGeheim123', 'abc123def456ghi789', 's3cr3t-value-xyz', 'hunter2hunter2', 'sk-abcdefghijklmnopqrstuvwxyz', 'dozjgNryP4J3jVmNHl0w5N', 'ghp_abcdefghijklmnopqrstuvwxyz012345'];
  const out = cases.map(redact).join('\n');
  for (const s of secrets) assert.ok(!out.includes(s), `Secret nicht maskiert: ${s}\n${out}`);
  assert.match(out, /REDACTED/);
});

test('Maskierung lässt normale Zeilen unverändert', () => {
  for (const line of ['Bot ist online als Gambino#1234', 'Guild 123456789012345678 geladen (42 Mitglieder)', 'GET /api/users 200 12ms', 'Session gestartet um 12:00']) {
    assert.equal(redact(line), line);
  }
});

test('Umgebungsvariablen: nur Namen, Werte nur für Whitelist', () => {
  const env = describeEnv({ NODE_ENV: 'production', DISCORD_TOKEN: 'geheim', PORT: '3000', MY_SETTING: 'wert' });
  assert.deepEqual(env, [
    { name: 'DISCORD_TOKEN', value: null },
    { name: 'MY_SETTING', value: null },
    { name: 'NODE_ENV', value: 'production' },
    { name: 'PORT', value: '3000' },
  ]);
});

test('pm2-Eintrag: öffentliche Darstellung enthält keine Secrets und keine internen Felder', async () => {
  const pm2 = createFakePm2();
  const bots = await pm2.list();
  const serialized = JSON.stringify(bots.map((b) => ({ ...publicBot(b), config: b._config })));
  assert.ok(!serialized.includes(FAKE_TOKEN));
  assert.ok(!serialized.includes('hunter2secret'));
  assert.ok(!serialized.includes('ghp_'));
  assert.ok(!Object.keys(publicBot(bots[0])).some((k) => k.startsWith('_')));
  assert.equal(bots[0].name, 'gambino-bot');
  assert.equal(bots[3].status, 'errored');
  assert.equal(bots[3].pid, null);
  assert.equal(bots[5].self, true);
  assert.equal(normalize({ pm_id: 1, name: 'x', pid: 5, pm2_env: { status: 'online' } }, 'p').self, false);
});

test('Log-Zeilen: Level, Zeitstempel, ANSI, Maskierung', () => {
  assert.equal(detectLevel('alles gut', 'out'), 'INFO');
  assert.equal(detectLevel('irgendwas', 'err'), 'ERROR');
  assert.equal(detectLevel('[WARN] langsam', 'err'), 'WARN');
  assert.equal(detectLevel('TypeError: x is not a function', 'out'), 'ERROR');
  assert.equal(detectLevel('(node:1) DeprecationWarning: alt', 'err'), 'WARN');
  const l = parseLine(`2025-03-01T10:20:30.123Z: \x1b[32mINFO\x1b[0m token=${FAKE_TOKEN}  `, { stream: 'out', bot: 'b', botId: 1 });
  assert.equal(l.ts, Date.parse('2025-03-01T10:20:30.123Z'));
  assert.equal(l.level, 'INFO');
  assert.ok(!l.text.includes(FAKE_TOKEN));
  assert.ok(!l.text.includes('\x1b'));
  const pm2Style = parseLine('2025-03-01 10:20:30 +02:00: hallo', { stream: 'out', bot: 'b', botId: 1 });
  assert.equal(pm2Style.ts, Date.parse('2025-03-01T10:20:30+02:00'));
  assert.equal(pm2Style.text, 'hallo');
  assert.equal(parseLine('ohne zeit', { stream: 'out', bot: 'b', botId: 1 }).ts, null);
});

test('readTail liefert die letzten Zeilen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcp-'));
  const file = path.join(dir, 'a.log');
  fs.writeFileSync(file, Array.from({ length: 500 }, (_, i) => `zeile ${i}`).join('\n') + '\n');
  const { lines } = readTail(file, 3);
  assert.deepEqual(lines, ['zeile 497', 'zeile 498', 'zeile 499']);
  assert.deepEqual(readTail(path.join(dir, 'fehlt.log')).lines, []);
  assert.equal(readTail(file, 1000, 200).lines.at(-1), 'zeile 499');
  fs.rmSync(dir, { recursive: true });
});
