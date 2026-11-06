# NeuroVue pipeline view — design

Date: 2026-11-06 · Status: approved in brainstorming, awaiting spec review

Revision: this replaces the earlier A/B launcher design (a native form vs.
NeuroFlow components in the Inspector). The owner chose a full pipeline view
built on a NeuroFlow component instead, so there is no A/B switch.

## Goal

Add a **Pipelines** view to NeuroVue (desktop), next to the dataset view. In it
a person picks a NeuroFlow tool or workflow, sets its values, and runs it
against the open dataset:

- a pipeline whose main input is `neuro:bids-dataset` runs **once** on the
  dataset root;
- a pipeline whose main input is `neuro:volume` or `neuro:label-map` runs
  **once per target volume**, the targets being the dataset view's filtered
  volumes or the selected one.

Outputs load back into the viewer. The view is a single React component,
`PipelineView`, published from the neuroflow repo as `@cdrake/neuroflow-react`.

## Constraints

- Desktop only. NeuroVue must stay portable to iPhone/iPad, so the backend
  compiles under `#[cfg(desktop)]` and the entry points are hidden when it is
  absent. Nothing in the shared iOS path depends on it.
- NeuroVue uses local installs. It doesn't bundle `neuroflow-mcp` or the gallery,
  so there is no new signing or notarization work.
- `@cdrake/neuroflow-react` is published by npm user `christopher.drake`, who
  owns the `@cdrake` org. The `@neuroflow` scope belongs to someone else.
- NeuroFlow uses React 18 and NeuroVue uses React 19. The package must work with
  both.
- `neuroflow-mcp` handles requests one at a time, in order (`server.rs`
  `serve`). Batches therefore run serially on one process.

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

### 1.2 Component changes

- `RunPanel` gets two optional props:
  - `initialInputs?: Record<string, unknown>`: seeds the form when the
    workflow changes. It wins over the localStorage values
    (`neuroflow.runInputs.v1`) for the keys it sets;
  - `lockedInputs?: Record<string, string>`: input name → a label shown in
    place of the field (for example "12 target volumes"). Locked inputs aren't
    editable, aren't validated as required, and are left out of the `inputs`
    passed to `onStart`. The host fills them.
- `WorkflowLibrary`'s `onCreate` becomes optional. Without it the New button is
  hidden.
- Both changes are additive. The NeuroFlow app passes neither and is unchanged.

### 1.3 `PipelineView`

A new component, `src/components/PipelineView.tsx`, rendered inside
`<div className="nf-root nf-pipeline-view">`:

```ts
interface PipelineViewProps {
  items: WorkflowLibraryItem[]
  activeId: string
  onSelect: (id: string) => void
  workflow: WorkflowDocument | null      // null while the host loads it
  tools: Map<string, ToolDefinition>
  run: HostRunState | null
  initialInputs?: Record<string, unknown>
  lockedInputs?: Record<string, string>
  runnable?: string | null               // forwarded to RunPanel
  onStart: (inputs: Record<string, unknown>) => void
  onCancel: () => void
  onOpen: (path: string) => void
  targets?: ReactNode                    // host slot, rendered above RunPanel
}
```

- **Layout:** `WorkflowLibrary` in a left column, then `WorkflowDiagram`, then
  `targets` and `RunPanel` in a right column. Below 900px the columns stack.
- **Diagram:** it is read-only. Node positions live in `PipelineView`'s own
  state, and `onBindInput`/`onAddTool` are no-ops.
- **`RunPanel` defaults:** `available` is `true`, `report` is
  `{ok: true, issues: []}`, and `environmentChecked` is `true`.
- **Tool documents:** a tool document isn't a workflow. The host wraps it with
  `wrapToolAsWorkflow` (exported, §1.4) before passing `workflow`.
- **No host knowledge:** `PipelineView` knows nothing about datasets, batches
  or MCP. The host owns those.

### 1.4 Library entry `src/lib.ts`

It exports:

- the components `PipelineView`, `WorkflowDiagram`, `WorkflowLibrary` and
  `RunPanel`, with their prop types and `HostRunState` / `HostRunStatus`.
  `RunTimeline` is left out: it renders the app's WASM preview path
  (`execution.ts`), not host runs;
- `wrapToolAsWorkflow(toolDoc): WorkflowDocument`: a one-step workflow whose
  inputs mirror the tool's inputs, bound by `ref: "inputs.<name>"`, and whose
  outputs mirror the tool's outputs;
- `buildWorkflowGraph` and `NodePositionMap`;
- `toolFromDocument` (tool document → `ToolDefinition`) and `shortType`;
- the types `WorkflowDocument`, `WorkflowLibraryItem`, `ToolDefinition` and
  `ParameterDef`;
- everything in `runTypes.ts`.

The entry must not import anything from `src/data/gallery.ts`, `host.ts`,
`execution.ts` or `@tauri-apps/*`. The tarball check in §1.7 enforces this.

### 1.5 Package folder `packages/neuroflow-react/`

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
- `README.md`: install, required CSS imports, a minimal `PipelineView` example,
  and how to fill `HostRunState` from `neuroflow-mcp`.

The app keeps importing from `src/`, and its layout doesn't change.

### 1.6 CSS

- Move the `nf-*` rules used by the exported components out of
  `src/styles/app.css` into `src/styles/components.css`, scoped under
  `.nf-root`. Include whatever BIDSvue tokens they reference from
  `bidsui.css`, declared on `.nf-root`, not `:root`. `PipelineView`'s own
  layout rules go here too.
- `app.css` imports `components.css`, and the app shell adds `nf-root` to its
  root element so the app looks the same as before.
- The package ships the file as `@cdrake/neuroflow-react/style.css`. Consumers
  also import `@xyflow/react/dist/style.css`.

### 1.7 Pre-publish check

`packages/neuroflow-react/test/consumer/` is a tiny React 19 + TypeScript app
that renders `PipelineView` from the installed tarball.

`npm run lib:check`:

1. packs the package;
2. installs the tarball into the consumer;
3. runs `tsc --noEmit` and `vite build`;
4. greps the built bundle to confirm it contains no `@tauri-apps` and no gallery
   JSON;
5. checks that the package's `dist/` contains no `host.d.ts` or
   `execution.d.ts`, and typechecks the consumer with `skipLibCheck: false` so
   the package's own declarations are checked too.

### 1.8 Publishing

Publish `0.1.0` by hand with `npm publish --access public` from
`packages/neuroflow-react`. Publishing from CI is out of scope.

## Part 2 — NeuroVue backend

### 2.1 Settings: `neuroflow.json`

The file lives in the app config folder, next to `mcp.json`:

```json
{
  "binary": "~/Dev/neuroflow/target/release/neuroflow-mcp",
  "registries": ["~/Dev/neuroflow/gallery"],
  "spec": "~/Dev/neuroflow-spec",
  "interpreters": { "node": "/opt/homebrew/bin/node", "python3": "~/.venvs/neuroflow/bin/python" }
}
```

- If the file is missing, NeuroVue writes this template the first time the
  Pipelines view opens and shows the "not set up" state.
- `~` is expanded.
- `--data-root` is not configured here. It is the same `roots` list as
  `mcp.json`, falling back to the home folder, so agents and pipelines see the
  same folders.

### 2.2 `src-tauri/src/neuroflow.rs`

`#[cfg(desktop)]`, about 150 lines, modelled on `mcp.rs`.

- **Lazy spawn.** On the first request, start `binary` with `--registry` for each
  entry, `--data-root` for each root, `--spec`,
  `--interpreter NAME=PATH`, and an explicit `--sessions ~/.neuroflow/runs` so
  NeuroVue knows where runs are written. The process uses piped stdio and
  `kill_on_drop`. After spawning, run the MCP `initialize` handshake and send
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
  - `neuroflow_status() -> {configured, running, settingsPath, stderrTail}`.
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
- `catalog()`: `neuroflow_list({runnableOnly: true})` joined by document id
  with `tools/list`, which is called once after init and cached. `tools/list`
  supplies each document's MCP tool name and `inputSchema`;
- `describe(id)`, which returns the NeuroFlow document (`neuroflow_describe`)
  for the diagram;
- `run(id, inputs, onProgress)`, which calls `tools/call` with the tool's MCP
  name and a `_meta.progressToken`. It returns `{ requestId, result: Promise<RunStructured> }`;
- `cancel(requestId)`;
- `readRun(runId)`.

The Pipelines view talks only to this module.

### 2.4 Target input and run mode

`targetInput(inputSchema): {name, kind: 'dataset' | 'volume'} | null` picks the
first **required** input whose `x-neuroflow-type` is:

- `neuro:bids-dataset` → `kind: 'dataset'`;
- `neuro:volume`, `neuro:label-map` or `neuro:mask` → `kind: 'volume'`.

It never matches on the input's name. The type vocabulary is the spec's
`schemas/0.1/common.schema.json`.

| `targetInput` | Mode | Targets |
|---|---|---|
| `dataset` | one run | `datasetRoot`. Disabled with a reason when the open dataset isn't BIDS (`bidsName` is null) |
| `volume` | one run per target | the dataset view's filtered items with a `sourcePath` and role ≠ `overlay`, or only the selected item when "Selected only" is on |
| `null` | one run | none: every input is set in the form |

The target input is passed to `PipelineView` as a `lockedInputs` entry. On
Run, NeuroVue adds it to the form's `inputs` for each target.

### 2.5 Batch queue

`src/domain/pipelineBatch.ts` is a pure reducer, so it can be tested without
the UI:

- **State:** `{ id, workflowId, startedAt, rows: BatchRow[] }`.
  - `BatchRow` is `{ target, status, progress?, runId?, error?, stderrTail?, outputs? }`.
  - `status` is `queued | running | completed | failed | cancelled`.
- **Events:** `start(targets)`, `progress(i, …)`, `done(i, structured)`,
  `error(i, message)` and `cancelAll`.
- **The runner:** a small loop in the view starts the next `queued` row after
  the current one settles. Only one request is in flight at a time.
- **Cancel batch:** sends `neuroflow_cancel` for the running row and marks
  every `queued` row `cancelled`.
- **No stop on failure:** a failed row doesn't stop the batch.
- **Re-runs:** **Re-run failed** starts a new batch from the failed and
  cancelled rows. `neuroflow-mcp` already answers repeated identical calls from
  its fingerprint cache, so re-running everything is cheap too.
- **Display:** `RunPanel`'s `run` shows the row being viewed: the running row,
  or the row the person clicked.

### 2.6 Loading outputs

On a `completed` run, collect every `ArtifactDescriptor` in
`structured.outputs`:

- **Single run, or the batch row for the volume currently shown:** each
  `.nii`/`.nii.gz` loads through the existing `addOverlayPath` action. Anything
  else, or a load that fails, becomes a "Reveal in Finder" row. One failed
  output doesn't stop the others from loading.
- **Other batch rows:** nothing loads automatically. The row has "Reveal" and
  "Show", which opens that target volume and loads its outputs.

Layers groups each run's loaded overlays under a collapsible header,
**Run: <title> · <HH:MM>**. Collapsing it hides those rows. Its "Reveal run"
button opens the run's session folder (`<sessions>/<runId>/`, which holds
`run.json` with params and logs). The overlay-id → run map lives in App state
only and isn't saved. "Working derivatives" isn't touched: outputs register
with role `overlay`, and `isDerivedItem` excludes overlays.

## Part 3 — NeuroVue UI

### 3.1 Placement

- **The switch:** the left pane of the split workspace (`.nv-dataset-pane`,
  which now holds `DatasetDesktop`) gets a **Dataset | Pipelines** switch at
  the top. Pipelines replaces `DatasetDesktop` in that pane.
- **Unchanged:** the viewer on the right and the dataset filter sidebar stay
  live, so the filters set the volume targets.
- **Other entry points:**
  - View › **Pipelines**;
  - a **Run pipeline on this volume…** button in the Operations tab, below
    niimath. It switches to Pipelines with "Selected only" on.
- **Desktop only:** the switch, the menu item and the button render only when
  the `neuroflow_status` command exists. On iPad the pane shows the dataset
  alone.

### 3.2 `PipelineViewHost` (`src/components/PipelineViewHost.tsx`)

This is NeuroVue's wrapper around `PipelineView`:

- it loads `client.catalog()` into `items`, and `client.describe(activeId)` into
  `workflow`, wrapping tools with `wrapToolAsWorkflow`;
- it computes `targetInput` and the targets (§2.4), and passes the
  `lockedInputs` label: "Dataset root", "12 target volumes" or "Selected
  volume";
- it renders the `targets` slot:
  - a **Targets** strip: the mode, the count, a "Selected only" toggle and the
    first few target names;
  - the batch rows, each with its status, progress, Reveal and Show;
  - Cancel batch and Re-run failed;
- it runs the queue (§2.5), keeps one `HostRunState` per row with
  `reduceRunState`, and loads outputs (§2.6);
- it shows the setup state when NeuroVue isn't configured, and the process
  error state with Restart (see Error handling);
- it imports `@xyflow/react/dist/style.css` and
  `@cdrake/neuroflow-react/style.css`.

`src/domain/neuroflowHostState.ts` has
`reduceRunState(prev: HostRunState | null, ev: RunEv): HostRunState`, which
maps start, progress, done, error and cancelled events to `HostRunState`. On
`done`, `finished` is built from `structuredContent` plus `readRun(runId)` for
`sessionDir` and `record`. `stderrTail` is `structured.logs?.stderr ?? null`.

## Error handling

| Failure | What the person sees |
|---|---|
| `neuroflow.json` is missing, or the binary isn't there | "NeuroFlow isn't set up", the expected path, and a "Reveal settings file" button |
| The process exits or `initialize` fails | Error state with the stderr tail and a "Restart" button. Waiting requests are rejected, so nothing hangs. In a batch the running row is marked `failed` and the batch continues; the next row's request respawns the process |
| A target or input is outside the data roots | That row is rejected before it runs, with the same "add a folder to roots" message agents get. The rest of the batch continues |
| A run ends `failed` | That row shows `failedStep`, `error` and the stderr tail. Nothing is loaded |
| Cancel batch | The running row is cancelled, queued rows become `cancelled`. On app quit the child is killed |
| An output won't load as an overlay | That output gets a "Reveal in Finder" row. The others still load |
| A dataset pipeline on a non-BIDS folder | Run is disabled, with "needs a BIDS dataset" |
| Zero targets after filtering | Run is disabled, with "no volumes match the filters" |

## Testing

- **Rust (`neuroflow.rs`)**: unit tests for routing JSON-RPC lines (responses out
  of order, notifications, a broken line, rejecting waiting requests when the
  process exits) and for building the arguments from settings plus the roots. No
  real process.
- **TS, pure modules:**
  - `neuroflowClient.ts` against a fake `invoke`: catalog join, run, cancel;
  - `targetInput`: matches by type not name, skips optional inputs, `null` when
    nothing matches;
  - `pipelineBatch.ts`: serial order, failure continues, cancel marks queued
    rows, re-run-failed picks failed and cancelled rows;
  - `reduceRunState`.
- **Package**: `npm run lib:check` (§1.7), plus a `PipelineView` render test in
  the neuroflow repo checking `lockedInputs` hides the field and is left out of
  `onStart`.
- **Integration**: one test, skipped when the binary is missing. It spawns the
  real `neuroflow-mcp --registry ~/Dev/neuroflow/gallery`, runs
  `python-volume-filter` on a fixture NIfTI, and checks that a NIfTI output
  path comes back.
- **Manual**: on `~/Dev/neurovue-stat-demo`:
  - filter to 3 volumes and run `python-volume-filter`. Expected: 3 rows
    complete in order, and the shown volume's overlay loads;
  - cancel mid-batch;
  - on a BIDS dataset, run a `neuro:bids-dataset` tool once.

## Order of work

1. neuroflow repo, Part 1, then publish `@cdrake/neuroflow-react@0.1.0`.
2. NeuroVue Part 2, the backend, client, target input and batch reducer.
3. NeuroVue Part 3, the Dataset | Pipelines switch and `PipelineViewHost`.
4. The Operations button, and output grouping in Layers.

## Out of scope

- Parallel runs. That would need a pool of `neuroflow-mcp` processes.
- Run history inside NeuroVue (sessions already live in `~/.neuroflow/runs`).
  Run headers in Layers and batch rows last only for the session.
- Registering outputs as derived items with `derivedFrom`, so they'd show up
  in "Working derivatives".
- Editing workflows in NeuroVue.
- Using the spec's `forEach` step iteration for batches. NeuroVue fans out
  host-side instead.
- iOS/iPad.
- Bundling `neuroflow-mcp`.
- Publishing from CI.
