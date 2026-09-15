#!/usr/bin/env bash
# Idempotent upgrade migration. Never flush the host ruleset or change its policy.
set -Eeuo pipefail
HS_ROOT="${HS_ROOT:-/opt/hs-pg}"
if command -v systemctl >/dev/null 2>&1; then
  for unit in hs-shield-agent.service hs-shield-integrator.service hs-shield-integrator.timer hs-shield-integrator.path hs-firewall-rollback.timer hs-firewall-rollback.service; do
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$unit"
    rm -rf "/etc/systemd/system/$unit.d"
  done
  systemctl daemon-reload
fi
if command -v nft >/dev/null 2>&1; then
  for table in hs_plugin hs_fair_use; do
    if nft list table inet "$table" >/dev/null 2>&1; then
      nft delete table inet "$table"
    fi
  done
fi
for file in backend/hs_shield_api.py backend/hs_shield_agent.py backend/hs_firewall.py backend/hs_services_agent_v2.py backend/hs_extensions_api.py backend/hs_fair_use_runtime.py backend/hs_fair_reconcile.py plugin/hs-shield.js plugin/hs-firewall-charts.js plugin/hs-native-extensions.js plugin/integrate-extensions.sh plugin/patch_extensions.py plugin/patch_shield_api.py plugin/integrate-shield.sh; do
  rm -f "$HS_ROOT/$file"
done
