#!/usr/bin/env bash
# Packs extension/ into dist/<name>-<version>.crx (signed with Chrome itself) and a .zip of the same files.
#
#   scripts/pack.sh [key.pem]
#
# The key decides the extension ID, so keep using the same one. Without a key a throwaway one is generated
# and every build gets a different ID. CHROME overrides the browser binary (default: google-chrome).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
key="${1:-}"
chrome="${CHROME:-google-chrome}"
version="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$root/extension/manifest.json" | head -1)"
name="dalanchong-$version"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$root/dist"
cp -R "$root/extension" "$work/extension"
find "$work/extension" -name '.DS_Store' -delete

if [ -z "$key" ]; then
  key="$work/key.pem"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$key" 2>/dev/null
  echo "warning: no key given, signed with a throwaway key; the extension ID changes on every build" >&2
fi

"$chrome" --headless=new --no-sandbox --disable-gpu --user-data-dir="$work/profile" \
  --pack-extension="$work/extension" --pack-extension-key="$key" >/dev/null 2>&1 || true
# Chrome reports nothing useful on failure, so check the output itself: CRX3 starts with "Cr24" and version 3.
if [ "$(head -c 8 "$work/extension.crx" 2>/dev/null | od -An -tx1 | tr -d ' \n')" != "4372323403000000" ]; then
  echo "error: Chrome did not produce a CRX3 file" >&2
  exit 1
fi

mv "$work/extension.crx" "$root/dist/$name.crx"
chmod 644 "$root/dist/$name.crx"
rm -f "$root/dist/$name.zip"
(cd "$work/extension" && zip -qr -X "$root/dist/$name.zip" .)

# Extension ID: first 128 bits of the SHA-256 of the public key, written with the letters a-p.
id="$(openssl rsa -in "$key" -pubout -outform DER 2>/dev/null | openssl dgst -sha256 -binary | od -An -tx1 | tr -d ' \n' | head -c 32 | tr '0-9a-f' 'a-p')"
echo "version=$version"
echo "id=$id"
echo "crx=dist/$name.crx"
echo "zip=dist/$name.zip"
