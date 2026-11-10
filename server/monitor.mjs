// Fragt pm2 und das System periodisch ab, hält einen kleinen Verlauf im Speicher und
// verteilt den Zustand an verbundene Clients (SSE). Ohne Zuschauer wird nur selten abgefragt.
import fs from 'node:fs';
import { SystemSampler, systemInfo } from './system.mjs';
import { publicBot } from './pm2.mjs';

const HISTORY = 120;
const BOT_HISTORY = 60;
const MAX_NOTIFICATIONS = 50;

export class Monitor {
  constructor({ pm2, config, log = console, sampler = new SystemSampler() }) {
    this.pm2 = pm2;
    this.config = config;
    this.log = log;
    this.sampler = sampler;
    this.info = systemInfo();
    this.clients = new Set();
    this.bots = [];
    this.system = null;
    this.pm2Ok = true;
    this.history = []; // [t, cpu%, ram%, rx B/s, tx B/s]
    this.botHistory = new Map(); // id -> [[t, cpu, memory]]
    this.notifications = [];
    this.notifySeq = 0;
    this.prev = null; // id -> { status, restarts, name }
    this.expected = new Map(); // id -> Zeitpunkt, bis zu dem Änderungen vom Panel ausgelöst sind
    this.flags = { ram: false, disk: false };
    this.avatars = new Set();
    this.avatarsAt = 0;
    this.timer = null;
    this.running = false;
    this.ticking = null;
  }

  async start() {
    this.running = true;
    await this.tick();
    this.schedule();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  schedule() {
    if (!this.running) return;
    clearTimeout(this.timer);
    const ms = this.clients.size > 0 ? this.config.pollMs : this.config.idlePollMs;
    this.timer = setTimeout(() => this.tick().finally(() => this.schedule()), ms);
    this.timer.unref?.();
  }

  subscribe(send) {
    this.clients.add(send);
    if (this.clients.size === 1) this.schedule(); // auf schnelles Intervall umschalten
    return () => {
      this.clients.delete(send);
    };
  }

  broadcast(event, data) {
    for (const send of this.clients) send(event, data);
  }

  notify(level, title, text = '') {
    const n = { id: ++this.notifySeq, ts: Date.now(), level, title, text };
    this.notifications.push(n);
    if (this.notifications.length > MAX_NOTIFICATIONS) this.notifications.shift();
    this.broadcast('notify', n);
  }

  expect(id, ms = 20_000) {
    this.expected.set(id, Date.now() + ms);
  }

  tick() {
    this.ticking ??= this.doTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  async doTick() {
    const now = Date.now();
    try {
      this.system = this.sampler.sample();
    } catch (err) {
      this.log.warn(`[monitor] Systemabfrage fehlgeschlagen: ${err.message}`);
    }
    try {
      const bots = await this.pm2.list();
      if (!this.pm2Ok) this.notify('info', 'pm2 wieder erreichbar');
      this.pm2Ok = true;
      this.detectChanges(bots, now);
      this.bots = bots;
    } catch (err) {
      if (this.pm2Ok) {
        this.log.warn(`[monitor] ${err.message}`);
        this.notify('error', 'pm2 nicht erreichbar', 'Die Prozessliste konnte nicht gelesen werden.');
      }
      this.pm2Ok = false;
    }
    this.record(now);
    this.checkThresholds();
    this.broadcast('state', this.state());
  }

  detectChanges(bots, now) {
    const cur = new Map(bots.map((b) => [b.id, { status: b.status, restarts: b.restarts, name: b.name }]));
    if (this.prev) {
      for (const [id, c] of cur) {
        const p = this.prev.get(id);
        const expected = (this.expected.get(id) || 0) > now;
        if (!p) {
          this.notify('info', `${c.name} wurde hinzugefügt`, 'Neuer pm2-Prozess erkannt.');
          continue;
        }
        if (expected) continue;
        if (c.status !== p.status) {
          if (c.status === 'errored') this.notify('error', `${c.name} ist abgestürzt`, 'Status: errored – pm2 hat die Neustarts eingestellt.');
          else if (c.status === 'stopped') this.notify('warn', `${c.name} wurde gestoppt`);
          else if (c.status === 'online' && p.status !== 'launching') this.notify('info', `${c.name} ist wieder online`);
        } else if (c.restarts > p.restarts && c.status === 'online') {
          this.notify('warn', `${c.name} wurde neu gestartet`, `Neustart Nr. ${c.restarts} (nicht über das Panel ausgelöst).`);
        }
      }
      for (const [id, p] of this.prev) {
        if (!cur.has(id)) {
          this.notify('warn', `${p.name} wurde aus pm2 entfernt`);
          this.botHistory.delete(id);
        }
      }
    }
    this.prev = cur;
    for (const [id, until] of this.expected) if (until <= now) this.expected.delete(id);
  }

  record(now) {
    const s = this.system;
    if (s) {
      this.history.push([now, s.cpu, s.mem.total ? Math.round((s.mem.used / s.mem.total) * 1000) / 10 : 0, s.net.rx, s.net.tx]);
      if (this.history.length > HISTORY) this.history.shift();
    }
    for (const b of this.bots) {
      let h = this.botHistory.get(b.id);
      if (!h) this.botHistory.set(b.id, (h = []));
      h.push([now, b.cpu, b.memory]);
      if (h.length > BOT_HISTORY) h.shift();
    }
  }

  checkThresholds() {
    const s = this.system;
    if (!s) return;
    const ram = s.mem.total ? (s.mem.used / s.mem.total) * 100 : 0;
    if (ram >= 92 && !this.flags.ram) {
      this.flags.ram = true;
      this.notify('warn', 'Arbeitsspeicher fast voll', `${Math.round(ram)} % belegt.`);
    } else if (ram < 85) this.flags.ram = false;
    const disk = s.disk.total ? (s.disk.used / s.disk.total) * 100 : 0;
    if (disk >= 90 && !this.flags.disk) {
      this.flags.disk = true;
      this.notify('warn', 'Festplatte fast voll', `${Math.round(disk)} % belegt.`);
    } else if (disk < 85) this.flags.disk = false;
  }

  findBot(id) {
    return this.bots.find((b) => b.id === id) || null;
  }

  // Optionale Bot-Bilder: data/avatars/<pm2-name>.png
  loadAvatars(now) {
    if (now - this.avatarsAt < 60_000) return;
    this.avatarsAt = now;
    try {
      this.avatars = new Set(fs.readdirSync(this.config.avatarDir).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)));
    } catch {
      this.avatars = new Set();
    }
  }

  state() {
    const now = Date.now();
    this.loadAvatars(now);
    return { ts: now, pm2Ok: this.pm2Ok, system: this.system, bots: this.bots.map((b) => ({ ...publicBot(b), avatar: this.avatars.has(b.name) })) };
  }

  snapshot() {
    return {
      info: this.info,
      history: this.history,
      botHistory: Object.fromEntries(this.botHistory),
      notifications: this.notifications,
      state: this.state(),
    };
  }
}
