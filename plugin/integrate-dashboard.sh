#!/usr/bin/env bash
set -Eeuo pipefail

HS_ROOT="${HS_ROOT:-/opt/hs-pg}"
PASARGUARD_ROOT="${PASARGUARD_ROOT:-/opt/pasarguard}"
DATA_DIR="${HS_PLUGIN_DATA_DIR:-/var/lib/pasarguard/hs-plugin}"
COMPOSE_FILE="${PASARGUARD_ROOT}/docker-compose.yml"
COMPOSE_PROJECT="${PASARGUARD_COMPOSE_PROJECT:-pasarguard}"
PATCHER="${HS_ROOT}/plugin/patch_pasarguard.py"
BACKUP_PATCHER="${HS_ROOT}/plugin/patch_backup_api.py"
ADMIN_JS="${HS_ROOT}/plugin/hs-plugin.js"
TAB_FIX_JS="${HS_ROOT}/plugin/hs-tab-fix.js"
NODE_PRO_JS="${HS_ROOT}/plugin/hs-node-pro.js"
BACKUP_JS="${HS_ROOT}/plugin/hs-backup.js"
BACKUP_WATCH_JS="${HS_ROOT}/plugin/hs-backup-tab-watchdog.js"
ADMIN_TIME_JS="${HS_ROOT}/plugin/hs-admin-time.js"
API_ADDON="${HS_ROOT}/backend/hs_plugin_api.py"
BACKUP_API="${HS_ROOT}/backend/hs_backup_api.py"
RUNTIME="${HS_ROOT}/backend/hs_plugin_runtime.py"
ADMIN_TIME_RUNTIME="${HS_ROOT}/backend/hs_admin_time.py"
LOADER_MARKER="hs-plugin-loader"
TAB_FIX_MARKER="hs-plugin-tab-fix-loader"
NODE_PRO_MARKER="hs-plugin-node-pro-loader"
BACKUP_MARKER="hs-plugin-backup-loader"
BACKUP_WATCH_MARKER="hs-plugin-backup-tab-watchdog-loader"
ADMIN_TIME_MARKER="hs-plugin-admin-time-loader"
LEGACY_NODE_IP_MARKER="hs-plugin-node-ip-fix-loader"

log(){ printf '\033[1;33m[HS Plugin]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;31m[HS Plugin]\033[0m %s\n' "$*" >&2; }
sha12(){ sha256sum "$1" | awk '{print substr($1,1,12)}'; }

for f in "$PATCHER" "$BACKUP_PATCHER" "$ADMIN_JS" "$TAB_FIX_JS" "$NODE_PRO_JS" "$BACKUP_JS" "$BACKUP_WATCH_JS" "$ADMIN_TIME_JS" "$API_ADDON" "$BACKUP_API" "$RUNTIME" "$ADMIN_TIME_RUNTIME"; do
  [[ -s "$f" ]] || { warn "missing $f"; exit 1; }
done
mkdir -p "$DATA_DIR"

inject_loaders_host(){
  local html="$1" admin_version tab_version node_version backup_version backup_watch_version admin_time_version
  [[ -f "$html" ]] || return 0
  admin_version="$(sha12 "$ADMIN_JS")"
  tab_version="$(sha12 "$TAB_FIX_JS")"
  node_version="$(sha12 "$NODE_PRO_JS")"
  backup_version="$(sha12 "$BACKUP_JS")"
  backup_watch_version="$(sha12 "$BACKUP_WATCH_JS")"
  admin_time_version="$(sha12 "$ADMIN_TIME_JS")"
  python3 - "$html" "$LOADER_MARKER" "$admin_version" "$TAB_FIX_MARKER" "$tab_version" "$NODE_PRO_MARKER" "$node_version" "$BACKUP_MARKER" "$backup_version" "$BACKUP_WATCH_MARKER" "$backup_watch_version" "$ADMIN_TIME_MARKER" "$admin_time_version" "$LEGACY_NODE_IP_MARKER" <<'PY'
from pathlib import Path
import re, sys
p=Path(sys.argv[1]); old=p.read_text(encoding='utf-8')
entries=[
    (sys.argv[2], f'/statics/hs-plugin.js?v={sys.argv[3]}'),
    (sys.argv[4], f'/statics/hs-tab-fix.js?v={sys.argv[5]}'),
    (sys.argv[6], f'/statics/hs-node-pro.js?v={sys.argv[7]}'),
    (sys.argv[8], f'/statics/hs-backup.js?v={sys.argv[9]}'),
    (sys.argv[10], f'/statics/hs-backup-tab-watchdog.js?v={sys.argv[11]}'),
    (sys.argv[12], f'/statics/hs-admin-time.js?v={sys.argv[13]}'),
]
legacy=[sys.argv[14]]
new=old
for marker, src in entries:
    tag=f'<script id="{marker}" src="{src}" defer></script>'
    pat=re.compile(rf'<script\s+id=["\']{re.escape(marker)}["\'][^>]*>\s*</script>',re.I)
    if pat.search(new):
        new=pat.sub(tag,new,count=1)
    elif '</body>' in new.lower():
        new=re.sub(r'</body>',tag+'\n</body>',new,count=1,flags=re.I)
    else:
        new+='\n'+tag+'\n'
for marker in legacy:
    pat=re.compile(rf'<script\s+id=["\']{re.escape(marker)}["\'][^>]*>\s*</script>\s*',re.I)
    new=pat.sub('',new)
if new!=old: p.write_text(new,encoding='utf-8')
PY
}

inject_loaders_container(){
  local cid="$1" html="$2" admin_version tab_version node_version backup_version backup_watch_version admin_time_version
  admin_version="$(sha12 "$ADMIN_JS")"
  tab_version="$(sha12 "$TAB_FIX_JS")"
  node_version="$(sha12 "$NODE_PRO_JS")"
  backup_version="$(sha12 "$BACKUP_JS")"
  backup_watch_version="$(sha12 "$BACKUP_WATCH_JS")"
  admin_time_version="$(sha12 "$ADMIN_TIME_JS")"
  docker exec "$cid" test -f "$html" >/dev/null 2>&1 || return 0
  docker exec -i "$cid" python3 - "$html" "$LOADER_MARKER" "$admin_version" "$TAB_FIX_MARKER" "$tab_version" "$NODE_PRO_MARKER" "$node_version" "$BACKUP_MARKER" "$backup_version" "$BACKUP_WATCH_MARKER" "$backup_watch_version" "$ADMIN_TIME_MARKER" "$admin_time_version" "$LEGACY_NODE_IP_MARKER" <<'PY'
from pathlib import Path
import re, sys
p=Path(sys.argv[1]); old=p.read_text(encoding='utf-8')
entries=[
    (sys.argv[2], f'/statics/hs-plugin.js?v={sys.argv[3]}'),
    (sys.argv[4], f'/statics/hs-tab-fix.js?v={sys.argv[5]}'),
    (sys.argv[6], f'/statics/hs-node-pro.js?v={sys.argv[7]}'),
    (sys.argv[8], f'/statics/hs-backup.js?v={sys.argv[9]}'),
    (sys.argv[10], f'/statics/hs-backup-tab-watchdog.js?v={sys.argv[11]}'),
    (sys.argv[12], f'/statics/hs-admin-time.js?v={sys.argv[13]}'),
]
legacy=[sys.argv[14]]
new=old
for marker, src in entries:
    tag=f'<script id="{marker}" src="{src}" defer></script>'
    pat=re.compile(rf'<script\s+id=["\']{re.escape(marker)}["\'][^>]*>\s*</script>',re.I)
    if pat.search(new):
        new=pat.sub(tag,new,count=1)
    elif '</body>' in new.lower():
        new=re.sub(r'</body>',tag+'\n</body>',new,count=1,flags=re.I)
    else:
        new+='\n'+tag+'\n'
for marker in legacy:
    pat=re.compile(rf'<script\s+id=["\']{re.escape(marker)}["\'][^>]*>\s*</script>\s*',re.I)
    new=pat.sub('',new)
if new!=old: p.write_text(new,encoding='utf-8')
PY
}

find_host_app(){
  local p
  for p in "$PASARGUARD_ROOT/app" "$PASARGUARD_ROOT/panel/app"; do
    [[ -f "$p/routers/__init__.py" ]] && { printf '%s\n' "$p"; return; }
  done
}

find_host_build(){
  local p
  for p in "$PASARGUARD_ROOT/dashboard/build" "$PASARGUARD_ROOT/panel/dashboard/build"; do
    [[ -f "$p/index.html" ]] && { printf '%s\n' "$p"; return; }
  done
}

integrate_host(){
  local app build
  app="$(find_host_app || true)"
  if [[ -n "$app" ]]; then
    install -m 0644 "$ADMIN_TIME_RUNTIME" "$app/hs_admin_time.py"
    python3 -m py_compile "$app/hs_admin_time.py"
    python3 "$PATCHER" --app-root "$app" --api-addon "$API_ADDON" --runtime "$RUNTIME"
    python3 "$BACKUP_PATCHER" --app-root "$app" --backup-api "$BACKUP_API"
    log "backend source hooks healthy at $app"
  fi
  build="$(find_host_build || true)"
  if [[ -n "$build" ]]; then
    mkdir -p "$build/statics"
    install -m 0644 "$ADMIN_JS" "$build/statics/hs-plugin.js"
    install -m 0644 "$TAB_FIX_JS" "$build/statics/hs-tab-fix.js"
    install -m 0644 "$NODE_PRO_JS" "$build/statics/hs-node-pro.js"
    install -m 0644 "$BACKUP_JS" "$build/statics/hs-backup.js"
    install -m 0644 "$BACKUP_WATCH_JS" "$build/statics/hs-backup-tab-watchdog.js"
    install -m 0644 "$ADMIN_TIME_JS" "$build/statics/hs-admin-time.js"
    rm -f "$build/statics/hs-node-ip-fix.js"
    inject_loaders_host "$build/index.html"
    inject_loaders_host "$build/404.html"
    log "dashboard loaders healthy at $build"
  fi
}

compose_available(){ command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && [[ -f "$COMPOSE_FILE" ]]; }
container_ids(){ if compose_available; then docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" ps -q 2>/dev/null || true; fi; }

find_container_app(){
  local cid="$1" f
  f="$(docker exec "$cid" sh -c "find /code /app /opt -maxdepth 5 -type f -path '*/app/routers/__init__.py' -print -quit 2>/dev/null" 2>/dev/null || true)"
  [[ -n "$f" ]] && printf '%s\n' "${f%/routers/__init__.py}"
}

find_container_build(){
  local cid="$1" f
  f="$(docker exec "$cid" sh -c "find /code /app /opt -maxdepth 6 -type f -path '*/dashboard/build/index.html' -print -quit 2>/dev/null" 2>/dev/null || true)"
  [[ -n "$f" ]] && printf '%s\n' "${f%/index.html}"
}

integrate_container(){
  local cid="$1" app build image
  [[ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || true)" == true ]] || return 0
  image="$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true)"
  [[ "$image" == *pasarguard/panel* ]] || return 0

  app="$(find_container_app "$cid" || true)"
  if [[ -n "$app" ]]; then
    docker cp "$PATCHER" "$cid:/tmp/hs-pg-patch.py" >/dev/null
    docker cp "$BACKUP_PATCHER" "$cid:/tmp/hs-pg-backup-patch.py" >/dev/null
    docker cp "$API_ADDON" "$cid:/tmp/hs_plugin_api.py" >/dev/null
    docker cp "$BACKUP_API" "$cid:/tmp/hs_backup_api.py" >/dev/null
    docker cp "$RUNTIME" "$cid:/tmp/hs_plugin_runtime.py" >/dev/null
    docker cp "$ADMIN_TIME_RUNTIME" "$cid:$app/hs_admin_time.py" >/dev/null
    docker exec "$cid" python3 -m py_compile "$app/hs_admin_time.py" >/dev/null
    docker exec "$cid" python3 /tmp/hs-pg-patch.py --app-root "$app" --api-addon /tmp/hs_plugin_api.py --runtime /tmp/hs_plugin_runtime.py >/dev/null
    docker exec "$cid" python3 /tmp/hs-pg-backup-patch.py --app-root "$app" --backup-api /tmp/hs_backup_api.py >/dev/null
    log "backend source hooks healthy in ${cid:0:12} ($app)"
  fi

  build="$(find_container_build "$cid" || true)"
  if [[ -n "$build" ]]; then
    docker exec "$cid" mkdir -p "$build/statics"
    docker cp "$ADMIN_JS" "$cid:$build/statics/hs-plugin.js" >/dev/null
    docker cp "$TAB_FIX_JS" "$cid:$build/statics/hs-tab-fix.js" >/dev/null
    docker cp "$NODE_PRO_JS" "$cid:$build/statics/hs-node-pro.js" >/dev/null
    docker cp "$BACKUP_JS" "$cid:$build/statics/hs-backup.js" >/dev/null
    docker cp "$BACKUP_WATCH_JS" "$cid:$build/statics/hs-backup-tab-watchdog.js" >/dev/null
    docker cp "$ADMIN_TIME_JS" "$cid:$build/statics/hs-admin-time.js" >/dev/null
    docker exec "$cid" rm -f "$build/statics/hs-node-ip-fix.js" >/dev/null 2>&1 || true
    inject_loaders_container "$cid" "$build/index.html"
    inject_loaders_container "$cid" "$build/404.html"
    log "dashboard loaders healthy in ${cid:0:12} ($build)"
  fi
}

main(){
  integrate_host || true
  local ids cid count=0
  ids="$(container_ids)"
  while read -r cid; do
    [[ -n "$cid" ]] || continue
    integrate_container "$cid"
    count=$((count+1))
  done <<<"$ids"

  if [[ $count -eq 0 && -z "$(find_host_app || true)" ]]; then
    warn "no active PasarGuard installation found"
    exit 2
  fi
  log "integration complete; HS tab, Node PRO, Web Backup, Admin Time Limit and backend hooks are installed"
}

main "$@"