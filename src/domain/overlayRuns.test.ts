import { expect, test } from 'bun:test'
import { groupOverlaysByRun, type RunTag } from './overlayRuns'

const tag = (runId: string): RunTag => ({
  runId,
  title: runId,
  startedAt: 0,
  sessionDir: '/',
})
test('groupOverlaysByRun keeps order and splits untagged runs', () => {
  const a = tag('a')
  const b = tag('b')
  const items = ['u1', 'a1', 'a2', 'u2', 'b1'].map((id) => ({ id }))
  const g = groupOverlaysByRun(items, { a1: a, a2: a, b1: b })
  expect(
    g.map((x) => [x.tag?.runId ?? null, x.items.map((i) => i.id)]),
  ).toEqual([
    [null, ['u1']],
    ['a', ['a1', 'a2']],
    [null, ['u2']],
    ['b', ['b1']],
  ])
})
