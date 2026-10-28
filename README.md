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
on macOS (universal .dmg), Linux (.deb, .rpm) and Windows (.msi,
NSIS .exe), and runs lint, typecheck and the Rust tests. It runs on pushes and
PRs to `main` and can also be run manually. Download the installers from the run's
artifacts.

There is no AppImage (`src-tauri/tauri.linux.conf.json`): linuxdeploy can't
bundle the bun-compiled `neurovue-mcp` sidecar, since `ldd` fails on it.

The Tauri host starts a local server and the viewer asks the host for its URL.
In browser-only Vite development, the app falls back to
`http://127.0.0.1:8087`, which is the current OSD/IIIF reference server.

## AI agents (MCP)

With View → Allow AI Agents on, NeuroVue runs an [MCP](https://modelcontextprotocol.io)
server at `http://127.0.0.1:4242/mcp`; a dev build (`bun run tauri:dev`) uses
4243, so it can run beside the installed app, and advertises itself to iPads
as "<Mac name> (dev)". Set `NEUROVUE_MCP_PORT` to move either. It
is off by default: while it runs, any program on this machine can drive
NeuroVue and open files through it. The choice persists across launches.

Connect a client to it, for example Claude Code:

```sh
claude mcp add --transport http neurovue http://127.0.0.1:4242/mcp
```

The server is `mcp-server/main.ts`: the NiiVue tools from
[`@niivue/nv-mcp`](https://www.npmjs.com/package/@niivue/nv-mcp), which the
NiiVue repo maintains, plus NeuroVue's own:

| Tool | Does |
| --- | --- |
| `open_path` | Opens a dataset folder, NIfTI volume or `.nvbundle` |
| `add_overlay_path` | Lays a NIfTI volume over the open dataset |
| `load_surfaces`, `load_tracts` | Add surface meshes or tracts (`.trk`, `.tck`, `.trx`) |
| `dataset`, `select_volume` | List the dataset's volumes and switch between them |
| `open_window` | Opens another window and returns its tab id |
| `focus_window` | Brings a window to the front, which `screenshot` needs |
| `list_devices`, `send_to_device` | Find NeuroVue on an iPad on the same network and send it the volume shown (or the dataset) to draw on; the person there accepts each send |

Agents open files by path, with no file picker, but only inside the allowed
data roots: the home folder unless `roots` in `mcp.json` (next to the on/off
setting, in `~/Library/Application Support/org.neurovue.app/` on macOS) lists
others, e.g. `{"enabled": true, "roots": ["/Volumes/data"]}`. The app resolves
each path through symlinks and refuses anything outside a root. It reads
`roots` on every call; toggle Allow AI Agents to update the folders the server
names to agents.

NeuroVue's tools are [NeuroFlow](https://github.com/niivue/neuroflow-spec)
tool documents in `mcp-server/tools/`; the server takes each tool's name,
title, annotations, description and input types from its document, following
the spec's MCP binding (RFC 0009) and agent usage (RFC 0011) rules, so every
path input carries its `x-neuroflow-type` and a known failure comes back with
its remedy. The documents pass neuroflow-spec's validator.

Each NeuroVue window connects to the server as one tab with its own dataset, so
an agent can open several windows and drive each by its tab id. `tauri dev` and
`tauri build` compile the server with `bun build --compile` into the
`neurovue-mcp` sidecar; `bun run build-mcp-server --force` rebuilds it.
[docs/mcp.md](docs/mcp.md) describes how the NiiVue and NeuroVue halves fit
together, and [demo/codex](demo/codex/README.md) has Codex drive two windows.

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
