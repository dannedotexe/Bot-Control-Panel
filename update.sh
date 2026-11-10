#!/usr/bin/env bash
# Bot Control Panel – Update: holt den aktuellen Stand und startet NUR das Panel neu.
set -euo pipefail
cd "$(dirname "$0")"
APP=bot-control-panel
[ "$(id -u)" -ne 0 ] || { echo "Bitte ohne sudo ausführen."; exit 1; }
BEFORE="$(git rev-parse --short HEAD)"
git pull --ff-only
AFTER="$(git rev-parse --short HEAD)"
if [ "$BEFORE" = "$AFTER" ] && [ "${1:-}" != "--force" ]; then echo "Bereits aktuell ($AFTER)."; exit 0; fi
for f in server/*.mjs; do node --check "$f"; done
[ -f public/index.html ] || { echo "public/ fehlt – Abbruch."; exit 1; }
if pm2 describe "$APP" >/dev/null 2>&1; then pm2 restart "$APP" --update-env >/dev/null
else pm2 start ecosystem.config.cjs --only "$APP" >/dev/null; fi
PORT="$(node scripts/envtool.mjs get BCP_PORT)"; PORT="${PORT:-8443}"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -ksS --max-time 3 "https://127.0.0.1:$PORT/api/session" 2>/dev/null | grep -q '"authenticated"'; then
    echo "Update $BEFORE → $AFTER erfolgreich, Panel läuft."; exit 0
  fi
done
echo "WARNUNG: Panel antwortet nicht. Prüfen: pm2 logs $APP --lines 30 --nostream"
echo "Zurück zur alten Version: git reset --hard $BEFORE && pm2 restart $APP"
exit 1
