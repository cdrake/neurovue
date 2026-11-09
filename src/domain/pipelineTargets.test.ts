import { describe, expect, test } from 'bun:test'
import { resolveTargets, targetInput } from './pipelineTargets'

const schema = (props: Record<string, string>, required: string[]) => ({
  type: 'object',
  required,
  properties: Object.fromEntries(
    Object.entries(props).map(([k, t]) => [k, { 'x-neuroflow-type': t }]),
  ),
})

describe('targetInput', () => {
  test('matches by type not name', () => {
    const s = {
      type: 'object',
      required: ['input'],
      properties: {
        input: { 'x-neuroflow-type': 'neuro:volume' },
        volume: { type: 'string' },
      },
    }
    expect(targetInput(s)).toEqual({ name: 'input', kind: 'volume' })
  })
  test('skips optional inputs and returns null when nothing matches', () => {
    expect(targetInput(schema({ a: 'neuro:volume' }, []))).toBeNull()
    expect(targetInput(schema({ a: 'neuro:other' }, ['a']))).toBeNull()
  })
  test('maps bids-dataset to dataset, label-map and mask to volume', () => {
    expect(targetInput(schema({ d: 'neuro:bids-dataset' }, ['d']))).toEqual({
      name: 'd',
      kind: 'dataset',
    })
    expect(targetInput(schema({ l: 'neuro:label-map' }, ['l']))?.kind).toBe(
      'volume',
    )
    expect(targetInput(schema({ m: 'neuro:mask' }, ['m']))?.kind).toBe('volume')
  })
})

describe('resolveTargets', () => {
  const item = (id: string, sourcePath?: string, role?: 'overlay') => ({
    id,
    label: id,
    sourcePath,
    role,
  })
  const ctx = (o = {}) => ({
    datasetRoot: '/d',
    bidsName: 'ds',
    filtered: [item('a', '/a.nii'), item('b', '/b.nii')],
    selected: null,
    selectedOnly: false,
    ...o,
  })
  test('dataset on non-BIDS folder is blocked', () => {
    expect(resolveTargets('dataset', ctx({ bidsName: null }))).toEqual({
      targets: [],
      blocker: 'needs a BIDS dataset',
    })
  })
  test('dataset gives one target', () => {
    expect(resolveTargets('dataset', ctx()).targets).toEqual([
      { key: '/d', label: 'ds', path: '/d', itemId: null },
    ])
  })
  test('skips overlays and items without sourcePath', () => {
    const r = resolveTargets(
      'volume',
      ctx({
        filtered: [
          item('a', '/a.nii'),
          item('o', '/o.nii', 'overlay'),
          item('n'),
        ],
      }),
    )
    expect(r.targets.map((t) => t.itemId)).toEqual(['a'])
  })
  test('selectedOnly gives one target', () => {
    const r = resolveTargets(
      'volume',
      ctx({ selectedOnly: true, selected: item('b', '/b.nii') }),
    )
    expect(r.targets.map((t) => t.itemId)).toEqual(['b'])
  })
  test('zero items gives filters blocker', () => {
    expect(resolveTargets('volume', ctx({ filtered: [] })).blocker).toBe(
      'no volumes match the filters',
    )
  })
})
