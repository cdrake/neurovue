import { describe, expect, test } from 'bun:test'
import type { RunStructured } from '@cdrake/neuroflow-react'
import type { RunEv } from './neuroflowHostState'
import {
  isActive,
  nextQueued,
  reduceBatch,
  retryTargets,
  shownRow,
  startBatch,
} from './pipelineBatch'
import type { BatchTarget } from './pipelineTargets'

const t = (k: string): BatchTarget => ({
  key: k,
  label: k,
  path: `/${k}`,
  itemId: k,
})
const targets = [t('a'), t('b'), t('c')]
const structured = (status: string): RunStructured => ({
  runId: 'r',
  status,
  outputs: {},
  provenance: '',
})
const done = (status: string) =>
  ({
    type: 'done',
    structured: structured(status),
    sessionDir: '/s',
    record: {},
  }) as const
const row = (index: number, ev: RunEv) => ({ type: 'row', index, ev }) as const

describe('batch', () => {
  const b0 = () => startBatch('w', 'T', { x: 1 }, targets, 5)
  test('runs serially', () => {
    let b = b0()
    expect(nextQueued(b)).toBe(0)
    b = reduceBatch(b, row(0, { type: 'start', workflowId: 'w' }))
    expect(nextQueued(b)).toBeNull()
    b = reduceBatch(b, row(0, done('completed')))
    expect(b.rows[0].status).toBe('completed')
    expect(nextQueued(b)).toBe(1)
  })
  test('continues after a failed row', () => {
    let b = b0()
    b = reduceBatch(b, row(0, { type: 'start', workflowId: 'w' }))
    b = reduceBatch(b, row(0, { type: 'error', message: 'x' }))
    expect(b.rows[0].status).toBe('failed')
    expect(nextQueued(b)).toBe(1)
  })
  test('snapshots inputs and targets', () => {
    const inputs = { x: 1 }
    const ts = [t('a')]
    const b = startBatch('w', 'T', inputs, ts, 5)
    inputs.x = 2
    ts[0].path = '/changed'
    ts.push(t('z'))
    expect(b.inputs).toEqual({ x: 1 })
    expect(b.rows.length).toBe(1)
    expect(b.rows[0].target.path).toBe('/a')
  })
  test('cancelQueued leaves running row; retryTargets lists failed+cancelled', () => {
    let b = b0()
    b = reduceBatch(b, row(0, { type: 'start', workflowId: 'w' }))
    b = reduceBatch(b, { type: 'cancelQueued' })
    expect(b.rows.map((r) => r.status)).toEqual([
      'running',
      'cancelled',
      'cancelled',
    ])
    b = reduceBatch(b, row(0, done('failed')))
    expect(retryTargets(b).map((x) => x.key)).toEqual(['a', 'b', 'c'])
  })
  test('terminal rows are sticky against late events', () => {
    let b = b0()
    b = reduceBatch(b, row(0, { type: 'start', workflowId: 'w' }))
    b = reduceBatch(b, row(0, { type: 'cancelled' }))
    b = reduceBatch(b, row(0, { type: 'progress', progress: 1 }))
    b = reduceBatch(b, row(0, done('completed')))
    expect(b.rows[0].status).toBe('cancelled')
    expect(nextQueued(b)).toBe(1)
  })
})

test('shownRow and isActive', () => {
  let b = startBatch('w', 'T', {}, targets, 5)
  expect(isActive(b)).toBe(true)
  expect(shownRow(b, null)).toBe(b.rows[2])
  b = reduceBatch(b, row(1, { type: 'start', workflowId: 'w' }))
  expect(shownRow(b, null)).toBe(b.rows[1])
  expect(shownRow(b, 0)).toBe(b.rows[0])
  b = reduceBatch(b, { type: 'cancelQueued' })
  b = reduceBatch(b, row(1, done('completed')))
  expect(isActive(b)).toBe(false)
  expect(isActive(null)).toBe(false)
})
