import { h, icon, pageHead, statusEl, avatar, botCounts, fmtBytes, fmtPct, fmtDuration, fmtDateTime, setText } from '../ui.js';
import { store } from '../api.js';
import { actionButtons } from '../actions.js';

export function botsPage() {
  const head = pageHead('Bots', '');
  const body = h('div', { class: 'rows' });
  const rows = new Map();

  const thead = h(
    'div',
    { class: 'thead' },
    h('span', { text: 'Bot' }),
    h('span', { text: 'Status' }),
    h('span', { text: 'PID' }),
    h('span', { class: 'r', text: 'CPU' }),
    h('span', { class: 'r', text: 'RAM' }),
    h('span', { text: 'Laufzeit' }),
    h('span', { text: 'Letzter Neustart' }),
    h('span'),
  );
  const el = h('div', null, head, h('div', { class: 'panel bot-table' }, thead, body));

  function cell(label, cls = '') {
    return h('span', { class: `cell ${cls}`.trim(), dataset: { label } });
  }

  function createRow(b) {
    const st = statusEl(b.status);
    const sub = h('div', { class: 'sub' });
    const pid = cell('PID', 'mono');
    const cpu = cell('CPU', 'r');
    const ram = cell('RAM', 'r');
    const up = cell('Laufzeit');
    const last = cell('Letzter Neustart', 'wide');
    const acts = actionButtons(b);
    const go = (hash) => (e) => {
      e.stopPropagation();
      location.hash = hash;
    };
    const el = h(
      'div',
      { class: 'bot-row' },
      h(
        'a',
        { class: 'bot-id', href: `#/bots/${b.id}` },
        avatar(b),
        h('div', { style: null }, h('div', { class: 'name' }, h('span', { text: b.name }), b.self ? h('span', { class: 'badge', text: 'Panel' }) : null, b.isModule ? h('span', { class: 'badge', text: 'Modul' }) : null), sub),
      ),
      h('span', { class: 'cell-status' }, st),
      pid,
      cpu,
      ram,
      up,
      last,
      h(
        'div',
        { class: 'actions' },
        acts,
        h('button', { class: 'btn sm ghost icon-only', title: 'Logs', 'aria-label': `Logs: ${b.name}`, onclick: go(`#/logs/${b.id}`) }, icon('scroll-text')),
        h('button', { class: 'btn sm ghost icon-only', title: 'Details', 'aria-label': `Details: ${b.name}`, onclick: go(`#/bots/${b.id}`) }, icon('chevron-right')),
      ),
    );
    el.querySelector('.bot-id > div').style.minWidth = '0';
    return { el, st, sub, pid, cpu, ram, up, last, acts };
  }

  function update() {
    const s = store.state;
    if (!s) return;
    const c = botCounts(s.bots);
    head.setSub(`${c.total} Prozesse in pm2 · ${c.online} aktiv${c.stopped ? ` · ${c.stopped} gestoppt` : ''}${c.errored ? ` · ${c.errored} mit Fehlern` : ''}`);
    const seen = new Set();
    for (const b of s.bots) {
      seen.add(b.id);
      let row = rows.get(b.id);
      if (!row) {
        row = createRow(b);
        rows.set(b.id, row);
        body.append(row.el);
      }
      const online = b.status === 'online';
      row.st.set(b.status);
      row.acts.update(b);
      setText(row.sub, [`ID ${b.id}`, b.version ? `v${b.version}` : null, `${b.restarts} Neustarts`].filter(Boolean).join(' · '));
      setText(row.pid, b.pid ? String(b.pid) : '–');
      setText(row.cpu, online ? fmtPct(b.cpu, 1) : '–');
      setText(row.ram, online ? fmtBytes(b.memory) : '–');
      setText(row.up, online && b.startedAt ? fmtDuration((s.ts - b.startedAt) / 1000) : '–');
      setText(row.last, b.startedAt ? fmtDateTime(b.startedAt) : '–');
    }
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        row.el.remove();
        rows.delete(id);
      }
    }
    const empty = body.querySelector('.empty');
    if (!s.bots.length && !empty) body.append(h('div', { class: 'empty', text: 'Keine pm2-Prozesse gefunden.' }));
    else if (s.bots.length) empty?.remove();
  }

  update();
  return { el, update, title: 'Bots' };
}
