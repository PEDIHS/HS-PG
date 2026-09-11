#!/usr/bin/env bash
set -Eeuo pipefail
# Run on a node after enrolling it in HS Plugin > Certificates > Node agents.
[[ $EUID -eq 0 ]] || { echo 'Run as root'; exit 1; }
PANEL="${1:-}"; NODE_ID="${2:-}"; TOKEN_FILE="${3:-}"; REF="${HS_REF:-main}"
[[ "$PANEL" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ && "$NODE_ID" =~ ^[0-9]+$ && -s "$TOKEN_FILE" ]] || {
  echo 'Usage: install-node-agent.sh https://panel.example.com NODE_ID /path/to/token-file'; exit 1;
}
command -v python3 >/dev/null
command -v systemctl >/dev/null
agent_tmp="$(mktemp -d)"
trap 'rm -rf "$agent_tmp"' EXIT
for name in hs_services.py hs_services_agent.py hs_services_agent_v2.py; do
  curl -fsSL --retry 3 --connect-timeout 15 --max-time 120 "https://raw.githubusercontent.com/PEDIHS/HS-PG/$REF/backend/$name" -o "$agent_tmp/$name"
done
python3 -m py_compile "$agent_tmp"/*.py
install -d -m 0700 /etc/hs-pg /var/lib/hs-pg-agent
install -d -m 0755 /opt/hs-pg/backend
install -m 0600 "$TOKEN_FILE" /etc/hs-pg/agent-token.new
mv /etc/hs-pg/agent-token.new /etc/hs-pg/agent-token
install -m 0644 "$agent_tmp"/*.py /opt/hs-pg/backend/
cat > /etc/systemd/system/hs-services-agent.service <<UNIT
[Unit]
Description=HS node certificate, Telegram and Fair Use service agent
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=root
UMask=0077
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 /opt/hs-pg/backend/hs_services_agent_v2.py --panel $PANEL --target $NODE_ID --token-file /etc/hs-pg/agent-token
Restart=on-failure
RestartSec=5
PrivateTmp=true
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now hs-services-agent.service
systemctl restart hs-services-agent.service

if command -v nft >/dev/null 2>&1; then
  echo 'HS Fair Use: nftables capability detected.'
else
  echo 'HS Fair Use warning: nftables is not installed; certificates and proxy management still work, but per-user speed caps will not enforce.' >&2
fi
