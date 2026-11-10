import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDiscordStatus, fetchDiscordStatus, fetchDiscordAvatar, findToken } from '../server/extras.mjs';

test('Discord-Status wird ausgewertet', async () => {
  const summary = { status: { indicator: 'minor', description: 'Minor Service Outage' }, components: [{ name: 'API', status: 'degraded_performance' }], incidents: [{ name: 'Erhöhte Latenz', status: 'investigating', impact: 'minor', updated_at: '2026-11-10T20:00:00Z' }] };
  const s = parseDiscordStatus(summary);
  assert.equal(s.indicator, 'minor');
  assert.equal(s.api, 'degraded_performance');
  assert.equal(s.incidents[0].name, 'Erhöhte Latenz');
  const fake = async (url) => {
    assert.equal(url, 'https://discordstatus.com/api/v2/summary.json');
    return { ok: true, json: async () => summary };
  };
  assert.equal((await fetchDiscordStatus(fake)).description, 'Minor Service Outage');
});

test('Discord-Profilbild: Token nur im Header an discord.com, Bild nur wenn PNG', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcp-av-'));
  const file = path.join(dir, 'auto', 'x.png');
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(20)]);
  const calls = [];
  const fake = async (url, opts) => {
    calls.push([url, opts?.headers?.Authorization || null]);
    if (url.endsWith('/users/@me')) return { ok: true, json: async () => ({ id: '123456789012345678', avatar: 'a'.repeat(32), username: 'Gambino' }) };
    return { ok: true, arrayBuffer: async () => png };
  };
  const me = await fetchDiscordAvatar('tok'.repeat(10), file, fake);
  assert.equal(me.username, 'Gambino');
  assert.ok(fs.readFileSync(file).equals(png));
  assert.equal(calls[0][1], `Bot ${'tok'.repeat(10)}`);
  assert.equal(calls[1][1], null, 'CDN bekommt kein Token');
  assert.match(calls[1][0], /^https:\/\/cdn\.discordapp\.com\/avatars\/123456789012345678\//);
  fs.rmSync(dir, { recursive: true });
});

test('Token wird aus .env oder pm2-Umgebung gefunden', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bcp-tk-'));
  const cwd = path.join(root, 'bot');
  fs.mkdirSync(cwd);
  assert.equal(findToken({ _config: { cwd }, _tokens: {} }, root), null);
  assert.equal(findToken({ _config: { cwd }, _tokens: { BOT_TOKEN: 'p'.repeat(30) } }, root), 'p'.repeat(30));
  fs.writeFileSync(path.join(cwd, '.env'), `DISCORD_TOKEN=${'e'.repeat(30)}\n`);
  assert.equal(findToken({ _config: { cwd }, _tokens: { BOT_TOKEN: 'p'.repeat(30) } }, root), 'e'.repeat(30));
  fs.rmSync(root, { recursive: true });
});
