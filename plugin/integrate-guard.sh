#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
LOCK=/run/hs-pg-integrator.lock
STATE=/var/lib/pasarguard/hs-plugin/integrator.state
exec 9>"$LOCK"
flock -n 9 || exit 0
mkdir -p "$(dirname "$STATE")"

source_rev(){
  find /opt/hs-pg/backend /opt/hs-pg/plugin /opt/zomorod/backend /opt/zomorod/plugin \
    -maxdepth 2 -type f \( -name '*.py' -o -name '*.js' -o -name '*.sh' \) \
    ! -name 'integrate-guard.sh' -print0 2>/dev/null \
    | sort -z | xargs -0 -r sha256sum | sha256sum | awk '{print $1}'
}

cid="$(docker ps --filter ancestor=pasarguard/panel:latest -q 2>/dev/null | head -1 || true)"
rev="$(source_rev)"
prev_cid=''; prev_rev=''
[[ -f "$STATE" ]] && read -r prev_cid prev_rev < "$STATE" || true

# Container identity + source tree digest are enough for the frequent health check.
# A recreated container changes CID; any deploy changes rev. This avoids dozens of
# docker exec/compose processes when nothing changed.
if [[ -n "$cid" && "$cid" == "$prev_cid" && "$rev" == "$prev_rev" ]]; then
  echo '[HS Integrator] unchanged; skipping reconcile'
  exit 0
fi

echo '[HS Integrator] change detected; running reconcile'
/bin/bash /opt/hs-pg/plugin/integrate-dashboard.sh
/bin/bash /opt/hs-pg/plugin/integrate-services.sh
[[ ! -x /opt/zomorod/plugin/integrate-dashboard.sh ]] || /bin/bash /opt/zomorod/plugin/integrate-dashboard.sh
cid="$(docker ps --filter ancestor=pasarguard/panel:latest -q 2>/dev/null | head -1 || true)"
printf '%s %s\n' "$cid" "$(source_rev)" > "$STATE"
chmod 600 "$STATE"
echo '[HS Integrator] reconcile complete'
