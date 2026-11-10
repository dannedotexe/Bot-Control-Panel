import { h, icon, pageHead, statusEl, meter, avatar, botCounts, fmtBytes, fmtPct, fmtDuration, fmtAgo, setText } from '../ui.js';
import { store } from '../api.js';

function stat(label, dotCls) {
  const value = h('div', { class: 'value', text: '–' });
  const dot = dotCls ? h('i', { class: 'dot' }) : null;
  const el = h('div', { class: 'stat' }, h('div', { class: 'label' }, dot, label), value);
  el.set = (n) => {
    setText(value, String(n));
    if (dot) dot.className = `dot ${n > 0 ? dotCls : ''}`.trim();
  };
  return el;
}

function metricRow(label) {
  const m = meter();
  const v = h('div', { class: 'v', text: '–' });
  const el = h('div', { class: 'metric-row' }, h('div', { class: 'k', text: label }), m, v);
  el.set = (pct, text) => {
    m.set(pct);
    setText(v, text);
  };
  return el;
}

function plainRow(label) {
  const v = h('div', { class: 'v', text: '–' });
  const el = h('div', { class: 'metric-row' }, h('div', { class: 'k', text: label }), h('div'), v);
  el.set = (val) => {
    if (val instanceof Node) v.replaceChildren(val);
    else setText(v, val);
  };
  return el;
}

export function overviewPage() {
  const head = pageHead('Overview', '');
  const sTotal = stat('Bots');
  const sOnline = stat('Aktiv', 'ok');
  const sStopped = stat('Gestoppt');
  const sErr = stat('Mit Fehlern', 'err');

  const serverStatus = statusEl('online');
  const rStatus = plainRow('Status');
  rStatus.set(serverStatus);
  const rUptime = plainRow('Uptime');
  const rCpu = metricRow('CPU');
  const rRam = metricRow('RAM');
  const rDisk = metricRow('Disk');

  const botList = h('div', { class: 'rows' });
  const botRows = new Map();
  const events = h('div', { class: 'rows' });
  const banner = h('div', { class: 'banner err' }, icon('circle-alert'), 'pm2 ist nicht erreichbar – Prozessdaten sind möglicherweise veraltet.');
  banner.hidden = true;

  const el = h(
    'div',
    null,
    head,
    banner,
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'panel stats' }, sTotal, sOnline, sStopped, sErr),
      h(
        'div',
        { class: 'grid cols-2' },
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', { text: 'Server' }), h('a', { href: '#/server' }, 'Details', icon('chevron-right'))), h('div', { class: 'rows' }, rStatus, rUptime, rCpu, rRam, rDisk)),
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', { text: 'Bots' }), h('a', { href: '#/bots' }, 'Alle anzeigen', icon('chevron-right'))), botList),
      ),
      h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', { text: 'Letzte Ereignisse' })), events),
    ),
  );

  function renderBots(bots) {
    const seen = new Set();
    for (const b of bots) {
      seen.add(b.id);
      let row = botRows.get(b.id);
      if (!row) {
        const st = statusEl(b.status);
        const cpu = h('span', { class: 'cell' });
        const ram = h('span', { class: 'cell' });
        const a = h('a', { class: 'compact-row', href: `#/bots/${b.id}` }, h('span', { class: 'bot-id' }, avatar(b, 'xs'), h('span', { class: 'name' }, h('span', { text: b.name }))), st, cpu, ram, icon('chevron-right', 'faint'));
        row = { a, st, cpu, ram };
        botRows.set(b.id, row);
        botList.append(a);
      }
      row.st.set(b.status);
      setText(row.cpu, b.status === 'online' ? fmtPct(b.cpu, 1) : '–');
      setText(row.ram, b.status === 'online' ? fmtBytes(b.memory) : '–');
    }
    for (const [id, row] of botRows) {
      if (!seen.has(id)) {
        row.a.remove();
        botRows.delete(id);
      }
    }
    if (!bots.length && !botList.querySelector('.empty')) botList.append(h('div', { class: 'empty', text: 'Keine pm2-Prozesse gefunden.' }));
    else if (bots.length) botList.querySelector('.empty')?.remove();
  }

  let lastNote = -1;
  function renderEvents() {
    const list = store.notifications.slice(-6).reverse();
    const top = list[0]?.id ?? 0;
    if (top === lastNote) return;
    lastNote = top;
    events.replaceChildren(
      ...(list.length
        ? list.map((n) =>
            h('div', { class: `note ${n.level}` }, icon(n.level === 'info' ? 'info' : n.level === 'warn' ? 'triangle-alert' : 'circle-alert'), h('div', null, h('div', { class: 'title', text: n.title }), n.text ? h('div', { class: 'text', text: n.text }) : null, h('div', { class: 'time', text: fmtAgo(n.ts) }))),
          )
        : [h('div', { class: 'empty', text: 'Keine Ereignisse seit dem Start des Panels.' })]),
    );
  }

  function update() {
    const s = store.state;
    if (!s) return;
    banner.hidden = s.pm2Ok;
    const c = botCounts(s.bots);
    sTotal.set(c.total);
    sOnline.set(c.online);
    sStopped.set(c.stopped);
    sErr.set(c.errored);
    head.setSub(store.info ? `${store.info.hostname} · ${store.info.os}` : '');
    const sys = s.system;
    if (sys) {
      setText(rUptime.lastChild, fmtDuration(sys.uptime));
      rCpu.set(sys.cpu, fmtPct(sys.cpu, 1));
      rRam.set((sys.mem.used / sys.mem.total) * 100, `${fmtBytes(sys.mem.used)} / ${fmtBytes(sys.mem.total)}`);
      rDisk.set((sys.disk.used / sys.disk.total) * 100, `${fmtBytes(sys.disk.used)} / ${fmtBytes(sys.disk.total)}`);
    }
    renderBots(s.bots);
    renderEvents();
  }

  update();
  return { el, update, title: 'Overview' };
}
