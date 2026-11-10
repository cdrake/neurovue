import { expect, test } from 'bun:test'
import { setStageControl, stageControlStates } from './stageControlSurface'
import type { StageControlsActions, StageControlsState } from './stageControls'

const state: StageControlsState = {
  viewModes: [
    { id: 'axial', label: 'Ax' },
    { id: 'render', label: '3D' },
  ],
  viewMode: 'render',
  hasVolume: true,
  look: {
    presets: [
      { id: 'standard', label: 'Standard' },
      { id: 'cinematic', label: 'Cinematic' },
    ],
    value: 'standard',
  },
  measure: null,
  draw: {
    active: false,
    enabled: true,
    eraser: false,
    hasDrawing: false,
    canSend: false,
  },
  palette: null,
  slice: { label: 'Axial', value: 3, max: 9 },
  clip: null,
}

function recorder(): { calls: string[]; actions: StageControlsActions } {
  const calls: string[] = []
  const log =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args].join(':'))
    }
  const actions = {
    viewMode: log('viewMode'),
    look: log('look'),
    measure: log('measure'),
    clearMeasurements: log('clearMeasurements'),
    draw: log('draw'),
    erase: log('erase'),
    undo: log('undo'),
    clearDrawing: log('clearDrawing'),
    send: log('send'),
    pen: log('pen'),
    brush: log('brush'),
    slice: log('slice'),
    clipPlane: log('clipPlane'),
    clipDepth: log('clipDepth'),
  } as StageControlsActions
  return { calls, actions }
}

test('lists what the stage shows', () => {
  expect(stageControlStates(state).map((c) => `${c.id}:${c.kind}`)).toEqual([
    'view-mode:segmented',
    'look:segmented',
    'draw:toggle',
    'slice:slider',
  ])
})

test('sets controls through the stage actions', () => {
  const { calls, actions } = recorder()
  const live = { state, actions }
  expect(setStageControl(live, 'look', { value: 'cinematic' }).value).toBe(
    'cinematic',
  )
  // A toggle already in the asked state isn't pressed again.
  setStageControl(live, 'draw', { value: false })
  setStageControl(live, 'draw', { value: true })
  expect(setStageControl(live, 'slice', { value: 42.4 }).value).toBe(9)
  expect(calls).toEqual(['look:cinematic', 'draw', 'slice:9'])
})

test('refuses in words', () => {
  const { actions } = recorder()
  const live = { state, actions }
  expect(() => setStageControl(live, 'look', { value: 'glass' })).toThrow(
    'standard, cinematic',
  )
  expect(() => setStageControl(live, 'nope', { value: 1 })).toThrow(
    'list_controls',
  )
  expect(() => setStageControl(live, 'look', { label: 'x' })).toThrow(
    'only a value',
  )
})
