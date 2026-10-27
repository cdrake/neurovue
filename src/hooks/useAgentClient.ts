import type { Handlers, NiiVueHost } from '@niivue/nv-mcp/browser'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useRef, useState } from 'react'

/** The agent server's state, as `mcp_status` and the `neurovue-mcp` event report it. */
export interface AgentServerStatus {
  enabled: boolean
  port: number
  /** Why the server is not running although enabled. */
  error: string | null
}

/** What NeuroVue answers for its own tools (see mcp-server/main.ts). */
export interface NeuroVueAgentActions {
  openPath(path: string): Promise<void>
  dataset(): Record<string, unknown>
  selectVolume(id: string): Promise<void>
  /** Adds a volume over every volume of the dataset; resolves once it shows. */
  addOverlay(path: string): Promise<{ id: string; label: string }>
  /** Adds surfaces or tracts to the meshes shown and returns their names. */
  addMeshes(paths: string[]): Promise<string[]>
}

type HostView = NiiVueHost['view']

/**
 * Connects this window to NeuroVue's MCP server while "Allow AI Agents" is
 * on, as one tab answering the NiiVue core tools and NeuroVue's own.
 *
 * The client outlives the viewer: NiivueStage recreates NiiVue on every layer
 * change, so the core tools answer for whichever instance `viewer()` returns
 * at the time of each call. Desktop only: without Tauri (or on iOS, where nothing
 * starts the server) the status never arrives and nothing connects.
 */
export function useAgentClient(options: {
  viewer: () => unknown
  title: () => string
  actions: NeuroVueAgentActions
}): { status: AgentServerStatus | null; connected: boolean } {
  const [status, setStatus] = useState<AgentServerStatus | null>(null)
  const [connected, setConnected] = useState(false)
  // Read the latest callbacks through a ref so the client is made once per
  // server start, not on every render.
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null
    invoke<AgentServerStatus>('mcp_status')
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch(() => {})
    void listen<AgentServerStatus>('neurovue-mcp', (event) =>
      setStatus(event.payload),
    )
      .then((next) => {
        if (cancelled) next()
        else unlisten = next
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const port = status?.enabled && !status.error ? status.port : null
  useEffect(() => {
    if (port === null) return
    let client: { detach(): void } | null = null
    let cancelled = false
    // Loaded only once agents are allowed, keeping it out of the startup path.
    void import('@niivue/nv-mcp/browser').then(
      ({ AgentClient, coreHandlers, sceneState }) => {
        if (cancelled) return
        // The core handlers keep the view they are made with, and NiivueStage
        // makes a new one on every layer change, so each call goes to
        // handlers made for the viewer shown at the time.
        let bound: { view: unknown; handlers: Handlers } | null = null
        const current = (): Handlers => {
          const view = optionsRef.current.viewer()
          if (!view) {
            throw new Error(
              'No volume is shown in this window yet; open one with open_path first.',
            )
          }
          if (bound?.view !== view) {
            bound = { view, handlers: coreHandlers({ view: view as HostView }) }
          }
          return bound.handlers
        }
        // Made without a view only to learn the method names; none reads
        // the view until called.
        const methods = Object.keys(coreHandlers({ view: null as never }))
        const handlers: Handlers = {
          ...Object.fromEntries(
            methods.map((method) => [
              method,
              (params: Record<string, unknown>) => current()[method](params),
            ]),
          ),
          ...neuroVueHandlers(() => optionsRef.current.actions),
        }
        const next = new AgentClient(handlers, {
          urls: [`ws://127.0.0.1:${port}/app`],
          title: () => optionsRef.current.title(),
          state: () => {
            const view = optionsRef.current.viewer()
            try {
              if (view) return sceneState({ view: view as HostView })
            } catch {
              // A viewer mid-load has no scene to report yet.
            }
            // No viewer yet: an empty window still says hello.
            return { volume: null, crosshair: null, plane: null }
          },
          onStatus: setConnected,
        })
        next.attach()
        client = next
      },
    )
    return () => {
      cancelled = true
      client?.detach()
      setConnected(false)
    }
  }, [port])

  return { status, connected }
}

function neuroVueHandlers(actions: () => NeuroVueAgentActions): Handlers {
  return {
    'neurovue.open_path': async (params) => {
      await actions().openPath(await agentPath(params, 'path'))
      return actions().dataset()
    },
    'neurovue.add_overlay_path': async (params) => {
      const overlay = await actions().addOverlay(
        await agentPath(params, 'path'),
      )
      return { overlay, dataset: actions().dataset() }
    },
    'neurovue.load_mesh_path': async (params) => {
      const raw = params.paths
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('paths must be a non-empty list of absolute paths.')
      }
      const paths = await Promise.all(
        raw.map((path) => agentPath({ path }, 'path')),
      )
      return { added: await actions().addMeshes(paths) }
    },
    'neurovue.dataset': async () => actions().dataset(),
    'neurovue.select_volume': async (params) => {
      await actions().selectVolume(stringParam(params, 'id'))
      return actions().dataset()
    },
    'neurovue.open_window': async (params) => {
      const id = stringParam(params, 'id')
      const title = typeof params.title === 'string' ? params.title : null
      await invoke('open_viewer_window', { tab: id, title })
      return { id }
    },
  }
}

/**
 * A path from an agent, resolved by the host: absolute, followed through
 * symlinks, and inside the folders agents may open (NeuroFlow RFC 0009 §5.4).
 * The host refuses anything else, so this is the guard, not the sidecar.
 */
function agentPath(
  params: Record<string, unknown>,
  key: string,
): Promise<string> {
  return invoke<string>('agent_resolve_path', {
    path: stringParam(params, key),
  })
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a non-empty string.`)
  }
  return value
}
