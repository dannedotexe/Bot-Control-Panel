// API-Zugriff, Session und Live-Zustand (SSE).
const listeners = new Set();

export const store = {
  session: null,
  info: null,
  history: [],
  botHistory: {},
  notifications: [],
  state: null,
  live: false,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(kind) {
  for (const fn of [...listeners]) fn(kind);
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error || 'error';
    this.body = body || {};
  }
}

const MESSAGES = {
  invalid_credentials: 'Benutzername, Passwort oder Code ist falsch.',
  locked: 'Zu viele Fehlversuche. Login vorübergehend gesperrt.',
  self_protected: 'Das Panel kann sich nicht selbst stoppen.',
  already_running: 'Der Prozess läuft bereits.',
  already_stopped: 'Der Prozess ist bereits gestoppt.',
  name_mismatch: 'Die Prozessliste hat sich geändert. Bitte erneut versuchen.',
  not_found: 'Nicht gefunden.',
  pm2_failed: 'pm2 hat die Aktion nicht ausgeführt.',
  bad_csrf: 'Sitzung ungültig. Bitte Seite neu laden.',
  too_many_streams: 'Zu viele offene Live-Verbindungen.',
};

export const errorText = (err) => MESSAGES[err?.code] || 'Unerwarteter Fehler. Bitte erneut versuchen.';

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && store.session?.csrf) headers['X-CSRF-Token'] = store.session.csrf;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError(0, { error: 'network' });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* leer */
  }
  if (!res.ok) {
    if (res.status === 401 && store.session && path !== '/api/login') endSession();
    throw new ApiError(res.status, data);
  }
  return data;
}

export async function loadSession() {
  const s = await api('/api/session');
  store.session = s.authenticated ? s : null;
  store.twoFactor = Boolean(s.twoFactor);
  return store.session;
}

export async function login(username, password, code) {
  store.session = await api('/api/login', { method: 'POST', body: { username, password, ...(code ? { code } : {}) } });
  emit('session');
}

export async function logout() {
  try {
    await api('/api/logout', { method: 'POST', body: {} });
  } catch {
    /* Session ist ohnehin weg */
  }
  endSession();
}

function endSession() {
  disconnect();
  store.session = null;
  store.state = null;
  emit('session');
}

// ---------- Live-Zustand ----------
let source = null;

export function connect() {
  if (source) return;
  source = new EventSource('/api/stream');
  source.addEventListener('init', (e) => {
    const d = JSON.parse(e.data);
    Object.assign(store, { info: d.info, history: d.history, botHistory: d.botHistory, notifications: d.notifications, state: d.state, live: true });
    emit('state');
    emit('notify');
  });
  source.addEventListener('state', (e) => {
    const s = JSON.parse(e.data);
    store.state = s;
    store.live = true;
    if (s.system) {
      const m = s.system.mem;
      store.history.push([s.ts, s.system.cpu, m.total ? (m.used / m.total) * 100 : 0, s.system.net.rx, s.system.net.tx]);
      if (store.history.length > 120) store.history.shift();
    }
    for (const b of s.bots) {
      const hist = (store.botHistory[b.id] ??= []);
      hist.push([s.ts, b.cpu, b.memory]);
      if (hist.length > 60) hist.shift();
    }
    emit('state');
  });
  source.addEventListener('notify', (e) => {
    store.notifications.push(JSON.parse(e.data));
    if (store.notifications.length > 50) store.notifications.shift();
    emit('notify');
  });
  source.addEventListener('expired', () => endSession());
  source.onerror = () => {
    store.live = false;
    emit('conn');
    // Bei abgelaufener Session liefert der Server 401 – dann nicht endlos neu verbinden.
    if (source && source.readyState === EventSource.CLOSED) {
      source = null;
      loadSession()
        .then((s) => (s ? setTimeout(connect, 3000) : endSession()))
        .catch(() => setTimeout(connect, 5000));
    }
  };
}

export function disconnect() {
  source?.close();
  source = null;
  store.live = false;
}

export function botAction(bot, action) {
  return api(`/api/bots/${bot.id}/action`, { method: 'POST', body: { action, name: bot.name } });
}
