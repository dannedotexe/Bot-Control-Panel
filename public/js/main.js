// Einstieg: Session prüfen, Login oder App-Rahmen (Sidebar, Topbar, Router) anzeigen.
import './theme.js';
import { h, icon, fmtAgo, botCounts } from './ui.js';
import { store, subscribe, loadSession, connect, logout } from './api.js';
import { loginPage } from './pages/login.js';
import { overviewPage } from './pages/overview.js';
import { botsPage } from './pages/bots.js';
import { botPage } from './pages/bot.js';
import { serverPage } from './pages/server.js';
import { logsPage } from './pages/logs.js';
import { settingsPage } from './pages/settings.js';

const root = document.getElementById('app');
const NAV = [
  ['overview', 'Overview', 'layout-dashboard'],
  ['bots', 'Bots', 'bot'],
  ['server', 'Server', 'server'],
  ['logs', 'Logs', 'scroll-text'],
  ['settings', 'Settings', 'settings'],
];
const SEEN_KEY = 'bcp-notes-seen';

let page = null;
let shell = null;
let openMenu = null;

function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

document.addEventListener('click', (e) => {
  if (openMenu && !e.target.closest('.menu-wrap')) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});

function toggleMenu(wrap, build) {
  const wasOpen = openMenu && openMenu.parentNode === wrap;
  closeMenu();
  if (wasOpen) return;
  openMenu = build();
  wrap.append(openMenu);
}

function seenId() {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

function buildShell() {
  const links = new Map();
  const botCount = h('span', { class: 'count num' });
  const nav = h(
    'nav',
    { class: 'nav', 'aria-label': 'Hauptnavigation' },
    NAV.map(([key, label, ic]) => {
      const a = h('a', { href: `#/${key}` }, icon(ic), h('span', { text: label }), key === 'bots' ? botCount : null);
      links.set(key, a);
      return a;
    }),
  );
  const foot = h('div', { class: 'sidebar-foot' });
  const crumbs = h('div', { class: 'crumbs' });
  const connDot = h('i', { class: 'dot' });
  const connText = h('span');
  const content = h('main', { class: 'content', id: 'content' });

  // Benachrichtigungen
  const bellDot = h('i', { class: 'bell-dot' });
  bellDot.hidden = true;
  const bellWrap = h('div', { class: 'menu-wrap' });
  const bell = h(
    'button',
    {
      class: 'btn ghost icon-only',
      title: 'Benachrichtigungen',
      'aria-label': 'Benachrichtigungen',
      onclick: () => {
        toggleMenu(bellWrap, () => {
          const list = store.notifications.slice().reverse();
          const last = list[0]?.id || 0;
          try {
            // IDs beginnen nach einem Panel-Neustart wieder bei 1
            localStorage.setItem(SEEN_KEY, String(last));
          } catch {
            /* egal */
          }
          bellDot.hidden = true;
          return h(
            'div',
            { class: 'menu wide', role: 'dialog', 'aria-label': 'Benachrichtigungen' },
            h('div', { class: 'panel-head' }, h('h2', { text: 'Benachrichtigungen' })),
            h(
              'div',
              { class: 'notes' },
              list.length
                ? list.map((n) =>
                    h(
                      'div',
                      { class: `note ${n.level}` },
                      icon(n.level === 'info' ? 'info' : n.level === 'warn' ? 'triangle-alert' : 'circle-alert'),
                      h('div', null, h('div', { class: 'title', text: n.title }), n.text ? h('div', { class: 'text', text: n.text }) : null, h('div', { class: 'time', text: fmtAgo(n.ts) })),
                    ),
                  )
                : h('div', { class: 'empty', text: 'Keine Benachrichtigungen.' }),
            ),
          );
        });
      },
    },
    icon('bell'),
    bellDot,
  );
  bell.style.position = 'relative';
  bellWrap.append(bell);

  // Profil
  const userWrap = h('div', { class: 'menu-wrap' });
  userWrap.append(
    h(
      'button',
      {
        class: 'user-btn',
        title: 'Profil',
        'aria-label': 'Profil',
        onclick: () =>
          toggleMenu(userWrap, () =>
            h(
              'div',
              { class: 'menu', role: 'menu' },
              h('div', { class: 'head' }, h('strong', { text: store.session?.user || '' }), 'Administrator'),
              h(
                'button',
                {
                  class: 'item',
                  role: 'menuitem',
                  onclick: () => {
                    closeMenu();
                    location.hash = '#/settings';
                  },
                },
                icon('settings'),
                'Einstellungen',
              ),
              h('button', { class: 'item', role: 'menuitem', onclick: logout }, icon('log-out'), 'Abmelden'),
            ),
          ),
      },
      icon('user'),
    ),
  );

  const el = h(
    'div',
    { class: 'shell' },
    h('aside', { class: 'sidebar' }, h('a', { class: 'brand', href: '#/overview' }, h('span', { class: 'brand-mark' }, icon('terminal')), 'Control Panel'), nav, foot),
    h(
      'div',
      { class: 'main' },
      h(
        'header',
        { class: 'topbar' },
        h('span', { class: 'brand-mark mobile-brand' }, icon('terminal')),
        crumbs,
        h('div', { class: 'spacer' }),
        h('div', { class: 'conn', title: 'Live-Verbindung' }, connDot, connText),
        bellWrap,
        h('a', { class: 'btn ghost icon-only', href: '#/settings', title: 'Einstellungen', 'aria-label': 'Einstellungen' }, icon('settings')),
        userWrap,
      ),
      content,
    ),
  );

  return {
    el,
    content,
    setActive(key, crumb) {
      for (const [k, a] of links) {
        a.classList.toggle('active', k === key);
        if (k === key) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
      crumbs.replaceChildren(...crumb.flatMap((c, i) => (i === crumb.length - 1 ? [h('strong', { text: c })] : [h('span', { text: c }), icon('chevron-right', 'faint')])));
    },
    update() {
      const s = store.state;
      connDot.className = `dot ${store.live ? 'ok' : 'warn'}`;
      connText.textContent = store.live ? 'Live' : 'Verbinde …';
      if (s) {
        const c = botCounts(s.bots);
        botCount.textContent = `${c.online}/${c.total}`;
        foot.replaceChildren(h('i', { class: `dot ${s.pm2Ok ? 'ok' : 'err'}` }), s.pm2Ok ? 'pm2 verbunden' : 'pm2 nicht erreichbar');
      }
    },
    updateBell() {
      const last = store.notifications.at(-1)?.id || 0;
      const seen = seenId();
      bellDot.hidden = !(last > 0 && (last > seen || seen > last + 1000) && store.notifications.some((n) => n.id > seen && n.level !== 'info'));
      if (seen > last) {
        try {
          localStorage.setItem(SEEN_KEY, '0');
        } catch {
          /* egal */
        }
      }
    },
  };
}

function route() {
  if (!store.session || !shell) return;
  closeMenu();
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const key = NAV.some(([k]) => k === parts[0]) ? parts[0] : 'overview';
  const id = /^\d+$/.test(parts[1] || '') ? Number(parts[1]) : undefined;
  page?.destroy?.();
  if (key === 'bots' && id !== undefined) page = botPage(id);
  else if (key === 'bots') page = botsPage();
  else if (key === 'server') page = serverPage();
  else if (key === 'logs') page = logsPage(id);
  else if (key === 'settings') page = settingsPage();
  else page = overviewPage();
  shell.setActive(key, page.crumb || [page.title]);
  shell.content.replaceChildren(page.el);
  document.title = `${page.title} · Control Panel`;
  window.scrollTo(0, 0);
}

let routedWithState = false;

function render() {
  page?.destroy?.();
  page = null;
  shell = null;
  closeMenu();
  if (!store.session) {
    page = loginPage();
    root.replaceChildren(page.el);
    document.title = 'Anmelden · Control Panel';
    return;
  }
  shell = buildShell();
  root.replaceChildren(shell.el);
  routedWithState = false;
  shell.update();
  connect();
  if (store.state) {
    routedWithState = true;
    route();
  } else shell.content.replaceChildren(h('div', { class: 'empty', text: 'Lade …' }));
}

subscribe((kind) => {
  if (kind === 'session') return render();
  if (!shell) return undefined;
  if (kind === 'notify') shell.updateBell();
  shell.update();
  if (kind === 'state') {
    if (!routedWithState) {
      routedWithState = true;
      route();
    } else page?.update?.();
  }
  return undefined;
});

window.addEventListener('hashchange', () => {
  if (store.state) route();
});

loadSession()
  .catch(() => null)
  .then(render);
