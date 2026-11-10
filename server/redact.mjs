// Maskiert Tokens/Secrets in Log-Zeilen und Konfigurationswerten, bevor sie den Server verlassen.

const SECRET_KEY = '(?:token|secret|passw(?:or)?d|passwd|pwd|api[_-]?key|apikey|auth(?:orization)?|cookie|session[_-]?(?:id|key|secret)?|private[_-]?key|client[_-]?secret|access[_-]?key|credentials?|webhook|dsn|database[_-]?url|mongo(?:db)?[_-]?ur[il]|redis[_-]?url)';

const RULES = [
  // Discord-Webhooks
  [/https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+/gi, 'https://discord.com/api/webhooks/[REDACTED]'],
  // JWT
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[REDACTED_JWT]'],
  // Discord-Bot-Token (Base64-ID.Zeitstempel.HMAC) und alte MFA-Tokens
  [/(?<![\w-])[A-Za-z\d_-]{23,28}\.[A-Za-z\d_-]{6,7}\.[A-Za-z\d_-]{27,}/g, '[REDACTED_TOKEN]'],
  [/\bmfa\.[\w-]{60,}/g, '[REDACTED_TOKEN]'],
  // Authorization-Header
  [/\b(Bearer|Bot|Basic)\s+[A-Za-z\d._~+/=-]{16,}/g, '$1 [REDACTED]'],
  // Zugangsdaten in URLs (user:pass@host)
  [/\b([a-z][a-z\d+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
  // Token in URLs ohne Passwort (https://ghp_xxx@github.com)
  [/\b(https?:\/\/)[A-Za-z\d_-]{20,}@/g, '$1[REDACTED]@'],
  // key=value / "key": "value"
  [new RegExp(`(\\b[\\w.-]*${SECRET_KEY}[\\w.-]*["']?\\s*[:=]\\s*)(["']?)[^\\s"',;}&]{4,}\\2`, 'gi'), '$1$2[REDACTED]$2'],
  // Bekannte Schlüssel-Präfixe (GitHub, Slack, Stripe, OpenAI …)
  [/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|AKIA)[-_]?[A-Za-z\d_-]{16,}/g, '[REDACTED_KEY]'],
  // Private Keys
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]'],
];

export function redact(text) {
  let out = String(text);
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

const SECRET_NAME = new RegExp(SECRET_KEY, 'i');
// Umgebungsvariablen, deren Werte unkritisch sind und angezeigt werden dürfen.
const SAFE_ENV = new Set(['NODE_ENV', 'PORT', 'HOST', 'TZ', 'LANG', 'LOG_LEVEL', 'NODE_APP_INSTANCE']);

export function isSecretName(name) {
  return SECRET_NAME.test(name);
}

// Liefert Umgebungsvariablen nur als Namen; Werte nur für eine kleine Whitelist.
export function describeEnv(env) {
  if (!env || typeof env !== 'object') return [];
  return Object.keys(env)
    .filter((k) => typeof env[k] !== 'object')
    .sort()
    .map((name) => ({
      name,
      value: SAFE_ENV.has(name) && !isSecretName(name) ? redact(String(env[name])).slice(0, 200) : null,
    }));
}
