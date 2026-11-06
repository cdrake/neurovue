# Launch NeuroFlow pipelines from NeuroVue — design

Date: 2026-11-06 · Status: approved in brainstorming, awaiting spec review

## Goal

Let a person viewing a volume in NeuroVue (desktop) pick a NeuroFlow tool or
workflow that accepts it, fill the remaining inputs, run it, and see the outputs
load back into the viewer.

We don't yet know which UI is best, so we build two variants behind a switch and
the owner picks one by using both on real data:

- **A, native:** a minimal form in NeuroVue's own style.
- **B, NeuroFlow UI:** NeuroFlow's `WorkflowDiagram` and `RunPanel`, published
  as `@cdrake/neuroflow-react`.

Both variants share one backend so the comparison is UI-only.

## Constraints

- Desktop only. NeuroVue must stay portable to iPhone/iPad, so the backend
  compiles under `#[cfg(desktop)]` and the entry point is hidden when it is
  absent. Nothing in the shared iOS path depends on it.
- NeuroVue uses local installs. It doesn't bundle `neuroflow-mcp` or the gallery,
  so there is no new signing or notarization work.
- `@cdrake/neuroflow-react` is published by npm user `christopher.drake`, who
  owns the `@cdrake` org. The `@neuroflow` scope belongs to someone else.
- NeuroFlow uses React 18 and NeuroVue uses React 19. The package must work with
  both.

## Part 1 — `@cdrake/neuroflow-react` (neuroflow repo)

### 1.1 Cut the leaks

These are behavior-neutral moves so the components can be bundled without the
app:

- Move `idTail` from `src/data/gallery.ts`, which `import.meta.glob`s the whole
  gallery, into `src/domain/neuroflow.ts`. `gallery.ts` re-exports it.
- Move `ArtifactDescriptor`, `RunStepRecord`, `RunRecord`, `RunStructured`,
  `RunFinishedEvent`, `ToolStatus`, `ToolReadiness` and `isArtifactDescriptor`
  from `src/domain/host.ts`, which imports `@tauri-apps/api`, into a new
  `src/domain/runTypes.ts` with no Tauri import. `host.ts` re-exports them so
  the rest of the app is unaffected. `RunPanel.tsx`, `WorkflowDiagram.tsx` and
  `graph.ts` must switch their imports, including `import type`, to
  `runTypes.ts`. Otherwise `tsc --emitDeclarationOnly` still emits `host.d.ts`,
  and that file references `@tauri-apps/api`.
- Change the exported components' return types from `JSX.Element` to
  `React.JSX.Element`, because React 19's types removed the global `JSX`
  namespace.

### 1.2 Library entry `src/lib.ts`

It exports:

- the components `WorkflowDiagram` and `RunPanel`, with their prop types and
  `HostRunState` / `HostRunStatus`. `RunTimeline` is left out: it renders the
  app's WASM preview path (`execution.ts`), not host runs;
- `buildWorkflowGraph` and `NodePositionMap`;
- `toolFromDocument` (tool document → `ToolDefinition`) and `shortType`;
- the types `WorkflowDocument`, `ToolDefinition` and `ParameterDef`;
- everything in `runTypes.ts`.

The entry must not import anything from `src/data/gallery.ts`, `host.ts`, `execution.ts` or
`@tauri-apps/*`. The tarball check in §1.5 enforces this.

### 1.3 Package folder `packages/neuroflow-react/`

- `package.json`:
  - `name: @cdrake/neuroflow-react`, `version: 0.1.0`, `type: module`;
  - `exports`: `"."` (ESM and types) and `"./style.css"`;
  - `peerDependencies`: `react` and `react-dom` at `^18.3 || ^19`, and
    `@xyflow/react` at `^12`;
  - `dependencies`: `lucide-react`;
  - `files: ["dist"]`;
  - license `MIT OR Apache-2.0`, same as the repo.
- `vite.config.ts`: library mode with entry `../../src/lib.ts`, ESM output to
  `dist/`, and every peer dependency and `lucide-react` external.
- Type declarations come from `tsc --emitDeclarationOnly` with a small
  `tsconfig.lib.json` rooted at `src/`. No new build dependency.
- Root scripts: `lib:build` and `lib:pack`.
- `README.md`: install, required CSS imports, a minimal example, and how to fill
  `HostRunState` from `neuroflow-mcp`.

The app keeps importing from `src/`, and its layout doesn't change.

### 1.4 CSS

- Move the `nf-*` rules used by the three components out of `src/styles/app.css`
  into `src/styles/components.css`, scoped under `.nf-root`. Include whatever
  BIDSvue tokens they reference from `bidsui.css`, declared on `.nf-root`, not
  `:root`.
- `app.css` imports `components.css`, and the app shell adds `nf-root` to its
  root element so the app looks the same as before.
- The package ships the file as `@cdrake/neuroflow-react/style.css`. Consumers
  also import `@xyflow/react/dist/style.css`.

### 1.5 Pre-publish check

`packages/neuroflow-react/test/consumer/` is a tiny React 19 + TypeScript app
that renders `WorkflowDiagram` and `RunPanel` from the installed tarball.

`npm run lib:check`:

1. packs the package;
2. installs the tarball into the consumer;
3. runs `tsc --noEmit` and `vite build`;
4. greps the built bundle to confirm it contains no `@tauri-apps` and no gallery
   JSON;
5. checks that the package's `dist/` contains no `host.d.ts` or
   `execution.d.ts`, and typechecks the consumer with `skipLibCheck: false` so
   the package's own declarations are checked too.

### 1.6 Publishing

Publish `0.1.0` by hand with `npm publish --access public` from
`packages/neuroflow-react`. Publishing from CI is out of scope.

## Part 2 — NeuroVue backend (shared by A and B)

### 2.1 Settings: `neuroflow.json`

The file lives in the app config folder, next to `mcp.json`:

```json
{
  "binary": "~/Dev/neuroflow/target/release/neuroflow-mcp",
  "registries": ["~/Dev/neuroflow/gallery"],
  "spec": "~/Dev/neuroflow-spec",
  "interpreters": { "node": "/opt/homebrew/bin/node", "python3": "~/.venvs/neuroflow/bin/python" },
  "variant": "A"
}
```

- If the file is missing, NeuroVue writes this template the first time the panel
  opens and shows the "not set up" state.
- `~` is expanded.
- `--data-root` is not configured here. It is the same `roots` list as
  `mcp.json`, falling back to the home folder, so agents and pipelines see the
  same folders.

### 2.2 `src-tauri/src/neuroflow.rs`

`#[cfg(desktop)]`, about 150 lines, modelled on `mcp.rs`.

- **Lazy spawn.** On the first request, start `binary` with `--registry` for each
  entry, `--data-root` for each root, `--spec`,
  `--interpreter NAME=PATH`, and an explicit `--sessions ~/.neuroflow/runs` so
  NeuroVue knows where runs are written. The process uses piped stdio and `kill_on_drop`.
  After spawning, run the MCP `initialize` handshake and send
  `notifications/initialized`.
- **Reader thread.** Parse stdout one JSON line at a time:
  - a response (has `id`) resolves the waiting request (a map from `id` to a
    oneshot sender);
  - `notifications/progress` is sent to the webview as a `neuroflow:progress`
    event carrying `{progressToken, progress, total, message}`;
  - a line that isn't valid JSON is logged and skipped.

  Stderr is kept in a ring buffer of 200 lines.
- **Commands.**
  - `neuroflow_request(method, params) -> Value`: assigns the id, writes the
    request, and awaits the result. A JSON-RPC error becomes `Err`.
  - `neuroflow_cancel(requestId)`: sends `notifications/cancelled`.
  - `neuroflow_status() -> {configured, running, settingsPath, stderrTail, variant}`.
  - `neuroflow_restart()`.
  - `neuroflow_read_run(runId) -> {sessionDir, record}`: reads
    `<sessions>/<runId>/run.json`. `runId` must be a single path segment.
    `neuroflow-mcp` exposes no `run.json` resource, and `RunPanel` uses
    `record.steps` for per-step status after a run. It falls back to
    `currentStep` while a run is in progress.
- **Process exit.** All waiting requests fail with
  `"neuroflow-mcp exited: <last stderr lines>"`. The next request respawns the
  process.
- **App exit.** Add `neuroflow::stop` next to `mcp::stop` in the
  `RunEvent::Exit` handler (`lib.rs`).
- **Input paths.** File inputs are checked with the existing `resolve_in_roots`
  (`mcp.rs`) before a run starts.

### 2.3 `src/domain/neuroflowClient.ts`

This is a thin typed wrapper over the commands:

- `status()`;
- `list({ acceptsType, runnableOnly: true })`, which calls `tools/call`
  `neuroflow_list`;
- `tools()`: calls `tools/list` once after init and caches it. This is where
  each document's MCP tool name and `inputSchema` come from. `neuroflow_list` is
  used only for the `acceptsType` filter, and the two are joined by document id;
- `describe(id)`, which returns the NeuroFlow document (`neuroflow_describe`)
  for the diagram;
- `run(id, inputs, onProgress)`, which calls `tools/call` with the tool's MCP
  name and a `_meta.progressToken`. It returns `{ requestId, result: Promise<RunStructured> }`.
- `cancel(requestId)`;
- `toHostRunState(...)`, the B adapter: progress events become
  `progress`/`total`/`message`, and the result becomes `finished`, built from
  `structuredContent` plus `neuroflow_read_run(runId)` for `sessionDir` and
  `record`.

Both UIs talk only to this module.

### 2.4 Loading outputs

On a `completed` run, collect every `ArtifactDescriptor` in
`structured.outputs`. Any `.nii` or `.nii.gz` loads through the existing
`addOverlayPath` action. Anything else, or a load that fails, becomes a
"Reveal in Finder" row. One failed output doesn't stop the others from loading.

Layers groups each run's loaded overlays under a collapsible header,
**Run: <title> · <HH:MM>**. Collapsing it hides those rows. Its "Reveal run"
button opens the run's session folder (`<sessions>/<runId>/`, which holds
`run.json` with params and logs). The overlay-id → run map lives in App state
only and isn't saved. "Working derivatives" isn't touched: outputs register
with role `overlay`, and `isDerivedItem` excludes overlays.

## Part 3 — NeuroVue UI

### Entry point

The launcher is a **Pipelines** section in the Inspector's existing
**Operations** tab, below `NiimathOperationsPanel`, with the current volume
preselected. No new panel or tab is added. Two shortcuts open it:

- View › **Run NeuroFlow…**;
- a "Run NeuroFlow…" button in the volume info panel.

Both set `sidePanelTab` to `'operations'` and scroll Pipelines into view.
Pipelines, the menu item and the button render only when the
`neuroflow_status` command exists (desktop). On iPad the Operations tab shows
niimath alone.

### Picker (shared)

The picker lists the result of `neuroflow_list({acceptsType: <volume type>,
runnableOnly: true})`. The type comes from the spec's vocabulary
(`common.schema.json`): `neuro:label-map` when NeuroVue shows the volume as a
label/atlas, otherwise `neuro:volume`. Masks aren't detected in v1. Each entry shows the title, kind
(tool/workflow) and a one-line description.

### The A/B switch

`variant` in `neuroflow.json`, also toggled from a **Debug › NeuroFlow UI: A/B**
menu item without rebuilding.

### Variant A — native (about 250 lines of TSX)

- The form is generated from the MCP `inputSchema`:
  - inputs whose `x-neuroflow-type` is a file or volume type get a path field
    with a picker, defaulting to the current volume when its type is compatible;
  - `enum` becomes a select;
  - `number`/`integer` become a number field;
  - everything else is a text field.

  Required inputs are marked.
- **Run** shows one progress line and a Cancel button. The result appears as the
  list of loaded overlays plus "Reveal" rows. On failure the panel shows
  `failedStep`, `error` and the stderr tail.

### Variant B — `@cdrake/neuroflow-react`

- Add the dependencies `@cdrake/neuroflow-react` and `@xyflow/react`, and import
  both CSS files.
- The panel is `<div className="nf-root">` holding `WorkflowDiagram`, read-only,
  above `RunPanel`.
  - A single tool is wrapped in a one-step workflow so the graph can draw.
  - The diagram's editing callbacks (`onBindInput`, `onAddTool`, `onMoveNode`)
    are no-ops or keep positions only in local state.
- `RunPanel` gets `toHostRunState(...)`. Its `onStart`, `onCancel` and `onOpen`
  map to `client.run`, `client.cancel` and reveal-in-Finder.
- Outputs load into the viewer exactly as in A (§2.4).
- The diagram doesn't fit the Inspector's normal width. While B's body is
  mounted, the side panel gets an `is-wide` class (about 560px) and loses it
  on unmount. Part of what the A/B test weighs is whether that width cost is
  worth the diagram.

## Error handling

| Failure | What the person sees |
|---|---|
| `neuroflow.json` is missing, or the binary isn't there | "NeuroFlow isn't set up", the expected path, and a "Reveal settings file" button |
| The process exits or `initialize` fails | Panel error with the stderr tail and a "Restart" button. Waiting requests are rejected, so nothing hangs |
| An input is outside the data roots | Rejected before the run, with the same "add a folder to roots" message agents get |
| The run ends `failed` | `failedStep`, `error` and the stderr tail. Nothing is loaded |
| Cancel | `notifications/cancelled`, and the panel shows `cancelled`. On app quit the child is killed |
| An output won't load as an overlay | That output gets a "Reveal in Finder" row. The others still load |

## Testing

- **Rust (`neuroflow.rs`)**: unit tests for routing JSON-RPC lines (responses out
  of order, notifications, a broken line, rejecting waiting requests when the
  process exits) and for building the arguments from settings plus the roots. No
  real process.
- **TS (`neuroflowClient.ts`)**: tests against a fake `invoke` for list, run,
  cancel and `toHostRunState`.
- **Integration**: one test, skipped when the binary is missing. It spawns the
  real `neuroflow-mcp --registry ~/Dev/neuroflow/gallery`, runs
  `python-volume-filter` on a fixture NIfTI, and checks that a NIfTI output
  path comes back.
- **Package**: `npm run lib:check` (§1.5) in the neuroflow repo.
- **Manual A/B**: on `~/Dev/neurovue-stat-demo`, run the same filter with A and
  with B, and confirm the overlay loads in both.

## Order of work

1. neuroflow repo, Part 1, then publish `@cdrake/neuroflow-react@0.1.0`.
2. NeuroVue Part 2, the backend and client.
3. NeuroVue Variant A.
4. NeuroVue Variant B.
5. Manual A/B. The losing variant is deleted. If A wins, the package stays for
   other consumers.

## Out of scope

- Run history inside NeuroVue (sessions already live in `~/.neuroflow/runs`).
  Run headers in Layers last only for the session.
- Registering outputs as derived items with `derivedFrom`, so they'd show up
  in "Working derivatives".
- Editing workflows in NeuroVue.
- iOS/iPad.
- Bundling `neuroflow-mcp`.
- Publishing from CI.
- A host abstraction inside the package: the components are already driven by
  props.
