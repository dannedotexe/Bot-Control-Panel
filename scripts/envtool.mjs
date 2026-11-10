// Hilfsprogramm für die Shell-Skripte. Secrets kommen immer über stdin, nie über Argumente.
//   hash                → liest Passwort von stdin, gibt scrypt-Hash aus
//   set <KEY>           → liest Wert von stdin, setzt KEY in .env (Datei 0600)
//   get <KEY>           → gibt den Wert aus (nur für unkritische Schlüssel verwenden)
//   has <KEY>           → Exit 0, wenn KEY gesetzt und nicht leer ist
//   random              → 48 zufällige Bytes (base64url)
//   totp-new            → neues Base32-Secret
//   totp-check          → stdin: "<secret> <code>", Exit 0 bei gültigem Code
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPassword, base32Encode, totpCode } from '../server/auth.mjs';
import { parseEnv } from '../server/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
const [cmd, key] = process.argv.slice(2);
const stdin = () => fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
const readEnv = () => (fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '');

function setKey(k, value) {
  if (!/^BCP_[A-Z0-9_]+$/.test(k)) throw new Error('Ungültiger Schlüssel');
  if (/[\r\n]/.test(value)) throw new Error('Wert darf keine Zeilenumbrüche enthalten');
  const lines = readEnv().split('\n');
  const idx = lines.findIndex((l) => l.startsWith(`${k}=`));
  if (idx >= 0) lines[idx] = `${k}=${value}`;
  else {
    if (lines.length && lines.at(-1) === '') lines.pop();
    lines.push(`${k}=${value}`, '');
  }
  const tmp = `${envFile}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
  fs.renameSync(tmp, envFile);
  fs.chmodSync(envFile, 0o600);
}

switch (cmd) {
  case 'hash': {
    const pw = stdin();
    if (pw.length < 12) {
      console.error('Passwort muss mindestens 12 Zeichen haben.');
      process.exit(2);
    }
    console.log(await hashPassword(pw));
    break;
  }
  case 'set':
    setKey(key, stdin());
    break;
  case 'get':
    process.stdout.write(parseEnv(readEnv())[key] || '');
    break;
  case 'has':
    process.exit(parseEnv(readEnv())[key] ? 0 : 1);
    break;
  case 'random':
    console.log(crypto.randomBytes(48).toString('base64url'));
    break;
  case 'totp-new':
    console.log(base32Encode(crypto.randomBytes(20)));
    break;
  case 'totp-check': {
    const [secret, code] = stdin().split(/\s+/);
    const c = Math.floor(Date.now() / 30_000);
    process.exit([c - 1, c, c + 1].some((x) => totpCode(secret, x) === code) ? 0 : 1);
    break;
  }
  default:
    console.error('Unbekannter Befehl');
    process.exit(64);
}
