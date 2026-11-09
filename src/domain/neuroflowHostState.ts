import type {
  HostRunState,
  RunRecord,
  RunStructured,
} from '@cdrake/neuroflow-react'

export type RunEv =
  | { type: 'start'; workflowId: string }
  | { type: 'progress'; progress: number; total?: number; message?: string }
  | {
      type: 'done'
      structured: RunStructured
      sessionDir: string
      record: RunRecord
    }
  | { type: 'error'; message: string }
  | { type: 'cancelled' }

const blank = (workflowId: string): HostRunState => ({
  ticket: null,
  workflowId,
  status: 'starting',
  progress: 0,
  total: 0,
  message: '',
  currentStep: null,
  finished: null,
  stderrTail: null,
  error: null,
})

export function reduceRunState(
  prev: HostRunState | null,
  ev: RunEv,
): HostRunState {
  if (ev.type === 'start') return blank(ev.workflowId)
  const s = prev ?? blank('')
  switch (ev.type) {
    case 'progress':
      return {
        ...s,
        status: 'running',
        progress: ev.progress,
        total: ev.total ?? s.total,
        message: ev.message ?? s.message,
      }
    case 'done': {
      const { structured } = ev
      return {
        ...s,
        status:
          structured.status === 'completed' || structured.status === 'cancelled'
            ? structured.status
            : 'failed',
        stderrTail: structured.logs?.stderr ?? null,
        finished: {
          ticket: '',
          ok: structured.status === 'completed',
          runId: structured.runId,
          status: structured.status,
          structured,
          summary: '',
          sessionDir: ev.sessionDir,
          record: ev.record,
        },
      }
    }
    case 'error':
      return { ...s, status: 'failed', error: ev.message }
    case 'cancelled':
      return { ...s, status: 'cancelled' }
  }
}
