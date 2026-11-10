#!/usr/bin/env bash
# Richtet automatische Updates ein (idempotent):
#  1. eigener, nur lesender GitHub-Deploy-Key für dieses Repo (~/.ssh/bot_panel_deploy)
#  2. Git-Remote auf diesen Key umstellen
#  3. systemd-Timer: alle 10 Sekunden update.sh (tut nichts, wenn es keinen neuen Code gibt)
# Abschalten: bash scripts/setup-autoupdate.sh --disable
# Log ansehen: journalctl -u bcp-update -n 30
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$(pwd)"
UNIT=/etc/systemd/system/bcp-update
if [ "${1:-}" = "--disable" ]; then
  sudo systemctl disable --now bcp-update.timer 2>/dev/null || true
  sudo rm -f "$UNIT.service" "$UNIT.timer"; sudo systemctl daemon-reload
  echo "Automatische Updates abgeschaltet."; exit 0
fi
[ "$(id -u)" -ne 0 ] || { echo "Bitte ohne sudo ausführen."; exit 1; }
KEY="$HOME/.ssh/bot_panel_deploy"
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "bot-control-panel@$(hostname)" -f "$KEY"
if ! grep -q '^Host github-bot-panel$' "$HOME/.ssh/config" 2>/dev/null; then
  printf '\nHost github-bot-panel\n  HostName github.com\n  User git\n  IdentityFile %s\n  IdentitiesOnly yes\n  BatchMode yes\n  StrictHostKeyChecking accept-new\n' "$KEY" >> "$HOME/.ssh/config"
  chmod 600 "$HOME/.ssh/config"
fi
git remote set-url origin git@github-bot-panel:dannedotexe/Bot-Control-Panel.git
# alten Cron-Eintrag (falls vorhanden) entfernen
(crontab -l 2>/dev/null | grep -v '# bot-control-panel-autoupdate') | crontab - 2>/dev/null || true
NODE_DIR="$(dirname "$(command -v node)")"
sudo tee "$UNIT.service" >/dev/null <<UNITEOF
[Unit]
Description=Bot Control Panel – Update prüfen
After=network-online.target

[Service]
Type=oneshot
User=$(id -un)
WorkingDirectory=$DIR
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
ExecStart=/bin/bash $DIR/update.sh --quiet
Nice=10
UNITEOF
sudo tee "$UNIT.timer" >/dev/null <<UNITEOF
[Unit]
Description=Bot Control Panel – Update alle 10 Sekunden prüfen

[Timer]
OnBootSec=30s
OnUnitInactiveSec=10s
AccuracySec=1s

[Install]
WantedBy=timers.target
UNITEOF
sudo systemctl daemon-reload
sudo systemctl enable --now bcp-update.timer >/dev/null 2>&1
echo "Timer eingerichtet: prüft alle 10 Sekunden. Log: journalctl -u bcp-update -n 30"
if git ls-remote origin >/dev/null 2>&1; then
  echo "GitHub-Zugriff: OK – automatische Updates laufen."
else
  echo
  echo "EIN SCHRITT FEHLT: Diesen öffentlichen Schlüssel auf GitHub eintragen"
  echo "(Repo Bot-Control-Panel → Settings → Deploy keys → Add deploy key, 'Allow write access' NICHT anhaken):"
  echo
  cat "$KEY.pub"
  echo
  echo "Danach prüfen mit: cd $DIR && git ls-remote origin >/dev/null && echo OK"
fi
