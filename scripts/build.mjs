// Baut das Frontend nach public/: kopiert die Quelldateien und erzeugt das Icon-Sprite
// aus lucide-static (nur die tatsächlich verwendeten Icons). Auf dem Server ist kein Build nötig.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'frontend');
const out = path.join(root, 'public');
const require = createRequire(import.meta.url);
const lucideDir = path.join(path.dirname(require.resolve('lucide-static/package.json')), 'icons');

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });

// Verwendete Icons aus dem Quelltext sammeln: icon('name') und Einträge wie 'layout-dashboard'
const names = new Set();
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.js')) {
      for (const m of fs.readFileSync(full, 'utf8').matchAll(/'([a-z][a-z0-9]*(?:-[a-z0-9]+)*)'/g)) {
        if (fs.existsSync(path.join(lucideDir, `${m[1]}.svg`))) names.add(m[1]);
      }
    }
  }
};
walk(src);

let sprite = '<svg xmlns="http://www.w3.org/2000/svg">\n';
for (const name of [...names].sort()) {
  const svg = fs.readFileSync(path.join(lucideDir, `${name}.svg`), 'utf8');
  const inner = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/\s*\n\s*/g, '');
  sprite += `<symbol id="${name}" viewBox="0 0 24 24">${inner}</symbol>\n`;
}
sprite += '</svg>\n';
fs.writeFileSync(path.join(out, 'icons.svg'), sprite);
console.log(`public/ gebaut – ${names.size} Icons: ${[...names].sort().join(', ')}`);
