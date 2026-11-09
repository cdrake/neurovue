import { describe, expect, test } from 'bun:test'
import type { RunRecord, RunStructured } from '@cdrake/neuroflow-react'
import { type RunEv, reduceRunState } from './neuroflowHostState'

const run = (evs: RunEv[]) => evs.reduce(reduceRunState, null as never)
const st = (status: string, stderr?: string): RunStructured => ({
  runId: 'r1',
  status,
  outputs: {},
  provenance: '',
  logs: stderr === undefined ? undefined : { stdout: '', stderr },
})
const record: RunRecord = { runId: 'r1' }

describe('reduceRunState', () => {
  test('start, progress, done(completed)', () => {
    const s = run([
      { type: 'start', workflowId: 'w' },
      { type: 'progress', progress: 1, total: 3, message: 'm' },
      { type: 'done', structured: st('completed'), sessionDir: '/s', record },
    ])
    expect(s.status).toBe('completed')
    expect(s.progress).toBe(1)
    expect(s.total).toBe(3)
    expect(s.finished).toMatchObject({
      ok: true,
      runId: 'r1',
      sessionDir: '/s',
      record,
    })
  })
  test('start gives starting; progress gives running', () => {
    expect(run([{ type: 'start', workflowId: 'w' }]).status).toBe('starting')
    expect(
      run([
        { type: 'start', workflowId: 'w' },
        { type: 'progress', progress: 0 },
      ]).status,
    ).toBe('running')
  })
  test('done(failed) sets stderrTail', () => {
    const s = run([
      { type: 'start', workflowId: 'w' },
      {
        type: 'done',
        structured: st('failed', 'boom'),
        sessionDir: '/s',
        record,
      },
    ])
    expect(s.status).toBe('failed')
    expect(s.stderrTail).toBe('boom')
    expect(s.finished).toMatchObject({ ok: false })
  })
  test('error gives failed', () => {
    const s = run([
      { type: 'start', workflowId: 'w' },
      { type: 'error', message: 'x' },
    ])
    expect(s.status).toBe('failed')
    expect(s.error).toBe('x')
  })
  test('cancelled after progress', () => {
    const s = run([
      { type: 'start', workflowId: 'w' },
      { type: 'progress', progress: 1 },
      { type: 'cancelled' },
    ])
    expect(s.status).toBe('cancelled')
    expect(s.progress).toBe(1)
  })
})
