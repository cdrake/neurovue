import '@xyflow/react/dist/style.css'
import '@cdrake/neuroflow-react/style.css'
import {
  PipelineView,
  type RunStructured,
  type ToolDefinition,
  toolFromDocument,
  type WorkflowDocument,
  wrapToolAsWorkflow,
} from '@cdrake/neuroflow-react'
import { type JSX, useEffect, useRef, useState } from 'react'
import { type DesktopItem, fetchVolumeMetadata } from '../domain/desktop'
import {
  type CatalogEntry,
  createNeuroflowClient,
  type NeuroflowStatus,
  type RunHandle,
} from '../domain/neuroflowClient'
import type { RunTag } from '../domain/overlayRuns'
import {
  type Batch,
  type BatchRow,
  isActive,
  nextQueued,
  reduceBatch,
  retryTargets,
  shownRow,
  startBatch,
} from '../domain/pipelineBatch'
import {
  type BatchTarget,
  resolveTargets,
  targetInput,
} from '../domain/pipelineTargets'

const client = createNeuroflowClient()
const SHOWN_NAMES = 3

export type PipelineViewHostProps = {
  hidden: boolean
  ctx: {
    datasetRoot: string | null
    bidsName: string | null
    filtered: DesktopItem[]
    selected: DesktopItem | null
  }
  preferSelected: number
  onRunOutputs: (
    structured: RunStructured,
    tag: RunTag,
    target: BatchTarget,
    isShown: boolean,
  ) => void
  onShowTarget: (target: BatchTarget) => void
  onReveal: (path: string) => void
}

// WorkflowLibrary reads only id/label/description; the active document is described on demand.
const stub = (id: string): WorkflowDocument => ({
  neuroflow: '0.1.0',
  kind: 'workflow',
  id,
  version: '',
  description: '',
  inputs: {},
  steps: {},
  outputs: {},
})

const sessionDir = (r: BatchRow): string => {
  const f = r.run?.finished
  return f && 'sessionDir' in f ? f.sessionDir : ''
}

export function PipelineViewHost(props: PipelineViewHostProps): JSX.Element {
  const { hidden, ctx } = props
  const latest = useRef(props)
  latest.current = props

  const [reload, setReload] = useState(0)
  const [status, setStatus] = useState<NeuroflowStatus | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [describeError, setDescribeError] = useState<string | null>(null)
  const [entries, setEntries] = useState<CatalogEntry[]>([])
  const [activeId, setActiveId] = useState('')
  const [workflow, setWorkflow] = useState<WorkflowDocument | null>(null)
  const [tools, setTools] = useState(new Map<string, ToolDefinition>())
  const [batch, setBatch] = useState<Batch | null>(null)
  const [clicked, setClicked] = useState<number | null>(null)
  const [selectedOnly, setSelectedOnly] = useState(false)
  const [paths, setPaths] = useState<Record<string, string>>({})

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is the trigger.
  useEffect(() => {
    let live = true
    setFailure(null)
    client
      .status()
      .then(async (s) => {
        if (!live) return
        setStatus(s)
        if (!s.configured) return
        const list = await client.catalog()
        if (!live) return
        setEntries(list)
        setActiveId((id) =>
          list.some((e) => e.id === id) ? id : (list[0]?.id ?? ''),
        )
      })
      .catch(async (e) => {
        if (!live) return
        setFailure(String(e))
        setStatus(await client.status().catch(() => null))
      })
    return () => {
      live = false
    }
  }, [reload])

  const entry = entries.find((e) => e.id === activeId) ?? null
  useEffect(() => {
    if (!entry) return
    let live = true
    setWorkflow(null)
    setTools(new Map())
    setDescribeError(null)
    client
      .describe(entry.id)
      .then((doc) => {
        if (!live) return
        if (entry.kind === 'tool') {
          const tool = toolFromDocument(doc as Record<string, unknown>)
          setTools(new Map([[tool.id, tool]]))
          setWorkflow(wrapToolAsWorkflow(doc))
        } else setWorkflow(doc as WorkflowDocument)
      })
      .catch((e) => live && setDescribeError(String(e)))
    return () => {
      live = false
    }
  }, [entry])

  useEffect(() => {
    if (props.preferSelected > 0) setSelectedOnly(true)
  }, [props.preferSelected])

  const target = entry ? targetInput(entry.inputSchema) : null

  // sourcePath lives in per-volume metadata; fetch it only while a volume pipeline is on screen.
  // Failures stay uncached and are retried once per dataset or visibility change.
  const tried = useRef(new Set<string>())
  const root = useRef(ctx.datasetRoot)
  const [loading, setLoading] = useState(0)
  useEffect(() => {
    root.current = ctx.datasetRoot
    tried.current = new Set()
    setPaths({})
  }, [ctx.datasetRoot])
  useEffect(() => {
    if (!hidden) tried.current = new Set()
  }, [hidden])
  const pool = (
    selectedOnly ? (ctx.selected ? [ctx.selected] : []) : ctx.filtered
  ).filter((i) => i.role !== 'overlay')
  const missing =
    target?.kind === 'volume' ? pool.filter((i) => !(i.id in paths)) : []
  const missingKey = missing.map((i) => i.id).join('\n')
  // biome-ignore lint/correctness/useExhaustiveDependencies: missingKey stands for missing.
  useEffect(() => {
    if (hidden) return
    const todo = missing.filter((i) => !tried.current.has(i.id))
    if (!todo.length) return
    for (const i of todo) tried.current.add(i.id)
    const forRoot = root.current
    setLoading((n) => n + 1)
    // shortcut: one metadata fetch per volume, all at once; page it if datasets reach thousands.
    void Promise.all(
      todo.map((i) =>
        fetchVolumeMetadata(i).then(
          (m) => [i.id, m.sourcePath ?? null] as const,
          () => [i.id, null] as const,
        ),
      ),
    )
      .then((found) => {
        const ok = found.flatMap(([id, path]) => (path ? [[id, path]] : []))
        if (root.current === forRoot && ok.length)
          setPaths((p) => ({ ...p, ...Object.fromEntries(ok) }))
      })
      .finally(() => setLoading((n) => n - 1))
  }, [hidden, missingKey])

  const withPath = (i: DesktopItem | null) =>
    i && { ...i, sourcePath: paths[i.id] ?? null }
  const resolved = target
    ? resolveTargets(target.kind, {
        datasetRoot: ctx.datasetRoot,
        bidsName: ctx.bidsName,
        filtered: ctx.filtered.map((i) => ({
          ...i,
          sourcePath: paths[i.id] ?? null,
        })),
        selected: withPath(ctx.selected),
        selectedOnly,
      })
    : null
  const targets: BatchTarget[] = resolved
    ? resolved.targets
    : entry
      ? [
          {
            key: 'run',
            label: entry.title,
            path: '',
            itemId: ctx.selected?.id ?? null,
          },
        ]
      : []

  // The runner: one tools/call in flight; each settled row re-renders and starts the next.
  const busy = useRef(false)
  const handle = useRef<RunHandle | null>(null)
  const cancelling = useRef(false)
  const batchEntry = useRef<CatalogEntry | null>(null)
  const [settled, setSettled] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: settled re-checks the queue once busy clears.
  useEffect(() => {
    const run = batchEntry.current
    if (!batch || !run || busy.current) return
    const index = nextQueued(batch)
    if (index === null) return
    busy.current = true
    cancelling.current = false
    const { id, inputs, startedAt, title } = batch
    const row = batch.rows[index].target
    const ti = targetInput(run.inputSchema)
    const send = (ev: Parameters<typeof reduceBatch>[1]) =>
      setBatch((b) => (b?.id === id ? reduceBatch(b, ev) : b))
    // 'start' first: reduceBatch drops any other event on a never-started row.
    send({
      type: 'row',
      index,
      ev: { type: 'start', workflowId: batch.workflowId },
    })
    let sent = false
    void (async () => {
      try {
        if (ti) await client.checkPath(row.path)
        if (cancelling.current) throw new Error('cancelled')
        sent = true
        const h = client.run(
          run,
          ti ? { ...inputs, [ti.name]: row.path } : inputs,
          (p) => send({ type: 'row', index, ev: { type: 'progress', ...p } }),
        )
        handle.current = h
        const structured = await h.result
        // A missing run.json still lets the outputs load; RunPanel just lacks per-step status.
        const { sessionDir, record } = await client
          .readRun(structured.runId)
          .catch(() => ({ sessionDir: '', record: {} }))
        send({
          type: 'row',
          index,
          ev: { type: 'done', structured, sessionDir, record },
        })
        if (structured.status === 'completed') {
          const p = latest.current
          p.onRunOutputs(
            structured,
            { runId: structured.runId, title, startedAt, sessionDir },
            row,
            ti?.kind !== 'volume' || row.itemId === p.ctx.selected?.id,
          )
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        // A path rejection never reached the process, so its stderr isn't this row's.
        const stderrTail =
          sent && !cancelling.current
            ? await client
                .status()
                .then((st) => st.stderrTail.join('\n') || undefined)
                .catch(() => undefined)
            : undefined
        send({
          type: 'row',
          index,
          ev: cancelling.current
            ? { type: 'cancelled' }
            : { type: 'error', message, stderrTail },
        })
      } finally {
        busy.current = false
        handle.current = null
        setSettled((n) => n + 1)
      }
    })()
  }, [batch, settled])

  const running = isActive(batch)
  const cancelBatch = () => {
    setBatch((b) => b && reduceBatch(b, { type: 'cancelQueued' }))
    cancelling.current = true
    handle.current?.requestId.then(client.cancel).catch(() => {})
  }
  const begin = (b: Batch, e: CatalogEntry) => {
    batchEntry.current = e
    setClicked(null)
    setBatch(b)
  }

  if (status && !status.configured)
    return (
      <div className="nv-pipelines nv-pipelines-state" hidden={hidden}>
        <strong>NeuroFlow isn't set up</strong>
        <p>Settings file: {status.settingsPath}</p>
        <div className="nv-pipelines-actions">
          <button
            type="button"
            onClick={() => props.onReveal(status.settingsPath)}
          >
            Reveal settings file
          </button>
          <button type="button" onClick={() => setReload((n) => n + 1)}>
            Check again
          </button>
        </div>
      </div>
    )
  if (failure)
    return (
      <div className="nv-pipelines nv-pipelines-state" hidden={hidden}>
        <strong>NeuroFlow stopped</strong>
        <p>{failure}</p>
        {status?.stderrTail.length ? (
          <pre>{status.stderrTail.join('\n')}</pre>
        ) : null}
        <div className="nv-pipelines-actions">
          <button
            type="button"
            onClick={() =>
              void client.restart().finally(() => setReload((n) => n + 1))
            }
          >
            Restart
          </button>
        </div>
      </div>
    )

  const own = batch && entry && batch.workflowId === entry.id ? batch : null
  const lockedLabel =
    target?.kind === 'dataset'
      ? 'Dataset root'
      : selectedOnly
        ? 'Selected volume'
        : `${targets.length} target volume${targets.length === 1 ? '' : 's'}`
  const runnable = running
    ? 'A batch is running'
    : loading
      ? 'Reading volume paths…'
      : (resolved?.blocker ?? null)

  const strip = entry && (
    <div className="nv-pipelines-targets">
      {describeError ? (
        <p className="nv-pipelines-error">
          Couldn't load {entry.title}: {describeError}
        </p>
      ) : null}
      <div className="nv-pipelines-targets-head">
        <strong>Targets</strong>
        <span>
          {target?.kind === 'dataset'
            ? 'Dataset'
            : target
              ? 'One run per volume'
              : 'Single run'}{' '}
          · {targets.length}
        </span>
        {target?.kind === 'volume' ? (
          <label>
            <input
              checked={selectedOnly}
              onChange={(e) => setSelectedOnly(e.target.checked)}
              type="checkbox"
            />
            Selected only
          </label>
        ) : null}
      </div>
      {target ? (
        <p className="nv-pipelines-names">
          {targets
            .slice(0, SHOWN_NAMES)
            .map((t) => t.label)
            .join(', ')}
          {targets.length > SHOWN_NAMES
            ? ` +${targets.length - SHOWN_NAMES} more`
            : ''}
        </p>
      ) : null}
      {batch && !own && running ? (
        <p className="nv-pipelines-names">Batch running for {batch.title}</p>
      ) : null}
      {own ? (
        <>
          <ul className="nv-pipelines-rows">
            {own.rows.map((r, i) => (
              <li
                className={`is-${r.status} ${clicked === i ? 'is-viewed' : ''}`}
                key={r.target.key}
              >
                <button
                  className="nv-pipelines-row-label"
                  onClick={() => setClicked(i)}
                  type="button"
                >
                  {r.target.label}
                </button>
                <span>
                  {r.status}
                  {r.status === 'running' && r.run?.total
                    ? ` ${r.run.progress}/${r.run.total}`
                    : ''}
                </span>
                {sessionDir(r) ? (
                  <button
                    onClick={() => props.onReveal(sessionDir(r))}
                    type="button"
                  >
                    Reveal
                  </button>
                ) : null}
                {r.target.itemId ? (
                  <button
                    onClick={() => props.onShowTarget(r.target)}
                    type="button"
                  >
                    Show
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="nv-pipelines-actions">
            {running ? (
              <button onClick={cancelBatch} type="button">
                Cancel batch
              </button>
            ) : retryTargets(own).length && batchEntry.current ? (
              <button
                onClick={() =>
                  batchEntry.current &&
                  begin(
                    startBatch(
                      own.workflowId,
                      own.title,
                      own.inputs,
                      retryTargets(own),
                      Date.now(),
                    ),
                    batchEntry.current,
                  )
                }
                type="button"
              >
                Re-run failed
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )

  return (
    <div className="nv-pipelines" hidden={hidden}>
      <PipelineView
        items={entries.map((e) => ({
          id: e.id,
          label: e.title,
          description: e.description,
          workflow: stub(e.id),
        }))}
        activeId={activeId}
        onSelect={setActiveId}
        workflow={workflow}
        tools={tools}
        run={own ? (shownRow(own, clicked)?.run ?? null) : null}
        lockedInputs={target ? { [target.name]: lockedLabel } : undefined}
        runnable={runnable}
        onStart={(inputs) => {
          if (!entry || running || runnable) return
          begin(
            startBatch(entry.id, entry.title, inputs, targets, Date.now()),
            entry,
          )
        }}
        onCancel={cancelBatch}
        onOpen={props.onReveal}
        targets={strip}
      />
    </div>
  )
}
