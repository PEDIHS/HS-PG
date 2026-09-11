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
  backend/hs_plugin_runtime.py
  backend/hs_plugin_api.py
  backend/hs_backup_api.py
  backend/hs_backup_agent.py
  plugin/patch_pasarguard.py
  plugin/patch_backup_api.py
  plugin/integrate-dashboard.sh
  plugin/hs-plugin.js
  plugin/hs-tab-fix.js
  plugin/hs-node-pro.js
  plugin/hs-backup.js
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
  "$TMP/backend/hs_backup_api.py" \
  "$TMP/backend/hs_backup_agent.py" \
  "$TMP/plugin/patch_pasarguard.py" \
  "$TMP/plugin/patch_backup_api.py" \
  || fail "Python validation failed"

if command -v node >/dev/null 2>&1; then
  node --check "$TMP/plugin/hs-plugin.js" || fail "hs-plugin.js validation failed"
  node --check "$TMP/plugin/hs-tab-fix.js" || fail "hs-tab-fix.js validation failed"
  node --check "$TMP/plugin/hs-node-pro.js" || fail "hs-node-pro.js validation failed"
  node --check "$TMP/plugin/hs-backup.js" || fail "hs-backup.js validation failed"
fi
bash -n "$TMP/plugin/integrate-dashboard.sh" "$TMP/cli/hs-pg" || fail "Shell validation failed"

backup="$ROOT/backups/$(date +%Y%m%d-%H%M%S)"
[[ -d "$ROOT" ]] && {
  mkdir -p "$backup"
  cp -a "$ROOT/backend" "$ROOT/plugin" "$ROOT/cli" "$ROOT/systemd" "$backup/" 2>/dev/null || true
}
mkdir -p "$ROOT/backend" "$ROOT/plugin" "$ROOT/cli" "$ROOT/systemd" "$DATA"
install -m 0644 "$TMP/backend/hs_plugin_runtime.py" "$ROOT/backend/hs_plugin_runtime.py"
install -m 0644 "$TMP/backend/hs_plugin_api.py" "$ROOT/backend/hs_plugin_api.py"
install -m 0644 "$TMP/backend/hs_backup_api.py" "$ROOT/backend/hs_backup_api.py"
install -m 0755 "$TMP/backend/hs_backup_agent.py" "$ROOT/backend/hs_backup_agent.py"
install -m 0755 "$TMP/plugin/patch_pasarguard.py" "$ROOT/plugin/patch_pasarguard.py"
install -m 0755 "$TMP/plugin/patch_backup_api.py" "$ROOT/plugin/patch_backup_api.py"
install -m 0755 "$TMP/plugin/integrate-dashboard.sh" "$ROOT/plugin/integrate-dashboard.sh"
install -m 0644 "$TMP/plugin/hs-plugin.js" "$ROOT/plugin/hs-plugin.js"
install -m 0644 "$TMP/plugin/hs-tab-fix.js" "$ROOT/plugin/hs-tab-fix.js"
install -m 0644 "$TMP/plugin/hs-node-pro.js" "$ROOT/plugin/hs-node-pro.js"
install -m 0644 "$TMP/plugin/hs-backup.js" "$ROOT/plugin/hs-backup.js"
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
    "backup_web": {"enabled": false}
  },
  "inbound_offsets": {},
  "updated_at": null
}
JSON
  chmod 600 "$DATA/state.json"
fi

mkdir -p "$DATA/backup-inbox" "$DATA/backup-outbox" "$DATA/backup-jobs"
chmod 700 "$DATA/backup-inbox" "$DATA/backup-outbox" "$DATA/backup-jobs" || true

if command -v systemctl >/dev/null 2>&1; then
  for unit in hs-pg-integrator.service hs-pg-integrator.timer hs-pg-integrator.path hs-pg-backup-agent.service; do
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
fi

log "$MODE files installed in $ROOT"
"$ROOT/plugin/integrate-dashboard.sh" || fail "PasarGuard integration failed safely; no service was restarted"
if [[ $RESTART -eq 1 ]]; then
  log "restarting PasarGuard as explicitly requested"
  /usr/local/bin/hs-pg restart
else
  log "no PasarGuard service restart performed"
  log "host persistence guard is active and will re-apply HS Plugin after PasarGuard update/restart/recreate"
  log "Web Backup backend route requires one PasarGuard restart after first install/update"
  log "run 'sudo hs-pg restart' when backend hooks need activation"
fi
log "future updates: sudo hs-pg update"
