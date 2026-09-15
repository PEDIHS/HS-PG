#!/usr/bin/env bash
# Build a separate, explicitly selected Xray binary; never replace a running core.
set -Eeuo pipefail
SOURCE="${1:?Usage: build-fair-core.sh XRAY_SOURCE_DIRECTORY OUTPUT_BINARY}"
OUTPUT="${2:?Output binary path required}"
HS_ROOT="${HS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
command -v go >/dev/null || { echo 'Go toolchain required (see Xray go.mod)'; exit 1; }
python3 "$HS_ROOT/plugin/patch_fair_core.py" "$SOURCE" "$HS_ROOT/core/hsfair"
(cd "$SOURCE" && go test ./common/hsfair && go build -trimpath -o "$OUTPUT" ./main)
echo "Built $OUTPUT; select it in the node's XRAY_EXECUTABLE_PATH and mount the HS agent data directory."
