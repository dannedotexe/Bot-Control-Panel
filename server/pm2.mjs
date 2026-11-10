// pm2-Anbindung. Bevorzugt die API des bereits global installierten pm2 (dauerhafte
// RPC-Verbindung zum laufenden Daemon, sehr sparsam). Fallback: `pm2 jlist` per execFile.
// Es gibt bewusst KEINE Shell-Ausführung und nur drei erlaubte Aktionen.
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { redact, describeEnv } from './redact.mjs';

export const ACTIONS = new Set(['start', 'stop', 'restart']);

const require = createRequire(import.meta.url);

function run(bin, args, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, PM2_SILENT: 'true' } }, (err, stdout) =>
      err ? reject(new Error(`pm2 ${args[0]} fehlgeschlagen`)) : resolve(stdout),
    );
  });
}

export function findPm2Module(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  const prefixes = new Set([path.resolve(process.execPath, '..', '..'), '/usr', '/usr/local']);
  for (const p of prefixes) candidates.push(path.join(p, 'lib', 'node_modules', 'pm2'));
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'package.json'))) return c;
    } catch {
      /* weiter */
    }
  }
  return '';
}

class ApiBackend {
  constructor(modulePath) {
    this.mode = 'api';
    this.pm2 = require(modulePath);
    this.version = require(path.join(modulePath, 'package.json')).version;
    this.connected = false;
    this.connecting = null;
  }

  connect() {
    if (this.connected) return Promise.resolve();
    this.connecting ??= new Promise((resolve, reject) => {
      this.pm2.connect((err) => {
        this.connecting = null;
        if (err) return reject(new Error('Verbindung zum pm2-Daemon fehlgeschlagen'));
        this.connected = true;
        resolve();
      });
    });
    return this.connecting;
  }

  async call(method, ...args) {
    await this.connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.reset();
        reject(new Error(`pm2 ${method}: Zeitüberschreitung`));
      }, 20_000);
      this.pm2[method](...args, (err, result) => {
        clearTimeout(timer);
        if (err) {
          this.reset();
          return reject(new Error(`pm2 ${method} fehlgeschlagen`));
        }
        resolve(result);
      });
    });
  }

  reset() {
    try {
      this.pm2.disconnect();
    } catch {
      /* egal */
    }
    this.connected = false;
  }

  list() {
    return this.call('list');
  }

  act(action, id) {
    // „start“ auf einen bestehenden (gestoppten) Prozess entspricht bei pm2 einem restart per ID.
    return this.call(action === 'stop' ? 'stop' : 'restart', id);
  }

  close() {
    this.reset();
  }
}

class CliBackend {
  constructor(bin) {
    this.mode = 'cli';
    this.bin = bin;
    this.version = '';
  }

  async list() {
    const out = await run(this.bin, ['jlist']);
    const start = out.indexOf('[');
    if (start < 0) throw new Error('pm2 jlist: unerwartete Ausgabe');
    return JSON.parse(out.slice(start));
  }

  act(action, id) {
    return run(this.bin, [action === 'start' ? 'restart' : action, String(id)]);
  }

  close() {}
}

// Wandelt einen pm2-Eintrag in ein internes Objekt um. `env` verlässt den Server nie im Klartext.
export function normalize(proc, selfName) {
  const e = proc.pm2_env || {};
  const v = e.versioning || null;
  const online = e.status === 'online';
  return {
    id: proc.pm_id,
    name: String(proc.name ?? e.name ?? proc.pm_id),
    status: e.status || 'unknown',
    pid: online && proc.pid ? proc.pid : null,
    cpu: online ? Math.round((proc.monit?.cpu || 0) * 10) / 10 : 0,
    memory: online ? proc.monit?.memory || 0 : 0,
    startedAt: e.pm_uptime || null,
    createdAt: e.created_at || null,
    restarts: e.restart_time || 0,
    unstableRestarts: e.unstable_restarts || 0,
    version: e.version && e.version !== 'N/A' ? String(e.version) : null,
    namespace: e.namespace || 'default',
    execMode: String(e.exec_mode || '').replace('_mode', '') || null,
    isModule: Boolean(e.pmx_module),
    self: (proc.name ?? e.name) === selfName && proc.pid === process.pid,
    // nur intern verwendet:
    _outLog: e.pm_out_log_path || '',
    _errLog: e.pm_err_log_path || '',
    _config: {
      script: e.pm_exec_path || null,
      cwd: e.pm_cwd || null,
      interpreter: e.exec_interpreter || null,
      nodeVersion: e.node_version || null,
      args: Array.isArray(e.args) ? e.args.map((a) => redact(String(a))) : e.args ? [redact(String(e.args))] : [],
      nodeArgs: Array.isArray(e.node_args) ? e.node_args.map((a) => redact(String(a))) : [],
      instances: e.instances ?? 1,
      autorestart: e.autorestart !== false,
      watch: Boolean(e.watch),
      maxMemoryRestart: e.max_memory_restart || null,
      user: e.username || null,
      outLog: e.pm_out_log_path || null,
      errLog: e.pm_err_log_path || null,
      git: v
        ? {
            branch: v.branch || null,
            revision: v.revision ? String(v.revision).slice(0, 10) : null,
            comment: v.comment ? redact(String(v.comment)).split('\n')[0].slice(0, 160) : null,
            url: v.url ? redact(String(v.url)) : null,
          }
        : null,
      env: describeEnv(e.env),
    },
  };
}

export function publicBot(bot) {
  const out = {};
  for (const k of Object.keys(bot)) if (!k.startsWith('_')) out[k] = bot[k];
  return out;
}

export function createPm2({ modulePath = '', bin = 'pm2', selfName = 'bot-control-panel', log = console } = {}) {
  let backend;
  const found = findPm2Module(modulePath);
  if (found) {
    try {
      backend = new ApiBackend(found);
    } catch (err) {
      log.warn(`[pm2] API aus ${found} nicht ladbar, nutze CLI: ${err.message}`);
    }
  }
  backend ??= new CliBackend(bin);

  return {
    get mode() {
      return backend.mode;
    },
    get version() {
      return backend.version;
    },
    async list() {
      const raw = await backend.list();
      return raw.map((p) => normalize(p, selfName)).sort((a, b) => a.id - b.id);
    },
    async act(action, id) {
      if (!ACTIONS.has(action)) throw new Error('Aktion nicht erlaubt');
      if (!Number.isInteger(id) || id < 0) throw new Error('Ungültige Prozess-ID');
      await backend.act(action, id);
    },
    close() {
      backend.close();
    },
  };
}
