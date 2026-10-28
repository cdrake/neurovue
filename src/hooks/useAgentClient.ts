import type { Handlers, NiiVueHost } from '@niivue/nv-mcp/browser'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useRef, useState } from 'react'
import { setPointLabels } from '../domain/pointLabels'
import type { VolumeFilterValues } from './useVolumeFilters'

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
  /** Sets the dataset pane's filter and returns the volumes it lists. */
  filterDataset(filters: VolumeFilterValues): Record<string, unknown>
  /** Zooms the dataset pane, centering a volume's tile when one is given. */
  zoomDataset(options: {
    zoom?: number
    volume?: string
  }): Promise<{ zoom: number }>
  /** Adds a volume over every volume of the dataset; resolves once it shows. */
  addOverlay(path: string): Promise<{ id: string; label: string }>
  /** Adds surfaces or tracts to the meshes shown and returns their names. */
  addMeshes(paths: string[]): Promise<string[]>
  /**
   * Takes shown volumes (by viewer index, or all) out of the layer stack.
   * Removing the base volume takes its overlays too and leaves the view
   * empty until a volume is selected or opened.
   */
  removeVolumes(index: number | 'all'): Promise<{ removed: string[] }>
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
            bound = {
              view,
              handlers: coreHandlers({
                view: view as HostView,
                labels: setPointLabels,
              }),
            }
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
          // NeuroVue owns the layer stack: core remove_volume would take the
          // volume out of NiiVue alone, leaving NeuroVue drawing it.
          remove_volume: async (params) => {
            const result = await optionsRef.current.actions.removeVolumes(
              params.all === true
                ? 'all'
                : volumeIndex(params.volume, optionsRef.current.viewer()),
            )
            // Read after the removal renders, not from the actions it ran with.
            return { ...result, dataset: optionsRef.current.actions.dataset() }
          },
          // Core load_document fetches a URL into NiiVue alone. A saved
          // document is a file on this computer, so it opens as a dataset.
          load_document: async (params) => {
            const path = documentPath(params.url)
            await optionsRef.current.actions.openPath(
              await agentPath({ path }, 'path'),
            )
            return optionsRef.current.actions.dataset()
          },
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
    'neurovue.filter_dataset': async (params) =>
      actions().filterDataset({
        query: typeof params.query === 'string' ? params.query : undefined,
        imageTypes: stringList(params, 'image_types'),
        roles: stringList(params, 'roles'),
      }),
    'neurovue.zoom_dataset': async (params) =>
      actions().zoomDataset({
        zoom: typeof params.zoom === 'number' ? params.zoom : undefined,
        volume: typeof params.volume === 'string' ? params.volume : undefined,
      }),
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
    'neurovue.focus_window': async () => {
      const focused = await invoke<string>('focus_window')
      await untilVisible()
      return { focused }
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

/**
 * Resolves once the page is visible, or after `ms`. A window brought forward
 * becomes visible a moment later, and screenshot refuses a hidden page.
 */
function untilVisible(ms = 2000): Promise<void> {
  if (document.visibilityState === 'visible') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    document.addEventListener('visibilitychange', done)
  })
}

/** The file a load_document `url` names: an absolute path or a file:// URL. */
function documentPath(url: unknown): string {
  if (typeof url === 'string' && url.startsWith('/')) return url
  if (typeof url === 'string' && url.startsWith('file://')) {
    return decodeURIComponent(new URL(url).pathname)
  }
  throw new Error(
    'NeuroVue opens documents from this computer: pass the absolute path of the .nvd file. ' +
      'save puts documents in the Downloads folder.',
  )
}

/** A volume named by index or name, as the core tools take it. */
function volumeIndex(volume: unknown, viewer: unknown): number {
  if (typeof volume === 'number' && Number.isInteger(volume)) return volume
  const volumes =
    (viewer as { volumes?: { name?: string }[] } | null)?.volumes ?? []
  if (typeof volume === 'string') {
    const index = volumes.findIndex((shown) => shown.name === volume)
    if (index >= 0) return index
  }
  throw new Error(
    `volume is an index or a name: one of ${volumes
      .map((shown, index) => `${index} "${shown.name}"`)
      .join(', ')}.`,
  )
}

function stringList(
  params: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error(`${key} must be a list of strings.`)
  }
  return value
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a non-empty string.`)
  }
  return value
}
