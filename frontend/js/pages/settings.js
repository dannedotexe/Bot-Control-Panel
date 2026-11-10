import { h, icon, pageHead, kv, fmtBytes, fmtDuration, fmtDateTime } from '../ui.js';
import { api, logout } from '../api.js';
import { getTheme, setTheme } from '../theme.js';

export function settingsPage() {
  const account = h('div', { class: 'rows' }, h('div', { class: 'empty', text: 'Lade …' }));
  const panel = h('div', { class: 'rows' });
  const security = h('div', { class: 'rows' });

  const themes = [
    ['dark', 'Dunkel', 'moon'],
    ['light', 'Hell', 'sun'],
    ['system', 'System', 'monitor'],
  ];
  const seg = h(
    'div',
    { class: 'seg', role: 'group', 'aria-label': 'Farbschema' },
    themes.map(([key, label, ic]) =>
      h(
        'button',
        {
          class: getTheme() === key ? 'on' : '',
          onclick: (e) => {
            setTheme(key);
            for (const b of seg.children) b.classList.remove('on');
            e.currentTarget.classList.add('on');
          },
        },
        icon(ic),
        label,
      ),
    ),
  );

  const el = h(
    'div',
    null,
    pageHead('Settings', 'Konto, Darstellung und Informationen zum Panel.'),
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', { text: 'Konto' }), h('button', { class: 'btn sm', onclick: logout }, icon('log-out'), 'Abmelden')), account),
      h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', { text: 'Darstellung' })), h('div', { class: 'rows' }, kv('Farbschema', seg))),
      h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', { text: 'Sicherheit' })), security),
      h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', { text: 'Panel' })), panel),
    ),
  );

  const code = (t) => h('code', { text: t });

  api('/api/panel')
    .then((p) => {
      account.replaceChildren(
        kv('Benutzer', p.user),
        kv('Rolle', 'Administrator'),
        kv('Angemeldet seit', fmtDateTime(p.session.createdAt)),
        kv('Sitzung läuft ab', `${fmtDateTime(p.session.expiresAt)} (nach ${p.session.idleMinutes} Min Inaktivität, spätestens nach ${p.session.maxHours} Std)`),
      );
      security.replaceChildren(
        kv('Zwei-Faktor (TOTP)', p.twoFactor ? h('span', { class: 'status ok' }, h('i', { class: 'dot ok' }), 'Aktiv') : h('span', null, h('span', { class: 'status warn' }, h('i', { class: 'dot warn' }), 'Nicht aktiv'), ' – einrichten mit ', code('bash scripts/setup-2fa.sh'))),
        kv('Passwort ändern', h('span', null, 'Auf dem Server: ', code('bash scripts/set-password.sh'))),
        kv('Login-Schutz', '5 Fehlversuche pro IP → Sperre (15 Min, verdoppelt sich bis 24 Std)'),
        kv('Erlaubte Aktionen', 'Nur Start, Stop und Restart bestehender pm2-Prozesse – keine Shell-Befehle'),
        kv('Transport', p.behindProxy ? 'HTTP hinter lokalem Reverse-Proxy (TLS dort)' : 'HTTPS (TLS ≥ 1.2), selbst signiertes Zertifikat'),
        ...(p.tls ? [kv('Zertifikat SHA-256', h('span', { class: 'mono', text: p.tls.fingerprint256 })), kv('Zertifikat gültig bis', p.tls.validTo)] : []),
      );
      panel.replaceChildren(
        kv('Version', p.version),
        kv('Port', String(p.port)),
        kv('pm2-Anbindung', `${p.pm2.mode === 'api' ? 'pm2-API (dauerhafte Verbindung)' : 'pm2 CLI (jlist)'}${p.pm2.version ? ` · pm2 ${p.pm2.version}` : ''}`),
        kv('Node.js', p.node),
        kv('Speicherverbrauch des Panels', fmtBytes(p.memory)),
        kv('Panel läuft seit', fmtDuration(p.uptime)),
        kv('Aktualisierung', `alle ${p.pollMs / 1000} s (nur solange das Panel geöffnet ist)`),
      );
    })
    .catch(() => account.replaceChildren(h('div', { class: 'empty', text: 'Informationen konnten nicht geladen werden.' })));

  return { el, update() {}, title: 'Settings' };
}
