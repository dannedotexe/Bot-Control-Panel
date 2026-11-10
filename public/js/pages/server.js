import { h, pageHead, sparkline, meter, kv, statusEl, fmtBytes, fmtPct, fmtRate, fmtDuration, setText, discordStatusEl, fmtAgo } from '../ui.js';
import { store } from '../api.js';

function chartPanel(title, opts, foot) {
  const big = h('div', { class: 'big', text: '–' });
  const side = h('div', { class: 'side' });
  const chart = sparkline(opts);
  const span = h('span', { text: '' });
  const el = h(
    'div',
    { class: 'panel chart-panel' },
    h('div', { class: 'panel-head' }, h('h2', { text: title })),
    h('div', { class: 'panel-body' }, h('div', { class: 'chart-top' }, big, side), chart, h('div', { class: 'chart-foot' }, span, foot || h('span', { text: 'jetzt' }))),
  );
  return { el, big, side, chart, span };
}

export function serverPage() {
  const head = pageHead('Server', '');
  const cpu = chartPanel('CPU', { max: 100 });
  const ram = chartPanel('Arbeitsspeicher', { max: 100 });
  const net = chartPanel(
    'Netzwerk',
    { max: null, area: false },
    h('span', null, h('span', { class: 'legend' }, h('i'), 'Empfangen'), h('span', { class: 'legend' }, h('i', { class: 'alt' }), 'Gesendet')),
  );

  const diskMeter = meter();
  const diskBig = h('div', { class: 'big', text: '–' });
  const diskSide = h('div', { class: 'side' });
  const swapMeter = meter();
  const swapText = h('div', { class: 'side', text: '' });
  const disk = h(
    'div',
    { class: 'panel chart-panel' },
    h('div', { class: 'panel-head' }, h('h2', { text: 'Speicherplatz' })),
    h(
      'div',
      { class: 'panel-body' },
      h('div', { class: 'chart-top' }, diskBig, diskSide),
      diskMeter,
      h('div', { class: 'chart-foot' }, h('span', { text: 'Dateisystem /' }), h('span')),
      h('div', { class: 'chart-top', style: null }, h('div', { class: 'muted', text: 'Swap' }), swapText),
      swapMeter,
    ),
  );
  disk.querySelectorAll('.chart-top')[1].style.marginTop = '14px';

  const rows = {
    status: kv('Status', statusEl('online')),
    discord: kv('Discord-API'),
    host: kv('Hostname'),
    os: kv('Betriebssystem'),
    kernel: kv('Kernel'),
    arch: kv('Architektur'),
    cpu: kv('Prozessor'),
    uptime: kv('Uptime'),
    load: kv('Load Average (1/5/15 Min)'),
    procs: kv('Prozesse'),
    node: kv('Node.js (Panel)'),
    traffic: kv('Datenverkehr seit Boot'),
  };

  const el = h(
    'div',
    null,
    head,
    h('div', { class: 'stack' }, h('div', { class: 'grid cols-2' }, cpu.el, ram.el, disk, net.el), h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', { text: 'Systeminformationen' })), h('div', { class: 'rows' }, Object.values(rows)))),
  );

  function update() {
    const s = store.state?.system;
    const info = store.info;
    if (!s || !info) return;
    const hist = store.history;
    const spanMs = Math.max(60_000, Math.min(360_000, hist.length ? Date.now() - hist[0][0] : 60_000));
    const spanLabel = `vor ${Math.round(spanMs / 60_000)} Min`;
    head.setSub(`${info.hostname} · aktualisiert alle paar Sekunden`);

    setText(cpu.big, fmtPct(s.cpu, 1));
    setText(cpu.side, `${info.cores} ${info.cores === 1 ? 'Kern' : 'Kerne'} · Load ${s.load[0].toLocaleString('de-DE')}`);
    cpu.chart.set([{ points: hist.map((p) => [p[0], p[1]]) }], spanMs, 'CPU-Auslastung');
    setText(cpu.span, spanLabel);

    const memPct = (s.mem.used / s.mem.total) * 100;
    ram.big.replaceChildren(fmtPct(memPct), h('small', { text: `${fmtBytes(s.mem.used)} von ${fmtBytes(s.mem.total)}` }));
    setText(ram.side, `${fmtBytes(s.mem.available)} verfügbar`);
    ram.chart.set([{ points: hist.map((p) => [p[0], p[2]]) }], spanMs, 'RAM-Auslastung');
    setText(ram.span, spanLabel);

    const diskPct = s.disk.total ? (s.disk.used / s.disk.total) * 100 : 0;
    diskBig.replaceChildren(fmtPct(diskPct), h('small', { text: `${fmtBytes(s.disk.used)} von ${fmtBytes(s.disk.total)}` }));
    setText(diskSide, `${fmtBytes(s.disk.total - s.disk.used)} frei`);
    diskMeter.set(diskPct);
    swapMeter.set(s.mem.swapTotal ? (s.mem.swapUsed / s.mem.swapTotal) * 100 : 0);
    setText(swapText, s.mem.swapTotal ? `${fmtBytes(s.mem.swapUsed)} von ${fmtBytes(s.mem.swapTotal)}` : 'nicht eingerichtet');

    net.big.replaceChildren(`↓ ${fmtRate(s.net.rx)}`, h('small', { text: `↑ ${fmtRate(s.net.tx)}` }));
    const top = net.chart.set([{ points: hist.map((p) => [p[0], p[3]]) }, { points: hist.map((p) => [p[0], p[4]]), alt: true }], spanMs, 'Netzwerkdurchsatz');
    setText(net.side, `Skala bis ${fmtRate(top)}`);
    setText(net.span, spanLabel);

    const d = store.discord;
    rows.discord.set(
      h(
        'span',
        null,
        discordStatusEl(d),
        d?.incidents?.length ? h('span', { class: 'faint', text: ` · ${d.incidents.map((i) => i.name).join(' · ')}` }) : null,
        d?.checkedAt ? h('span', { class: 'faint', text: ` · geprüft ${fmtAgo(d.checkedAt)}` }) : null,
      ),
    );
    rows.host.set(info.hostname);
    rows.os.set(info.os);
    rows.kernel.set(info.kernel);
    rows.arch.set(info.arch);
    rows.cpu.set(`${info.cpuModel} · ${info.cores} ${info.cores === 1 ? 'Kern' : 'Kerne'}`);
    rows.uptime.set(fmtDuration(s.uptime));
    rows.load.set(s.load.map((x) => x.toLocaleString('de-DE', { minimumFractionDigits: 2 })).join(' / '));
    rows.procs.set(String(s.procs));
    rows.node.set(info.node);
    rows.traffic.set(`↓ ${fmtBytes(s.net.rxTotal)} · ↑ ${fmtBytes(s.net.txTotal)}`);
  }

  update();
  return { el, update, title: 'Server' };
}
