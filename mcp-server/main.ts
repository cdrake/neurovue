/**
 * NeuroVue's MCP server: the NiiVue core tools from @niivue/nv-mcp plus
 * NeuroVue's own, which open datasets, overlays, surfaces and tracts from disk
 * and manage viewer windows. NeuroVue's tools are NeuroFlow tool documents
 * (tools/*.neuroflow.json); neuroflow.ts turns them into MCP tools.
 *
 * The app compiles this with `bun build --compile` (scripts/build-mcp-server.cjs)
 * and runs it as a sidecar while "Allow AI Agents" is on. Each NeuroVue window
 * connects to it as one tab; the server holds no scene of its own.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type Extension,
  startServer,
  TAB_ARG,
  type ToolContext,
  type ToolReply,
} from '@niivue/nv-mcp/server'
import { type ZodType, z } from 'zod'
import {
  DOCUMENTS,
  inputSchema,
  type ToolDocument,
  toolDescription,
  withRemedy,
} from './neuroflow'

const PORT = Number(process.env.NEUROVUE_MCP_PORT ?? 4242)
const VERSION = process.env.NEUROVUE_VERSION ?? '0.0.0'
// The app that started us; when it goes (even by crashing) so do we, rather
// than holding the port against its next launch.
const PARENT_PID = Number(process.env.NEUROVUE_PARENT_PID ?? 0)
// The folders agents may open files from, joined like PATH. The app checks
// every path against them (NeuroFlow RFC 0009 §5.4); this only tells agents.
const ROOTS = (process.env.NEUROVUE_MCP_ROOTS ?? '')
  .split(process.platform === 'win32' ? ';' : ':')
  .filter(Boolean)

// The Tauri webview's origin: tauri://localhost on macOS and Linux,
// http://tauri.localhost on Windows. Dev builds load from loopback, which the
// server always allows.
const ALLOWED_ORIGINS = ['tauri://localhost', 'http://tauri.localhost']

/** Registers a tool from its NeuroFlow document; `run` answers the call. */
function register<Shape extends Record<string, ZodType>>(
  server: McpServer,
  doc: ToolDocument,
  shapes: Shape,
  run: (
    args: z.infer<z.ZodObject<Shape>> & { tab?: string },
  ) => Promise<ToolReply>,
): void {
  const { name, title, annotations } = doc.extensions['neuroflow/mcp']
  server.registerTool(
    name,
    {
      title,
      description: toolDescription(doc),
      inputSchema: { ...TAB_ARG, ...inputSchema(doc, shapes) },
      annotations,
    },
    async (args: Record<string, unknown>) =>
      withRemedy(doc, await run(args as Parameters<typeof run>[0])),
  )
}

const neurovue: Extension = {
  name: 'neurovue',
  register(server: McpServer, context: ToolContext) {
    register(
      server,
      DOCUMENTS.openPath,
      { path: z.string().min(1) },
      ({ tab, path }) =>
        context.answer(
          'neurovue.open_path',
          { path },
          { tab, lead: () => `Opened ${path}.` },
        ),
    )

    register(server, DOCUMENTS.dataset, {}, ({ tab }) =>
      context.answer('neurovue.dataset', {}, { tab }),
    )

    register(
      server,
      DOCUMENTS.selectVolume,
      { id: z.string().min(1) },
      ({ tab, id }) =>
        context.answer('neurovue.select_volume', { id }, { tab }),
    )

    register(
      server,
      DOCUMENTS.filterDataset,
      {
        query: z.string(),
        image_types: z.array(z.string().min(1)),
        roles: z.array(z.string().min(1)),
      },
      ({ tab, ...filters }) =>
        context.answer('neurovue.filter_dataset', filters, {
          tab,
          lead: (result) => {
            const { listed, of } = result as { listed: unknown[]; of: number }
            return `The dataset pane lists ${listed.length} of ${of} volumes.`
          },
        }),
    )

    register(
      server,
      DOCUMENTS.zoomDataset,
      { zoom: z.number().min(0.5).max(4), volume: z.string().min(1) },
      ({ tab, ...options }) =>
        context.answer('neurovue.zoom_dataset', options, { tab }),
    )

    register(
      server,
      DOCUMENTS.setWindowMode,
      { mode: z.enum(['express', 'dataset']) },
      ({ tab, mode }) =>
        context.answer('neurovue.set_window_mode', { mode }, { tab }),
    )

    register(
      server,
      DOCUMENTS.addOverlayPath,
      { path: z.string().min(1) },
      ({ tab, path }) =>
        context.answer(
          'neurovue.add_overlay_path',
          { path },
          { tab, lead: () => `Added ${path} as an overlay.` },
        ),
    )

    // Surfaces and tracts load the same way; they are two tools so each
    // input carries its own NeuroFlow type.
    for (const doc of [DOCUMENTS.loadSurfaces, DOCUMENTS.loadTracts]) {
      register(
        server,
        doc,
        { paths: z.array(z.string().min(1)).min(1) },
        ({ tab, paths }) =>
          context.answer('neurovue.load_mesh_path', { paths }, { tab }),
      )
    }

    register(
      server,
      DOCUMENTS.openWindow,
      { title: z.string() },
      async ({ tab, title }) => {
        const id = crypto.randomUUID().slice(0, 8)
        const opened = await context.answer(
          'neurovue.open_window',
          { id, title },
          { tab, lead: () => `Opened window ${id}.` },
        )
        if (opened.isError) return opened
        // Hand back once the new window has connected, so the next call with
        // its id finds it.
        const until = Date.now() + 15_000
        while (Date.now() < until) {
          if (context.bridge.list().some((t) => t.id === id)) return opened
          await Bun.sleep(200)
        }
        return context.failure(
          new Error(
            `Window ${id} opened but has not connected yet; try list_tabs shortly.`,
          ),
        )
      },
    )

    register(server, DOCUMENTS.focusWindow, {}, ({ tab }) =>
      context.answer('neurovue.focus_window', {}, { tab }),
    )
  },
}

const options = {
  name: 'neurovue',
  version: VERSION,
  port: PORT,
  extensions: [neurovue],
  allowedOrigins: ALLOWED_ORIGINS,
  bridge: {
    noTabHint:
      'Ask the person to open NeuroVue and turn on View > Allow AI Agents.',
  },
  instructions:
    'NeuroVue is a desktop neuroimaging viewer. Each of its windows is one tab here, with its own ' +
    'dataset; list_tabs names them, and every tool takes `tab` to pick one. To show data from ' +
    'this computer, give its absolute path: open_path opens a dataset (a BIDS or other folder, ' +
    'a NIfTI volume, a .nvbundle or a saved .nvd document), add_overlay_path lays a volume over it, and load_surfaces ' +
    'and load_tracts add meshes. dataset lists the volumes and select_volume switches between ' +
    'them; filter_dataset narrows the dataset pane to some of them, zoom_dataset zooms its ' +
    'thumbnails, and set_window_mode switches between that dataset view and Express, the ' +
    `viewer alone. Paths must be inside ${
      ROOTS.length ? ROOTS.join(', ') : 'the folders the person allows'
    }. ` +
    'load_volume, add_overlay and load_mesh only reach the URLs NeuroVue itself serves, not the ' +
    'internet or the disk, and what they add is dropped when NeuroVue reloads the viewer (on ' +
    'select_volume, open_path or add_overlay_path). To compare datasets side by side, call ' +
    'open_window and drive each window by its tab id; focus_window brings one to the front so ' +
    'the person sees it, and screenshot needs that. set_instances is unrelated to windows: it ' +
    'draws copies of a volume inside one viewer.',
}

// A NeuroVue that just quit (or crashed) leaves its server holding the port
// for up to two seconds, until that server notices its parent is gone.
const BIND_WAIT_MS = 5000
const bindUntil = Date.now() + BIND_WAIT_MS
for (;;) {
  try {
    startServer(options)
    break
  } catch (error) {
    const busy = (error as { code?: string }).code === 'EADDRINUSE'
    if (!busy || Date.now() > bindUntil) {
      console.error(
        busy
          ? `neurovue-mcp: port ${PORT} is in use by another program.`
          : `neurovue-mcp: ${error instanceof Error ? error.message : error}`,
      )
      process.exit(1)
    }
    await Bun.sleep(250)
  }
}

if (PARENT_PID > 0) {
  setInterval(() => {
    try {
      process.kill(PARENT_PID, 0)
    } catch {
      process.exit(0)
    }
  }, 2000)
}
