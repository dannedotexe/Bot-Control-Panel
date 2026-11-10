// pm2-Attrappe für Tests und Screenshots: liefert Einträge im Format von `pm2 jlist`
// (inklusive absichtlich enthaltener Schein-Secrets, um die Maskierung zu prüfen).
import fs from 'node:fs';
import path from 'node:path';
import { normalize, ACTIONS } from '../../server/pm2.mjs';

export const FAKE_TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4OQ', 'GaBcDe', 'abcdefghijklmnopqrstuvwxyz0123456789ab'].join('.');

const DEFS = [
  { name: 'gambino-bot', version: '2.4.1', mem: 96, cpu: 1.2, restarts: 3, ageH: 52 },
  { name: 'chud-bot', version: '1.0.7', mem: 71, cpu: 0.4, restarts: 0, ageH: 190 },
  { name: 'hugosmp-bot', version: '0.9.3', mem: 64, cpu: 0.3, restarts: 1, ageH: 190 },
  { name: 'hugopredict', version: '1.2.0', mem: 0, cpu: 0, restarts: 16, ageH: 5, status: 'errored' },
  { name: 'yamamoto-bot', version: '3.1.0', mem: 88, cpu: 2.1, restarts: 2, ageH: 30 },
  { name: 'bot-control-panel', version: '1.0.0', mem: 41, cpu: 0.2, restarts: 0, ageH: 12, self: true },
];

export function createFakePm2({ logDir, selfName = 'bot-control-panel', now = Date.now } = {}) {
  const calls = [];
  const procs = DEFS.map((d, i) => {
    const out = logDir ? path.join(logDir, `${d.name}-out.log`) : '';
    const err = logDir ? path.join(logDir, `${d.name}-error.log`) : '';
    if (logDir) {
      fs.writeFileSync(out, '');
      fs.writeFileSync(err, '');
    }
    const status = d.status || 'online';
    return {
      pm_id: i,
      name: d.name,
      pid: status === 'online' ? (d.self ? process.pid : 1200 + i * 137) : 0,
      monit: { cpu: d.cpu, memory: d.mem * 1024 * 1024 },
      pm2_env: {
        status,
        pm_uptime: now() - d.ageH * 3_600_000,
        created_at: now() - 400 * 3_600_000,
        restart_time: d.restarts,
        unstable_restarts: status === 'errored' ? 15 : 0,
        version: d.version,
        namespace: 'default',
        exec_mode: 'fork_mode',
        pm_exec_path: `/home/ubuntu/${d.name}/index.js`,
        pm_cwd: `/home/ubuntu/${d.name}`,
        exec_interpreter: 'node',
        node_version: '20.18.0',
        args: ['--shard', '0'],
        autorestart: true,
        watch: false,
        username: 'ubuntu',
        pm_out_log_path: out,
        pm_err_log_path: err,
        versioning: { branch: 'main', revision: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', comment: 'fix: reconnect handling', url: 'https://ghp_abcdefghijklmnopqrstuvwxyz012345@github.com/example/repo.git' },
        env: { NODE_ENV: 'production', PORT: '3090', DISCORD_TOKEN: FAKE_TOKEN, DATABASE_URL: 'postgres://user:hunter2secret@db/x' },
        DISCORD_TOKEN: FAKE_TOKEN,
      },
    };
  });

  return {
    mode: 'api',
    version: '5.4.2',
    calls,
    procs,
    failList: false,
    async list() {
      if (this.failList) throw new Error('pm2 list fehlgeschlagen');
      return procs.map((p) => normalize(p, selfName));
    },
    async act(action, id) {
      if (!ACTIONS.has(action)) throw new Error('Aktion nicht erlaubt');
      calls.push([action, id]);
      const p = procs.find((x) => x.pm_id === id);
      if (action === 'stop') {
        p.pm2_env.status = 'stopped';
        p.pid = 0;
      } else {
        p.pm2_env.status = 'online';
        p.pid = 4000 + calls.length;
        p.pm2_env.pm_uptime = now();
        p.pm2_env.restart_time += 1;
      }
    },
    close() {},
  };
}
