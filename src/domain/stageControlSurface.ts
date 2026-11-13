// The stage's on-canvas controls, as nv-mcp's control tools see them: an agent
// lists the same view mode, look, tools, pen and sliders a person sees, and
// sets them through the same actions. The set is fixed by the stage, so
// add_control and remove_control decline; set_view and set_options remain the
// way to change NiiVue directly.
import type {
  ControlPatch,
  ControlState,
  HostedControls,
} from '@niivue/nv-mcp/browser'
import type { StageControlsActions, StageControlsState } from './stageControls'

type Live = { state: StageControlsState; actions: StageControlsActions }

// One stage per window: the one attached last answers.
let live: (() => Live | null) | null = null

/** Makes `source` the stage the control tools answer for; returns the release. */
export function provideStageControls(source: () => Live | null): () => void {
  live = source
  return () => {
    if (live === source) live = null
  }
}

const WAND_SCOPES = [
  { id: 'slice', label: 'Slice' },
  { id: 'volume', label: 'Volume' },
]

function segmented(
  id: string,
  label: string,
  options: readonly { id: string; label: string }[],
  value: string | null,
  enabled = true,
): ControlState {
  return {
    id,
    kind: 'segmented',
    label,
    options: options.map((o) => ({ id: o.id, label: o.label })),
    value,
    enabled,
  }
}

function toggle(
  id: string,
  label: string,
  value: boolean,
  enabled: boolean,
): ControlState {
  return { id, kind: 'toggle', label, value, enabled }
}

function button(id: string, label: string, enabled: boolean): ControlState {
  return { id, kind: 'button', label, value: null, enabled }
}

/** The controls the stage shows now, as nv-mcp reports controls. */
export function stageControlStates(state: StageControlsState): ControlState[] {
  const controls: ControlState[] = [
    segmented(
      'view-mode',
      'View',
      state.viewModes,
      state.viewMode,
      state.hasVolume,
    ),
  ]
  if (state.look) {
    controls.push(
      segmented('look', 'Look', state.look.presets, state.look.value),
    )
  }
  const { measure, shapes, draw } = state
  if (measure) {
    controls.push(
      toggle('measure', 'Measure', measure.active, measure.enabled),
      button('clear-measure', 'Clear ruler', measure.enabled),
    )
    if (measure.active) {
      controls.push(
        segmented('measure-tool', 'Measure tool', measure.tools, measure.tool),
      )
    }
  }
  if (shapes) {
    controls.push(toggle('shapes', 'Shapes', shapes.active, shapes.enabled))
    if (shapes.active) {
      controls.push(
        segmented('shape-tool', 'Shape', shapes.tools, shapes.tool),
        button('shape-undo', 'Undo', true),
        button('shape-redo', 'Redo', true),
        button('clear-shapes', 'Clear shapes', true),
      )
    }
  }
  if (draw) {
    controls.push(toggle('draw', 'Draw', draw.active, draw.enabled))
    if (draw.active) {
      controls.push(
        segmented('draw-tool', 'Draw tool', draw.tools, draw.tool),
        button('undo', 'Undo', draw.hasDrawing),
        button('clear-drawing', 'Clear ink', draw.hasDrawing),
        button('save-mask', 'Save mask', draw.hasDrawing),
      )
    }
  }
  if (state.canExport) controls.push(button('export-svg', 'Export SVG', true))
  if (draw?.canSend) controls.push(button('send', 'Send', true))
  const { palette } = state
  if (palette) {
    controls.push(
      segmented(
        'pen',
        'Pen',
        palette.colors.map((c) => ({ id: String(c.value), label: c.name })),
        palette.eraser ? null : String(palette.penValue),
      ),
      segmented(
        'brush',
        'Brush',
        palette.sizes.map((s) => ({ id: String(s.size), label: s.name })),
        String(palette.brushSize),
      ),
    )
  }
  const { wand } = state
  if (wand) {
    controls.push(
      {
        id: 'wand-tolerance',
        kind: 'slider',
        label: 'Wand tolerance',
        min: 0.01,
        max: 0.5,
        step: 0.01,
        value: wand.tolerance,
        enabled: true,
      },
      segmented(
        'wand-scope',
        'Wand reach',
        WAND_SCOPES,
        wand.volume ? 'volume' : 'slice',
      ),
    )
  }
  if (state.slice) {
    controls.push({
      id: 'slice',
      kind: 'slider',
      label: state.slice.label,
      min: 0,
      max: state.slice.max,
      step: 1,
      value: state.slice.value,
      enabled: true,
    })
  }
  const { clip } = state
  if (clip) {
    controls.push(
      segmented('clip-planes', 'Clip plane', clip.planes, clip.activeId),
      {
        id: 'clip-depth',
        kind: 'slider',
        label: clip.slider ? `${clip.slider.label} clip` : 'Clip',
        min: -1,
        max: 1,
        step: 0.02,
        value: clip.slider?.depth ?? 0,
        enabled: clip.slider !== null,
      },
    )
  }
  return controls
}

/**
 * Sets one control to `value` through the stage's own actions, as a click or
 * drag would, and returns it as it now stands. Throws in words otherwise.
 */
export function setStageControl(
  { state, actions }: Live,
  id: string,
  patch: ControlPatch,
): ControlState {
  const control = stageControlStates(state).find((c) => c.id === id)
  if (!control) {
    throw new Error(
      `The stage shows no control "${id}" now. list_controls shows the ones it has.`,
    )
  }
  const extra = Object.keys(patch).filter((key) => key !== 'value')
  if (extra.length > 0 || patch.value === undefined) {
    throw new Error(
      `NeuroVue's stage controls take only a value; ${id} can't change ${extra.join(', ') || 'anything else'}.`,
    )
  }
  if (!control.enabled) throw new Error(`"${control.label}" is disabled now.`)
  const { value } = patch
  switch (control.kind) {
    case 'button':
      throw new Error(
        `"${control.label}" is a button; set_control can't press it.`,
      )
    case 'toggle': {
      if (typeof value !== 'boolean') {
        throw new Error(`"${control.label}" takes true or false.`)
      }
      // The stage's tool buttons toggle, so press only to change.
      if (value !== control.value) {
        if (id === 'measure') actions.measure()
        else if (id === 'shapes') actions.shapes()
        else if (id === 'draw') actions.draw()
      }
      return { ...control, value }
    }
    case 'segmented': {
      const option = control.options?.find((o) => o.id === String(value))
      if (!option) {
        const ids = control.options?.map((o) => o.id).join(', ')
        throw new Error(`"${control.label}" takes one of: ${ids}.`)
      }
      if (id === 'view-mode') actions.viewMode(option.id)
      else if (id === 'look') actions.look(option.id)
      else if (id === 'measure-tool') actions.measureTool(option.id)
      else if (id === 'shape-tool') actions.shapeTool(option.id)
      else if (id === 'draw-tool') actions.drawTool(option.id)
      else if (id === 'wand-scope') actions.wandVolume(option.id === 'volume')
      else if (id === 'pen') actions.pen(Number(option.id))
      else if (id === 'brush') actions.brush(Number(option.id))
      else if (id === 'clip-planes') actions.clipPlane(option.id)
      return { ...control, value: option.id }
    }
    case 'slider': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`"${control.label}" takes a number.`)
      }
      const min = control.min ?? 0
      const max = control.max ?? 1
      const clamped = Math.min(max, Math.max(min, value))
      if (id === 'slice') {
        const index = Math.round(clamped)
        actions.slice(index)
        return { ...control, value: index }
      }
      if (id === 'wand-tolerance') {
        actions.wandTolerance(clamped)
        return { ...control, value: clamped }
      }
      const plane = state.clip?.slider
      if (plane) actions.clipDepth(plane.id, clamped)
      return { ...control, value: clamped }
    }
    default:
      throw new Error(`"${control.label}" can't be set.`)
  }
}

const FIXED =
  "NeuroVue's stage controls are fixed: list_controls and set_control reach them; use set_view or set_options to change NiiVue directly."

/** The control host passed to nv-mcp: the stage attached now, if any. */
export const stageControlSurface: HostedControls = {
  list() {
    const current = live?.()
    return current ? stageControlStates(current.state) : []
  },
  update(id, patch) {
    const current = live?.()
    if (!current)
      throw new Error('No volume is shown yet, so no stage controls.')
    return setStageControl(current, id, patch)
  },
  add() {
    throw new Error(FIXED)
  },
  remove() {
    throw new Error(FIXED)
  },
  clear() {
    throw new Error(FIXED)
  },
}
