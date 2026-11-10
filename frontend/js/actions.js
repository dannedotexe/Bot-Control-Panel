// Start/Stop/Restart-Schaltflächen mit Rückfrage.
import { h, icon, toast, confirmDialog } from './ui.js';
import { botAction, errorText } from './api.js';

const DEF = {
  start: { label: 'Starten', icon: 'play', done: 'gestartet' },
  stop: { label: 'Stoppen', icon: 'square', done: 'gestoppt', danger: true },
  restart: { label: 'Neu starten', icon: 'rotate-cw', done: 'neu gestartet' },
};

export async function runAction(bot, action) {
  const def = DEF[action];
  if (action !== 'start') {
    const ok = await confirmDialog({
      title: `${bot.name} ${action === 'stop' ? 'stoppen' : 'neu starten'}?`,
      text: bot.self
        ? 'Das Panel startet sich selbst neu. Die Verbindung wird kurz unterbrochen.'
        : action === 'stop'
          ? 'Der Prozess wird über pm2 beendet und bleibt gestoppt, bis er wieder gestartet wird.'
          : 'Der Prozess wird über pm2 beendet und sofort wieder gestartet.',
      confirmLabel: def.label,
      danger: action === 'stop',
    });
    if (!ok) return false;
  }
  try {
    await botAction(bot, action);
    toast(`${bot.name} ${def.done}`);
    return true;
  } catch (err) {
    toast(errorText(err), 'error');
    return false;
  }
}

// Liefert ein Element mit den drei Aktionen; update(bot) passt die Verfügbarkeit an.
export function actionButtons(bot, { labels = false, size = 'sm' } = {}) {
  let current = bot;
  let busy = false;
  const buttons = {};
  const el = h('div', { class: 'action-set', style: null });
  el.style.display = 'contents';
  for (const action of ['start', 'stop', 'restart']) {
    const def = DEF[action];
    const btn = h(
      'button',
      {
        class: `btn ${size} ${labels ? '' : 'icon-only ghost'} ${def.danger ? 'danger' : ''}`.replace(/\s+/g, ' ').trim(),
        title: def.label,
        'aria-label': `${def.label}: ${bot.name}`,
        onclick: async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (busy) return;
          busy = true;
          refresh();
          await runAction(current, action);
          busy = false;
          refresh();
        },
      },
      icon(def.icon),
      labels ? def.label : null,
    );
    buttons[action] = btn;
    el.append(btn);
  }
  function refresh() {
    const online = current.status === 'online' || current.status === 'launching' || current.status === 'waiting restart';
    buttons.start.disabled = busy || online || current.self;
    buttons.stop.disabled = busy || current.status === 'stopped' || current.self;
    buttons.restart.disabled = busy;
  }
  el.update = (b) => {
    current = b;
    refresh();
  };
  refresh();
  return el;
}
