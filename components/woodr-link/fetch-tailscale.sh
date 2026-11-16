#!/bin/sh
# fetch-tailscale.sh - get Tailscale's own daemon from Tailscale, check it, put it in place. Run as root at install.
#
# This repository ships no Tailscale binary. The pinned version in tailscale.pin is downloaded from
# pkgs.tailscale.com, its SHA-256 is compared with the one recorded in tailscale.pin (taken from Tailscale's
# published checksum when the pin was written), and only a match is installed. A mismatch installs nothing.
#   tailscale.pin:  VERSION=1.x.y   ARCH=amd64   SHA256=<64 hex>
# Result: $ROOT/bin/tailscaled (+ tailscale, the licence text is in the archive's parent project: BSD-3-Clause).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=${WOODR_LINK_ROOT:-/var/opt/woodr-link}
. "$HERE/tailscale.pin"
NAME="tailscale_${VERSION}_${ARCH}"
URL="https://pkgs.tailscale.com/stable/${NAME}.tgz"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/woodr-link.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

if [ -x "$ROOT/bin/tailscaled" ] && [ "$(cat "$ROOT/bin/VERSION" 2>/dev/null)" = "$VERSION" ]; then
    echo "woodr-link: Tailscale $VERSION is already in place"
    exit 0
fi
echo "woodr-link: downloading $URL"
if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$TMP/ts.tgz" "$URL"; else wget -q -O "$TMP/ts.tgz" "$URL"; fi
GOT=$(sha256sum "$TMP/ts.tgz" | cut -d' ' -f1)
if [ "$GOT" != "$SHA256" ]; then
    echo "woodr-link: checksum mismatch, nothing installed (got $GOT, pinned $SHA256)" >&2
    exit 1
fi
tar -xzf "$TMP/ts.tgz" -C "$TMP"
mkdir -p "$ROOT/bin" "$ROOT/state"
chmod 0700 "$ROOT/state"
install -m 0755 "$TMP/$NAME/tailscaled" "$ROOT/bin/tailscaled.new"
install -m 0755 "$TMP/$NAME/tailscale" "$ROOT/bin/tailscale.new"
mv -f "$ROOT/bin/tailscaled.new" "$ROOT/bin/tailscaled"
mv -f "$ROOT/bin/tailscale.new" "$ROOT/bin/tailscale"
echo "$VERSION" > "$ROOT/bin/VERSION"
echo "woodr-link: Tailscale $VERSION installed in $ROOT/bin"
