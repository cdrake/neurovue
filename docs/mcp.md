# AI agents (MCP) — how NeuroVue and NiiVue share one server

NeuroVue runs one [MCP](https://modelcontextprotocol.io) server with two sets
of tools: NiiVue's and NeuroVue's. Each repo maintains its own half, and the
app puts them together at runtime. For setup and the tool list, see the
README's "AI agents (MCP)" section.

## The pieces

```
AI agent (Claude Code, …)
   │  MCP over HTTP: http://127.0.0.1:4242/mcp
   ▼
neurovue-mcp sidecar (mcp-server/main.ts)
   │  startServer() from @niivue/nv-mcp/server
   │    ├─ NiiVue core tools (load_volume, where_am_i, …)     ← niivue repo
   │    └─ extension "neurovue" (open_path, load_tracts, …)   ← this repo
   │
   │  WebSocket: ws://127.0.0.1:4242/app, one connection per window
   ├──────────────────┬──────────────────┐
   ▼                  ▼                  ▼
window "main"     window "a1b2c3d4"     …          each window is one nv-mcp tab
   AgentClient: NiiVue core handlers + NeuroVue handlers
   │  Tauri invoke, for anything that touches the disk
   ▼
Rust host: agent_resolve_path, file reads, volumetric server
```

## What NiiVue provides

`@niivue/nv-mcp` is maintained in the niivue repo and has two sides.

- **The server side** (`@niivue/nv-mcp/server`):
  - `startServer()` runs the MCP endpoint and registers the core tools. They
    drive any NiiVue view: loading, colormaps, crosshair, clipping, meshes,
    screenshots and so on.
  - It also runs a **bridge** that browser windows connect to. Each connection
    is a **tab** with an id, and every tool takes an optional `tab` argument
    to choose which window it acts on.
  - Apps add tools of their own through an **`Extension`**. An extension gets
    `context.answer(method, params, { tab })`, which sends the call to the
    chosen tab and turns the window's reply into an MCP result.
- **The browser side** (`@niivue/nv-mcp/browser`):
  - `AgentClient` connects a page to the bridge.
  - `coreHandlers({ view })` answers the core tools against a NiiVue
    instance.
  - `sceneState()` reports what the window is showing.

Any NiiVue-based app gets the whole core toolset by hosting the server and
attaching a client.

## What NeuroVue adds

- **`mcp-server/main.ts`**:
  - Calls `startServer({ extensions: [neurovue], … })` with one extension named
    `neurovue`.
  - `bun build --compile` (`scripts/build-mcp-server.cjs`) turns it into the
    `neurovue-mcp` sidecar. Tauri starts the sidecar only while View → Allow
    AI Agents is on.
- **Tool definitions as NeuroFlow documents**:
  - Each NeuroVue tool is a JSON document in `mcp-server/tools/*.neuroflow.json`.
  - `mcp-server/neuroflow.ts` turns each document into an MCP tool using the
    [NeuroFlow](https://github.com/niivue/neuroflow-spec) rules (RFC 0009 for
    the MCP binding, RFC 0011 for agent usage):
    - the name, title and hints come from the `neuroflow/mcp` block;
    - every input carries its `x-neuroflow-type`;
    - the description gets "Use when / Avoid when / Requires / Effects" sections;
    - a known failure comes back with its remedy, in the reply text and in
      `structuredContent.remedy`.
  - The server doesn't advertise `com.niivue/neuroflow`, because NeuroVue has
    no `neuroflow_list`/`describe`/`run` tools.
- **`src/hooks/useAgentClient.ts`** (the window side):
  - Every window creates one `AgentClient` whose handlers are NiiVue's
    `coreHandlers` plus `neurovue.*` handlers.
  - The `neurovue.*` handlers call into the app itself, for example opening a
    dataset, adding an overlay or loading meshes.
  - NeuroVue makes a new viewer whenever the dataset or its layers change, so
    the hook sends each core call to the viewer shown at the time.
- **The Rust host (`src-tauri/src/mcp.rs`)**:
  - Starts and stops the sidecar, and saves the on/off setting in `mcp.json`.
  - `open_window` opens a new window that connects as a new tab, and
    `focus_window` brings a window to the front. `use_tab` only picks the tab
    later calls go to; it doesn't raise the window, and `screenshot` refuses
    a hidden one.
  - It is also the **security gate**: every path from an agent goes through
    `agent_resolve_path`. The path must be absolute and, after symlinks are
    resolved, must fall inside an allowed root: `roots` in `mcp.json`, or the
    home folder when none are set (NeuroFlow RFC 0009 §5.4). Paths the person
    picks in the native dialogs skip this check.

## How a call flows

Take `open_path { tab: "a1b2c3d4", path: "/Users/…/sub-01" }`:

1. The agent sends the call to the sidecar.
2. The `neurovue` extension calls
   `context.answer('neurovue.open_path', { path }, { tab })`, and the bridge
   sends it to that window over its WebSocket.
3. The window's handler asks Rust to check the path, then opens it the way
   File → Open would.
4. The reply travels back up. If it's an error the document knows, it carries
   the remedy.

A core tool such as `set_colormap` follows the same route but ends in NiiVue's
own handler.

## Why it's split this way

- NiiVue's tools evolve in the niivue repo and arrive here as a version bump of
  `@niivue/nv-mcp`; NeuroVue never forks them. Bump `@niivue/niivue` and
  `@niivue/uikit` to the versions nv-mcp names as its peers.
- NeuroVue's tools, its disk access and its security rules stay in NeuroVue.
  Nothing app-specific leaks into NiiVue.
- One server drives many windows, each with its own dataset, through tab ids.
- Another NiiVue app can reuse the pattern: host the server, add its own
  extension and attach a client.

## Adding a NeuroVue tool

1. Write `mcp-server/tools/<slug>.neuroflow.json`: an `org.neurovue/<slug>`
   id, typed inputs, a `neuroflow/mcp` block, and a `neuroflow/usage` block
   with known failures.
2. Import it in `mcp-server/neuroflow.ts` (`DOCUMENTS`) and add a
   `register(...)` call in `mcp-server/main.ts` that forwards to a
   `neurovue.*` method.
3. Handle that method in `src/hooks/useAgentClient.ts`, and send any disk path
   through `agentPath` so the host checks it.
4. Check the document with neuroflow-spec's validator. CI doesn't run it yet.

## Platform notes

- **macOS and Windows**: the sidecar ships in the app bundle and installer.
- **Linux**: only .deb and .rpm are built (`src-tauri/tauri.linux.conf.json`).
  The AppImage packager, linuxdeploy, can't handle the bun-compiled sidecar
  because `ldd` exits 1 on it.
- **iOS**: the sidecar isn't bundled (`tauri.ios.conf.json`).
- **Hidden windows**: WebKit would pause a covered or hidden window, which
  would then stop answering, so background throttling is off. nv-mcp's
  screenshot tool still refuses while a window is hidden.
