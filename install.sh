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
  core/hsfair/limit.go
  core/hsfair/limit_test.go
  core/hsfair/link.go
  plugin/build-fair-core.sh
  plugin/patch_fair_core.py
  plugin/retire-firewall.sh
  plugin/retire_legacy.py
  plugin/patch_services_api.py
  plugin/integrate-services.sh
  plugin/install-node-agent.sh
  plugin/install-mtproxy.sh
  backend/hs_services.py
  backend/hs_services_api.py
  backend/hs_services_agent.py
  backend/hs_outbounds.py
  backend/hs_fair_runtime.py
  backend/hs_fair_use.py
  plugin/hs-host-fair.js
  plugin/hs-services.js
  systemd/hs-services-agent.service
  backend/hs_plugin_runtime.py
  backend/hs_plugin_api.py
  backend/hs_admin_time.py
  backend/hs_admin_time_job.py
  backend/hs_backup_api.py
  backend/hs_backup_agent.py
  plugin/patch_pasarguard.py
  plugin/patch_backup_api.py
  plugin/integrate-dashboard.sh
  plugin/integrate-shield.sh
  plugin/hs-plugin.js
  plugin/hs-tab-fix.js
  plugin/hs-node-pro.js
  plugin/hs-backup.js
  plugin/hs-backup-tab-watchdog.js
  plugin/hs-admin-time.js
  cli/hs-pg
  systemd/hs-pg-integrator.service
  systemd/hs-pg-integrator.timer
  systemd/hs-pg-integrator.path
  systemd/hs-pg-backup-agent.service
)
for file in "${files[@]}"; do
  mkdir -p "$TMP/$(dirname "$file")"
  dl "$(raw "$file")" "$TMP/$file" || fail "failed to download $file"
done

python3 -m py_compile \
  "$TMP/backend/hs_plugin_runtime.py" \
  "$TMP/backend/hs_plugin_api.py" \
  "$TMP/backend/hs_admin_time.py" \
  "$TMP/backend/hs_admin_time_job.py" \
  "$TMP/backend/hs_backup_api.py" \
  "$TMP/backend/hs_backup_agent.py" \
  "$TMP/plugin/patch_pasarguard.py" \
  "$TMP/plugin/patch_backup_api.py" \
  "$TMP/backend/hs_services.py" \
  "$TMP/backend/hs_services_api.py" \
  "$TMP/backend/hs_services_agent.py" \
  "$TMP/backend/hs_outbounds.py" \
  "$TMP/backend/hs_fair_use.py" \
  || fail "Python validation failed"

if command -v node >/dev/null 2>&1; then
  node --check "$TMP/plugin/hs-services.js" || fail "hs-services.js validation failed"
  node --check "$TMP/plugin/hs-plugin.js" || fail "hs-plugin.js validation failed"
  node --check "$TMP/plugin/hs-tab-fix.js" || fail "hs-tab-fix.js validation failed"
  node --check "$TMP/plugin/hs-node-pro.js" || fail "hs-node-pro.js validation failed"
  node --check "$TMP/plugin/hs-backup.js" || fail "hs-backup.js validation failed"
  node --check "$TMP/plugin/hs-backup-tab-watchdog.js" || fail "hs-backup-tab-watchdog.js validation failed"
  node --check "$TMP/plugin/hs-admin-time.js" || fail "hs-admin-time.js validation failed"
fi
bash -n "$TMP/plugin/integrate-dashboard.sh" "$TMP/plugin/integrate-shield.sh" "$TMP/cli/hs-pg" || fail "Shell validation failed"

if command -v systemctl >/dev/null 2>&1; then
  systemctl stop hs-pg-integrator.timer hs-pg-integrator.path hs-pg-integrator.service hs-services-agent.service >/dev/null 2>&1 || true
fi
backup="$ROOT/backups/$(date +%Y%m%d-%H%M%S)"
[[ -d "$ROOT" ]] && {
  mkdir -p "$backup"
  cp -a "$ROOT/backend" "$ROOT/plugin" "$ROOT/cli" "$ROOT/systemd" "$backup/" 2>/dev/null || true
}
bash "$TMP/plugin/retire-firewall.sh"
mkdir -p "$ROOT/backend" "$ROOT/plugin" "$ROOT/cli" "$ROOT/systemd" "$DATA"
mkdir -p "$ROOT/core/hsfair"
install -m 0644 "$TMP/core/hsfair/"*.go "$ROOT/core/hsfair/"
for file in build-fair-core.sh patch_fair_core.py retire-firewall.sh retire_legacy.py patch_services_api.py integrate-services.sh; do
  install -m 0755 "$TMP/plugin/$file" "$ROOT/plugin/$file"
done
install -m 0755 "$TMP/plugin/install-node-agent.sh" "$ROOT/plugin/install-node-agent.sh"
install -m 0755 "$TMP/plugin/install-mtproxy.sh" "$ROOT/plugin/install-mtproxy.sh"
install -m 0644 "$TMP/backend/hs_services.py" "$ROOT/backend/hs_services.py"
install -m 0644 "$TMP/backend/hs_services_api.py" "$ROOT/backend/hs_services_api.py"
install -m 0644 "$TMP/backend/hs_services_agent.py" "$ROOT/backend/hs_services_agent.py"
install -m 0644 "$TMP/backend/hs_outbounds.py" "$ROOT/backend/hs_outbounds.py"
install -m 0644 "$TMP/backend/hs_fair_runtime.py" "$ROOT/backend/hs_fair_runtime.py"
install -m 0644 "$TMP/backend/hs_fair_use.py" "$ROOT/backend/hs_fair_use.py"
install -m 0644 "$TMP/plugin/hs-host-fair.js" "$ROOT/plugin/hs-host-fair.js"
install -m 0644 "$TMP/plugin/hs-services.js" "$ROOT/plugin/hs-services.js"
install -m 0644 "$TMP/backend/hs_plugin_runtime.py" "$ROOT/backend/hs_plugin_runtime.py"
install -m 0644 "$TMP/backend/hs_plugin_api.py" "$ROOT/backend/hs_plugin_api.py"
install -m 0644 "$TMP/backend/hs_admin_time.py" "$ROOT/backend/hs_admin_time.py"
install -m 0644 "$TMP/backend/hs_admin_time_job.py" "$ROOT/backend/hs_admin_time_job.py"
install -m 0644 "$TMP/backend/hs_backup_api.py" "$ROOT/backend/hs_backup_api.py"
install -m 0755 "$TMP/backend/hs_backup_agent.py" "$ROOT/backend/hs_backup_agent.py"
install -m 0755 "$TMP/plugin/patch_pasarguard.py" "$ROOT/plugin/patch_pasarguard.py"
install -m 0755 "$TMP/plugin/patch_backup_api.py" "$ROOT/plugin/patch_backup_api.py"
install -m 0755 "$TMP/plugin/integrate-dashboard.sh" "$ROOT/plugin/integrate-dashboard.sh"
install -m 0755 "$TMP/plugin/integrate-shield.sh" "$ROOT/plugin/integrate-shield.sh"
install -m 0644 "$TMP/plugin/hs-plugin.js" "$ROOT/plugin/hs-plugin.js"
install -m 0644 "$TMP/plugin/hs-tab-fix.js" "$ROOT/plugin/hs-tab-fix.js"
install -m 0644 "$TMP/plugin/hs-node-pro.js" "$ROOT/plugin/hs-node-pro.js"
install -m 0644 "$TMP/plugin/hs-backup.js" "$ROOT/plugin/hs-backup.js"
install -m 0644 "$TMP/plugin/hs-backup-tab-watchdog.js" "$ROOT/plugin/hs-backup-tab-watchdog.js"
install -m 0644 "$TMP/plugin/hs-admin-time.js" "$ROOT/plugin/hs-admin-time.js"
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

mkdir -p "$DATA/services" /var/lib/hs-pg-agent
chmod 700 "$DATA/services" /var/lib/hs-pg-agent
mkdir -p "$DATA/backup-inbox" "$DATA/backup-outbox" "$DATA/backup-jobs" "$DATA/admin-time"
chmod 700 "$DATA/backup-inbox" "$DATA/backup-outbox" "$DATA/backup-jobs" "$DATA/admin-time" || true

if command -v systemctl >/dev/null 2>&1; then
  for unit in hs-pg-integrator.service hs-pg-integrator.timer hs-pg-integrator.path hs-pg-backup-agent.service hs-services-agent.service; do
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
fi

log "Legacy HS Firewall services and owned nftables tables removed; loaders cleaned during integration"
log "$MODE files installed in $ROOT"
"$ROOT/plugin/integrate-dashboard.sh" || fail "PasarGuard integration failed safely; no service was restarted"
"$ROOT/plugin/integrate-services.sh" || fail "HS Services integration failed"
if [[ $RESTART -eq 1 ]]; then
  log "restarting PasarGuard as explicitly requested"
  /usr/local/bin/hs-pg restart
else
  log "no PasarGuard service restart performed"
  log "host persistence guard is active and will re-apply HS Plugin after PasarGuard update/restart/recreate"
  log "Web Backup, Admin Time and newly patched backend routes may require one PasarGuard restart after first install/update"
  log "run 'sudo hs-pg restart' only when backend hooks need activation"
fi
log "future updates: sudo hs-pg update"
