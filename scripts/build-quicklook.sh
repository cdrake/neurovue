#!/bin/sh
# Builds NeuroVue's Finder Quick Look extensions (preview + thumbnail) for
# NIfTI files as universal .appex bundles in src-tauri/target/quicklook/.
# tauri.macos.conf.json copies them into NeuroVue.app/Contents/PlugIns.
# Signs with $APPLE_SIGNING_IDENTITY when set, ad hoc otherwise.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
src="$root/src-tauri/quicklook"
out="$root/src-tauri/target/quicklook"
min_macos=12.0
version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$root/src-tauri/tauri.conf.json" | head -1)
identity=${APPLE_SIGNING_IDENTITY:--}
# Notarization needs a secure timestamp; ad hoc signatures can't have one.
timestamp=--timestamp
[ "$identity" = "-" ] && timestamp=--timestamp=none

build_appex() {
  name=$1 # NeuroVuePreview | NeuroVueThumbnail
  dir=$2  # Preview | Thumbnail
  appex="$out/$name.appex"
  rm -rf "$appex" "$out/$name.build"
  mkdir -p "$appex/Contents/MacOS" "$out/$name.build"

  for arch in arm64 x86_64; do
    xcrun swiftc -O -parse-as-library -application-extension \
      -target "$arch-apple-macos$min_macos" -module-name "$name" \
      -Xlinker -e -Xlinker _NSExtensionMain -lz \
      "$src"/Shared/*.swift "$src/$dir"/*.swift \
      -o "$out/$name.build/$name-$arch"
  done
  lipo -create "$out/$name.build/$name"-* -output "$appex/Contents/MacOS/$name"

  sed -e "s/__VERSION__/$version/g" -e "s/__MIN_MACOS__/$min_macos/g" \
    "$src/$dir/Info.plist" >"$appex/Contents/Info.plist"

  # Quick Look extensions must be sandboxed; the hardened runtime is needed for
  # notarization.
  codesign --force --options runtime "$timestamp" \
    --entitlements "$src/QuickLook.entitlements" --sign "$identity" "$appex"
}

build_appex NeuroVuePreview Preview
build_appex NeuroVueThumbnail Thumbnail
echo "Quick Look extensions built in $out"
