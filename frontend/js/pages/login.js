import { h, icon } from '../ui.js';
import { login, store, errorText } from '../api.js';

export function loginPage() {
  const user = h('input', { class: 'input', id: 'user', name: 'username', autocomplete: 'username', required: true, autocapitalize: 'none', spellcheck: 'false' });
  const pass = h('input', { class: 'input', id: 'pass', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const code = h('input', { class: 'input num', id: 'code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '\\d{6}', placeholder: '6-stelliger Code' });
  const codeField = h('div', { class: 'field' }, h('label', { for: 'code', text: 'Zwei-Faktor-Code' }), code);
  codeField.hidden = !store.twoFactor;
  const error = h('div', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Anmelden');
  let timer;

  function lock(seconds) {
    clearInterval(timer);
    let left = seconds;
    const tick = () => {
      if (left <= 0) {
        clearInterval(timer);
        submit.disabled = false;
        error.textContent = '';
        return;
      }
      submit.disabled = true;
      const m = Math.floor(left / 60);
      error.textContent = `Zu viele Fehlversuche. Erneut möglich in ${m > 0 ? `${m} Min ` : ''}${left % 60} s.`;
      left -= 1;
    };
    tick();
    timer = setInterval(tick, 1000);
  }

  const form = h(
    'form',
    {
      class: 'panel',
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        if (submit.disabled) return;
        if (!user.value || !pass.value) {
          error.textContent = 'Bitte Benutzername und Passwort eingeben.';
          return;
        }
        submit.disabled = true;
        error.textContent = '';
        try {
          await login(user.value.trim(), pass.value, code.value.trim());
        } catch (err) {
          submit.disabled = false;
          if (err.code === 'totp_required') {
            codeField.hidden = false;
            code.focus();
            error.textContent = 'Bitte den Code aus der Authenticator-App eingeben.';
          } else if (err.code === 'locked') {
            lock(err.body.retryAfter || 60);
          } else if (err.code === 'network') {
            error.textContent = 'Server nicht erreichbar.';
          } else {
            error.textContent = errorText(err);
            pass.value = '';
            code.value = '';
            pass.focus();
          }
        }
      },
    },
    h('h1', { text: 'Anmelden' }),
    h('p', { class: 'sub', text: 'Zugriff nur für Administratoren.' }),
    h('div', { class: 'field' }, h('label', { for: 'user', text: 'Benutzername' }), user),
    h('div', { class: 'field' }, h('label', { for: 'pass', text: 'Passwort' }), pass),
    codeField,
    submit,
    error,
  );

  const el = h(
    'div',
    { class: 'login' },
    h('div', { class: 'login-card' }, h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('terminal')), 'Control Panel'), form, h('p', { class: 'login-note', text: 'Verbindung verschlüsselt · Fehlversuche werden protokolliert' })),
  );
  queueMicrotask(() => user.focus());
  return { el, destroy: () => clearInterval(timer) };
}
