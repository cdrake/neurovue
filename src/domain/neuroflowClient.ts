import {
  type ArtifactDescriptor,
  isArtifactDescriptor,
  type RunRecord,
  type RunStructured,
} from '@cdrake/neuroflow-react'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen } from '@tauri-apps/api/event'

export type JsonSchema = Record<string, unknown>
export type NeuroflowStatus = {
  configured: boolean
  running: boolean
  settingsPath: string
  stderrTail: string[]
}
export type CatalogEntry = {
  id: string
  kind: 'tool' | 'workflow'
  title: string
  description: string
  mcpName: string
  inputSchema: JsonSchema
}
export type Progress = { progress: number; total?: number; message?: string }
export type RunHandle = {
  requestId: Promise<number>
  result: Promise<RunStructured>
  progressToken: string
}
export interface NeuroflowClient {
  status(): Promise<NeuroflowStatus>
  catalog(): Promise<CatalogEntry[]>
  describe(id: string): Promise<unknown>
  run(
    entry: CatalogEntry,
    inputs: Record<string, unknown>,
    onProgress: (p: Progress) => void,
  ): RunHandle
  cancel(requestId: number): Promise<void>
  readRun(runId: string): Promise<{ sessionDir: string; record: RunRecord }>
  checkPath(path: string): Promise<string>
}

type CallToolResult = {
  structuredContent?: unknown
  isError?: boolean
  content?: { text?: string }[]
}

export function createNeuroflowClient(
  deps: { invoke?: typeof tauriInvoke; listen?: typeof tauriListen } = {},
): NeuroflowClient {
  const invoke = deps.invoke ?? tauriInvoke
  const listen = deps.listen ?? tauriListen
  const req = <T>(method: string, params: unknown) =>
    invoke<T>('neuroflow_request', { method, params })
  const call = async <T>(
    name: string,
    args: unknown,
    meta?: unknown,
  ): Promise<T> => {
    const r = await req<CallToolResult>('tools/call', {
      name,
      arguments: args,
      ...(meta ? { _meta: meta } : {}),
    })
    if (r.isError) throw new Error(r.content?.[0]?.text ?? `${name} failed`)
    return r.structuredContent as T
  }

  const progressHandlers = new Map<string, (p: Progress) => void>()
  // shortcut: request-id events carry no token, so they're matched FIFO to runs in
  // invoke order; upgrade if the Rust side starts echoing the progressToken.
  const idWaiters: ((id: number) => void)[] = []
  let ready: Promise<unknown> | undefined
  const listening = () =>
    (ready ??= Promise.all([
      listen<{ progressToken?: string } & Progress>(
        'neuroflow:progress',
        (e) => {
          const t = e.payload.progressToken
          if (t !== undefined) progressHandlers.get(String(t))?.(e.payload)
        },
      ),
      listen<{ requestId: number }>('neuroflow:request-id', (e) =>
        idWaiters.shift()?.(e.payload.requestId),
      ),
    ]))

  let tools:
    | Promise<
        { name: string; description?: string; inputSchema?: JsonSchema }[]
      >
    | undefined
  let seq = 0

  return {
    status: () => invoke<NeuroflowStatus>('neuroflow_status'),
    async catalog() {
      tools ??= req<{ tools: never[] }>('tools/list', {}).then((r) => r.tools)
      const [all, list] = await Promise.all([
        tools,
        call<{ items: Omit<CatalogEntry, 'description' | 'inputSchema'>[] }>(
          'neuroflow_list',
          {
            runnableOnly: true,
          },
        ),
      ])
      const byName = new Map(all.map((t) => [t.name, t]))
      return list.items.flatMap((i) => {
        const t = byName.get(i.mcpName)
        return t
          ? [
              {
                id: i.id,
                kind: i.kind,
                title: i.title,
                mcpName: i.mcpName,
                description: t.description ?? '',
                inputSchema: t.inputSchema ?? {},
              },
            ]
          : []
      })
    },
    describe: (id) => call('neuroflow_describe', { id }),
    run(entry, inputs, onProgress) {
      const progressToken = `nv-${Date.now().toString(36)}-${++seq}`
      progressHandlers.set(progressToken, onProgress)
      let resolveId!: (id: number) => void
      const requestId = new Promise<number>((r) => {
        resolveId = r
        idWaiters.push(r)
      })
      const result = listening()
        .then(() =>
          call<RunStructured>(entry.mcpName, inputs, { progressToken }),
        )
        .finally(() => {
          progressHandlers.delete(progressToken)
          const i = idWaiters.indexOf(resolveId)
          if (i >= 0) idWaiters.splice(i, 1)
        })
      return { requestId, result, progressToken }
    },
    cancel: (requestId) => invoke('neuroflow_cancel', { requestId }),
    readRun: (runId) => invoke('neuroflow_read_run', { runId }),
    checkPath: (path) => invoke('neuroflow_check_path', { path }),
  }
}

export async function isAvailable(): Promise<boolean> {
  try {
    await createNeuroflowClient().status()
    return true
  } catch {
    return false
  }
}

export const isNifti = (path: string) => /\.nii(\.gz)?$/i.test(path)

export function outputArtifacts(s: RunStructured): ArtifactDescriptor[] {
  const walk = (v: unknown): ArtifactDescriptor[] =>
    Array.isArray(v) ? v.flatMap(walk) : isArtifactDescriptor(v) ? [v] : []
  return Object.values(s.outputs).flatMap(walk)
}
