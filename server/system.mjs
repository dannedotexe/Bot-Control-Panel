// Systemmetriken direkt aus /proc (Linux) – ohne Abhängigkeiten, ohne Shell-Aufrufe.
import fs from 'node:fs';
import os from 'node:os';

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

function cpuTimes() {
  const line = read('/proc/stat').split('\n', 1)[0];
  if (line.startsWith('cpu ')) {
    const n = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = n[3] + (n[4] || 0);
    return { idle, total: n.slice(0, 8).reduce((a, b) => a + b, 0) };
  }
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

function memory() {
  const info = {};
  for (const line of read('/proc/meminfo').split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) info[m[1]] = Number(m[2]) * 1024;
  }
  const total = info.MemTotal || os.totalmem();
  const available = info.MemAvailable ?? os.freemem();
  return {
    total,
    used: total - available,
    available,
    swapTotal: info.SwapTotal || 0,
    swapUsed: (info.SwapTotal || 0) - (info.SwapFree || 0),
  };
}

function network() {
  let rx = 0;
  let tx = 0;
  for (const line of read('/proc/net/dev').split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest || name.trim() === 'lo') continue;
    const n = rest.trim().split(/\s+/).map(Number);
    rx += n[0] || 0;
    tx += n[8] || 0;
  }
  return { rx, tx };
}

function disk() {
  try {
    const s = fs.statfsSync('/');
    const total = s.blocks * s.bsize;
    return { total, used: total - s.bavail * s.bsize };
  } catch {
    return { total: 0, used: 0 };
  }
}

function processCount() {
  try {
    let n = 0;
    for (const name of fs.readdirSync('/proc')) if (name.charCodeAt(0) >= 48 && name.charCodeAt(0) <= 57) n += 1;
    return n;
  } catch {
    return 0;
  }
}

export function systemInfo() {
  const rel = read('/etc/os-release');
  const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(rel);
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    os: pretty ? pretty[1] : `${os.type()} ${os.release()}`,
    kernel: os.release(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model?.trim() || 'unbekannt',
    cores: cpus.length || 1,
    node: process.version,
  };
}

export class SystemSampler {
  constructor() {
    this.prevCpu = cpuTimes();
    this.prevNet = network();
    this.prevTime = Date.now();
  }

  sample() {
    const now = Date.now();
    const cpu = cpuTimes();
    const dTotal = cpu.total - this.prevCpu.total;
    const dIdle = cpu.idle - this.prevCpu.idle;
    const cpuPct = dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : 0;
    const net = network();
    const dt = Math.max(0.001, (now - this.prevTime) / 1000);
    const rate = (a, b) => Math.max(0, (a - b) / dt);
    const out = {
      cpu: Math.round(cpuPct * 10) / 10,
      load: os.loadavg().map((x) => Math.round(x * 100) / 100),
      mem: memory(),
      disk: disk(),
      net: { rx: Math.round(rate(net.rx, this.prevNet.rx)), tx: Math.round(rate(net.tx, this.prevNet.tx)), rxTotal: net.rx, txTotal: net.tx },
      uptime: Math.round(os.uptime()),
      procs: processCount(),
    };
    this.prevCpu = cpu;
    this.prevNet = net;
    this.prevTime = now;
    return out;
  }
}
