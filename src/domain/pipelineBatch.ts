import type { HostRunState } from '@cdrake/neuroflow-react'
import { type RunEv, reduceRunState } from './neuroflowHostState'
import type { BatchTarget } from './pipelineTargets'

export type RowStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
export type BatchRow = {
  target: BatchTarget
  status: RowStatus
  run: HostRunState | null
}
export type Batch = {
  id: string
  workflowId: string
  title: string
  startedAt: number
  inputs: Record<string, unknown>
  rows: BatchRow[]
}

export function startBatch(
  workflowId: string,
  title: string,
  inputs: Record<string, unknown>,
  targets: BatchTarget[],
  now: number,
): Batch {
  return {
    id: crypto.randomUUID(),
    workflowId,
    title,
    startedAt: now,
    inputs: structuredClone(inputs),
    rows: targets.map((t) => ({
      target: { ...t },
      status: 'queued',
      run: null,
    })),
  }
}

export function reduceBatch(
  b: Batch,
  ev: { type: 'row'; index: number; ev: RunEv } | { type: 'cancelQueued' },
): Batch {
  if (ev.type === 'cancelQueued')
    return {
      ...b,
      rows: b.rows.map((r) =>
        r.status === 'queued' ? { ...r, status: 'cancelled' } : r,
      ),
    }
  return {
    ...b,
    rows: b.rows.map((r, i) => {
      if (i !== ev.index) return r
      // terminal rows are sticky, and a never-started row only accepts 'start'
      const terminal =
        r.status === 'completed' ||
        r.status === 'failed' ||
        r.status === 'cancelled'
      if (ev.ev.type !== 'start' && (terminal || !r.run)) return r
      const run = reduceRunState(r.run, ev.ev)
      const status = run.status
      return {
        ...r,
        run,
        // 'starting' and 'rejected' map onto the row's coarser states
        status:
          status === 'starting'
            ? 'running'
            : status === 'rejected'
              ? 'failed'
              : status,
      }
    }),
  }
}

export function nextQueued(b: Batch): number | null {
  if (b.rows.some((r) => r.status === 'running')) return null
  const i = b.rows.findIndex((r) => r.status === 'queued')
  return i < 0 ? null : i
}

export const retryTargets = (b: Batch): BatchTarget[] =>
  b.rows
    .filter((r) => r.status === 'failed' || r.status === 'cancelled')
    .map((r) => r.target)

/** The row RunPanel shows: the clicked one, else the running one, else the last. */
export function shownRow(b: Batch, clicked: number | null): BatchRow | null {
  return (
    (clicked !== null ? b.rows[clicked] : undefined) ??
    b.rows.find((r) => r.status === 'running') ??
    b.rows[b.rows.length - 1] ??
    null
  )
}

export const isActive = (b: Batch | null): boolean =>
  !!b?.rows.some((r) => r.status === 'queued' || r.status === 'running')
