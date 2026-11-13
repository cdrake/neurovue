#!/usr/bin/env bash
# Build the neurovue-web release tarball (server binary + web UI) for Neurodesk.
#
#   scripts/package-web.sh [OUT_DIR]     (default: dist-pkg)
#
# Produces neurovue-web-<version>-linux-x86_64.tar.gz and its .sha256. The
# tarball unpacks to neurovue-web-<version>-linux-x86_64/{neurovue-web,dist-web/,LICENSE};
# run it as `neurovue-web --dist <that dir>/dist-web`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mkdir -p "${1:-$root/dist-pkg}" && cd "${1:-$root/dist-pkg}" && pwd)"
version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/src-tauri/web/Cargo.toml" | head -1)"
app_version="$(sed -n 's/^  "version": "\(.*\)",/\1/p' "$root/package.json" | head -1)"
if [ "$version" != "$app_version" ]; then
  echo "package-web: web crate version $version != package.json $app_version" >&2
  exit 1
fi

name="neurovue-web-$version-linux-x86_64"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

(cd "$root" && bun run build:web)
(cd "$root/src-tauri/web" && cargo build --release --locked)

mkdir -p "$stage/$name"
cp "$root/src-tauri/web/target/release/neurovue-web" "$stage/$name/"
cp -R "$root/dist-web" "$stage/$name/dist-web"
cp "$root/LICENSE" "$stage/$name/"

tar -C "$stage" -czf "$out/$name.tar.gz" "$name"
(cd "$out" && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
echo "package-web: $out/$name.tar.gz"
cat "$out/$name.tar.gz.sha256"
