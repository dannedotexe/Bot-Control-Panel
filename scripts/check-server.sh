#!/usr/bin/env bash
# Bot Control Panel – NUR LESENDES Prüfskript.
# Ändert nichts am System und gibt keine Secrets aus (pm2-Umgebungsvariablen werden nie gelesen
# oder angezeigt). Als der Benutzer ausführen, unter dem pm2 läuft (ubuntu):
#   bash check-server.sh
set -u
PORT="${1:-8443}"
line() { printf '\n=== %s ===\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

line "System"
echo "Datum:        $(date -Is)"
echo "Benutzer:     $(id -un) (uid $(id -u))"
echo "Hostname:     $(hostname)"
echo "Architektur:  $(uname -m)"
echo "Kernel:       $(uname -r)"
[ -r /etc/os-release ] && echo "OS:           $(. /etc/os-release && echo "$PRETTY_NAME")"
echo "CPU-Kerne:    $(nproc 2>/dev/null || echo '?')"
echo "Uptime:       $(uptime -p 2>/dev/null || uptime)"
echo "Load:         $(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"

line "Arbeitsspeicher / Swap"
free -m 2>/dev/null || echo "free nicht verfügbar"

line "Festplatte"
df -h / /home 2>/dev/null | awk '!seen[$0]++'

line "Node / npm / pm2 / Werkzeuge"
for c in node npm pm2 git openssl curl; do
  if have "$c"; then
    case "$c" in
      openssl) v="$(openssl version 2>/dev/null)" ;;
      git) v="$(git --version 2>/dev/null)" ;;
      curl) v="$(curl --version 2>/dev/null | head -n1 | cut -d' ' -f1-2)" ;;
      *) v="$("$c" --version 2>/dev/null | tail -n1)" ;;
    esac
    printf '%-8s %s  (%s)\n' "$c" "$v" "$(command -v "$c")"
  else
    printf '%-8s FEHLT\n' "$c"
  fi
done
if have npm; then
  g="$(npm root -g 2>/dev/null)"
  echo "npm root -g: $g"
  [ -f "$g/pm2/package.json" ] && echo "pm2-Modul:   $g/pm2 (gefunden)" || echo "pm2-Modul:   nicht unter npm root -g gefunden"
fi

line "pm2-Prozesse (ohne Umgebungsvariablen)"
if have pm2 && have node; then
  pm2 jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let list; try { list = JSON.parse(s.slice(s.indexOf("["))); } catch { console.log("pm2 jlist nicht lesbar"); return; }
      if (!list.length) return console.log("(keine Prozesse)");
      const mb = (n) => (n ? (n / 1048576).toFixed(0) + " MB" : "-");
      for (const p of list) {
        const e = p.pm2_env || {};
        const up = e.status === "online" && e.pm_uptime ? Math.round((Date.now() - e.pm_uptime) / 3600000) + " h" : "-";
        console.log(`[${p.pm_id}] ${p.name}`);
        console.log(`     status=${e.status} pid=${p.pid || "-"} cpu=${p.monit ? p.monit.cpu : "-"}% ram=${mb(p.monit && p.monit.memory)} restarts=${e.restart_time} uptime=${up}`);
        console.log(`     mode=${e.exec_mode} interpreter=${e.exec_interpreter} node=${e.node_version || "-"} user=${e.username || "-"}`);
        console.log(`     script=${e.pm_exec_path}`);
        console.log(`     cwd=${e.pm_cwd}`);
        console.log(`     out=${e.pm_out_log_path}`);
        console.log(`     err=${e.pm_err_log_path}`);
      }
      console.log(`\nSumme RAM der pm2-Prozesse: ${mb(list.reduce((a, p) => a + ((p.monit && p.monit.memory) || 0), 0))}`);
    });'
  echo "PM2_HOME:    ${PM2_HOME:-$HOME/.pm2}"
  echo "pm2-Daemon:  $(pgrep -u "$(id -u)" -f 'PM2 v' >/dev/null 2>&1 && echo läuft || echo 'nicht gefunden')"
  echo "Dump-Datei:  $([ -f "${PM2_HOME:-$HOME/.pm2}/dump.pm2" ] && echo vorhanden || echo fehlt)"
  echo "Log-Größe:   $(du -sh "${PM2_HOME:-$HOME/.pm2}/logs" 2>/dev/null | cut -f1)"
else
  echo "pm2 oder node nicht im PATH"
fi

line "pm2-Autostart (systemd)"
if have systemctl; then
  for u in "pm2-$(id -un)" pm2-root; do
    printf '%-14s enabled=%s active=%s\n' "$u" "$(systemctl is-enabled "$u" 2>/dev/null | head -n1 | grep . || echo nein)" "$(systemctl is-active "$u" 2>/dev/null | head -n1 | grep . || echo nein)"
  done
fi

line "Webserver"
for s in caddy nginx apache2; do
  if have "$s" || { have systemctl && systemctl list-unit-files "$s.service" 2>/dev/null | grep -q "$s"; }; then
    printf '%-8s installiert, active=%s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null || echo '?')"
  else
    printf '%-8s nicht installiert\n' "$s"
  fi
done

line "Lauschende TCP-Ports"
if have ss; then
  if sudo -n true 2>/dev/null; then sudo -n ss -ltnpH 2>/dev/null | awk '{print $4, $6}' | sed -E 's/users:\(\("([^"]+)".*/\1/' | sort -u
  else ss -ltnH 2>/dev/null | awk '{print $4}' | sort -u; fi
fi
echo
if have ss && ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$PORT\$"; then
  echo "Port $PORT: BELEGT"
else
  echo "Port $PORT: frei"
fi

line "Firewall (iptables INPUT, nur lesen)"
if sudo -n true 2>/dev/null; then
  sudo -n iptables -L INPUT -n --line-numbers 2>/dev/null | head -n 30 || echo "iptables nicht lesbar"
  echo "ufw: $(sudo -n ufw status 2>/dev/null | head -n1 || echo 'nicht installiert')"
  echo "netfilter-persistent: $(have netfilter-persistent && echo vorhanden || echo fehlt)"
else
  echo "Kein passwortloses sudo – iptables übersprungen."
fi

line "Fertig"
echo "Es wurde nichts verändert. Bitte die komplette Ausgabe (Screenshot oder Text) zurückschicken."
