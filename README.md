# NeuroVue

NeuroVue is a lightweight viewer app for neuroimaging workflow previews. It is
modeled on the OSD volume desktop and the IIIF volumetric server, but the app
shell and local data server are Rust/Tauri.

The intended split is:

- Rust local server: IIIF desktop manifests, volume metadata, raw NIfTI bytes,
  session patch files, and future OME-Zarr/tract/mesh routes.
- Web viewer: OSD-style dataset browsing plus NiiVue WebGPU/WebGL rendering.
  Surface meshes (GIfTI, MZ3, OBJ, STL, FreeSurfer, …) open with File → Open
  Mesh, alone or over a volume; the host reads their bytes and NiiVue parses
  them, so they skip the local server.
- Tauri wrapper: native file access, session lifecycle, and app windows.

## Development

Needs [Bun](https://bun.sh) (version in `.bun-version`), a Rust toolchain and
the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```sh
bun install
bun run tauri:dev     # desktop app with live reload
bun run tauri:build   # release installers for this OS
bun run lint          # biome
bun run typecheck
```

`@niivue/niivue` and `@niivue/uikit` come from npm. To try unreleased NiiVue
changes, `bun link` a local checkout of [niivue/mono](https://github.com/niivue/mono)
packages.

`tauri dev` and `tauri build` prepare a Tauri sidecar for
`niimath` by downloading the latest platform release from
`rordenlab/niimath`. To refresh an already staged binary, run:

```sh
bun run ensure-niimath --force
```

### macOS release build

`bun run tauri:build:mac` builds a universal (Apple silicon + Intel) app and
`.dmg`. Run `rustup target add x86_64-apple-darwin` once first. Signing and
notarization come from the environment, so nothing personal lives in the repo:

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
# Notarization (optional; skipped with a warning when unset), either:
export APPLE_ID=... APPLE_PASSWORD=<app-specific password> APPLE_TEAM_ID=<TEAMID>
# or an App Store Connect API key:
export APPLE_API_KEY=... APPLE_API_ISSUER=... APPLE_API_KEY_PATH=...
bun run tauri:build:mac
```

Output lands in `src-tauri/target/universal-apple-darwin/release/bundle/`.
Without notarization, Gatekeeper blocks the app on other Macs.

Tauri can't use a `notarytool` keychain profile, so with one you notarize the
signed `.dmg` after the build instead. Store the profile once (it prompts for an
app-specific password from account.apple.com and keeps it in your keychain):

```sh
xcrun notarytool store-credentials <profile> --apple-id <apple-id> --team-id <TEAMID>
```

Then, for each release:

```sh
DMG=src-tauri/target/universal-apple-darwin/release/bundle/dmg/NeuroVue_<version>_universal.dmg
xcrun notarytool submit "$DMG" --keychain-profile <profile> --wait
xcrun stapler staple "$DMG"
spctl -a -vv -t open --context context:primary-signature "$DMG"  # "Notarized Developer ID"
```

### Finder Quick Look

The macOS app ships two Quick Look extensions (`src-tauri/quicklook/`). One is
a Space-bar preview showing the axial, coronal and sagittal mid-slices plus a
header summary. The other draws Finder icon thumbnails from the axial mid-slice.
Both work on `.nii` and `.nii.gz` (NIfTI-1 and NIfTI-2) and read only the first
volume's three mid-planes, so large files preview quickly.

- `bun run build-quicklook` compiles them with `swiftc` into
  `src-tauri/target/quicklook/`. `tauri build` runs this automatically on macOS
  (`tauri.macos.conf.json`) and copies them into `Contents/PlugIns/`. They are
  signed with `APPLE_SIGNING_IDENTITY` when it's set, and ad hoc otherwise.
- `tauri dev` doesn't load them. Build the app, then launch it once (or copy it
  to /Applications) so macOS registers the extensions.
- macOS keys file types on the last extension only, so `.nii.gz` arrives as
  generic gzip. The extensions claim gzip, check the header, and decline
  anything that isn't NIfTI.
- To test from a terminal:

  ```sh
  qlmanage -r                                   # reset the Quick Look cache
  qlmanage -x -t -s 256 -o /tmp/thumbs file.nii.gz
  /usr/bin/log stream --predicate 'subsystem == "org.neurovue.app.quicklook"' --level debug
  ```

### iOS (TestFlight)

```sh
rustup target add aarch64-apple-ios
rustup component add llvm-tools   # needed with Xcode 27, see below
APPLE_DEVELOPMENT_TEAM=<TEAMID> bunx tauri ios build --export-method app-store-connect
```

Sign in to your Apple ID in Xcode → Settings → Accounts first: automatic
signing creates the App Store profile. The build writes
`src-tauri/gen/apple/build/arm64/NeuroVue.ipa` and an `.xcarchive` beside it.
Open the archive in Xcode's Organizer and choose Distribute App → TestFlight to
upload it. Raise `CFBundleVersion` for every upload.

Xcode 27's SwiftPM hides the Swift functions Tauri's Rust code calls. swift-rs
1.0.9+ makes them public again with rustup's `llvm-objcopy`; without
`llvm-tools` the link fails with undefined `_register_plugin` and similar.

### Linux and Windows

Tauri doesn't cross-compile installers, so each OS builds on its own runner.
The `Build` workflow (`.github/workflows/build.yml`) builds unsigned installers
on macOS (universal .dmg), Linux (.deb, .rpm, .AppImage) and Windows (.msi,
NSIS .exe), and runs lint, typecheck and the Rust tests. It runs on pushes and
PRs to `main` and can also be run manually. Download the installers from the run's
artifacts.

The Tauri host starts a local server and the viewer asks the host for its URL.
In browser-only Vite development, the app falls back to
`http://127.0.0.1:8087`, which is the current OSD/IIIF reference server.

## Reference Contract

NeuroVue starts with the same core endpoints used by the OSD desktop:

- `GET /api`
- `GET /iiif/desktop`
- `GET /iiif/desktop/neuro/manifest`
- `GET /iiif/image/{volume}/{axis}/{slice}/info.json`
- `GET /iiif/image/{volume}/{axis}/{slice}/{region}/{size}/{rotation}/{quality}.{format}`
- `GET /volumes/{volume}/metadata`
- `GET /volumes/{volume}/raw.nii.gz`

The initial Rust server includes a compatibility shim and serves the bundled MNI152
sample (`src-tauri/resources/mni152.nii.gz`) when no dataset is open.
