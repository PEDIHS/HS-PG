#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root'; exit 1; }
PANEL="${1:-}"; NODE_ID="${2:-}"; BOOTSTRAP="${3:-${HS_BOOTSTRAP_TOKEN:-}}"; REF="${HS_REF:-main}"
[[ "$PANEL" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ && ( "$NODE_ID" == auto || "$NODE_ID" =~ ^[0-9]+$ ) && ${#BOOTSTRAP} -ge 20 ]] || {
  echo 'Usage: install-node-bridge.sh https://panel.example.com NODE_ID|auto ONE_TIME_BOOTSTRAP'; exit 1;
}
for cmd in curl python3 systemctl; do command -v "$cmd" >/dev/null || { echo "$cmd is required"; exit 1; }; done
umask 077
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BASE="https://raw.githubusercontent.com/PEDIHS/HS-PG/$REF"
if [[ "$NODE_ID" == auto ]]; then
  PG_ENV="${HS_PG_ENV:-/opt/pg-node/.env}"; PG_CERT="${HS_PG_CERT:-/var/lib/pg-node/certs/ssl_cert.pem}"
  [[ -s "$PG_ENV" && -s "$PG_CERT" ]] || { echo 'PasarGuard node env/certificate not found'; exit 1; }
  request_json="$(python3 - "$BOOTSTRAP" "$PG_ENV" "$PG_CERT" <<'PY'
import json,sys
from pathlib import Path
bootstrap,env_path,cert_path=sys.argv[1:]
value=''
for line in Path(env_path).read_text().splitlines():
    if line.startswith('API_KEY='): value=line.split('=',1)[1].strip().strip('"\''); break
if not value: raise SystemExit('API_KEY missing from PasarGuard node env')
print(json.dumps({'bootstrap_token':bootstrap,'api_key':value,'server_ca':Path(cert_path).read_text()}))
PY
)"
  response="$(curl -fsS --retry 3 --connect-timeout 15 --max-time 60 -H 'Content-Type: application/json' -d "$request_json" "$PANEL/api/hs-services/node-register")"
  NODE_ID="$(printf '%s' "$response" | python3 -c 'import json,sys;print(json.load(sys.stdin)["target"])')"
  AGENT_TOKEN="$(printf '%s' "$response" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')"
else
  json_token="$(python3 -c 'import json,sys;print(json.dumps({"bootstrap_token":sys.argv[1]}))' "$BOOTSTRAP")"
  response="$(curl -fsS --retry 3 --connect-timeout 15 --max-time 60 -H 'Content-Type: application/json' -d "$json_token" "$PANEL/api/hs-services/agents/$NODE_ID/exchange")"
  AGENT_TOKEN="$(printf '%s' "$response" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')"
fi
unset BOOTSTRAP request_json json_token response
for name in hs_services.py hs_services_agent.py; do
  curl -fsSL --retry 3 --connect-timeout 15 --max-time 120 "$BASE/backend/$name" -o "$TMP/$name"
done
curl -fsSL --retry 3 --connect-timeout 15 --max-time 120 "$BASE/plugin/retire-firewall.sh" -o "$TMP/retire-firewall.sh"
python3 -m py_compile "$TMP"/*.py
bash -n "$TMP/retire-firewall.sh"

NODE_CONTAINER=''; NODE_DATA_HOST=''; NODE_DATA_CONTAINER=''; NODE_WORKDIR=''; NODE_ENV=''
if command -v docker >/dev/null; then
  while IFS='|' read -r cid name image; do
    [[ "$image" == pasarguard/node* ]] || continue
    [[ -z "$NODE_CONTAINER" ]] || { echo 'Multiple PasarGuard node containers detected; set up Fair Core manually'; NODE_CONTAINER=''; break; }
    NODE_CONTAINER="$cid"
  done < <(docker ps --format '{{.ID}}|{{.Names}}|{{.Image}}')
fi
if [[ -n "$NODE_CONTAINER" ]]; then
  readarray -t mount < <(docker inspect "$NODE_CONTAINER" | python3 -c 'import json,sys; d=json.load(sys.stdin)[0]; m=next((x for x in d.get("Mounts",[]) if x.get("Destination","").startswith("/var/lib/")),None); print(m.get("Source","") if m else ""); print(m.get("Destination","") if m else "")')
  NODE_DATA_HOST="${mount[0]:-}"; NODE_DATA_CONTAINER="${mount[1]:-}"
  NODE_WORKDIR="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$NODE_CONTAINER" 2>/dev/null || true)"
  [[ -n "$NODE_WORKDIR" && -f "$NODE_WORKDIR/.env" ]] && NODE_ENV="$NODE_WORKDIR/.env"
fi

FAIR_READY=false
if [[ -n "$NODE_CONTAINER" && -n "$NODE_DATA_HOST" && -n "$NODE_DATA_CONTAINER" && -n "$NODE_ENV" && "${HS_INSTALL_FAIR_CORE:-1}" != 0 ]]; then
  current="$(docker exec "$NODE_CONTAINER" /usr/local/bin/xray version 2>/dev/null | head -1 | awk '{print $2}' || true)"
  [[ "$current" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || current='26.3.27'
  mkdir -p "$TMP/core/hsfair" "$NODE_DATA_HOST/hs"
  fair_bin="$NODE_DATA_HOST/xray-hs-fair"
  valid_fair(){
    [[ -x "$1" ]] || return 1
    [[ "$("$1" version 2>/dev/null | head -1 | awk '{print $2}')" == "$current" ]]
  }
  if valid_fair "$fair_bin"; then
    echo "Reusing HS Fair Core for Xray $current"
  else
    arch="$(uname -m)"; asset_arch=''
    [[ "$arch" == x86_64 || "$arch" == amd64 ]] && asset_arch='amd64'
    asset_url="${HS_FAIR_CORE_BINARY_URL:-}"
    [[ -n "$asset_url" || -z "$asset_arch" ]] || asset_url="https://github.com/PEDIHS/HS-PG/releases/download/fair-core-v1/xray-hs-fair-${current}-linux-${asset_arch}"
    downloaded=false
    if [[ -n "$asset_url" ]] && curl -fL --silent --show-error --retry 2 --connect-timeout 15 --max-time 180 "$asset_url" -o "$TMP/xray-hs-fair"; then
      chmod 0755 "$TMP/xray-hs-fair"
      if valid_fair "$TMP/xray-hs-fair"; then install -m 0755 "$TMP/xray-hs-fair" "$fair_bin"; downloaded=true; fi
    fi
    if [[ "$downloaded" != true ]]; then
      echo "Prebuilt Fair Core unavailable; building Xray $current locally"
      curl -fsSL --retry 3 "$BASE/plugin/patch_fair_core.py" -o "$TMP/patch_fair_core.py"
      for name in link.go limit.go limit_test.go; do curl -fsSL --retry 3 "$BASE/core/hsfair/$name" -o "$TMP/core/hsfair/$name"; done
      curl -fsSL --retry 3 "https://github.com/XTLS/Xray-core/archive/refs/tags/v${current}.tar.gz" -o "$TMP/xray.tgz"
      tar -xzf "$TMP/xray.tgz" -C "$TMP"
      source_dir="$(find "$TMP" -maxdepth 1 -type d -name 'Xray-core-*' | head -1)"
      python3 "$TMP/patch_fair_core.py" "$source_dir" "$TMP/core/hsfair"
      if command -v go >/dev/null; then
        (cd "$source_dir" && go test ./common/hsfair && CGO_ENABLED=0 go build -trimpath -o "$fair_bin" ./main)
      else
        docker run --rm -v "$source_dir:/src" -w /src golang:1.27-bookworm sh -c 'go test ./common/hsfair && CGO_ENABLED=0 go build -trimpath -o /src/xray-hs-fair ./main'
        install -m 0755 "$source_dir/xray-hs-fair" "$fair_bin"
      fi
    fi
  fi
  chmod 0755 "$NODE_DATA_HOST/xray-hs-fair"
  python3 - "$NODE_ENV" "$NODE_DATA_CONTAINER/xray-hs-fair" "$NODE_DATA_CONTAINER/hs/fair-policy.json" <<'PY'
from pathlib import Path
import sys
path=Path(sys.argv[1]); values={'XRAY_EXECUTABLE_PATH':sys.argv[2],'HS_FAIR_POLICY_FILE':sys.argv[3]}
lines=path.read_text().splitlines(); seen=set(); out=[]
for line in lines:
    key=line.split('=',1)[0] if '=' in line and not line.lstrip().startswith('#') else ''
    if key in values: out.append(f'{key}={values[key]}'); seen.add(key)
    else: out.append(line)
for key,value in values.items():
    if key not in seen: out.append(f'{key}={value}')
path.write_text('\n'.join(out)+'\n')
PY
  FAIR_POLICY_HOST="$NODE_DATA_HOST/hs/fair-policy.json"
  FAIR_READY=true
else
  FAIR_POLICY_HOST='/var/lib/hs-pg-agent/fair-policy.json'
fi

systemctl disable --now hs-services-agent.service >/dev/null 2>&1 || true
bash "$TMP/retire-firewall.sh"
install -d -m 0700 /etc/hs-pg /var/lib/hs-pg-agent
install -d -m 0755 /opt/hs-pg/backend
printf '%s\n' "$AGENT_TOKEN" > /etc/hs-pg/agent-token
chmod 0600 /etc/hs-pg/agent-token
install -m 0644 "$TMP"/*.py /opt/hs-pg/backend/
python3 - "$FAIR_POLICY_HOST" <<'PY'
from pathlib import Path
import json,sys
p=Path('/etc/hs-pg/services.json')
try: data=json.loads(p.read_text())
except (OSError,ValueError): data={}
data['fair_policy_file']=sys.argv[1]
p.write_text(json.dumps(data,indent=2,sort_keys=True)+'\n')
p.chmod(0o600)
PY
cat > /etc/systemd/system/hs-node-bridge.service <<UNIT
[Unit]
Description=HS Node Bridge
After=network-online.target docker.service
Wants=network-online.target
[Service]
Type=simple
User=root
UMask=0077
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 /opt/hs-pg/backend/hs_services_agent.py --panel $PANEL --target $NODE_ID --token-file /etc/hs-pg/agent-token
Restart=on-failure
RestartSec=5
PrivateTmp=true
NoNewPrivileges=true
ProtectHome=true
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now hs-node-bridge.service
if [[ "$FAIR_READY" == true ]]; then
  (cd "$NODE_WORKDIR" && docker compose up -d)
fi
sleep 2
systemctl is-active --quiet hs-node-bridge.service || { journalctl -u hs-node-bridge.service -n 30 --no-pager; exit 1; }
echo "HS Node Bridge connected: target=$NODE_ID fair_core=$FAIR_READY"
