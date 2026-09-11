#!/usr/bin/env bash
set -Eeuo pipefail

REPO="PEDIHS/HS-PG"
REF="main"
ROOT="/opt/hs-pg"
DATA="/var/lib/pasarguard/hs-plugin"
TMP=""
MODE="install"
RESTART=0

log(){ printf '\033[1;33m[HS Plugin]\033[0m %s\n' "$*"; }
fail(){ printf '\033[1;31m[HS Plugin]\033[0m %s\n' "$*" >&2; exit 1; }
cleanup(){ [[ -n "$TMP" && -d "$TMP" ]] && rm -rf "$TMP" || true; }
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --update|update) MODE="update"; shift ;;
    --restart) RESTART=1; shift ;;
    --ref) [[ $# -ge 2 ]] || fail "--ref requires a value"; REF="$2"; shift 2 ;;
    -h|--help) echo "Usage: install.sh [--update] [--restart] [--ref <tag|branch>]"; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

[[ ${EUID} -eq 0 ]] || fail "run as root/sudo"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"
if command -v curl >/dev/null 2>&1; then
  dl(){ curl -fL --retry 3 --connect-timeout 15 --max-time 120 -H 'Cache-Control: no-cache' "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  dl(){ wget -q --tries=3 --timeout=20 "$1" -O "$2"; }
else fail "curl or wget is required"; fi

TMP="$(mktemp -d)"
raw(){ printf 'https://raw.githubusercontent.com/%s/%s/%s?hs=%s' "$REPO" "$REF" "$1" "$(date +%s)"; }
files=(
  plugin/install-node-agent.sh plugin/install-mtproxy.sh
  backend/hs_firewall.py backend/hs_services.py backend/hs_services_api.py backend/hs_services_agent.py backend/hs_services_agent_v2.py
  backend/hs_outbounds.py backend/hs_fair_use.py backend/hs_fair_use_runtime.py backend/hs_fair_reconcile.py backend/hs_extensions_api.py
  backend/hs_plugin_runtime.py backend/hs_plugin_api.py backend/hs_admin_time.py backend/hs_admin_time_job.py
  backend/hs_backup_api.py backend/hs_backup_agent.py backend/hs_shield_api.py backend/hs_shield_agent.py
  plugin/patch_pasarguard.py plugin/patch_backup_api.py plugin/patch_shield_api.py plugin/patch_extensions.py
  plugin/integrate-dashboard.sh plugin/integrate-shield.sh plugin/integrate-extensions.sh
  plugin/hs-plugin.js plugin/hs-tab-fix.js plugin/hs-node-pro.js plugin/hs-backup.js plugin/hs-backup-tab-watchdog.js plugin/hs-admin-time.js plugin/hs-shield.js
  plugin/hs-services.js plugin/hs-native-extensions.js plugin/hs-firewall-charts.js
  cli/hs-pg
  systemd/hs-services-agent.service systemd/hs-pg-integrator.service systemd/hs-pg-integrator.timer systemd/hs-pg-integrator.path
  systemd/hs-pg-backup-agent.service systemd/hs-shield-agent.service systemd/hs-shield-integrator.service
)
for file in "${files[@]}"; do
  mkdir -p "$TMP/$(dirname "$file")"
  dl "$(raw "$file")" "$TMP/$file" || fail "failed to download $file"
done

python3 -m py_compile \
  "$TMP/backend/hs_plugin_runtime.py" "$TMP/backend/hs_plugin_api.py" \
  "$TMP/backend/hs_admin_time.py" "$TMP/backend/hs_admin_time_job.py" \
  "$TMP/backend/hs_backup_api.py" "$TMP/backend/hs_backup_agent.py" \
  "$TMP/backend/hs_shield_api.py" "$TMP/backend/hs_shield_agent.py" \
  "$TMP/backend/hs_firewall.py" "$TMP/backend/hs_services.py" "$TMP/backend/hs_services_api.py" \
  "$TMP/backend/hs_services_agent.py" "$TMP/backend/hs_services_agent_v2.py" \
  "$TMP/backend/hs_outbounds.py" "$TMP/backend/hs_fair_use.py" "$TMP/backend/hs_fair_use_runtime.py" \
  "$TMP/backend/hs_fair_reconcile.py" "$TMP/backend/hs_extensions_api.py" \
  "$TMP/plugin/patch_pasarguard.py" "$TMP/plugin/patch_backup_api.py" "$TMP/plugin/patch_shield_api.py" "$TMP/plugin/patch_extensions.py" \
  || fail "Python validation failed"

if command -v node >/dev/null 2>&1; then
  for file in "$TMP"/plugin/*.js; do node --check "$file" || fail "$(basename "$file") validation failed"; done
fi
bash -n "$TMP/plugin/integrate-dashboard.sh" "$TMP/plugin/integrate-shield.sh" "$TMP/plugin/integrate-extensions.sh" "$TMP/plugin/install-node-agent.sh" "$TMP/plugin/install-mtproxy.sh" "$TMP/cli/hs-pg" || fail "Shell validation failed"

backup="$ROOT/backups/$(date +%Y%m%d-%H%M%S)"
[[ -d "$ROOT" ]] && { mkdir -p "$backup"; cp -a "$ROOT/backend" "$ROOT/plugin" "$ROOT/cli" "$ROOT/systemd" "$backup/" 2>/dev/null || true; }
mkdir -p "$ROOT/backend" "$ROOT/plugin" "$ROOT/cli" "$ROOT/systemd" "$DATA"

install -m 0755 "$TMP/plugin/install-node-agent.sh" "$ROOT/plugin/install-node-agent.sh"
install -m 0755 "$TMP/plugin/install-mtproxy.sh" "$ROOT/plugin/install-mtproxy.sh"
for file in hs_firewall.py hs_services.py hs_services_api.py hs_services_agent.py hs_services_agent_v2.py hs_outbounds.py hs_fair_use.py hs_fair_use_runtime.py hs_fair_reconcile.py hs_extensions_api.py hs_plugin_runtime.py hs_plugin_api.py hs_admin_time.py hs_admin_time_job.py hs_backup_api.py hs_shield_api.py; do
  install -m 0644 "$TMP/backend/$file" "$ROOT/backend/$file"
done
install -m 0755 "$TMP/backend/hs_backup_agent.py" "$ROOT/backend/hs_backup_agent.py"
install -m 0755 "$TMP/backend/hs_shield_agent.py" "$ROOT/backend/hs_shield_agent.py"
for file in patch_pasarguard.py patch_backup_api.py patch_shield_api.py patch_extensions.py integrate-dashboard.sh integrate-shield.sh integrate-extensions.sh; do
  install -m 0755 "$TMP/plugin/$file" "$ROOT/plugin/$file"
done
for file in hs-plugin.js hs-tab-fix.js hs-node-pro.js hs-backup.js hs-backup-tab-watchdog.js hs-admin-time.js hs-shield.js hs-services.js hs-native-extensions.js hs-firewall-charts.js; do
  install -m 0644 "$TMP/plugin/$file" "$ROOT/plugin/$file"
done
rm -f "$ROOT/plugin/hs-node-ip-fix.js"
install -m 0755 "$TMP/cli/hs-pg" "$ROOT/cli/hs-pg"
install -m 0755 "$TMP/cli/hs-pg" /usr/local/bin/hs-pg

if [[ ! -f "$DATA/state.json" ]]; then
  cat > "$DATA/state.json" <<'JSON'
{
  "version": 2,
  "features": {
    "host_usage_ratio": {"enabled": true},
    "node_pro": {"enabled": false},
    "backup_web": {"enabled": false},
    "admin_time_limit": {"enabled": true}
  },
  "inbound_offsets": {},
  "admin_time_limits": {},
  "updated_at": null
}
JSON
  chmod 600 "$DATA/state.json"
fi

mkdir -p "$DATA/services" /var/lib/hs-pg-agent "$DATA/backup-inbox" "$DATA/backup-outbox" "$DATA/backup-jobs" "$DATA/admin-time" "$DATA/shield"
chmod 700 "$DATA/services" /var/lib/hs-pg-agent "$DATA/backup-inbox" "$DATA/backup-outbox" "$DATA/backup-jobs" "$DATA/admin-time" "$DATA/shield" || true

if command -v systemctl >/dev/null 2>&1; then
  for unit in hs-pg-integrator.service hs-pg-integrator.timer hs-pg-integrator.path hs-pg-backup-agent.service hs-shield-agent.service hs-shield-integrator.service hs-services-agent.service; do
    install -m 0644 "$TMP/systemd/$unit" "/etc/systemd/system/$unit"
  done
  systemctl daemon-reload
  systemctl enable hs-pg-integrator.timer >/dev/null 2>&1 || true
  systemctl restart hs-pg-integrator.timer >/dev/null 2>&1 || true
  [[ -f /opt/pasarguard/docker-compose.yml ]] && systemctl enable --now hs-pg-integrator.path >/dev/null 2>&1 || true
  systemctl enable hs-pg-integrator.service >/dev/null 2>&1 || true
  systemctl restart hs-pg-integrator.service >/dev/null 2>&1 || true
  systemctl enable hs-pg-backup-agent.service >/dev/null 2>&1 || true
  systemctl restart hs-pg-backup-agent.service >/dev/null 2>&1 || true
  systemctl enable --now hs-services-agent.service >/dev/null 2>&1 || true
  systemctl restart hs-services-agent.service >/dev/null 2>&1 || true
  systemctl enable hs-shield-agent.service >/dev/null 2>&1 || true
  systemctl restart hs-shield-agent.service >/dev/null 2>&1 || true
  systemctl enable hs-shield-integrator.service >/dev/null 2>&1 || true
  systemctl restart hs-shield-integrator.service >/dev/null 2>&1 || true
fi

log "$MODE files installed in $ROOT"
"$ROOT/plugin/integrate-dashboard.sh" || fail "PasarGuard integration failed safely; no service was restarted"
"$ROOT/plugin/integrate-extensions.sh" || fail "HS native extension integration failed safely"
"$ROOT/plugin/integrate-shield.sh" || fail "HS Shield integration failed safely; panel networking was not changed"
if [[ $RESTART -eq 1 ]]; then
  log "restarting PasarGuard as explicitly requested"
  /usr/local/bin/hs-pg restart
else
  log "no PasarGuard service restart performed"
  log "host persistence guard will re-apply HS Plugin, Fair Use and native Outbound UI after PasarGuard update/restart/recreate"
  log "HS Shield defaults to observe mode. Enforce requires nftables, preflight and a 45-second confirmation."
  log "Fair Use uses per-user Xray marks plus nftables on enrolled nodes; install/update the HS node agent on nodes that should enforce rate caps."
  log "newly patched backend routes require one PasarGuard restart after first install/update"
  log "run 'sudo hs-pg restart' only when backend hooks need activation"
fi
log "future updates: sudo hs-pg update"
