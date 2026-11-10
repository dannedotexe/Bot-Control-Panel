// Farbschema: Dunkel ist Standard; Auswahl wird lokal im Browser gespeichert.
const KEY = 'bcp-theme';
const media = window.matchMedia('(prefers-color-scheme: light)');

export function getTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'system' ? v : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme() {
  const t = getTheme();
  const resolved = t === 'system' ? (media.matches ? 'light' : 'dark') : t;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'light' ? '#fafafa' : '#0f1012');
}

export function setTheme(t) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* privater Modus */
  }
  applyTheme();
}

media.addEventListener('change', applyTheme);
applyTheme();
