# NeuroFlow Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch NeuroFlow tools and workflows on the current volume from NeuroVue
desktop. Two UIs (A native, B `@cdrake/neuroflow-react`) are built behind a switch
for a hands-on A/B comparison.

**Architecture:** NeuroVue's Rust side spawns a locally installed `neuroflow-mcp`
and relays JSON-RPC over stdio. A thin TS client (`neuroflowClient.ts`) drives
list, run and cancel. Both UIs sit on that client. Variant B uses NeuroFlow's
`WorkflowDiagram` and `RunPanel`, published from the neuroflow repo as an npm
library.

**Tech Stack:** Rust (Tauri 2, tokio, serde_json); React 19 + TS + bun (NeuroVue);
React 18 + Vite library mode (neuroflow); MCP over stdio.

**Spec:** `docs/superpowers/specs/2026-11-06-neuroflow-launcher-design.md`. Read it
first. Section numbers (§) below refer to it.

## Global Constraints

- NeuroVue's backend and UI entry point are desktop-only: `#[cfg(desktop)]` in
  Rust. The UI checks for the command and hides itself when it's absent. Nothing
  on the iOS path depends on it.
- No bundling of `neuroflow-mcp`. Everything comes from `neuroflow.json` in the
  app config dir, next to `mcp.json`.
- `--data-root` = `mcp.json` `roots`, falling back to the home folder. Do not add
  a separate roots setting.
- Package: `@cdrake/neuroflow-react@0.1.0`, ESM only.
  - Peer dependencies: `react` and `react-dom` at `^18.3 || ^19`, and
    `@xyflow/react` at `^12`.
  - Dependency: `lucide-react`.
  - License `MIT OR Apache-2.0`.
- The package entry must not reach `src/data/gallery.ts`, `src/domain/host.ts`,
  `src/domain/execution.ts` or `@tauri-apps/*`. That applies to the JS and to
  the `.d.ts` files.
- Exported components return `React.JSX.Element`, not `JSX.Element`.
- Package CSS is scoped under `.nf-root`, including the BIDSvue tokens it uses.
- No new build dependencies in either repo. Don't fork `nv-mcp`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Repos:
  - neuroflow: `~/Dev/neuroflow`, on a new branch `feat/neuroflow-react` from
    `main`;
  - NeuroVue: `~/Dev/neurovue`, on branch `feat/neuroflow-launcher`.

## Review Focus

1. **A tool takes the volume under a differently named input.** For example,
   `python-volume-filter` takes its volume as `input`, not `volume`. Prefill must
   pick the first required input whose `x-neuroflow-type` is compatible with the
   volume type. It must not match on the input name. Test in Task 7.
2. **The volume path is `.nii.gz`, or has spaces or non-ASCII characters.** The
   path must reach `neuroflow-mcp` byte-for-byte. Output loading must recognise
   `.nii.gz` as NIfTI. Tests in Task 5 (args) and Task 7 (output classification).
3. **The person cancels, and the panel is closed or reopened mid-run.** Cancel
   must reach the right request id. A late response for a cancelled request must
   be dropped, not crash or resolve a newer request. Test in Task 5.
4. **`neuroflow-mcp` writes a partial or interleaved stdout line, or a non-JSON
   log line.** The reader must skip it and keep routing. Test in Task 5.
5. **A second run starts while the first is still going.** Requests must stay
   independent by id, and progress tokens must route to the right run. Tests in
   Task 5 (routing) and Task 6 (progress token per run).

---

# Part 1 — neuroflow repo (`~/Dev/neuroflow`)

### Task 1: Cut the package leaks

**Files:**
- Create: `src/domain/runTypes.ts`
- Modify:
  - `src/domain/host.ts`: move the types out and re-export them;
  - `src/domain/neuroflow.ts`: add `idTail`;
  - `src/data/gallery.ts`: re-export `idTail` from `../domain/neuroflow`;
  - `src/components/RunPanel.tsx`, `src/components/WorkflowDiagram.tsx` and
    `src/domain/graph.ts`: import from `./runTypes` / `../domain/runTypes` and
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
  - none of `RunPanel.tsx`, `WorkflowDiagram.tsx` or `graph.ts` contains
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
  `RunPanel.tsx`, `WorkflowDiagram.tsx` and `graph.ts`, plus the xyflow node
  classes they set. Move every `app.css` rule whose selector uses one of those
  classes into `components.css`, and prefix each selector with `.nf-root `.
  Copy the `var(--…)` tokens those rules use from `bidsui.css` into a
  `.nf-root { … }` block. Keep the originals in `bidsui.css` for the rest of the
  app.

- [ ] **Step 2: Verify that nothing looks different.** Run `npm run dev`, open the
  builder, load the `filter-qa` workflow, and compare the diagram and Run panel
  with `main`. Expected: identical. Then run `npm run build`. Expected: success.

- [ ] **Step 3: Commit.** Message: `refactor: scope diagram and run panel CSS under .nf-root`.

### Task 3: Library entry, package and pre-publish check

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
- Consumes: Task 1 `runTypes.ts`, and `toolFromDocument` from `src/data/documents.ts`.
- Produces, as the `@cdrake/neuroflow-react` exports:
  - the components `WorkflowDiagram` and `RunPanel`, with the prop types
    `WorkflowDiagramProps` and `RunPanelProps`;
  - `HostRunState` and `HostRunStatus`;
  - `buildWorkflowGraph` and `NodePositionMap`;
  - `toolFromDocument` and `shortType`;
  - the types `WorkflowDocument`, `ToolDefinition` and `ParameterDef`;
  - all of `runTypes.ts`.

  It also produces `@cdrake/neuroflow-react/style.css`, built from
  `src/styles/components.css`.

  `WorkflowDiagramProps` and `RunPanelProps` need `export` added where they are
  declared.

- [ ] **Step 1: Write the check script** `scripts/check.mjs`. It fails (non-zero
  exit with a message) unless all of these hold:
  1. `dist/` contains `index.js`, `index.d.ts` and `style.css`;
  2. no file under `dist/` matches `/@tauri-apps|gallery\/tools|\.tool\.json/`;
  3. there is no `dist/**/host.d.ts`, `execution.d.ts` or `gallery.d.ts`;
  4. after `npm pack` into a temp dir, then `npm install <tgz>` in
     `test/consumer`, both `npx tsc --noEmit` (consumer tsconfig has
     `skipLibCheck: false`, React 19 types) and `npx vite build` succeed in
     `test/consumer`.

  The consumer's `main.tsx` renders `<div className="nf-root">` holding:
  - a `WorkflowDiagram` with a one-step workflow built inline and no-op
    callbacks;
  - a `RunPanel` with `run={null}`;

  and imports both CSS files.

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
    to fill `HostRunState` from `neuroflow-mcp` (§2.3).

- [ ] **Step 4: Verify.** Run `npm run lib:check`. Expected: exits 0. Fix leaks
  at their source, not by loosening the check.

- [ ] **Step 5: Commit.** Message: `feat: publishable @cdrake/neuroflow-react package`.
  Add `packages/neuroflow-react/dist` and `test/consumer/node_modules` to
  `.gitignore`.

### Task 4: Publish 0.1.0 (needs the owner)

- [ ] **Step 1: Run `npm run lib:check` again.** Expected: exits 0.
- [ ] **Step 2: Publish.** Ask the owner to run
  `! cd ~/Dev/neuroflow/packages/neuroflow-react && npm publish --access public`.
  It needs their npm login and 2FA, so don't run it yourself.
- [ ] **Step 3: Verify.** Run `npm view @cdrake/neuroflow-react version`.
  Expected: `0.1.0`.
- [ ] **Step 4: Push the branch and open a PR in `cdrake/neuroflow`.**

---

# Part 2 — NeuroVue backend (`~/Dev/neurovue`)

### Task 5: `neuroflow.rs`: settings, spawn and JSON-RPC relay

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
    `{ configured: bool, running: bool, settingsPath: String, stderrTail: Vec<String>, variant: String }`
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
- `Settings`: `{ binary, registries: Vec<String>, spec: Option<String>, interpreters: BTreeMap<String,String>, variant: String }`.
  `~` is expanded. The template is the §2.1 JSON, with `variant` defaulting to
  `"A"`. Sessions dir is `~/.neuroflow/runs`.

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

### Task 6: `neuroflowClient.ts`

**Files:**
- Create: `src/domain/neuroflowClient.ts`
- Test: `src/domain/neuroflowClient.test.ts`, run with `bun test`.

**Interfaces:**
- Consumes the Task 5 commands and events.
- Produces:

```ts
export type NeuroflowStatus = { configured: boolean; running: boolean; settingsPath: string; stderrTail: string[]; variant: 'A' | 'B' }
export type CatalogEntry = { id: string; kind: 'tool' | 'workflow'; title: string; description: string; mcpName: string; inputSchema: JsonSchema }
export type RunHandle = { requestId: Promise<number>; result: Promise<RunStructured>; progressToken: string }
export interface NeuroflowClient {
  status(): Promise<NeuroflowStatus>
  catalog(acceptsType: string): Promise<CatalogEntry[]>  // tools/list (cached) ⋈ neuroflow_list({acceptsType, runnableOnly:true}) by id
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

  `RunStructured`, `RunRecord` and `ArtifactDescriptor` are defined locally in
  this file, matching neuroflow `runTypes.ts`. Variant A doesn't depend on the
  package. Task 9 replaces these local types with the package's.

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

---

# Part 3 — NeuroVue UI

### Task 7: Shared panel shell, entry point, prefill and output loading

**Files:**
- Create:
  - `src/components/NeuroflowPanel.tsx`: the shell (status/setup state, picker,
    switch on the variant);
  - `src/domain/neuroflowForm.ts`: pure helpers.
- Modify:
  - `src-tauri/src/lib.rs`: add a desktop View menu item `view-neuroflow`,
    labelled "Run NeuroFlow…", plus `view-neuroflow-variant`, labelled
    "NeuroFlow UI: A/B". Both go through the existing `view-` prefix dispatch.
  - `src/hooks/useNativeMenu.ts`: add `'neuroflow' | 'neuroflow-variant'` to
    `NativeMenuAction`.
  - `src/App.tsx`:
    - add an `addOverlayFromPath(path)` helper, extracted from the agent
      `addOverlay` body (lines ~1215–1224), and use it in both places;
    - add a `neuroflowOpen` state, and render `<NeuroflowPanel>` as a dock next
      to `TerminalPanel`;
    - add a "Run NeuroFlow…" button to the volume info panel near
      `metadata.sourcePath` (~line 3494). It renders only when
      `isAvailable()` resolves to true.
- Test: `src/domain/neuroflowForm.test.ts`

**Interfaces:**
- Consumes the Task 6 client, and `metadata.sourcePath` as the current volume
  path.
- Produces, in `neuroflowForm.ts`:
  - `volumeType(isLabel: boolean): 'neuro:volume' | 'neuro:label-map'`;
  - `prefillInputs(schema: JsonSchema, volumeType: string, volumePath: string): Record<string, unknown>`.
    It puts `volumePath` into the first **required** property whose
    `x-neuroflow-type` equals `volumeType`. Failing that, `neuro:volume`
    accepts `neuro:label-map` and `neuro:mask`. It applies `default`s and never
    matches on property name.
  - `fieldKind(prop: JsonSchemaProperty): 'path' | 'enum' | 'number' | 'text'`.
    `path` is any `x-neuroflow-type` starting with `neuro:` or equal to
    `core:file` or `core:directory`.
- Produces `<NeuroflowPanel volumePath: string | null; isLabel: boolean; onLoadOverlay(path): Promise<void>; onClose(): void>`.
  It renders the variant body as
  `{variant === 'A' ? <NeuroflowRunA …/> : <NeuroflowRunB …/>}` with props
  `{ client, entry: CatalogEntry, initialInputs, onLoadOverlay }`. The panel
  owns `loadOutputs(structured)`:
  1. run `isNifti` over `outputArtifacts`;
  2. call `onLoadOverlay` for each NIfTI, in sequence;
  3. collect failures and non-NIfTI outputs into "Reveal in Finder" rows, using
     the existing reveal command (grep `reveal` in `src/domain/desktop.ts`).

  Until Tasks 8–9 land, A and B are placeholders.

- [ ] **Step 1: Write the failing tests.**
  - `prefill matches by type not name`. The schema has required
    `input: {x-neuroflow-type: neuro:volume}` and optional
    `volume: {type: string}`. Prefill sets `input`, not `volume`.
  - `prefill skips optional inputs and applies defaults`.
  - `prefill accepts label-map input for neuro:volume when no exact match`.
  - `prefill leaves inputs empty when nothing matches`.
  - `fieldKind`: one case for each of the four kinds.

- [ ] **Step 2: Run them to see them fail.** Run
  `bun test src/domain/neuroflowForm.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the helpers, then the panel and its wiring.** Shell
  states:
  - not configured: show the settings path and a "Reveal settings file"
    button;
  - process error: show `stderrTail` and a Restart button (`neuroflow_restart`);
  - otherwise: the picker list, `client.catalog(volumeType(isLabel))`, then the
    chosen entry's variant body.

  The variant menu item flips `variant` in `neuroflow.json`. Add a
  `neuroflow_set_variant(variant: String)` command to Task 5's file, with a
  one-line test that it round-trips, and re-render.

- [ ] **Step 4: Verify.** Run `bun test src/domain && npm run typecheck && npm run lint && (cd src-tauri && cargo test neuroflow)`.
  Expected: PASS. Then run `npm run tauri:dev`, open
  `~/Dev/neurovue-stat-demo`, and choose View › Run NeuroFlow…. Expected: the
  picker lists the gallery tools that accept `neuro:volume`.

- [ ] **Step 5: Commit.** Message: `feat: NeuroFlow launcher panel shell and entry points`.

### Task 8: Variant A — native form

**Files:**
- Create: `src/components/NeuroflowRunA.tsx`
- Modify: `src/components/NeuroflowPanel.tsx` (replace the A placeholder).

**Interfaces:**
- Consumes the Task 7 props, plus `fieldKind` and the Task 6 client.
- Produces nothing for later tasks.

- [ ] **Step 1: Implement.** One field per `inputSchema` property, using
  `fieldKind`:
  - `path`: a text field plus a "Choose…" button through
    `@tauri-apps/plugin-dialog` `open`;
  - `enum`: a `<select>`;
  - `number`: `<input type=number>`;
  - `text`: `<input>`.

  Mark required fields with `*`. Disable Run until every required field is set.

  On Run:
  1. pass each `path` value through `client.checkPath`, and show the roots error
     inline if it fails;
  2. call `client.run`;
  3. show the latest progress `message` and a "progress/total" line, plus a
     Cancel button that calls `client.cancel(await handle.requestId)`.

  When the run finishes:
  - `completed`: `loadOutputs`;
  - `failed`: show `failedStep`, `error` and `logs.stderr`, the path from
    `RunStructured.logs`;
  - `cancelled`: show "Cancelled".

  Use NeuroVue's existing panel class names. No new CSS file.

- [ ] **Step 2: Manual check.** In `tauri:dev` on `~/Dev/neurovue-stat-demo`,
  run `python-volume-filter`. Expected: progress shows, and the filtered volume
  appears as an overlay. Run it again and Cancel mid-run. Expected: "Cancelled",
  and the app keeps responding. Pick a file outside the roots. Expected: the
  roots error, and no run starts.

- [ ] **Step 3: Verify.** Run `npm run typecheck && npm run lint`. Expected: PASS.

- [ ] **Step 4: Commit.** Message: `feat: native NeuroFlow run form (variant A)`.

### Task 9: Variant B — `@cdrake/neuroflow-react`

**Files:**
- Create:
  - `src/components/NeuroflowRunB.tsx`
  - `src/domain/neuroflowHostState.ts`
- Modify:
  - `package.json`: add `@cdrake/neuroflow-react@^0.1.0` and
    `@xyflow/react@^12` with `bun add`;
  - `src/components/NeuroflowPanel.tsx`: replace the B placeholder;
  - `src/domain/neuroflowClient.ts`: replace the local run types with
    re-exports from the package.
- Test: `src/domain/neuroflowHostState.test.ts`

**Interfaces:**
- Consumes the Task 4 package API, plus the Task 6 client.
- Produces, in `neuroflowHostState.ts`:
  - `wrapToolAsWorkflow(toolDoc: unknown): WorkflowDocument`: a one-step
    workflow whose inputs mirror the tool's inputs, whose step binds them by
    `ref: "inputs.<name>"`, and whose outputs mirror the tool's outputs;
  - `reduceRunState(prev: HostRunState | null, ev: RunEv): HostRunState`, where
    `RunEv` is one of:
    - `{type:'start', workflowId}`, giving `status: 'starting'`;
    - `{type:'progress', progress, total, message}`, giving `'running'`;
    - `{type:'done', structured, sessionDir, record}`;
    - `{type:'error', message}`, giving `'failed'` with `error` set;
    - `{type:'cancelled'}`.

    For `done`, `finished` gets
    `{ticket:'', ok: status==='completed', runId, status, structured, summary:'', sessionDir, record}`,
    and `status` comes from `structured.status`. `stderrTail` is
    `structured.logs?.stderr ?? null`.

- [ ] **Step 1: Write the failing tests.**
  - `wrapToolAsWorkflow binds every tool input by ref and exposes every output`.
    Use `python-volume-filter.tool.json` from `~/Dev/neuroflow/gallery/tools`,
    copied into `src/domain/__fixtures__/`.
  - `reduceRunState start→progress→done(completed)`: final status
    `'completed'`, `finished.record.steps` present, `progress`/`total` from the
    last progress event.
  - `reduceRunState done(failed) sets stderrTail from structured.logs.stderr`.
  - `reduceRunState cancelled after progress gives 'cancelled'`.

- [ ] **Step 2: Run them to see them fail.** Run
  `bun test src/domain/neuroflowHostState.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `NeuroflowRunB` renders, inside
  `<div className="nf-root">`:
  - a `WorkflowDiagram`, read-only, given:
    - the workflow: the described document if it's a workflow, otherwise
      `wrapToolAsWorkflow`;
    - `tools`: a map built from `toolFromDocument` over the described tool docs;
    - `nodePositions` kept in local state, updated by `onMoveNode`;
    - `onBindInput` and `onAddTool` as no-ops;
  - a `RunPanel` given:
    - `available` set to `true`;
    - `report` set to `{ok: true, issues: []}`;
    - `runnable={null}` and `environmentChecked`;
    - `run` from `reduceRunState`;
    - `onStart(inputs)`: `checkPath` the path inputs, then `client.run`. On
      completion, call `client.readRun(runId)`, dispatch `done`, then call
      `loadOutputs`;
    - `onCancel`: `client.cancel`;
    - `onOpen`: reveal in Finder.

  To prefill, seed `RunPanel`'s stored inputs before mounting. It reads
  `localStorage['neuroflow.runInputs.v1'][workflow.id]`
  (`RunPanel.tsx:48`), so write `initialInputs` there. Add a code comment
  starting with `shortcut:` that says RunPanel has no initial-values prop, and
  to add one to the package if B wins. Import
  `@xyflow/react/dist/style.css` and `@cdrake/neuroflow-react/style.css` in
  this component only.

- [ ] **Step 4: Verify.** Run `bun test src/domain && npm run typecheck && npm run lint && npm run build`.
  Expected: PASS. Then in `tauri:dev`, switch with View › NeuroFlow UI: A/B to B
  and run the same `python-volume-filter`. Expected:
  - a diagram with one step;
  - the Run panel steps go from running to succeeded;
  - the overlay loads, the same result as A.

- [ ] **Step 5: Commit.** Message: `feat: NeuroFlow run panel from @cdrake/neuroflow-react (variant B)`.

### Task 10: Docs and hand-off

**Files:**
- Modify: `docs/mcp.md`. Add a short "Running NeuroFlow pipelines" section:
  - the `neuroflow.json` fields;
  - that `--data-root` comes from `roots`;
  - the A/B menu item;
  - desktop only.

- [ ] **Step 1: Write the section.**
- [ ] **Step 2: Verify.** Run
  `npm run typecheck && npm run lint && bun test src/domain && (cd src-tauri && cargo test)`.
  Expected: all PASS.
- [ ] **Step 3: Commit,** then push `feat/neuroflow-launcher` and open a PR. Its
  body lists the manual A/B checklist from spec §Testing for the owner.
