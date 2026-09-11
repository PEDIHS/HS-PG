#!/usr/bin/env bash
set -Eeuo pipefail

HS_ROOT="${HS_ROOT:-/opt/hs-pg}"
PASARGUARD_ROOT="${PASARGUARD_ROOT:-/opt/pasarguard}"
DATA_DIR="${HS_PLUGIN_DATA_DIR:-/var/lib/pasarguard/hs-plugin}"
COMPOSE_FILE="${PASARGUARD_ROOT}/docker-compose.yml"
COMPOSE_PROJECT="${PASARGUARD_COMPOSE_PROJECT:-pasarguard}"
PATCHER="${HS_ROOT}/plugin/patch_pasarguard.py"
ADMIN_JS="${HS_ROOT}/plugin/hs-plugin.js"
TAB_FIX_JS="${HS_ROOT}/plugin/hs-tab-fix.js"
API_ADDON="${HS_ROOT}/backend/hs_plugin_api.py"
RUNTIME="${HS_ROOT}/backend/hs_plugin_runtime.py"
LOADER_MARKER="hs-plugin-loader"
TAB_FIX_MARKER="hs-plugin-tab-fix-loader"

log(){ printf '\033[1;33m[HS Plugin]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;31m[HS Plugin]\033[0m %s\n' "$*" >&2; }
sha12(){ sha256sum "$1" | awk '{print substr($1,1,12)}'; }

for f in "$PATCHER" "$ADMIN_JS" "$TAB_FIX_JS" "$API_ADDON" "$RUNTIME"; do
  [[ -s "$f" ]] || { warn "missing $f"; exit 1; }
done
mkdir -p "$DATA_DIR"

inject_loaders_host(){
  local html="$1" admin_version tab_version
  [[ -f "$html" ]] || return 0
  admin_version="$(sha12 "$ADMIN_JS")"
  tab_version="$(sha12 "$TAB_FIX_JS")"
  python3 - "$html" "$LOADER_MARKER" "$admin_version" "$TAB_FIX_MARKER" "$tab_version" <<'PY'
from pathlib import Path
import re, sys
p=Path(sys.argv[1]); main_marker=sys.argv[2]; main_v=sys.argv[3]; tab_marker=sys.argv[4]; tab_v=sys.argv[5]
old=p.read_text(encoding='utf-8')
main=f'<script id="{main_marker}" src="/statics/hs-plugin.js?v={main_v}" defer></script>'
tab=f'<script id="{tab_marker}" src="/statics/hs-tab-fix.js?v={tab_v}" defer></script>'
new=old
for marker, tag in ((main_marker, main),(tab_marker, tab)):
    pat=re.compile(rf'<script\s+id=["\']{re.escape(marker)}["\'][^>]*>\s*</script>',re.I)
    if pat.search(new):
        new=pat.sub(tag,new,count=1)
    elif '</body>' in new.lower():
        new=re.sub(r'</body>',tag+'\n</body>',new,count=1,flags=re.I)
    else:
        new+='\n'+tag+'\n'
if new!=old: p.write_text(new,encoding='utf-8')
PY
}

inject_loaders_container(){
  local cid="$1" html="$2" admin_version tab_version
  admin_version="$(sha12 "$ADMIN_JS")"
  tab_version="$(sha12 "$TAB_FIX_JS")"
  docker exec "$cid" test -f "$html" >/dev/null 2>&1 || return 0
  docker exec -i "$cid" python3 - "$html" "$LOADER_MARKER" "$admin_version" "$TAB_FIX_MARKER" "$tab_version" <<'PY'
from pathlib import Path
import re, sys
p=Path(sys.argv[1]); main_marker=sys.argv[2]; main_v=sys.argv[3]; tab_marker=sys.argv[4]; tab_v=sys.argv[5]
old=p.read_text(encoding='utf-8')
main=f'<script id="{main_marker}" src="/statics/hs-plugin.js?v={main_v}" defer></script>'
tab=f'<script id="{tab_marker}" src="/statics/hs-tab-fix.js?v={tab_v}" defer></script>'
new=old
for marker, tag in ((main_marker, main),(tab_marker, tab)):
    pat=re.compile(rf'<script\s+id=["\']{re.escape(marker)}["\'][^>]*>\s*</script>',re.I)
    if pat.search(new):
        new=pat.sub(tag,new,count=1)
    elif '</body>' in new.lower():
        new=re.sub(r'</body>',tag+'\n</body>',new,count=1,flags=re.I)
    else:
        new+='\n'+tag+'\n'
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
    python3 "$PATCHER" --app-root "$app" --api-addon "$API_ADDON" --runtime "$RUNTIME"
    log "backend source hooks healthy at $app"
  fi
  build="$(find_host_build || true)"
  if [[ -n "$build" ]]; then
    mkdir -p "$build/statics"
    install -m 0644 "$ADMIN_JS" "$build/statics/hs-plugin.js"
    install -m 0644 "$TAB_FIX_JS" "$build/statics/hs-tab-fix.js"
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
    docker cp "$API_ADDON" "$cid:/tmp/hs_plugin_api.py" >/dev/null
    docker cp "$RUNTIME" "$cid:/tmp/hs_plugin_runtime.py" >/dev/null
    docker exec "$cid" python3 /tmp/hs-pg-patch.py --app-root "$app" --api-addon /tmp/hs_plugin_api.py --runtime /tmp/hs_plugin_runtime.py >/dev/null
    log "backend source hooks healthy in ${cid:0:12} ($app)"
  fi

  build="$(find_container_build "$cid" || true)"
  if [[ -n "$build" ]]; then
    docker exec "$cid" mkdir -p "$build/statics"
    docker cp "$ADMIN_JS" "$cid:$build/statics/hs-plugin.js" >/dev/null
    docker cp "$TAB_FIX_JS" "$cid:$build/statics/hs-tab-fix.js" >/dev/null
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
  log "integration complete; HS tab fallback and backend hooks are installed"
}

main "$@"
