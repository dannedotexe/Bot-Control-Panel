// Einstiegspunkt: lädt .env, startet den HTTPS-Server (oder HTTP hinter lokalem Reverse-Proxy).
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig } from './config.mjs';
import { createPm2 } from './pm2.mjs';
import { createApp } from './app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(root);
const errors = validateConfig(config);
if (errors.length) {
  for (const e of errors) console.error(`[config] ${e}`);
  // Nicht in einer Neustart-Schleife hängen: pm2 stoppt nach max_restarts.
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const pm2 = createPm2({ modulePath: config.pm2Module, bin: config.pm2Bin, selfName: config.selfName });

let tlsInfo = null;
let server;
const serverOptions = { requestTimeout: 30_000, headersTimeout: 15_000, keepAliveTimeout: 60_000, maxHeaderSize: 8192 };

if (config.behindProxy) {
  server = http.createServer(serverOptions, (req, res) => app.handler(req, res));
} else {
  const cert = fs.readFileSync(config.tlsCert);
  try {
    const x = new crypto.X509Certificate(cert);
    tlsInfo = { fingerprint256: x.fingerprint256, validTo: x.validTo, subjectAltName: x.subjectAltName || null };
  } catch {
    /* nur Anzeige */
  }
  server = https.createServer({ ...serverOptions, key: fs.readFileSync(config.tlsKey), cert, minVersion: 'TLSv1.2' }, (req, res) => app.handler(req, res));
}

const app = createApp({ config, pm2, version, tlsInfo });

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

await app.start();
server.listen(config.port, config.host, () => {
  console.log(`[panel] v${version} läuft auf ${config.behindProxy ? 'http' : 'https'}://${config.host}:${config.port} (pm2: ${pm2.mode})`);
});

function shutdown() {
  app.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => console.error(`[panel] ${err?.stack || err}`));
