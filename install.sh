#!/usr/bin/env bash
# Bot Control Panel – Installation (idempotent, mehrfach ausführbar).
# Als der Benutzer ausführen, unter dem pm2 läuft (ubuntu) – NICHT mit sudo.
# Bestehende Bots und deren pm2-Einträge werden nicht verändert.
#
#   bash install.sh [--port 8443] [--ip 1.2.3.4] [--reset-password] [--new-cert]
set -euo pipefail
cd "$(dirname "$0")"
APP=bot-control-panel
PORT=""; IP=""; RESET_PW=0; NEW_CERT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --ip) IP="$2"; shift 2 ;;
    --reset-password) RESET_PW=1; shift ;;
    --new-cert) NEW_CERT=1; shift ;;
    *) echo "Unbekannte Option: $1"; exit 64 ;;
  esac
done
say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die() { echo "FEHLER: $1" >&2; exit 1; }
env_tool() { node scripts/envtool.mjs "$@"; }

say "1/6 Voraussetzungen"
[ "$(id -u)" -ne 0 ] || die "Bitte ohne sudo als pm2-Benutzer (z. B. ubuntu) ausführen."
for c in node pm2 openssl; do command -v "$c" >/dev/null 2>&1 || die "$c nicht gefunden."; done
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>18||(a===18&&b>=17)?0:1)' || die "Node >= 18.17 erforderlich (gefunden: $(node -v))."
[ -f public/index.html ] || die "public/ fehlt – Repository unvollständig."
echo "Node $(node -v), pm2 $(pm2 --version 2>/dev/null | tail -n1), $(uname -m)"

say "2/6 Konfiguration (.env)"
umask 077
[ -f .env ] || { : > .env; echo ".env angelegt."; }
chmod 600 .env
if [ -n "$PORT" ]; then printf '%s' "$PORT" | env_tool set BCP_PORT; fi
env_tool has BCP_PORT || printf '8443' | env_tool set BCP_PORT
PORT="$(env_tool get BCP_PORT)"
case "$PORT" in ''|*[!0-9]*) die "Ungültiger Port: $PORT" ;; esac
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "Port muss zwischen 1024 und 65535 liegen."
env_tool has BCP_HOST || printf '0.0.0.0' | env_tool set BCP_HOST
if ! env_tool has BCP_ADMIN_USER; then
  read -rp "Admin-Benutzername [admin]: " U; U="${U:-admin}"
  printf '%s' "$U" | grep -Eq '^[A-Za-z0-9._-]{1,64}$' || die "Nur Buchstaben, Ziffern, . _ - erlaubt."
  printf '%s' "$U" | env_tool set BCP_ADMIN_USER
fi
env_tool has BCP_SESSION_SECRET || env_tool random | tr -d '\n' | env_tool set BCP_SESSION_SECRET
if ! env_tool has BCP_PM2_MODULE; then
  G="$(npm root -g 2>/dev/null || true)"
  if [ -n "$G" ] && [ -f "$G/pm2/package.json" ]; then
    printf '%s' "$G/pm2" | env_tool set BCP_PM2_MODULE
    echo "pm2-API: $G/pm2"
  else
    echo "pm2-Modul nicht gefunden – das Panel nutzt dann 'pm2 jlist' (funktioniert, etwas mehr CPU)."
  fi
fi
if [ "$RESET_PW" -eq 1 ] || ! env_tool has BCP_ADMIN_PASSWORD_HASH; then
  bash scripts/set-password.sh --no-restart
else
  echo "Admin-Passwort ist bereits gesetzt (ändern: bash scripts/set-password.sh)."
fi

say "3/6 TLS-Zertifikat (selbst signiert)"
mkdir -p data/tls data/avatars
chmod 700 data/tls
if [ "$NEW_CERT" -eq 1 ] || [ ! -f data/tls/cert.pem ] || [ ! -f data/tls/key.pem ]; then
  if [ -z "$IP" ]; then
    GUESS="$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || true)"
    read -rp "Öffentliche IP des Servers [${GUESS:-bitte eingeben}]: " IP; IP="${IP:-$GUESS}"
  fi
  printf '%s' "$IP" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || die "Ungültige IPv4-Adresse: $IP"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 825 \
    -subj "/CN=$APP" -addext "subjectAltName=IP:$IP,IP:127.0.0.1,DNS:localhost" \
    -keyout data/tls/key.pem -out data/tls/cert.pem 2>/dev/null
  chmod 600 data/tls/key.pem
  echo "Zertifikat für $IP erstellt (gültig 825 Tage)."
else
  echo "Zertifikat vorhanden (neu erzeugen: bash install.sh --new-cert --ip <IP>)."
fi
FPR="$(openssl x509 -in data/tls/cert.pem -noout -fingerprint -sha256 | cut -d= -f2)"

say "4/6 Start über pm2"
if pm2 describe "$APP" >/dev/null 2>&1; then
  pm2 restart "$APP" --update-env >/dev/null
  echo "Panel neu gestartet."
else
  if command -v ss >/dev/null 2>&1 && ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$PORT\$"; then
    die "Port $PORT ist bereits belegt. Anderen Port wählen: bash install.sh --port 9443"
  fi
  pm2 start ecosystem.config.cjs --only "$APP" >/dev/null
  echo "Panel gestartet."
fi
OK=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -ksS --max-time 3 "https://127.0.0.1:$PORT/api/session" 2>/dev/null | grep -q '"authenticated"'; then OK=1; break; fi
done
if [ "$OK" -eq 1 ]; then echo "Selbsttest: https://127.0.0.1:$PORT antwortet."
else echo "WARNUNG: Panel antwortet lokal nicht. Bitte prüfen: pm2 logs $APP --lines 30 --nostream"; fi

say "5/6 Autostart nach Reboot"
echo "Damit das Panel einen Reboot übersteht, muss die pm2-Prozessliste gespeichert werden (pm2 save)."
echo "Das speichert den AKTUELLEN Zustand aller pm2-Prozesse – ein gerade gestoppter Bot bliebe"
echo "nach einem Reboot gestoppt. Aktueller Zustand:"
pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const p of JSON.parse(s.slice(s.indexOf("["))))console.log("  "+String(p.pm2_env.status).padEnd(9)+p.name)}catch{}})'
read -rp "Jetzt 'pm2 save' ausführen? [j/N]: " A
case "$A" in j|J|y|Y) pm2 save >/dev/null && echo "Gespeichert." ;; *) echo "Übersprungen – später selbst ausführen: pm2 save" ;; esac
if command -v systemctl >/dev/null 2>&1; then
  if [ "$(systemctl is-enabled "pm2-$(id -un)" 2>/dev/null || true)" = "enabled" ]; then echo "pm2-$(id -un).service ist aktiviert."
  else echo "HINWEIS: pm2-$(id -un).service ist nicht aktiviert. Einrichten mit: pm2 startup"; fi
fi

say "6/6 Firewall (wird NICHT automatisch geändert)"
cat <<TXT
a) iptables auf dem Server (Oracle-Ubuntu blockt standardmäßig alles außer SSH):
     sudo iptables -I INPUT "\$(sudo iptables -L INPUT --line-numbers -n | awk '/REJECT/{print \$1; exit}')" -m state --state NEW -p tcp --dport $PORT -j ACCEPT
     sudo netfilter-persistent save
b) Oracle Cloud Console → Networking → Virtual Cloud Networks → dein VCN → Subnet →
   Security List (oder NSG der Instanz) → Add Ingress Rule:
     Source CIDR: am besten nur deine eigene IP (x.x.x.x/32), sonst 0.0.0.0/0
     IP Protocol: TCP, Destination Port Range: $PORT

Aufruf:   https://<Server-IP>:$PORT
Der Browser warnt wegen des selbst signierten Zertifikats. Vor dem Akzeptieren den
SHA-256-Fingerabdruck vergleichen (Schloss-Symbol → Zertifikat anzeigen):
  $FPR
Empfohlen: 2FA aktivieren mit  bash scripts/setup-2fa.sh
TXT
