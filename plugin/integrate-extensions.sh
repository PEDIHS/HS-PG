#!/usr/bin/env bash
set -Eeuo pipefail

HS_ROOT="${HS_ROOT:-/opt/hs-pg}"
PASARGUARD_ROOT="${PASARGUARD_ROOT:-/opt/pasarguard}"
PATCHER="$HS_ROOT/plugin/patch_extensions.py"
API="$HS_ROOT/backend/hs_extensions_api.py"
RUNTIME="$HS_ROOT/backend/hs_fair_use_runtime.py"
RECONCILE="$HS_ROOT/backend/hs_fair_reconcile.py"
SERVICES="$HS_ROOT/backend/hs_services.py"
NATIVE_JS="$HS_ROOT/plugin/hs-native-extensions.js"
FIREWALL_JS="$HS_ROOT/plugin/hs-firewall-charts.js"

log(){ printf '\033[1;33m[HS Extensions]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;31m[HS Extensions]\033[0m %s\n' "$*" >&2; }
sha12(){ sha256sum "$1" | awk '{print substr($1,1,12)}'; }

for file in "$PATCHER" "$API" "$RUNTIME" "$RECONCILE" "$SERVICES" "$NATIVE_JS" "$FIREWALL_JS"; do
  [[ -s "$file" ]] || { warn "missing $file"; exit 1; }
done

patch_host_html(){
  local html="$1" nv fv
  [[ -f "$html" ]] || return 0
  nv="$(sha12 "$NATIVE_JS")"; fv="$(sha12 "$FIREWALL_JS")"
  python3 - "$html" "$nv" "$fv" <<'PY'
from pathlib import Path
import re,sys
p=Path(sys.argv[1]); text=p.read_text(encoding='utf-8')
for marker,src in [
    ('hs-native-extensions-loader',f'/statics/hs-native-extensions.js?v={sys.argv[2]}'),
    ('hs-firewall-charts-loader',f'/statics/hs-firewall-charts.js?v={sys.argv[3]}'),
]:
    tag=f'<script id="{marker}" src="{src}" defer></script>'
    pattern=re.compile(rf'<script\s+id=["\']{marker}["\'][^>]*>\s*</script>',re.I)
    if pattern.search(text): text=pattern.sub(tag,text,count=1)
    elif re.search(r'</body>',text,re.I): text=re.sub(r'</body>',tag+'\n</body>',text,count=1,flags=re.I)
    else: text+='\n'+tag+'\n'
p.write_text(text,encoding='utf-8')
PY
}

patch_container_html(){
  local cid="$1" html="$2" nv fv
  nv="$(sha12 "$NATIVE_JS")"; fv="$(sha12 "$FIREWALL_JS")"
  docker exec "$cid" test -f "$html" >/dev/null 2>&1 || return 0
  docker exec -i "$cid" python3 - "$html" "$nv" "$fv" <<'PY'
from pathlib import Path
import re,sys
p=Path(sys.argv[1]); text=p.read_text(encoding='utf-8')
for marker,src in [
    ('hs-native-extensions-loader',f'/statics/hs-native-extensions.js?v={sys.argv[2]}'),
    ('hs-firewall-charts-loader',f'/statics/hs-firewall-charts.js?v={sys.argv[3]}'),
]:
    tag=f'<script id="{marker}" src="{src}" defer></script>'
    pattern=re.compile(rf'<script\s+id=["\']{marker}["\'][^>]*>\s*</script>',re.I)
    if pattern.search(text): text=pattern.sub(tag,text,count=1)
    elif re.search(r'</body>',text,re.I): text=re.sub(r'</body>',tag+'\n</body>',text,count=1,flags=re.I)
    else: text+='\n'+tag+'\n'
p.write_text(text,encoding='utf-8')
PY
}

find_host_app(){ local p; for p in "$PASARGUARD_ROOT/app" "$PASARGUARD_ROOT/panel/app"; do [[ -f "$p/routers/__init__.py" ]] && { echo "$p"; return; }; done; }
find_host_build(){ local p; for p in "$PASARGUARD_ROOT/dashboard/build" "$PASARGUARD_ROOT/panel/dashboard/build"; do [[ -f "$p/index.html" ]] && { echo "$p"; return; }; done; }

integrate_host(){
  local app build
  app="$(find_host_app || true)"
  if [[ -n "$app" ]]; then
    python3 "$PATCHER" --app-root "$app" --api "$API" --runtime "$RUNTIME" --reconcile "$RECONCILE" --services "$SERVICES"
    log "backend native hooks healthy at $app"
  fi
  build="$(find_host_build || true)"
  if [[ -n "$build" ]]; then
    mkdir -p "$build/statics"
    install -m 0644 "$NATIVE_JS" "$build/statics/hs-native-extensions.js"
    install -m 0644 "$FIREWALL_JS" "$build/statics/hs-firewall-charts.js"
    patch_host_html "$build/index.html"; patch_host_html "$build/404.html"
    log "native UI assets healthy at $build"
  fi
}

container_ids(){
  command -v docker >/dev/null 2>&1 || return 0
  local cid image
  while read -r cid; do
    [[ -n "$cid" ]] || continue
    image="$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true)"
    [[ "$image" == *pasarguard/panel* ]] && echo "$cid"
  done < <(docker ps -q 2>/dev/null || true)
}
find_container_app(){ local cid="$1" f; f="$(docker exec "$cid" sh -c "find /code /app /opt -maxdepth 5 -type f -path '*/app/routers/__init__.py' -print -quit 2>/dev/null" 2>/dev/null || true)"; [[ -n "$f" ]] && echo "${f%/routers/__init__.py}"; }
find_container_build(){ local cid="$1" f; f="$(docker exec "$cid" sh -c "find /code /app /opt -maxdepth 6 -type f -path '*/dashboard/build/index.html' -print -quit 2>/dev/null" 2>/dev/null || true)"; [[ -n "$f" ]] && echo "${f%/index.html}"; }

integrate_container(){
  local cid="$1" app build expected actual
  app="$(find_container_app "$cid" || true)"
  if [[ -n "$app" ]]; then
    docker cp "$PATCHER" "$cid:/tmp/hs-patch-extensions.py" >/dev/null
    docker cp "$API" "$cid:/tmp/hs_extensions_api.py" >/dev/null
    docker cp "$RUNTIME" "$cid:/tmp/hs_fair_use_runtime.py" >/dev/null
    docker cp "$RECONCILE" "$cid:/tmp/hs_fair_reconcile.py" >/dev/null
    docker cp "$SERVICES" "$cid:/tmp/hs_services_runtime.py" >/dev/null
    docker exec "$cid" python3 /tmp/hs-patch-extensions.py --app-root "$app" --api /tmp/hs_extensions_api.py --runtime /tmp/hs_fair_use_runtime.py --reconcile /tmp/hs_fair_reconcile.py --services /tmp/hs_services_runtime.py >/dev/null
    log "backend hooks healthy in ${cid:0:12}"
  fi
  build="$(find_container_build "$cid" || true)"
  [[ -n "$build" ]] || { warn "dashboard build not found in ${cid:0:12}"; return 1; }
  docker exec "$cid" mkdir -p "$build/statics"
  docker cp "$NATIVE_JS" "$cid:$build/statics/hs-native-extensions.js" >/dev/null
  docker cp "$FIREWALL_JS" "$cid:$build/statics/hs-firewall-charts.js" >/dev/null
  patch_container_html "$cid" "$build/index.html"; patch_container_html "$cid" "$build/404.html"
  expected="$(sha12 "$NATIVE_JS")"
  actual="$(docker exec "$cid" sha256sum "$build/statics/hs-native-extensions.js" 2>/dev/null | awk '{print substr($1,1,12)}' || true)"
  [[ "$actual" == "$expected" ]] || { warn "asset verification failed in ${cid:0:12}"; return 2; }
  docker exec "$cid" grep -q "hs-native-extensions.js?v=$expected" "$build/index.html" || { warn "loader verification failed in ${cid:0:12}"; return 3; }
}

main(){
  integrate_host || true
  local count=0 cid
  while read -r cid; do [[ -n "$cid" ]] || continue; integrate_container "$cid"; count=$((count+1)); done < <(container_ids)
  if [[ $count -eq 0 && -z "$(find_host_app || true)" ]]; then warn "no active PasarGuard installation found"; exit 2; fi
  log "extension integration complete"
}
main "$@"
