#!/bin/sh
# update-tailscale.sh - put Tailscale's own released daemon into this folder (bin/), for the Store to install.
# Run on a computer, not on the car:   sh components/woodr-link/update-tailscale.sh
#
# The head unit cannot fetch it itself: mgu-uplink gives the internet only to listed users, never to root, and
# the unit's own resolver does not reach the internet. So the daemon is shipped in the repository like any tool
# file, as Tailscale publishes it (BSD-3-Clause, bin/LICENSE-tailscale), never rebuilt or changed here.
#
# The version and checksum allowed are in tailscale.pin (the archive's SHA-256 as Tailscale publishes it next to
# the archive). The archive is downloaded from pkgs.tailscale.com, checked against BOTH the pin and Tailscale's
# published checksum, and only then unpacked. A mismatch changes nothing. To move to a new version: set VERSION,
# run once with SHA256= empty to see Tailscale's published value, put it in the pin, and run again.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/tailscale.pin"
NAME="tailscale_${VERSION}_${ARCH}"
URL="https://pkgs.tailscale.com/stable/${NAME}.tgz"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/woodr-link.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

curl -fsSL -o "$TMP/ts.tgz" "$URL"
PUBLISHED=$(curl -fsSL "$URL.sha256" | tr -d ' \r\n')
GOT=$(sha256sum "$TMP/ts.tgz" | cut -d' ' -f1)
echo "update-tailscale: $NAME: published $PUBLISHED, downloaded $GOT, pinned ${SHA256:-<none>}"
if [ "$GOT" != "$PUBLISHED" ] || [ "$GOT" != "$SHA256" ]; then
    echo "update-tailscale: checksums differ, nothing changed" >&2
    exit 1
fi
tar -xzf "$TMP/ts.tgz" -C "$TMP"
mkdir -p "$HERE/bin"
cp "$TMP/$NAME/tailscaled" "$HERE/bin/tailscaled.new"
chmod 0755 "$HERE/bin/tailscaled.new"
mv -f "$HERE/bin/tailscaled.new" "$HERE/bin/tailscaled"
curl -fsSL -o "$HERE/bin/LICENSE-tailscale" "https://raw.githubusercontent.com/tailscale/tailscale/v${VERSION}/LICENSE"
echo "update-tailscale: bin/tailscaled is Tailscale $VERSION ($(sha256sum "$HERE/bin/tailscaled" | cut -d' ' -f1))"
