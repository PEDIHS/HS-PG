#!/usr/bin/env bash
set -Eeuo pipefail

HS_ROOT="${HS_ROOT:-/opt/hs-pg}"
PASARGUARD_ROOT="${PASARGUARD_ROOT:-/opt/pasarguard}"
PATCHER="${HS_ROOT}/plugin/patch_shield_api.py"
API="${HS_ROOT}/backend/hs_shield_api.py"
JS="${HS_ROOT}/plugin/hs-shield.js"
MARKER="hs-shield-loader"

log(){ printf '\033[1;33m[HS Shield]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;31m[HS Shield]\033[0m %s\n' "$*" >&2; }
sha12(){ sha256sum "$1" | awk '{print substr($1,1,12)}'; }

for file in "$PATCHER" "$API" "$JS"; do
  [[ -s "$file" ]] || { warn "missing $file"; exit 1; }
done

inject_loader_host(){
  local html="$1" version tag
  [[ -f "$html" ]] || return 0
  version="$(sha12 "$JS")"
  tag="<script id=\"${MARKER}\" src=\"/statics/hs-shield.js?v=${version}\" defer></script>"
  python3 - "$html" "$MARKER" "$tag" <<'PY'
from pathlib import Path
import re, sys
p=Path(sys.argv[1]); marker=sys.argv[2]; tag=sys.argv[3]
old=p.read_text(encoding='utf-8')
pat=re.compile(rf'<script\s+id=["\']{re.escape(marker)}["\'][^>]*>\s*</script>', re.I)
if pat.search(old): new=pat.sub(tag, old, count=1)
elif '</body>' in old.lower(): new=re.sub(r'</body>', tag+'\n</body>', old, count=1, flags=re.I)
else: new=old+'\n'+tag+'\n'
if new != old: p.write_text(new, encoding='utf-8')
PY
}

inject_loader_container(){
  local cid="$1" html="$2" version tag
  docker exec "$cid" test -f "$html" >/dev/null 2>&1 || return 0
  version="$(sha12 "$JS")"
  tag="<script id=\"${MARKER}\" src=\"/statics/hs-shield.js?v=${version}\" defer></script>"
  docker exec -i "$cid" python3 - "$html" "$MARKER" "$tag" <<'PY'
from pathlib import Path
import re, sys
p=Path(sys.argv[1]); marker=sys.argv[2]; tag=sys.argv[3]
old=p.read_text(encoding='utf-8')
pat=re.compile(rf'<script\s+id=["\']{re.escape(marker)}["\'][^>]*>\s*</script>', re.I)
if pat.search(old): new=pat.sub(tag, old, count=1)
elif '</body>' in old.lower(): new=re.sub(r'</body>', tag+'\n</body>', old, count=1, flags=re.I)
else: new=old+'\n'+tag+'\n'
if new != old: p.write_text(new, encoding='utf-8')
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
    python3 "$PATCHER" --app-root "$app" --shield-api "$API"
    log "API hook healthy at $app"
  fi
  build="$(find_host_build || true)"
  if [[ -n "$build" ]]; then
    mkdir -p "$build/statics"
    install -m 0644 "$JS" "$build/statics/hs-shield.js"
    inject_loader_host "$build/index.html"
    inject_loader_host "$build/404.html"
    log "dashboard loader healthy at $build"
  fi
}

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
    docker cp "$PATCHER" "$cid:/tmp/hs-shield-patch.py" >/dev/null
    docker cp "$API" "$cid:/tmp/hs_shield_api.py" >/dev/null
    docker exec "$cid" python3 /tmp/hs-shield-patch.py --app-root "$app" --shield-api /tmp/hs_shield_api.py >/dev/null
    log "API hook healthy in ${cid:0:12} ($app)"
  fi

  build="$(find_container_build "$cid" || true)"
  if [[ -n "$build" ]]; then
    docker exec "$cid" mkdir -p "$build/statics"
    docker cp "$JS" "$cid:$build/statics/hs-shield.js" >/dev/null
    inject_loader_container "$cid" "$build/index.html"
    inject_loader_container "$cid" "$build/404.html"
    log "dashboard loader healthy in ${cid:0:12} ($build)"
  fi
}

main(){
  integrate_host || true
  local found=0 cid image
  if command -v docker >/dev/null 2>&1; then
    while read -r cid; do
      [[ -n "$cid" ]] || continue
      image="$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true)"
      [[ "$image" == *pasarguard/panel* ]] || continue
      integrate_container "$cid"
      found=$((found+1))
    done < <(docker ps -q 2>/dev/null || true)
  fi
  if [[ $found -eq 0 && -z "$(find_host_app || true)" ]]; then
    warn "no active PasarGuard installation found"
    exit 2
  fi
  log "integration complete"
}

main "$@"
