#!/usr/bin/env bash
# Richtet TOTP-2FA ein (oder entfernt sie mit --disable). Das Secret wird einmalig im Terminal
# angezeigt, damit du es in die Authenticator-App eintragen kannst – NICHT als Screenshot teilen.
set -euo pipefail
cd "$(dirname "$0")/.."
restart() { pm2 describe bot-control-panel >/dev/null 2>&1 && pm2 restart bot-control-panel --update-env >/dev/null && echo "Panel neu gestartet."; }
if [ "${1:-}" = "--disable" ]; then
  printf '' | node scripts/envtool.mjs set BCP_TOTP_SECRET
  echo "2FA deaktiviert."; restart; exit 0
fi
SECRET="$(node scripts/envtool.mjs totp-new)"
USER_NAME="$(node scripts/envtool.mjs get BCP_ADMIN_USER)"
echo
echo "In der Authenticator-App (Aegis, Google Authenticator, 1Password …) 'Schlüssel manuell eingeben':"
echo "  Konto:      Bot Control Panel (${USER_NAME:-admin})"
echo "  Schlüssel:  $SECRET"
echo "  Typ:        zeitbasiert (TOTP), 6 Ziffern, 30 Sekunden"
echo
echo "Oder als Link: otpauth://totp/BotControlPanel:${USER_NAME:-admin}?secret=$SECRET&issuer=BotControlPanel"
echo
for _ in 1 2 3; do
  read -rp "Aktuellen 6-stelligen Code zur Bestätigung eingeben: " CODE
  if printf '%s %s' "$SECRET" "$CODE" | node scripts/envtool.mjs totp-check; then
    printf '%s' "$SECRET" | node scripts/envtool.mjs set BCP_TOTP_SECRET
    echo "2FA aktiviert."; restart
    echo "Tipp: Terminal jetzt leeren (clear), damit der Schlüssel nicht sichtbar bleibt."
    exit 0
  fi
  echo "Code stimmt nicht (Uhrzeit des Handys korrekt?)."
done
echo "Abgebrochen – es wurde nichts geändert."; exit 1
