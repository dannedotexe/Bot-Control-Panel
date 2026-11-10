#!/usr/bin/env bash
# Setzt/ändert das Admin-Passwort (nur der scrypt-Hash landet in .env).
set -euo pipefail
cd "$(dirname "$0")/.."
while true; do
  read -rsp "Neues Admin-Passwort (mind. 12 Zeichen): " P1; echo
  read -rsp "Passwort wiederholen: " P2; echo
  if [ "$P1" != "$P2" ]; then echo "Die Eingaben stimmen nicht überein."; continue; fi
  if [ "${#P1}" -lt 12 ]; then echo "Zu kurz (mind. 12 Zeichen)."; continue; fi
  break
done
HASH="$(printf '%s' "$P1" | node scripts/envtool.mjs hash)"
unset P1 P2
printf '%s' "$HASH" | node scripts/envtool.mjs set BCP_ADMIN_PASSWORD_HASH
echo "Passwort-Hash in .env gespeichert."
if [ "${1:-}" != "--no-restart" ] && pm2 describe bot-control-panel >/dev/null 2>&1; then
  pm2 restart bot-control-panel --update-env >/dev/null && echo "Panel neu gestartet – alle Sitzungen wurden beendet."
fi
