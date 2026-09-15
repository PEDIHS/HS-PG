#!/usr/bin/env bash
# Compatibility entry point for an older running guard. Firewall is retired.
set -Eeuo pipefail
HS_ROOT="${HS_ROOT:-/opt/hs-pg}"
bash "$HS_ROOT/plugin/retire-firewall.sh"
exec bash "$HS_ROOT/plugin/integrate-services.sh"
