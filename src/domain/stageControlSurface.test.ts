import { expect, test } from 'bun:test'
import {
  pressStageButton,
  replayStageControls,
  setStageControl,
  stageControlHint,
  stageControlStates,
} from './stageControlSurface'
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
  shapes: null,
  draw: {
    active: false,
    enabled: true,
    tools: [
      { id: 'pen', label: 'Pen' },
      { id: 'wand', label: 'Wand' },
    ],
    tool: 'pen',
    hasDrawing: false,
    canSend: false,
  },
  canExport: false,
  magnify: null,
  magnifyZoom: null,
  levels: null,
  box: null,
  palette: null,
  wand: null,
  slice: { label: 'Axial', value: 3, max: 9, marks: [] },
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
    drawTool: log('drawTool'),
    wandTolerance: log('wandTolerance'),
    undo: log('undo'),
    clearDrawing: log('clearDrawing'),
    send: log('send'),
    pen: log('pen'),
    brush: log('brush'),
    slice: log('slice'),
    clipPlane: log('clipPlane'),
    clipDepth: log('clipDepth'),
    magnify: log('magnify'),
    magnifyZoom: log('magnifyZoom'),
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

test('picks the draw tool and sets the wand', () => {
  const { calls, actions } = recorder()
  const drawing: StageControlsState = {
    ...state,
    draw: {
      ...(state.draw as NonNullable<StageControlsState['draw']>),
      active: true,
      tool: 'wand',
    },
    wand: { tolerance: 0.05, volume: false },
  }
  const live = { state: drawing, actions }
  expect(stageControlStates(drawing).map((c) => c.id)).toContain('draw-tool')
  setStageControl(live, 'draw-tool', { value: 'pen' })
  expect(setStageControl(live, 'wand-tolerance', { value: 2 }).value).toBe(0.5)
  expect(() => setStageControl(live, 'draw-tool', { value: 'fill' })).toThrow(
    'pen, wand',
  )
  expect(calls).toEqual(['drawTool:pen', 'wandTolerance:0.5'])
})

test('lists and sets the magnifier', () => {
  const { calls, actions } = recorder()
  const magnifying: StageControlsState = {
    ...state,
    magnify: true,
    magnifyZoom: 3,
  }
  const live = { state: magnifying, actions }
  expect(stageControlStates(magnifying).map((c) => c.id)).toContain(
    'magnify-zoom',
  )
  setStageControl(live, 'magnify', { value: true })
  expect(setStageControl(live, 'magnify-zoom', { value: 20 }).value).toBe(10)
  setStageControl(live, 'magnify', { value: false })
  expect(calls).toEqual(['magnifyZoom:10', 'magnify'])
})

test('every button the stage lists can be pressed', () => {
  const full: StageControlsState = {
    ...state,
    box: { active: true, enabled: true },
    measure: { active: false, enabled: true, tools: [], tool: '' },
    shapes: { active: true, enabled: true, tools: [], tool: '' },
    draw: {
      ...(state.draw as NonNullable<StageControlsState['draw']>),
      active: true,
      hasDrawing: true,
      canSend: true,
    },
    canExport: true,
  }
  const buttons = stageControlStates(full).filter((c) => c.kind === 'button')
  const pressed: string[] = []
  const actions = new Proxy({} as StageControlsActions, {
    get: (_, name) => () => pressed.push(String(name)),
  })
  for (const button of buttons) pressStageButton(actions, button.id)
  expect(pressed.length).toBe(buttons.length)
})

test('names the slices holding a drawing', () => {
  const marked = {
    ...state,
    slice: {
      label: 'Axial',
      value: 3,
      max: 9,
      marks: [
        [1, 3],
        [7, 7],
      ] as const,
    },
  }
  const slice = stageControlStates(marked).find((c) => c.id === 'slice')
  expect(slice?.label).toBe('Axial, drawings on slices 2–4, 8')
})

test('a saved tool hint replays a toggle, then its tool the next frame', () => {
  const frames: (() => void)[] = []
  const raf = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = (cb) => frames.push(() => cb(0))
  try {
    const { calls, actions } = recorder()
    const live = { state: structuredClone(state), actions }
    replayStageControls(() => live, {
      draw: true,
      'draw-tool': 'wand',
      'view-mode': 'axial',
      unknown: 1,
    })
    expect(calls).toEqual(['draw'])
    // The re-render the press caused.
    if (live.state.draw) live.state.draw.active = true
    frames.shift()?.()
    expect(calls).toEqual(['draw', 'drawTool:wand'])
    expect(frames).toHaveLength(0)
  } finally {
    globalThis.requestAnimationFrame = raf
  }
})

test('the hint keeps tool state, not scene state', () => {
  const hint = stageControlHint(state)
  expect(hint).toEqual({ draw: false })
})
