import { expect, test } from 'bun:test'
import type { UIKitOverlayFrame } from '@niivue/niivue'
import type { StageControlsState } from './stageControls'

// A phone: coarse pointer, so 44 px controls.
globalThis.matchMedia = (() => ({ matches: true })) as never
// Imported after: COARSE_POINTER is read at load.
const { StageControls } = await import('./stageControls')

type Spec = {
  x: number
  y: number
  width?: number
  label?: string
  segments?: unknown[]
}

// Stand-ins for uikit's overlays, with fixed widths in place of font metrics.
class FakeOverlay {
  readonly specs = new Map<string, Spec>()
  constructor(readonly measure: (spec: Spec) => number) {}
  get ids() {
    return [...this.specs.keys()]
  }
  add(spec: Spec & { id: string }) {
    this.specs.set(spec.id, spec)
  }
  update(id: string, patch: Partial<Spec>) {
    this.specs.set(id, { ...(this.specs.get(id) as Spec), ...patch })
  }
  remove(id: string) {
    this.specs.delete(id)
  }
  getLayout(id: string) {
    const spec = this.specs.get(id)
    return spec && { ...spec, width: this.measure(spec), height: 44 }
  }
  setValue() {}
  blur() {}
}
class FakeButtons extends FakeOverlay {
  addButton = this.add
  updateButton = this.update
  removeButton = this.remove
}
class FakeSegmenteds extends FakeOverlay {
  addSegmented = this.add
  updateSegmented = this.update
  removeSegmented = this.remove
}
class FakeSliders extends FakeOverlay {
  isDragging = false
  addSlider = this.add
  updateSlider = this.update
  removeSlider = this.remove
}

const tools = [
  { id: 'pen', label: 'Pen' },
  { id: 'wand', label: 'Wand' },
]
const colors = ['Red', 'Green', 'Blue', 'Yellow', 'Cyan', 'Pink', 'White'].map(
  (name, value) => ({ value: value + 1, name, css: '#ff0000' }),
)
const phone: StageControlsState = {
  magnify: false,
  magnifyZoom: null,
  box: { active: false, enabled: true },
  levels: null,
  viewModes: ['Ax', 'Co', 'Sa', '3D'].map((label) => ({ id: label, label })),
  viewMode: 'Ax',
  hasVolume: true,
  look: null,
  measure: { active: false, enabled: true, tools, tool: 'pen' },
  shapes: { active: false, enabled: true, tools, tool: 'pen' },
  draw: {
    active: true,
    enabled: true,
    tools,
    tool: 'pen',
    hasDrawing: true,
    canSend: true,
  },
  canExport: true,
  palette: {
    colors,
    penValue: 1,
    sizes: [1, 3, 6].map((size) => ({ size, name: `${size}` })),
    brushSize: 3,
    eraser: false,
  },
  wand: null,
  slice: { label: 'Axial', value: 3, max: 9, marks: [] },
  clip: null,
}

test.each([
  ['pen', phone],
  [
    'wand',
    {
      ...phone,
      palette: {
        ...(phone.palette as NonNullable<StageControlsState['palette']>),
        sizes: [],
      },
      wand: { tolerance: 0.1, volume: false },
    },
  ],
])('the %s settings fit a 375 px stage', (_, state) => {
  const overlays = [
    new FakeButtons((spec) => spec.width ?? 18 + 8 * (spec.label?.length ?? 0)),
    new FakeSegmenteds((spec) => 60 * (spec.segments?.length ?? 0)),
    new FakeSliders((spec) => spec.width ?? 0),
  ]
  const controls = new StageControls({} as never)
  const [buttons, segmenteds, sliders] = overlays
  Object.assign(controls, {
    buttons,
    segmenteds,
    sliders,
    controls: { requestRedraw() {}, drawOverlay() {} },
  })
  controls.update(state as StageControlsState, {} as never)
  controls.drawOverlay({
    bounds: { width: 375, height: 700 },
    dpr: 1,
  } as UIKitOverlayFrame)
  const placed = overlays.flatMap((o) =>
    o.ids.map((id) => {
      const box = o.getLayout(id) as Spec & { width: number }
      return { id, right: box.x + box.width }
    }),
  )
  expect(placed.length).toBeGreaterThan(15)
  expect(placed.filter((control) => control.right > 375)).toEqual([])
})
