// Kleine DOM-Helfer, Formatierung und wiederverwendbare Bausteine. Kein innerHTML mit Daten.
const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

export function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

export function icon(name, cls = '') {
  const el = svg('svg', { class: `icon ${cls}`.trim(), viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  el.append(svg('use', { href: `/icons.svg#${name}` }));
  return el;
}

// ---------- Formatierung ----------
export function fmtBytes(n, digits = 1) {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toLocaleString('de-DE', { maximumFractionDigits: i < 2 ? 0 : n >= 100 ? 0 : digits })} ${units[i]}`;
}

export function fmtRate(n) {
  return `${fmtBytes(n).replace(/^0 MB$/, '0 KB')}/s`;
}

export function fmtPct(n, digits = 0) {
  if (!Number.isFinite(n)) return '–';
  return `${n.toLocaleString('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: digits })} %`;
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400);
  const hh = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} T ${hh} Std`;
  if (hh > 0) return `${hh} Std ${m} Min`;
  if (m > 0) return `${m} Min ${sec % 60} s`;
  return `${sec} s`;
}

const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'medium' });

export const fmtTime = (ts) => (ts ? timeFmt.format(ts) : '–');
export const fmtDateTime = (ts) => (ts ? dateFmt.format(ts) : '–');
export const fmtFull = (ts) => (ts ? fullFmt.format(ts) : '');

export function fmtAgo(ts) {
  if (!ts) return '–';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${Math.floor(s / 60)} Min`;
  if (s < 86400) return `vor ${Math.floor(s / 3600)} Std`;
  return `vor ${Math.floor(s / 86400)} T`;
}

// ---------- Status ----------
const STATUS = {
  online: ['Online', 'ok'],
  stopped: ['Gestoppt', ''],
  stopping: ['Stoppt …', 'warn'],
  launching: ['Startet …', 'warn'],
  'waiting restart': ['Wartet auf Neustart', 'warn'],
  errored: ['Fehler', 'err'],
  'one-launch-status': ['Startfehler', 'err'],
};

export function statusMeta(status) {
  const [label, cls] = STATUS[status] || [status || 'Unbekannt', ''];
  return { label, cls };
}

export function statusEl(status) {
  const el = h('span', { class: 'status' }, h('i', { class: 'dot' }), h('span'));
  const set = (s) => {
    const { label, cls } = statusMeta(s);
    el.className = `status ${cls}`.trim();
    el.firstChild.className = `dot ${cls}`.trim();
    el.lastChild.textContent = label;
  };
  set(status);
  el.set = set;
  return el;
}

export function botCounts(bots) {
  const c = { total: bots.length, online: 0, stopped: 0, errored: 0 };
  for (const b of bots) {
    if (b.status === 'online') c.online += 1;
    else if (b.status === 'stopped' || b.status === 'stopping') c.stopped += 1;
    else if (b.status === 'errored' || b.status === 'one-launch-status' || b.status === 'waiting restart') c.errored += 1;
  }
  return c;
}

export function avatar(bot, size = '') {
  const initials = bot.name
    .replace(/[-_.]?bot$/i, '')
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join('') || bot.name.slice(0, 2);
  const el = h('span', { class: `avatar ${size}`.trim(), 'aria-hidden': 'true' }, initials.length === 1 ? bot.name.replace(/[-_.]/g, '').slice(0, 2) : initials);
  // Optionales Bild: data/avatars/<pm2-name>.png
  if (bot.avatar) {
    const img = new Image();
    img.alt = '';
    img.addEventListener('load', () => el.replaceChildren(img));
    img.src = `/avatars/${encodeURIComponent(bot.name)}.png`;
  }
  return el;
}

export function meter() {
  const bar = h('i');
  const el = h('div', { class: 'meter' }, bar);
  el.set = (pct) => {
    const p = Math.max(0, Math.min(100, pct || 0));
    bar.style.width = `${p}%`;
    el.className = `meter ${p >= 95 ? 'err' : p >= 85 ? 'warn' : ''}`.trim();
  };
  return el;
}

// ---------- Sparkline ----------
// series: Array von { points: [[t, v], …], alt?: bool }. Zeitachse = spanMs bis jetzt.
export function sparkline({ max = null, area = true } = {}) {
  const W = 300;
  const H = 56;
  const el = svg('svg', { class: 'spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' });
  el.set = (series, spanMs, label = '') => {
    el.replaceChildren();
    if (label) el.setAttribute('aria-label', label);
    const end = Date.now();
    const start = end - spanMs;
    let top = max;
    if (top === null) {
      top = 0;
      for (const s of series) for (const [, v] of s.points) if (v > top) top = v;
      top = top > 0 ? top * 1.15 : 1;
    }
    el.append(svg('line', { class: 'base', x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5 }));
    series.forEach((s, idx) => {
      const pts = s.points.filter(([t]) => t >= start);
      if (pts.length < 2) return;
      const xy = pts.map(([t, v]) => [((t - start) / spanMs) * W, H - 1 - (Math.min(v, top) / top) * (H - 4)]);
      const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
      if (area && idx === 0) {
        el.append(svg('path', { class: 'area', d: `${d}L${xy.at(-1)[0].toFixed(1)} ${H}L${xy[0][0].toFixed(1)} ${H}Z` }));
      }
      el.append(svg('path', { class: `line ${s.alt ? 'alt' : ''}`.trim(), d }));
    });
    return top;
  };
  return el;
}

// ---------- Toast & Dialog ----------
let toastHost;
export function toast(message, type = 'ok') {
  toastHost ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const el = h('div', { class: `toast ${type}` }, icon(type === 'error' ? 'circle-alert' : 'circle-check'), h('span', { text: message }));
  toastHost.append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3200);
}

export function confirmDialog({ title, text, confirmLabel = 'Bestätigen', danger = false }) {
  return new Promise((resolve) => {
    const done = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
    };
    const ok = h('button', { class: `btn ${danger ? 'danger-solid' : 'primary'}`, onclick: () => done(true) }, confirmLabel);
    const overlay = h(
      'div',
      { class: 'overlay', onclick: (e) => e.target === overlay && done(false) },
      h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' }, h('h3', { text: title }), h('p', { text }), h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => done(false) }, 'Abbrechen'), ok)),
    );
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    ok.focus();
  });
}

export function pageHead(title, sub, right) {
  const subEl = h('p', { text: sub || '' });
  const el = h('div', { class: 'page-head' }, h('div', null, h('h1', { text: title }), subEl), right || null);
  el.setSub = (t) => {
    subEl.textContent = t;
  };
  return el;
}

export function kv(key, value) {
  const v = h('div', { class: 'v' });
  const el = h('div', { class: 'kv' }, h('div', { class: 'k', text: key }), v);
  el.set = (val) => {
    if (val instanceof Node) v.replaceChildren(val);
    else v.textContent = val === null || val === undefined || val === '' ? '–' : String(val);
  };
  el.set(value);
  return el;
}

export function setText(el, value) {
  if (el.textContent !== value) el.textContent = value;
}

// Dialog mit Eingabefeldern. Liefert { name: wert } oder null bei Abbruch.
export function formDialog({ title, text, fields, confirmLabel = 'Speichern', danger = false }) {
  return new Promise((resolve) => {
    const inputs = {};
    const done = (ok) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(ok ? Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])) : null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
    };
    const form = h(
      'form',
      {
        class: 'dialog',
        role: 'dialog',
        'aria-modal': 'true',
        onsubmit: (e) => {
          e.preventDefault();
          done(true);
        },
      },
      h('h3', { text: title }),
      text ? h('p', { text }) : null,
      h(
        'div',
        { class: 'dialog-fields' },
        fields.map((f) => {
          const el = h('input', { class: 'input', name: f.name, type: f.type || 'text', placeholder: f.placeholder || '', autocomplete: f.autocomplete || 'off', spellcheck: 'false', required: f.required ? true : null, readonly: f.readonly ? true : null });
          if (f.value) el.value = f.value;
          inputs[f.name] = el;
          return h('label', { class: 'field' }, h('span', { text: f.label }), el, f.hint ? h('small', { class: 'faint', text: f.hint }) : null);
        }),
      ),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => done(false) }, 'Abbrechen'), h('button', { class: `btn ${danger ? 'danger-solid' : 'primary'}`, type: 'submit' }, confirmLabel)),
    );
    const overlay = h('div', { class: 'overlay', onclick: (e) => e.target === overlay && done(false) }, form);
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    (fields.find((f) => !f.readonly && !f.value) ? inputs[fields.find((f) => !f.readonly && !f.value).name] : Object.values(inputs)[0])?.focus();
  });
}

const DISCORD = {
  none: ['Alle Systeme normal', 'ok'],
  minor: ['Leichte Störung', 'warn'],
  major: ['Größere Störung', 'err'],
  critical: ['Schwere Störung', 'err'],
  unknown: ['Status unbekannt', ''],
};

export function discordStatusEl(d) {
  const [label, cls] = DISCORD[d?.indicator] || DISCORD.unknown;
  const text = d?.error && d?.indicator === 'unknown' ? 'Nicht abrufbar' : label;
  return h('span', { class: `status ${cls}`.trim(), title: d?.description || '' }, h('i', { class: `dot ${cls}`.trim() }), text);
}
