// Live-Log-Ansicht: Historie + Live-Zeilen per SSE, Filter nach Level/Stream, Suche, Auto-Scroll.
import { h, icon, fmtTime, fmtFull } from './ui.js';

const MAX_BUFFER = 3000;
const MAX_DOM = 1500;
const LEVELS = ['INFO', 'WARN', 'ERROR'];

export function createLogView({ bot = 'all', showBot = false, short = false, lines = 300 } = {}) {
  let buffer = [];
  let source = null;
  let follow = true;
  let query = '';
  let stream = 'all';
  const levels = new Set(LEVELS);
  let shown = 0;

  const list = h('div', { class: `log-view ${short ? 'short' : ''}`.trim(), role: 'log', 'aria-live': 'off', tabindex: '0' });
  if (showBot) list.style.setProperty('--bot-col', '116px');
  const count = h('span');
  const state = h('span', { class: 'status' }, h('i', { class: 'dot' }), h('span', { text: 'Verbinde …' }));

  const levelSeg = h(
    'div',
    { class: 'seg', role: 'group', 'aria-label': 'Level' },
    LEVELS.map((lv) =>
      h(
        'button',
        {
          class: 'on',
          'aria-pressed': 'true',
          onclick: (e) => {
            const btn = e.currentTarget;
            if (levels.has(lv)) levels.delete(lv);
            else levels.add(lv);
            btn.classList.toggle('on', levels.has(lv));
            btn.setAttribute('aria-pressed', String(levels.has(lv)));
            render();
          },
        },
        h('i', { class: `lv ${lv}` }),
        lv,
      ),
    ),
  );

  const streamSel = h(
    'select',
    {
      class: 'select',
      'aria-label': 'Ausgabe',
      onchange: (e) => {
        stream = e.target.value;
        render();
      },
    },
    h('option', { value: 'all' }, 'stdout + stderr'),
    h('option', { value: 'out' }, 'Nur stdout'),
    h('option', { value: 'err' }, 'Nur stderr (Fehlerprotokoll)'),
  );

  let searchTimer;
  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Logs durchsuchen …',
    'aria-label': 'Logs durchsuchen',
    oninput: (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        query = e.target.value.trim().toLowerCase();
        render();
      }, 120);
    },
  });

  const followBtn = h('button', { class: 'btn sm on', title: 'Automatisch mitlaufen', onclick: () => setFollow(!follow) }, icon('arrow-down-to-line'), 'Live');
  const clearBtn = h(
    'button',
    {
      class: 'btn sm ghost icon-only',
      title: 'Ansicht leeren',
      'aria-label': 'Ansicht leeren',
      onclick: () => {
        buffer = [];
        render();
      },
    },
    icon('trash-2'),
  );

  const tools = h('div', { class: 'log-tools' }, h('div', { class: 'field-icon' }, icon('search'), search), levelSeg, streamSel, followBtn, clearBtn);
  const el = h('div', { class: 'panel' }, tools, list, h('div', { class: 'log-foot' }, count, state));

  function setFollow(v) {
    follow = v;
    followBtn.classList.toggle('on', follow);
    if (follow) list.scrollTop = list.scrollHeight;
  }

  list.addEventListener('scroll', () => {
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    if (!atBottom && follow) setFollow(false);
    else if (atBottom && !follow) setFollow(true);
  });

  const matches = (l) => {
    if (stream !== 'all' && l.stream !== stream) return false;
    const lv = l.level === 'DEBUG' ? 'INFO' : l.level;
    if (!levels.has(lv)) return false;
    return !query || l.text.toLowerCase().includes(query) || l.bot.toLowerCase().includes(query);
  };

  function lineEl(l) {
    const msg = h('span', { class: 'm' });
    if (query) {
      const lower = l.text.toLowerCase();
      let pos = 0;
      let idx;
      while ((idx = lower.indexOf(query, pos)) !== -1 && query.length) {
        if (idx > pos) msg.append(l.text.slice(pos, idx));
        msg.append(h('mark', { text: l.text.slice(idx, idx + query.length) }));
        pos = idx + query.length;
      }
      msg.append(l.text.slice(pos));
    } else msg.textContent = l.text;
    return h(
      'div',
      { class: `log-line ${l.level}` },
      h('span', { class: 't', title: fmtFull(l.ts), text: l.ts ? fmtTime(l.ts) : '–' }),
      h('span', { class: 'b', text: showBot ? l.bot : '' }),
      h('span', { class: 'l', text: l.level }),
      msg,
    );
  }

  function updateCount() {
    count.textContent = `${shown.toLocaleString('de-DE')} von ${buffer.length.toLocaleString('de-DE')} Zeilen`;
  }

  function render() {
    const visible = buffer.filter(matches).slice(-MAX_DOM);
    shown = visible.length;
    const frag = document.createDocumentFragment();
    for (const l of visible) frag.append(lineEl(l));
    list.replaceChildren(frag);
    if (!visible.length) list.append(h('div', { class: 'empty', text: buffer.length ? 'Keine Zeilen für diesen Filter.' : 'Noch keine Log-Ausgabe.' }));
    updateCount();
    if (follow) list.scrollTop = list.scrollHeight;
  }

  function add(batch) {
    buffer.push(...batch);
    if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
    const visible = batch.filter(matches);
    if (visible.length) {
      list.querySelector('.empty')?.remove();
      const frag = document.createDocumentFragment();
      for (const l of visible) frag.append(lineEl(l));
      list.append(frag);
      shown += visible.length;
      while (list.childElementCount > MAX_DOM) {
        list.firstElementChild.remove();
        shown -= 1;
      }
      if (follow) list.scrollTop = list.scrollHeight;
    }
    updateCount();
  }

  function setState(text, cls) {
    state.className = `status ${cls}`.trim();
    state.firstChild.className = `dot ${cls}`.trim();
    state.lastChild.textContent = text;
  }

  function open() {
    source = new EventSource(`/api/logs/stream?bot=${encodeURIComponent(bot)}&lines=${lines}`);
    source.addEventListener('history', (e) => {
      buffer = JSON.parse(e.data);
      render();
      setState('Live', 'ok');
    });
    source.addEventListener('lines', (e) => add(JSON.parse(e.data)));
    source.onerror = () => setState('Verbindung unterbrochen – neuer Versuch …', 'warn');
  }

  render();
  open();

  return {
    el,
    destroy() {
      source?.close();
      clearTimeout(searchTimer);
    },
  };
}
