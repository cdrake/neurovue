# NeuroVue Pipeline View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Pipelines view to NeuroVue desktop. It runs a NeuroFlow tool or
workflow once on the dataset root, or once per filtered volume, and loads the
outputs back into the viewer.

**Architecture:** The neuroflow repo publishes `@medview/neuroflow-react`. Its
`PipelineView` combines the existing library, diagram and run panel and is
driven entirely by props. NeuroVue's Rust side spawns a locally installed
`neuroflow-mcp` and relays JSON-RPC over stdio. A TS client and pure reducers
(target input, serial batch, run state) feed `PipelineViewHost`, which replaces
`DatasetDesktop` in the left pane when the person switches to Pipelines.

**Tech Stack:** Rust (Tauri 2, tokio, serde_json); React 19 + TS + bun (NeuroVue);
React 18 + Vite library mode (neuroflow); MCP over stdio.

**Spec:** `docs/superpowers/specs/2026-11-06-neuroflow-launcher-design.md` (the
pipeline view design). Read it first. Section numbers (§) below refer to it.

## Global Constraints

- NeuroVue's backend and UI entry points are desktop-only: `#[cfg(desktop)]` in
  Rust. The UI checks for the command and hides itself when it's absent. Nothing
  on the iOS path depends on it.
- No bundling of `neuroflow-mcp`. Everything comes from `neuroflow.json` in the
  app config dir, next to `mcp.json`.
- `--data-root` = `mcp.json` `roots`, falling back to the home folder. Do not add
  a separate roots setting.
- Package: `@medview/neuroflow-react@0.1.0`, ESM only.
  - Peer dependencies: `react` and `react-dom` at `^18.3 || ^19`, and
    `@xyflow/react` at `^12`.
  - Dependency: `lucide-react`.
  - License `MIT OR Apache-2.0`.
- The package entry must not reach `src/data/gallery.ts`, `src/domain/host.ts`,
  `src/domain/execution.ts` or `@tauri-apps/*`. That applies to the JS and to
  the `.d.ts` files.
- Exported components return `React.JSX.Element`, not `JSX.Element`.
- Package CSS is scoped under `.nf-root`, including the BIDSvue tokens it uses.
- `PipelineView` knows nothing about datasets, batches or MCP (§1.3).
- Batches run serially: one `tools/call` in flight at a time (`neuroflow-mcp`
  handles requests in order).
- No new build dependencies in either repo. Don't fork `nv-mcp`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Repos:
  - neuroflow: `~/Dev/neuroflow`, on a new branch `feat/neuroflow-react` from
    `main`;
  - NeuroVue: `~/Dev/neurovue`, on branch `feat/neuroflow-launcher`.

## Review Focus

1. **A pipeline takes the volume under a differently named input.** For
   example, `python-volume-filter` takes its volume as `input`, not `volume`.
   `targetInput` must match on `x-neuroflow-type`, never on the name. Test in
   Task 8.
2. **The person switches back to Dataset, or picks another pipeline, while a
   batch runs.** The batch must keep running and its rows must survive.
   `PipelineViewHost` stays mounted once opened (hidden, not unmounted), and the
   batch carries its own `workflowId` and entry, so picking another pipeline
   doesn't touch it. Manual check in Task 9.
3. **The filters change during a batch.** The targets are a snapshot taken at
   `startBatch`. Later filter changes don't add or drop rows. Test in Task 8.
4. **`neuroflow-mcp` crashes mid-batch, or writes a non-JSON line.** The
   reader skips bad lines. On exit, the running row fails and the next row
   respawns the process. Tests in Task 6 (`classify`, `fail_all`) and Task 8
   (an error row doesn't stop the queue).
5. **The volume path is `.nii.gz`, or has spaces or non-ASCII characters.** The
   path must reach `neuroflow-mcp` byte-for-byte. Output loading must recognise
   `.nii.gz` as NIfTI. Tests in Task 6 (args) and Task 7 (`isNifti`).

---

# Part 1 — neuroflow repo (`~/Dev/neuroflow`)

### Task 1: Cut the package leaks

**Files:**
- Create: `src/domain/runTypes.ts`
- Modify:
  - `src/domain/host.ts`: move the types out and re-export them;
  - `src/domain/neuroflow.ts`: add `idTail`;
  - `src/data/gallery.ts`: re-export `idTail` from `../domain/neuroflow`;
  - `src/components/RunPanel.tsx`, `src/components/WorkflowDiagram.tsx`,
    `src/components/WorkflowLibrary.tsx` and `src/domain/graph.ts`: import from `./runTypes` / `../domain/runTypes` and
    `idTail` from `../domain/neuroflow`. Change `JSX.Element` to
    `React.JSX.Element` (add `import type React from 'react'` where needed).
- Test: `tests/ui/packageBoundary.test.ts`

**Interfaces:**
- Produces: `src/domain/runTypes.ts` exporting `ArtifactDescriptor`,
  `RunStepRecord`, `RunRecord`, `RunStructured`, `RunFinishedEvent`,
  `ToolStatus`, `ToolReadiness` and `isArtifactDescriptor(value: unknown): value is ArtifactDescriptor`.
  It also produces `idTail(id: string): string` in `src/domain/neuroflow.ts`.
  The definitions are moved verbatim and do not change.

- [ ] **Step 1: Create the branch.** `git switch -c feat/neuroflow-react main`

- [ ] **Step 2: Write the failing test** `tests/ui/packageBoundary.test.ts`.
  It reads the sources with `fs` and asserts:
  - `src/domain/runTypes.ts` exists and has no `@tauri-apps` import;
  - none of `RunPanel.tsx`, `WorkflowDiagram.tsx`, `WorkflowLibrary.tsx` or
    `graph.ts` contains
    `from '../domain/host'`, `from './host'`, `from '../data/gallery'` or
    `JSX.Element` that is not preceded by `React.`.

- [ ] **Step 3: Run it to see it fail.** Run `npm run test:ui`. Expected: FAIL in
  `packageBoundary`.

- [ ] **Step 4: Make the moves listed under Files.**

- [ ] **Step 5: Verify.** Run `npm run test:ui && npm run build`. Expected: all
  tests PASS, and `tsc` and `vite build` succeed.

- [ ] **Step 6: Commit.** Message: `refactor: split run types and idTail out of host and gallery`.

### Task 2: Scope the component CSS under `.nf-root`

**Files:**
- Create: `src/styles/components.css`
- Modify:
  - `src/styles/app.css`: remove the moved rules and add
    `@import './components.css';` at the top;
  - `src/App.tsx:654`: change `<main className="nf-shell">` to
    `<main className="nf-shell nf-root">`.

**Interfaces:**
- Produces: `src/styles/components.css`. Every selector starts with `.nf-root`.
  Any `--` custom properties those rules read are declared on `.nf-root`, copied
  from `bidsui.css`.

- [ ] **Step 1: Find the class names the components use.** Grep `className=` in
  `RunPanel.tsx`, `WorkflowDiagram.tsx`, `WorkflowLibrary.tsx` and `graph.ts`, plus the xyflow node
  classes they set. Move every `app.css` rule whose selector uses one of those
  classes into `components.css`, and prefix each selector with `.nf-root `.
  Copy the `var(--…)` tokens those rules use from `bidsui.css` into a
  `.nf-root { … }` block. Keep the originals in `bidsui.css` for the rest of the
  app.

- [ ] **Step 2: Verify that nothing looks different.** Run `npm run dev`, open the
  builder, load the `filter-qa` workflow, and compare the diagram and Run panel
  with `main`. Expected: identical. Then run `npm run build`. Expected: success.

- [ ] **Step 3: Commit.** Message: `refactor: scope the exported components' CSS under .nf-root`.

### Task 3: `PipelineView`, `RunPanel` props and `wrapToolAsWorkflow`

**Files:**
- Create:
  - `src/components/PipelineView.tsx`
  - `src/domain/runInputs.ts`
  - `src/domain/wrapTool.ts`
- Modify:
  - `src/components/RunPanel.tsx`: add `initialInputs` and `lockedInputs`, and
    use the `runInputs.ts` helpers in place of the inline `missing` and `start`
    logic;
  - `src/components/WorkflowLibrary.tsx`: make `onCreate` optional and hide
    New when it's absent;
  - `src/styles/components.css`: add the `.nf-root .nf-pipeline-view` grid,
    stacking below 900px.
- Test: `tests/ui/pipelineView.test.ts`

**Interfaces:**
- Consumes the Task 1 types.
- Produces:
  - in `runInputs.ts`:
    - `seedValues(stored: Record<string, string>, initial?: Record<string, unknown>): Record<string, string>`:
      `initial` wins for the keys it sets, stringified (strings stay as they
      are, everything else goes through `JSON.stringify`);
    - `missingInputs(workflow: WorkflowDocument, values: Record<string, string>, locked?: Record<string, string>): string[]`:
      today's rule, with locked inputs skipped;
    - `buildPayload(workflow: WorkflowDocument, values: Record<string, string>, locked?: Record<string, string>): Record<string, unknown>`:
      today's `start` body, with locked inputs left out;
  - `RunPanelProps` gains `initialInputs?: Record<string, unknown>` and
    `lockedInputs?: Record<string, string>`. A locked input renders its label
    in place of the field;
  - `wrapToolAsWorkflow(toolDoc: unknown): WorkflowDocument` in `wrapTool.ts`
    (§1.4). Its id is the tool's id, and the single step id is the tool id's
    tail;
  - `PipelineView` and `PipelineViewProps`, exactly as in §1.3.

- [ ] **Step 1: Write the failing tests** in `tests/ui/pipelineView.test.ts`.
  - `seedValues lets initial win and stringifies non-strings`:
    `seedValues({a:'1', b:'x'}, {b:'y', c:3})` →
    `{a:'1', b:'y', c:'3'}`.
  - `missingInputs skips locked inputs`: a workflow with required `input` and
    `sigma`, values `{sigma:'2'}` and locked `{input:'3 volumes'}` → `[]`.
    Without `locked` → `['input']`.
  - `buildPayload leaves locked inputs out`.
  - `wrapToolAsWorkflow binds every tool input by ref and exposes every output`.
    Use `gallery/tools/python-volume-filter.tool.json`. Each step input is
    `{ref: 'inputs.<name>'}`, and `Object.keys(wf.outputs)` equals the tool's
    output names.
  - `PipelineView renders library, diagram slot, targets and locked label`:
    `renderToStaticMarkup` from `react-dom/server` over a `PipelineView` with
    one item, the wrapped workflow, `run={null}`, `lockedInputs={{input: '3 volumes'}}`
    and `targets` set to a `<p>TARGETS</p>` element. Build elements with
    `createElement`, since `test:ui` bundles `*.test.ts` files, not `.tsx`. The markup contains `TARGETS` and
    `3 volumes`, and has no `<input name="input"`. Guard the `localStorage`
    access in `RunPanel` with `typeof localStorage !== 'undefined'` so it
    renders under node. If `@xyflow/react` won't render under node, assert on
    `RunPanel` (locked label, no field) and `WorkflowLibrary` (no New button
    without `onCreate`) directly, and leave the diagram to the Task 4
    consumer build.

- [ ] **Step 2: Run them to see them fail.** Run `npm run test:ui`. Expected:
  FAIL in `pipelineView`.

- [ ] **Step 3: Implement** the helpers, the props, and `PipelineView` as in §1.3.

- [ ] **Step 4: Verify.** Run `npm run test:ui && npm run build`. Expected:
  PASS. Then run `npm run dev` and load `filter-qa`. Expected: the builder looks
  and behaves as before, and the Run panel still remembers inputs.

- [ ] **Step 5: Commit.** Message: `feat: PipelineView and locked/initial run inputs`.

### Task 4: Library entry, package and pre-publish check

**Files:**
- Create:
  - `src/lib.ts`
  - `packages/neuroflow-react/package.json`
  - `packages/neuroflow-react/vite.config.ts`
  - `packages/neuroflow-react/tsconfig.lib.json`
  - `packages/neuroflow-react/README.md`
  - `packages/neuroflow-react/scripts/check.mjs`
  - `packages/neuroflow-react/test/consumer/{package.json,tsconfig.json,index.html,main.tsx}`
- Modify: root `package.json` scripts. Add:
  - `lib:build`: `vite build -c packages/neuroflow-react/vite.config.ts && tsc -p packages/neuroflow-react/tsconfig.lib.json`
  - `lib:check`: `npm run lib:build && node packages/neuroflow-react/scripts/check.mjs`

**Interfaces:**
- Consumes: Task 1 `runTypes.ts`; Task 3 `PipelineView`, `PipelineViewProps` and
  `wrapToolAsWorkflow`; `toolFromDocument` from `src/data/documents.ts`.
- Produces, as the `@medview/neuroflow-react` exports:
  - the components `PipelineView`, `WorkflowDiagram`, `WorkflowLibrary` and
    `RunPanel`, with the prop types `PipelineViewProps`,
    `WorkflowDiagramProps`, `WorkflowLibraryProps` and `RunPanelProps`;
  - `wrapToolAsWorkflow`;
  - `HostRunState` and `HostRunStatus`;
  - `buildWorkflowGraph` and `NodePositionMap`;
  - `toolFromDocument` and `shortType`;
  - the types `WorkflowDocument`, `WorkflowLibraryItem`, `ToolDefinition` and
    `ParameterDef`;
  - all of `runTypes.ts`.

  It also produces `@medview/neuroflow-react/style.css`, built from
  `src/styles/components.css`.

  `WorkflowDiagramProps`, `WorkflowLibraryProps` and `RunPanelProps` need
  `export` added where they are declared.

- [ ] **Step 1: Write the check script** `scripts/check.mjs`. It fails (non-zero
  exit with a message) unless all of these hold:
  1. `dist/` contains `index.js`, `index.d.ts` and `style.css`;
  2. no file under `dist/` matches `/@tauri-apps|gallery\/tools|\.tool\.json/`;
  3. there is no `dist/**/host.d.ts`, `execution.d.ts` or `gallery.d.ts`;
  4. after `npm pack` into a temp dir, then `npm install <tgz>` in
     `test/consumer`, both `npx tsc --noEmit` (consumer tsconfig has
     `skipLibCheck: false`, React 19 types) and `npx vite build` succeed in
     `test/consumer`.

  The consumer's `main.tsx` renders a `PipelineView` with one library item, the
  workflow from `wrapToolAsWorkflow` over an inline tool document, `run={null}`,
  a `lockedInputs` entry and a `targets` node, and imports both CSS files.

- [ ] **Step 2: Run it to see it fail.** Run `npm run lib:check`. Expected: FAIL
  (the package doesn't exist yet).

- [ ] **Step 3: Write the package files.**
  - `src/lib.ts`: the exports listed under Interfaces.
  - `package.json`: exactly what Global Constraints says, plus
    `"exports": {".": {"types": "./dist/index.d.ts", "import": "./dist/index.js"}, "./style.css": "./dist/style.css"}`,
    `"files": ["dist"]` and `"sideEffects": ["*.css"]`.
  - `vite.config.ts`:
    - `build.lib` with entry `../../src/lib.ts`, `formats: ['es']` and
      `fileName: 'index'`;
    - `outDir: packages/neuroflow-react/dist`;
    - `rollupOptions.external`: react, react-dom, `react/jsx-runtime`,
      `@xyflow/react` and `lucide-react`;
    - `cssCodeSplit: false`;
    - `components.css` imported from `src/lib.ts` so it emits as `style.css`.
  - `tsconfig.lib.json`: extends the root config, with `noEmit: false`,
    `declaration: true`, `emitDeclarationOnly: true`, `rootDir: ../../src`,
    `outDir: dist`, `files: [../../src/lib.ts]` and
    `types: ["vite/client"]`.
  - `README.md`: install, the two CSS imports, the consumer example, and how
    to fill `HostRunState` from `neuroflow-mcp` (§1.5).

- [ ] **Step 4: Verify.** Run `npm run lib:check`. Expected: exits 0. Fix leaks
  at their source, not by loosening the check.

- [ ] **Step 5: Commit.** Message: `feat: publishable @medview/neuroflow-react package`.
  Add `packages/neuroflow-react/dist` and `test/consumer/node_modules` to
  `.gitignore`.

### Task 5: Publish 0.1.0 (needs the owner)

- [ ] **Step 1: Run `npm run lib:check` again.** Expected: exits 0.
- [ ] **Step 2: Publish.** Ask the owner to run
  `! cd ~/Dev/neuroflow/packages/neuroflow-react && npm publish --access public`.
  It needs their npm login and 2FA, so don't run it yourself.
- [ ] **Step 3: Verify.** Run `npm view @medview/neuroflow-react version`.
  Expected: `0.1.0`.
- [ ] **Step 4: Push the branch and open a PR in `cdrake/neuroflow`.**

---

# Part 2 — NeuroVue backend (`~/Dev/neurovue`)

### Task 6: `neuroflow.rs`: settings, spawn and JSON-RPC relay

**Files:**
- Create: `src-tauri/src/neuroflow.rs`
- Modify `src-tauri/src/lib.rs`:
  - add `#[cfg(desktop)] mod neuroflow;`;
  - `.manage(neuroflow::NeuroflowState::default())` in the desktop builder
    block;
  - register the commands in the desktop `generate_handler!` list, next to the
    `mcp::` entries;
  - call `neuroflow::stop(_app)` beside `mcp::stop(_app)` in
    `RunEvent::Exit`.
- Modify `src-tauri/src/mcp.rs`: make `allowed_roots` and `resolve_in_roots`
  `pub(crate)`.
- Test: `#[cfg(test)] mod tests` inside `neuroflow.rs`.

**Interfaces:**
- Consumes: `mcp::allowed_roots(app) -> Vec<PathBuf>` and
  `mcp::resolve_in_roots(&Path, &[PathBuf]) -> Result<PathBuf, String>`.
- Produces these Tauri commands, all `async`, returning `Result<_, String>`:
  - `neuroflow_status() -> NeuroflowStatus`, where `NeuroflowStatus` is
    `{ configured: bool, running: bool, settingsPath: String, stderrTail: Vec<String> }`
    (camelCase via serde);
  - `neuroflow_request(method: String, params: Value) -> Value`: returns the
    JSON-RPC `result`; an `error` member becomes `Err(message)`. It also emits
    the event `neuroflow:request-id` `{ requestId: u64 }` *before* writing, so
    the UI can cancel;
  - `neuroflow_cancel(request_id: u64)`;
  - `neuroflow_restart()`;
  - `neuroflow_read_run(run_id: String) -> { sessionDir: String, record: Value }`;
  - `neuroflow_check_path(path: String) -> String`: the canonical path, or the
    roots error.
- Emits the event `neuroflow:progress` with the `params` of
  `notifications/progress`, unchanged.
- Pure functions, unit-tested:
  - `fn build_args(s: &Settings, roots: &[PathBuf], sessions: &Path) -> Vec<OsString>`;
  - `enum Line { Response { id: u64, result: Result<Value, String> }, Progress(Value), Other }` and
    `fn classify(line: &str) -> Line`;
  - `fn valid_run_id(id: &str) -> bool`;
  - `struct Pending` (`HashMap<u64, oneshot::Sender<Result<Value, String>>>`),
    with `insert`, `resolve(id, r) -> bool` (`false` when the id is unknown) and
    `fail_all(msg)`.
- `Settings`: `{ binary, registries: Vec<String>, spec: Option<String>, interpreters: BTreeMap<String,String> }`.
  `~` is expanded. The template is the §2.1 JSON. Sessions dir is `~/.neuroflow/runs`.

- [ ] **Step 1: Write the failing tests.**
  - `build_args_passes_paths_verbatim`: given the registry
    `/Data/my lab/ü.gallery`, roots `["/Data/my lab"]`, interpreters
    `{node: /opt/homebrew/bin/node}`, spec `None` and sessions
    `/h/.neuroflow/runs`, it expects exactly
    `["--registry","/Data/my lab/ü.gallery","--data-root","/Data/my lab","--sessions","/h/.neuroflow/runs","--interpreter","node=/opt/homebrew/bin/node"]`.
  - `build_args_includes_spec_when_set`: `--spec` followed by the path appears
    once.
  - `classify_response_ok` / `classify_response_error`:
    `{"jsonrpc":"2.0","id":7,"result":{"a":1}}` gives `Response{id:7, Ok({"a":1})}`;
    `{"jsonrpc":"2.0","id":7,"error":{"code":-1,"message":"boom"}}` gives
    `Response{id:7, Err("boom")}`.
  - `classify_progress`: a `notifications/progress` line gives `Progress(params)`.
  - `classify_garbage`: `"Loading registry…"`, `"{\"jsonrpc\":"` and `""` all
    give `Other`.
  - `pending_routes_out_of_order`: insert 1 and 2, resolve 2 then 1, and each
    receiver gets its own value.
  - `pending_drops_unknown_and_cancelled`: `resolve(99, …)` returns `false`.
    After a request is cancelled (removed), its late response returns `false`
    and doesn't panic.
  - `pending_fail_all`: both waiting receivers get
    `Err("neuroflow-mcp exited: …")`.
  - `run_id_must_be_one_segment`: `"run-2026"` is valid; `"../x"`, `"a/b"` and
    `""` are not.

- [ ] **Step 2: Run them to see them fail.** Run
  `cd src-tauri && cargo test neuroflow`. Expected: compile errors or FAIL.

- [ ] **Step 3: Implement the pure functions, then the process glue.**
  - Spawn with `tokio::process::Command`, piped stdio and
    `kill_on_drop(true)`. Do it lazily inside `neuroflow_request` while holding
    a `tokio::sync::Mutex<Option<Child…>>`.
  - On first spawn, send `initialize` with
    `{protocolVersion:"2025-06-18", capabilities:{}, clientInfo:{name:"neurovue",version}}`,
    then `notifications/initialized`.
  - A stdout reader task runs `classify`:
    - `Response` goes to `Pending::resolve`;
    - `Progress` goes to `app.emit("neuroflow:progress", params)`;
    - `Other` goes to `log::debug`.

    When stdout closes, call `fail_all` with the stderr tail and clear the child.
  - A stderr reader keeps the last 200 lines.
  - `neuroflow_cancel` removes the id from `Pending` and writes
    `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id}}`.
  - `neuroflow_status` writes the template when the file is missing.
    `configured` is true when the file parses and the binary exists.

- [ ] **Step 4: Verify.** Run `cd src-tauri && cargo test neuroflow && cargo clippy --all-targets`.
  Expected: PASS with no new warnings.

- [ ] **Step 5: Add an integration test** `real_server_lists_tools`, marked
  `#[ignore]`. It runs only when `NEUROFLOW_MCP_BIN` and `NEUROFLOW_GALLERY` are
  set. It spawns via the same glue, without Tauri (factor spawn plus relay
  behind a struct that takes an `emit` closure), sends `tools/list`, and asserts
  that the list contains a name starting with `neuroflow.gallery.tools.`.
  Run: `NEUROFLOW_MCP_BIN=~/Dev/neuroflow/target/release/neuroflow-mcp NEUROFLOW_GALLERY=~/Dev/neuroflow/gallery cargo test neuroflow -- --ignored`.
  Expected: PASS. Build the binary first with
  `cargo build --release -p neuroflow-mcp` in `~/Dev/neuroflow`.

- [ ] **Step 6: Commit.** Message: `feat: relay to a local neuroflow-mcp from the desktop app`.

### Task 7: `neuroflowClient.ts`

**Files:**
- Create: `src/domain/neuroflowClient.ts`
- Modify: `package.json`: `bun add @medview/neuroflow-react@^0.1.0 @xyflow/react@^12`.
  This needs Task 5's publish. Until then, a `file:` path to the Task 4
  tarball is an acceptable stand-in, switched to `^0.1.0` before the PR.
  Task 6 doesn't need the package.
- Test: `src/domain/neuroflowClient.test.ts`, run with `bun test`.

**Interfaces:**
- Consumes the Task 6 commands and events, and the run types from
  `@medview/neuroflow-react` (Task 5).
- Produces:

```ts
export type NeuroflowStatus = { configured: boolean; running: boolean; settingsPath: string; stderrTail: string[] }
export type CatalogEntry = { id: string; kind: 'tool' | 'workflow'; title: string; description: string; mcpName: string; inputSchema: JsonSchema }
export type RunHandle = { requestId: Promise<number>; result: Promise<RunStructured>; progressToken: string }
export interface NeuroflowClient {
  status(): Promise<NeuroflowStatus>
  catalog(): Promise<CatalogEntry[]>  // tools/list (cached) ⋈ neuroflow_list({runnableOnly:true}) by id
  describe(id: string): Promise<unknown>                  // neuroflow_describe → document
  run(entry: CatalogEntry, inputs: Record<string, unknown>, onProgress: (p: { progress: number; total?: number; message?: string }) => void): RunHandle
  cancel(requestId: number): Promise<void>
  readRun(runId: string): Promise<{ sessionDir: string; record: RunRecord }>
  checkPath(path: string): Promise<string>
}
export function createNeuroflowClient(deps?: { invoke?: typeof invoke; listen?: typeof listen }): NeuroflowClient
export function isAvailable(): Promise<boolean>   // false off desktop: neuroflow_status rejects as unknown command
export function isNifti(path: string): boolean    // .nii or .nii.gz, case-insensitive
export function outputArtifacts(s: RunStructured): ArtifactDescriptor[]  // flattens outputs, incl. arrays
```

  `RunStructured`, `RunRecord` and `ArtifactDescriptor` are imported (as types)
  from `@medview/neuroflow-react`.

  Look up the exact `neuroflow_list` / `neuroflow_describe` argument names and
  result shapes in `~/Dev/neuroflow/crates/neuroflow-mcp/src/server.rs` (around
  lines 280–300 and 740–800). Tool results arrive as MCP `CallToolResult`: read
  `structuredContent`, and treat `isError: true` as a rejection carrying the
  `content[0].text`.

- [ ] **Step 1: Write the failing tests**, with a fake `invoke` / `listen`.
  - `catalog joins tools/list and neuroflow_list by id`. `tools/list` returns 3
    tools and `neuroflow_list` returns 2 ids. The result has 2 entries carrying
    `mcpName` and `inputSchema`, and `tools/list` is called once across two
    `catalog()` calls.
  - `run sends a unique progressToken and routes progress to its own run`. Start
    two runs and emit progress for the second one's token. Only the second
    run's `onProgress` fires.
  - `run rejects on isError with the tool text`.
  - `cancel invokes neuroflow_cancel with the request id`.
  - `isNifti`: true for `a.nii`, `B.NII.GZ` and `/x/my scan.nii.gz`; false for
    `a.nii.gz.json` and `a.mgz`.
  - `outputArtifacts flattens nested arrays and skips non-artifacts`.

- [ ] **Step 2: Run them to see them fail.** Run
  `bun test src/domain/neuroflowClient.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Verify.** Run `bun test src/domain/neuroflowClient.test.ts && npm run typecheck`.
  Expected: PASS.

- [ ] **Step 5: Commit.** Message: `feat: typed client for neuroflow-mcp`.

### Task 8: Pure modules: target input, run state, batch, overlay grouping

**Files:**
- Create:
  - `src/domain/pipelineTargets.ts`
  - `src/domain/neuroflowHostState.ts`
  - `src/domain/pipelineBatch.ts`
  - `src/domain/overlayRuns.ts`
- Test: one `*.test.ts` file beside each, run with `bun test`.

**Interfaces:**
- Consumes the Task 7 client types, plus `HostRunState`, `RunStructured` and
  `RunRecord` from `@medview/neuroflow-react`, and `DesktopItem` from
  `src/domain/desktop.ts`.
- Produces, in `pipelineTargets.ts`:
  - `targetInput(inputSchema: JsonSchema): { name: string; kind: 'dataset' | 'volume' } | null`
    (§2.4);
  - `type BatchTarget = { key: string; label: string; path: string; itemId: string | null }`;
  - `resolveTargets(kind: 'dataset' | 'volume', ctx: { datasetRoot: string | null; bidsName: string | null; filtered: DesktopItem[]; selected: DesktopItem | null; selectedOnly: boolean }): { targets: BatchTarget[]; blocker: string | null }`.
    The blockers are `'needs a BIDS dataset'` and
    `'no volumes match the filters'`. Volume targets are items with a
    `sourcePath` and role ≠ `'overlay'`.
- Produces, in `neuroflowHostState.ts`:
  - `type RunEv = {type:'start', workflowId} | {type:'progress', progress, total?, message?} | {type:'done', structured: RunStructured, sessionDir: string, record: RunRecord} | {type:'error', message: string} | {type:'cancelled'}`;
  - `reduceRunState(prev: HostRunState | null, ev: RunEv): HostRunState`:
    - `start` gives `'starting'`;
    - `progress` gives `'running'`;
    - `done` sets `status` from `structured.status`, and `finished` to
      `{ticket:'', ok: status==='completed', runId, status, structured, summary:'', sessionDir, record}`;
    - `error` gives `'failed'` with `error` set;
    - `cancelled` gives `'cancelled'`;
    - `stderrTail` is `structured.logs?.stderr ?? null`.
- Produces, in `pipelineBatch.ts`:
  - `type RowStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'`;
  - `type BatchRow = { target: BatchTarget; status: RowStatus; run: HostRunState | null }`;
  - `type Batch = { id: string; workflowId: string; title: string; startedAt: number; inputs: Record<string, unknown>; rows: BatchRow[] }`;
  - `startBatch(workflowId: string, title: string, inputs: Record<string, unknown>, targets: BatchTarget[], now: number): Batch`.
    It copies `inputs` and `targets`;
  - `reduceBatch(b: Batch, ev: {type:'row', index: number, ev: RunEv} | {type:'cancelQueued'}): Batch`.
    Row status follows the row's `run.status`. `cancelQueued` turns every
    `queued` row into `cancelled`;
  - `nextQueued(b: Batch): number | null`. It returns `null` while any row is
    `running`;
  - `retryTargets(b: Batch): BatchTarget[]`: the targets of failed and
    cancelled rows.
- Produces, in `overlayRuns.ts`:
  - `type RunTag = { runId: string; title: string; startedAt: number; sessionDir: string }`;
  - `groupOverlaysByRun<T extends {id: string}>(items: T[], runs: Record<string, RunTag>): Array<{tag: RunTag | null; items: T[]}>`.
    It keeps first-appearance order, and consecutive untagged items share one
    `null` group.

- [ ] **Step 1: Write the failing tests.**
  - `targetInput matches by type not name`. Required
    `input: {x-neuroflow-type: neuro:volume}` and optional
    `volume: {type: string}` give `{name:'input', kind:'volume'}`.
  - `targetInput skips optional inputs and returns null when nothing matches`.
  - `targetInput maps bids-dataset to dataset, and label-map and mask to volume`.
  - `resolveTargets`:
    - a dataset on a non-BIDS folder gives the BIDS blocker;
    - overlays and items without a `sourcePath` are skipped;
    - `selectedOnly` gives one target;
    - zero filtered items gives the filters blocker.
  - `reduceRunState`:
    - start→progress→done(completed) gives `'completed'`, with
      `finished.record` set and `progress`/`total` from the last progress
      event;
    - done(failed) sets `stderrTail` from `structured.logs.stderr`;
    - cancelled after progress gives `'cancelled'`.
  - `batch runs serially`: after `startBatch` with 3 targets, `nextQueued` is 0.
    After row 0 starts, it's `null`. After row 0 completes, it's 1.
  - `batch continues after a failed row`: row 0 errors, and `nextQueued` is 1.
  - `startBatch snapshots inputs and targets`: mutating the inputs object or
    the targets array afterwards doesn't change `batch.inputs` or `rows`.
  - `cancelQueued leaves the running row alone`, and `retryTargets` returns
    the failed and cancelled rows' targets in order.
  - `groupOverlaysByRun keeps order and splits untagged runs`: items
    `[u1, a1, a2, u2, b1]` (a and b are two runs) give four groups:
    `[null:[u1]], [a:[a1,a2]], [null:[u2]], [b:[b1]]`.

- [ ] **Step 2: Run them to see them fail.** Run `bun test src/domain`.
  Expected: FAIL for the four new files.

- [ ] **Step 3: Implement the four modules.**

- [ ] **Step 4: Verify.** Run `bun test src/domain && npm run typecheck && npm run lint`.
  Expected: PASS.

- [ ] **Step 5: Commit.** Message: `feat: pipeline targets, batch queue and run-state reducers`.

---

# Part 3 — NeuroVue UI

### Task 9: Dataset | Pipelines switch and `PipelineViewHost`

**Files:**
- Create: `src/components/PipelineViewHost.tsx`
- Modify:
  - `src-tauri/src/lib.rs`: add a desktop View menu item `view-pipelines`,
    labelled "Pipelines". It goes through the existing `view-` prefix dispatch;
  - `src/hooks/useNativeMenu.ts`: add `'pipelines'` to `NativeMenuAction`;
  - `src/App.tsx`:
    - add `leftPane: 'dataset' | 'pipelines'` and `pipelinesMounted` state;
    - add a Dataset | Pipelines switch at the top of `.nv-dataset-pane`
      (~line 2099), reusing the `nv-sidepanel-tabs` markup pattern (~line
      2589). It renders only when `isAvailable()` resolves to true;
    - once Pipelines is first chosen, render `<PipelineViewHost>` in that pane
      and keep it mounted: toggle `hidden` on it and on `DatasetDesktop`
      rather than unmounting either;
    - the `pipelines` menu action switches the pane to Pipelines.
  - `src/styles.css`: the switch, and `PipelineViewHost`'s Targets strip and
    batch rows.

**Interfaces:**
- Consumes the Task 7 client and the Task 8 modules, plus `PipelineView` and
  `wrapToolAsWorkflow` from the package.
- Produces
  `<PipelineViewHost ctx={ResolveTargetsCtx minus selectedOnly} preferSelected={number} onRunOutputs(structured: RunStructured, tag: RunTag, target: BatchTarget, isShown: boolean): void onShowTarget(target: BatchTarget): void onReveal(path: string): void />`.
  - `preferSelected` is a counter. When it increments, the host turns on
    "Selected only" (Task 10 uses this).
  - `isShown` is true for single runs, and for the batch row whose
    `target.itemId` is the selected item.

- [ ] **Step 1: Implement `PipelineViewHost`** as in §3.2.
  - The runner is a `useEffect` on the batch. When `nextQueued` returns an
    index, it:
    1. runs `client.checkPath(target.path)` (a rejection becomes that row's
       `error` event);
    2. runs `client.run(entry, {...batch.inputs, [targetInput.name]: target.path}, onProgress)`;
    3. on result, calls `client.readRun(runId)`, then dispatches `done` and
       `onRunOutputs`.
  - When `targetInput` is `null`, Run starts a batch with one synthetic target
    `{key:'run', label: title, path:'', itemId: selected?.id ?? null}`. Skip
    `checkPath` and add nothing to `batch.inputs`.
  - **Cancel batch** dispatches `cancelQueued`, then `client.cancel` on the
    running row's request id.
  - Only when `batch.workflowId === activeId`: `RunPanel`'s `run` is the
    clicked row's `run`, falling back to the running row's, then the last
    row's, and the batch rows render in `targets`. Otherwise pass
    `run={null}` and show one line, "Batch running for <title>". Starting a
    new batch while one runs is blocked.
  - Setup and error states:
    - not configured: show the settings path and "Reveal settings file";
    - process error: show `stderrTail` and Restart (`neuroflow_restart`).

- [ ] **Step 2: Verify.** Run `npm run typecheck && npm run lint && npm run build`.
  Expected: PASS. Then run `npm run tauri:dev`, open
  `~/Dev/neurovue-stat-demo`, and switch to Pipelines. Expected:
  - the library lists the runnable gallery entries;
  - choosing `python-volume-filter` shows a one-step diagram and the Targets
    strip with the filtered volume count;
  - filtering to 3 volumes and pressing Run completes 3 rows in order;
  - switching to Dataset and back mid-batch keeps the batch running;
  - back on Dataset, the dataset desktop still draws, pans and resizes. If
    OpenSeadragon needs it, trigger a redraw when it's shown again.

- [ ] **Step 3: Commit.** Message: `feat: Pipelines view hosting @medview/neuroflow-react PipelineView`.

### Task 10: Outputs, run headers in Layers, and the Operations button

**Files:**
- Modify `src/App.tsx`:
  - add `addOverlayFromPath(path)`, extracted from the agent `addOverlay` body
    (~lines 1215–1224), and use it in both places;
  - add `neuroflowRuns: Record<overlayId, RunTag>` state;
  - add `handleRunOutputs`, wired to `onRunOutputs` (§2.6):
    - when `isShown`, load each NIfTI from `outputArtifacts` in sequence and
      record each new overlay id under `tag`;
    - collect failures and non-NIfTI outputs as Reveal rows, which the host
      shows on that batch row;
  - add `onShowTarget`: call `showVolume(target.itemId)`, then load that row's
    outputs as above;
  - in the Layers overlay rows (~line 2803), use `groupOverlaysByRun` to render
    a collapsible `Run: <title> · <HH:MM>` header with "Reveal run"
    (`tag.sessionDir`). Collapsing it hides that run's rows, and untagged
    overlays render as today;
  - add a "Run pipeline on this volume…" button after `<NiimathOperationsPanel>`
    (~line 2399). It sets `leftPane` to `'pipelines'` and increments
    `preferSelected`. It renders only when `isAvailable()` resolves to true.
- Modify `src/styles.css`: the run header row.

**Interfaces:**
- Consumes the Task 9 host callbacks, Task 8 `groupOverlaysByRun` and
  `RunTag`, Task 7 `isNifti` and `outputArtifacts`, and the existing reveal
  command (grep `reveal` in `src/domain/desktop.ts`).

- [ ] **Step 1: Implement the changes listed under Files.**

- [ ] **Step 2: Verify.** Run `bun test src/domain && npm run typecheck && npm run lint && npm run build`.
  Expected: PASS. Then, in `tauri:dev` on the stat demo:
  - run `python-volume-filter` on the selected volume. Expected: its output
    appears in Layers under a `Run: … · HH:MM` header, and Reveal run opens
    the session folder;
  - in a 3-volume batch, press Show on another row. Expected: that volume
    opens with its output overlaid;
  - press the Operations button. Expected: Pipelines opens with "Selected
    only" on.

- [ ] **Step 3: Commit.** Message: `feat: load pipeline outputs grouped by run, Operations entry point`.

### Task 11: Docs and hand-off

**Files:**
- Modify: `docs/mcp.md`. Add a short "Running NeuroFlow pipelines" section:
  - the `neuroflow.json` fields;
  - that `--data-root` comes from `roots`;
  - the Pipelines view and how target mode follows the pipeline's input type;
  - batches run one at a time;
  - desktop only.

- [ ] **Step 1: Write the section.**
- [ ] **Step 2: Verify.** Run
  `npm run typecheck && npm run lint && bun test src/domain && (cd src-tauri && cargo test)`.
  Expected: all PASS.
- [ ] **Step 3: Commit,** then push `feat/neuroflow-launcher` and open a PR. Its
  body lists the manual checklist from spec §Testing for the owner.
