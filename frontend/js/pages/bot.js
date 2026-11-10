import { h, icon, statusEl, avatar, sparkline, kv, fmtBytes, fmtPct, fmtDuration, fmtDateTime, fmtTime, fmtFull, setText } from '../ui.js';
import { store, api } from '../api.js';
import { actionButtons } from '../actions.js';
import { createLogView } from '../logview.js';

function stat(label, small = false) {
  const value = h('div', { class: `value ${small ? 'sm' : ''}`.trim(), text: '–' });
  const el = h('div', { class: 'stat' }, h('div', { class: 'label', text: label }), value);
  el.set = (v) => {
    if (v instanceof Node) value.replaceChildren(v);
    else setText(value, v);
  };
  return el;
}

function chartPanel(title, opts) {
  const big = h('div', { class: 'big', text: '–' });
  const side = h('div', { class: 'side' });
  const chart = sparkline(opts);
  const el = h('div', { class: 'panel chart-panel' }, h('div', { class: 'panel-head' }, h('h2', { text: title })), h('div', { class: 'panel-body' }, h('div', { class: 'chart-top' }, big, side), chart, h('div', { class: 'chart-foot' }, h('span', { text: 'vor 3 Min' }), h('span', { text: 'jetzt' }))));
  return { el, big, side, chart };
}

export function botPage(id) {
  const find = () => store.state?.bots.find((b) => b.id === id);
  const first = find();
  if (!first) {
    return {
      el: h('div', null, h('a', { class: 'back', href: '#/bots' }, icon('arrow-left'), 'Bots'), h('div', { class: 'panel empty', text: 'Dieser Prozess existiert in pm2 nicht (mehr).' })),
      update() {},
      title: 'Bot',
    };
  }

  const st = statusEl(first.status);
  const acts = actionButtons(first, { labels: true, size: '' });
  const sStatus = stat('Status', true);
  sStatus.set(st);
  const sPid = stat('PID', true);
  const sCpu = stat('CPU', true);
  const sRam = stat('RAM', true);
  const sUp = stat('Laufzeit', true);
  const sRestarts = stat('Neustarts', true);
  const cpu = chartPanel('CPU', { max: null });
  const ram = chartPanel('Arbeitsspeicher', { max: null });

  // ---------- Tabs ----------
  const tabBody = h('div');
  let active = null;
  let logView = null;
  const tabDefs = [
    ['logs', 'Live-Logs'],
    ['errors', 'Letzte Fehler'],
    ['config', 'Konfiguration'],
  ];
  const tabButtons = tabDefs.map(([key, label]) => h('button', { role: 'tab', onclick: () => showTab(key) }, label));

  function showTab(key) {
    if (active === key) return;
    active = key;
    tabButtons.forEach((b, i) => {
      b.classList.toggle('on', tabDefs[i][0] === key);
      b.setAttribute('aria-selected', String(tabDefs[i][0] === key));
    });
    logView?.destroy();
    logView = null;
    if (key === 'logs') {
      logView = createLogView({ bot: id, short: true });
      tabBody.replaceChildren(logView.el);
    } else if (key === 'errors') loadErrors();
    else loadConfig();
  }

  async function loadErrors() {
    tabBody.replaceChildren(h('div', { class: 'panel empty', text: 'Lade …' }));
    try {
      const { lines } = await api(`/api/bots/${id}/errors`);
      if (active !== 'errors') return;
      const list = h('div', { class: 'log-view short' });
      for (const l of lines) {
        list.append(h('div', { class: `log-line ${l.level}` }, h('span', { class: 't', title: fmtFull(l.ts), text: l.ts ? fmtTime(l.ts) : '–' }), h('span', { class: 'b' }), h('span', { class: 'l', text: l.level }), h('span', { class: 'm', text: l.text })));
      }
      if (!lines.length) list.append(h('div', { class: 'empty', text: 'Das Fehlerprotokoll (stderr) ist leer.' }));
      tabBody.replaceChildren(
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', { text: 'Fehlerprotokoll (stderr), letzte Zeilen' }), h('button', { class: 'btn sm ghost', onclick: loadErrors }, icon('refresh-cw'), 'Aktualisieren')), list),
      );
      list.scrollTop = list.scrollHeight;
    } catch {
      if (active === 'errors') tabBody.replaceChildren(h('div', { class: 'panel empty', text: 'Fehlerprotokoll konnte nicht geladen werden.' }));
    }
  }

  async function loadConfig() {
    tabBody.replaceChildren(h('div', { class: 'panel empty', text: 'Lade …' }));
    try {
      const { bot, config: c } = await api(`/api/bots/${id}`);
      if (active !== 'config') return;
      const mono = (t) => (t ? h('span', { class: 'mono', text: t }) : '–');
      const rows = [
        kv('Name', bot.name),
        kv('pm2-ID', String(bot.id)),
        kv('Namespace', bot.namespace),
        kv('Version', bot.version),
        kv('Skript', mono(c.script)),
        kv('Arbeitsverzeichnis', mono(c.cwd)),
        kv('Argumente', c.args.length ? mono(c.args.join(' ')) : '–'),
        kv('Interpreter', [c.interpreter, c.nodeVersion ? `(Node ${c.nodeVersion})` : ''].filter(Boolean).join(' ')),
        kv('Ausführungsmodus', bot.execMode),
        kv('Benutzer', c.user),
        kv('Autorestart', c.autorestart ? 'Ja' : 'Nein'),
        kv('Watch', c.watch ? 'Ja' : 'Nein'),
        kv('RAM-Limit (Neustart)', c.maxMemoryRestart ? fmtBytes(c.maxMemoryRestart) : 'Keins'),
        kv('Angelegt', fmtDateTime(bot.createdAt)),
        kv('Instabile Neustarts', String(bot.unstableRestarts)),
        kv('Log (stdout)', mono(c.outLog)),
        kv('Log (stderr)', mono(c.errLog)),
      ];
      if (c.git) {
        rows.push(kv('Git', [c.git.branch, c.git.revision].filter(Boolean).join(' @ ')));
        if (c.git.comment) rows.push(kv('Letzter Commit', c.git.comment));
      }
      const env = h('div', { class: 'rows' });
      for (const v of c.env) env.append(kv(v.name, v.value === null ? h('span', { class: 'faint', text: '•••••••• (verborgen)' }) : h('span', { class: 'mono', text: v.value })));
      if (!c.env.length) env.append(h('div', { class: 'empty', text: 'Keine in pm2 hinterlegten Umgebungsvariablen.' }));
      for (const r of env.children) r.firstChild?.classList?.add('mono');
      tabBody.replaceChildren(
        h(
          'div',
          { class: 'stack' },
          h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', { text: 'Prozess' })), h('div', { class: 'rows' }, rows)),
          h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', { text: 'Umgebungsvariablen' }), h('span', { class: 'faint', text: 'Werte werden aus Sicherheitsgründen nicht übertragen' })), env),
        ),
      );
    } catch {
      if (active === 'config') tabBody.replaceChildren(h('div', { class: 'panel empty', text: 'Konfiguration konnte nicht geladen werden.' }));
    }
  }

  const sub = h('div', { class: 'muted' });
  const title = h('h1', { text: first.name });
  const el = h(
    'div',
    null,
    h('a', { class: 'back', href: '#/bots' }, icon('arrow-left'), 'Bots'),
    h('div', { class: 'detail-head' }, avatar(first, 'lg'), h('div', { class: 'titles' }, title, sub), h('div', { class: 'actions' }, acts)),
    h('div', { class: 'stack' }, h('div', { class: 'panel stats cols-6' }, sStatus, sPid, sCpu, sRam, sUp, sRestarts), h('div', { class: 'grid cols-2' }, cpu.el, ram.el)),
    h('div', { class: 'tabs', role: 'tablist' }, tabButtons),
    tabBody,
  );

  function update() {
    const s = store.state;
    const b = find();
    if (!s || !b) return;
    const online = b.status === 'online';
    st.set(b.status);
    acts.update(b);
    setText(sub, [`pm2-ID ${b.id}`, b.version ? `v${b.version}` : null, b.startedAt ? `letzter Neustart ${fmtDateTime(b.startedAt)}` : null].filter(Boolean).join(' · '));
    sPid.set(b.pid ? String(b.pid) : '–');
    sCpu.set(online ? fmtPct(b.cpu, 1) : '–');
    sRam.set(online ? fmtBytes(b.memory) : '–');
    sUp.set(online && b.startedAt ? fmtDuration((s.ts - b.startedAt) / 1000) : '–');
    sRestarts.set(String(b.restarts));
    const hist = store.botHistory[id] || [];
    const span = 180_000;
    setText(cpu.big, online ? fmtPct(b.cpu, 1) : '–');
    const cpuTop = cpu.chart.set([{ points: hist.map(([t, c]) => [t, c]) }], span, 'CPU-Verlauf');
    setText(cpu.side, `Skala bis ${fmtPct(cpuTop, cpuTop < 10 ? 1 : 0)}`);
    setText(ram.big, online ? fmtBytes(b.memory) : '–');
    const ramTop = ram.chart.set([{ points: hist.map(([t, , m]) => [t, m]) }], span, 'RAM-Verlauf');
    setText(ram.side, `Skala bis ${fmtBytes(ramTop)}`);
  }

  showTab('logs');
  update();
  return {
    el,
    update,
    title: first.name,
    crumb: ['Bots', first.name],
    destroy: () => logView?.destroy(),
  };
}
