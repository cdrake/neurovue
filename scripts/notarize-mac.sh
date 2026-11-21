#!/bin/sh
# Notarizes a signed `bun run tauri:build:mac` with a notarytool keychain
# profile (which Tauri can't use): staples the .app first, so a copy dragged
# out of the DMG passes Gatekeeper offline, then rebuilds, signs, notarizes and
# staples the DMG around it. `tauri bundle` would rebuild the .app and lose the
# ticket, so the DMG is made with hdiutil.
# Usage: APPLE_SIGNING_IDENTITY=... scripts/notarize-mac.sh <profile>
set -eu

profile=${1:?usage: notarize-mac.sh <notarytool-profile>}
identity=${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY}
root=$(cd "$(dirname "$0")/.." && pwd)
bundle="$root/src-tauri/target/universal-apple-darwin/release/bundle"
version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$root/src-tauri/tauri.conf.json" | head -1)
app="$bundle/macos/NeuroVue.app"
dmg="$bundle/dmg/NeuroVue_${version}_universal.dmg"
work=$(mktemp -d)

ditto -c -k --keepParent "$app" "$work/NeuroVue.zip"
xcrun notarytool submit "$work/NeuroVue.zip" --keychain-profile "$profile" --wait
xcrun stapler staple "$app"

mkdir "$work/stage"
ditto "$app" "$work/stage/NeuroVue.app"
ln -s /Applications "$work/stage/Applications"
hdiutil create -volname NeuroVue -srcfolder "$work/stage" -ov -format UDZO "$dmg"
codesign --force --timestamp --sign "$identity" "$dmg"
xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait
xcrun stapler staple "$dmg"
spctl -a -vv -t open --context context:primary-signature "$dmg"
echo "$dmg"
