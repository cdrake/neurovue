# AGENTS.md

Guidance for agents (and humans) working in this repo.

## What this is

NeuroVue is a [Tauri v2](https://tauri.app) desktop and iOS app for viewing NIfTI brain
volumes. Frontend is React + TypeScript (`src/`) rendering with
[`@niivue/niivue`](https://github.com/niivue/niivue); the Rust backend
(`src-tauri/src/`) embeds a local axum HTTP server that serves volumes, IIIF
image previews, and a multi-resolution pyramid, and exposes Tauri commands.

## Commands

```bash
bun install --frozen-lockfile
bun run typecheck   # app + mcp-server
bun run lint        # Biome
bun test
(cd src-tauri && cargo test)
(cd src-tauri/web && cargo test --locked)
bun run tauri:dev   # desktop app
bun tauri ios build # iOS (see iOS notes)
```

CI runs all the tests above: run them before calling a change done. Installs,
cargo fetches and the iOS build need network and write outside the repo
(Xcode's DerivedData), so a sandboxed agent (Codex's default) must run them
with network and full access.

Commits use conventional commits (`feat:`, `fix:`, `docs:`, ...); Biome is the
only linter and formatter.

## Driving the app (MCP)

With View → Allow AI Agents on, the app serves MCP at
`http://127.0.0.1:4242/mcp` (4243 for `tauri:dev`). Connect Claude Code with
`claude mcp add --transport http neurovue http://127.0.0.1:4242/mcp`, or Codex
with an `[mcp_servers.neurovue]` entry in `~/.codex/config.toml` (see
`demo/codex`). NeuroVue's own tools are NeuroFlow documents in
`mcp-server/tools/`: a new or changed one must pass neuroflow-spec's validator,
which CI doesn't run yet (`docs/mcp.md`).

## Mobile portability is a hard constraint

**Goal: ship iPhone and iPad apps from this same codebase.** The project is
already structurally mobile-capable (Tauri v2, `mobile_entry_point` in
`src-tauri/src/lib.rs`, `staticlib`/`cdylib` crate types). Do **not** introduce
designs or implementations that would prevent an iOS/iPadOS build, and prefer
choices that keep that path open. Concretely:

- **Keep the data transport swappable.** The embedded `127.0.0.1` HTTP server
  runs on iOS too (App Transport Security allows loopback), but its socket is
  subject to app lifecycle, and a custom protocol / IPC may replace it. Access
  server data through the existing `serverUrl` + `fetch` seam and avoid
  HTTP-only semantics (range requests, `Cache-Control` reliance, multiple ports)
  that a custom protocol couldn't replicate.
- **Subprocess implementations stay desktop-only.** iOS forbids spawning
  external executables/PTYs. The Python terminal (`portable-pty`) is desktop-only
  outright (`src-tauri/src/terminal.rs`, `#[cfg(desktop)]`). niimath runs as a
  native sidecar on desktop (`src-tauri/src/niimath.rs`, `#[cfg(desktop)]`), so
  it is desktop-only for now. niimath also ships as a **WebAssembly build**: the
  planned mobile/web path runs it behind the same frontend interface
  (`src/domain/niimath.ts`, today only the native command), so keep that
  interface free of desktop assumptions. Keep desktop-only
  deps behind target cfgs and never make a subprocess command load-bearing.
- **Don't assume arbitrary filesystem access.** iOS sandboxes the filesystem
  (document-picker URLs / security-scoped bookmarks, not free `canonicalize()`
  of absolute paths). Keep dataset acquisition behind an abstraction.
- **WebGL2 is the guaranteed baseline; WebGPU is progressive enhancement.** iOS
  WebGPU support is thin. Preserve the `navigator.gpu` → WebGL2 fallback (see
  `preferredBackend()`); do not adopt WebGPU-only niivue features.
- **Every interaction needs a touch path.** Pointer events already cover touch —
  keep using them. No hover-only or wheel-only controls: wheel-zoom and
  hover-reveal affordances must have pinch/tap equivalents.
- **Layout stays responsive.** iPhone is small, iPad is ~desktop. Don't make
  fixed desktop pixel dimensions load-bearing; keep panels collapsible/adaptive.
- **Keep memory bounded.** iOS kills memory-hungry apps. Maintain the source
  voxel ceiling and cache budgets, and keep their limits env-overridable so
  mobile can run tighter.

When a proposed change would trade away mobile portability, call it out and
prefer the portable option.

## UI changes: check Mac, iPad and iPhone

Every UI change (DOM or canvas/UIKit overlay) must lay out on all three before
it is done:

- **iPhone:** portrait (~375–430 pt wide) and landscape (~390 pt tall);
  safe-area insets (notch, home indicator); coarse pointer, 44 pt targets.
- **iPad:** full screen, Split View/Stage Manager widths (down to iPhone size),
  both orientations; Pencil and finger.
- **Mac:** a small window as well as a large one; mouse and trackpad.
- **Short panes:** landscape iPhone, Slide Over, and two panes side by side are
  short as well as narrow. Check height, not just width.

Canvas overlays wrap or shrink to the stage width (pass `maxWidth`, place with
`getLayout()`, or `measure()` for the tool palette) instead of assuming one row
fits, and give way vertically when a short pane can't fit them all (see the
slice slider and tool palette in `src/domain/stageControls.ts`). Its layout
tests (`stageControls.test.ts`) are the quick check. Say in the PR which of the three
were checked and how (device, simulator, or narrowed window).

## iOS notes

iPhone and iPad both ship (`TARGETED_DEVICE_FAMILY` 1,2). Gotchas:

- iOS plist keys go in `src-tauri/Info.ios.plist`; edits to `gen/apple` plists
  are overwritten by the CLI merge.
- Revert `DEVELOPMENT_TEAM` in `project.pbxproj` after iOS builds.
- `bun tauri ios build` exits 1 after `BUILD SUCCEEDED` in the simulator build;
  harmless.
- `gen/apple/Sources/neurovue/main.mm` swizzles `TaoSceneDelegate` for UIScene.
- Data protection is `NSFileProtectionComplete` (the profile requires it).
- Receiving is opt-in (`receive-enabled` marker in the data root); sends are TLS 1.3
  (Network.framework, `src-tauri/src/tls.m`) with a 6-digit code bound to the
  session; macOS and iOS only.
- Touch: 44 pt targets on coarse pointers; font sizes in rem, and the root
  follows Dynamic Type (`-apple-system-body`) on touch devices.
- The canvas stage controls are mirrored in a hidden DOM
  (`StageControlsMirror`) for VoiceOver. Keep it in sync via `stageControlStates`
  in `src/domain/stageControlSurface.ts`.
- Open submission blockers: #80 (privacy policy/support URLs), #93 (Mac App
  Store: sandbox, security-scoped bookmarks, helpers). macOS ships as a
  Developer ID DMG.
