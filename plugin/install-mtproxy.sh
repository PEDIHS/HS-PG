#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root'; exit 1; }
for tool in git make cc; do command -v "$tool" >/dev/null || { echo 'Install git build-essential libssl-dev zlib1g-dev first'; exit 1; }; done
MTPROXY_COMMIT=f36d8af769ffaeac36978d38c2c0f6d1104c2137
mt_build="$(mktemp -d)"
trap 'rm -rf "$mt_build"' EXIT
git clone https://github.com/TelegramMessenger/MTProxy.git "$mt_build/source"
git -C "$mt_build/source" checkout --detach "$MTPROXY_COMMIT"
make -C "$mt_build/source" -j2
install -m 0755 "$mt_build/source/objs/bin/mtproto-proxy" /usr/local/bin/mtproto-proxy
install -d /usr/local/share/licenses/hs-mtproxy
install -m 0644 "$mt_build/source/GPLv2" "$mt_build/source/LGPLv2" /usr/local/share/licenses/hs-mtproxy/
echo 'Official MTProxy binary installed. Create a proxy in HS Plugin > Telegram Proxy.'
