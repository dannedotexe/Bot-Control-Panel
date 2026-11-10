import { h, pageHead } from '../ui.js';
import { store } from '../api.js';
import { createLogView } from '../logview.js';

export function logsPage(initialBot) {
  let view = null;
  let current = initialBot !== undefined && store.state?.bots.some((b) => b.id === initialBot) ? String(initialBot) : 'all';
  const holder = h('div');
  const select = h('select', {
    class: 'select',
    'aria-label': 'Bot auswählen',
    onchange: (e) => {
      current = e.target.value;
      history.replaceState(null, '', current === 'all' ? '#/logs' : `#/logs/${current}`);
      mount();
    },
  });
  let optionKey = '';

  function fillOptions() {
    const bots = store.state?.bots || [];
    const key = bots.map((b) => `${b.id}:${b.name}`).join('|');
    if (key === optionKey) return;
    optionKey = key;
    select.replaceChildren(h('option', { value: 'all' }, 'Alle Bots'), ...bots.map((b) => h('option', { value: String(b.id) }, b.name)));
    select.value = current;
  }

  function mount() {
    view?.destroy();
    view = createLogView({ bot: current, showBot: current === 'all', lines: 400 });
    holder.replaceChildren(view.el);
  }

  const el = h('div', null, pageHead('Logs', 'Live-Ausgabe direkt aus den pm2-Logdateien. Tokens und Passwörter werden maskiert.', select), holder);
  fillOptions();
  mount();

  return { el, update: fillOptions, title: 'Logs', destroy: () => view?.destroy() };
}
