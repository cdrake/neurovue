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
  segmentWidth?: number
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
  override getLayout(id: string) {
    const layout = super.getLayout(id)
    const width = this.specs.get(id)?.segmentWidth ?? 60
    return (
      layout && { ...layout, segments: layout.segments?.map(() => ({ width })) }
    )
  }
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
  [
    'shapes palette',
    {
      ...phone,
      draw: {
        ...(phone.draw as NonNullable<StageControlsState['draw']>),
        active: false,
      },
      shapes: {
        active: true,
        enabled: true,
        tools: [
          'freehand',
          'rectangle',
          'ellipse',
          'arrow',
          'spline',
          'livewire',
        ].map((id) => ({ id, label: id.slice(0, 7) })),
        tool: 'freehand',
      },
      palette: {
        ...(phone.palette as NonNullable<StageControlsState['palette']>),
        sizes: [],
      },
    },
  ],
])('the %s settings fit a 375 px stage', (_, state) => {
  const overlays = [
    new FakeButtons((spec) => spec.width ?? 18 + 8 * (spec.label?.length ?? 0)),
    new FakeSegmenteds(
      (spec) => (spec.segmentWidth ?? 60) * (spec.segments?.length ?? 0),
    ),
    new FakeSliders((spec) => spec.width ?? 0),
  ]
  const controls = new StageControls({
    metrics: { glyphs: new Map() },
  } as never)
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
  // Drawing's tool palette counts each of its items.
  const palette = (
    controls as unknown as {
      palette: { getLayout(): { items: { x: number; width: number }[] } | null }
    }
  ).palette.getLayout()
  for (const [i, item] of (palette?.items ?? []).entries()) {
    placed.push({ id: `palette-${i}`, right: item.x + item.width })
  }
  expect(placed.length).toBeGreaterThan(15)
  // Drawing and shapes pick their tools on the palette, not a picker.
  expect(
    palette?.items.some((item) => 'kind' in item && item.kind === 'tool'),
  ).toBe(true)
  // Inside the 14 px edge margin.
  expect(placed.filter((control) => control.right > 361)).toEqual([])
})

test('the tools fold away, and the slice slider gives way to them', () => {
  const buttons = new FakeButtons((spec) => spec.width ?? 60)
  const sliders = new FakeSliders((spec) => spec.width ?? 0)
  const controls = new StageControls({
    metrics: { glyphs: new Map() },
  } as never)
  Object.assign(controls, {
    buttons,
    segmenteds: new FakeSegmenteds((spec) => 60 * (spec.segments?.length ?? 0)),
    sliders,
    controls: { requestRedraw() {}, drawOverlay() {} },
  })
  const state = {
    ...phone,
    slice: { label: 'Axial', value: 0, max: 9, marks: [] },
  } as StageControlsState
  controls.update(state, {} as never)
  // A landscape phone's short pane.
  const frame = { bounds: { width: 375, height: 300 }, dpr: 1 }
  controls.drawOverlay(frame as UIKitOverlayFrame)
  expect(buttons.ids).toContain('draw')
  expect(sliders.ids).not.toContain('slice')

  const toggle = buttons.specs.get('tools') as unknown as { onClick(): void }
  toggle.onClick()
  controls.drawOverlay(frame as UIKitOverlayFrame)
  expect(buttons.ids).toEqual(['tools'])
  expect(sliders.ids).toEqual(['slice'])
})

type Palette = {
  isShown: boolean
  getLayout(): {
    y: number
    height: number
    items: {
      kind: string
      id: string
      x: number
      y: number
      width: number
      height: number
    }[]
  } | null
  pointerDown(x: number, y: number): boolean
  pointerUp(x: number, y: number): boolean
  keyDown(e: { key: string }): boolean
}
// Drawing on a phone, with uikit's real tool palette.
function drawingStage(picked: string[] = []) {
  const buttons = new FakeButtons((spec) => spec.width ?? 60)
  const controls = new StageControls({
    metrics: { glyphs: new Map() },
  } as never)
  Object.assign(controls, {
    buttons,
    segmenteds: new FakeSegmenteds((spec) => 60 * (spec.segments?.length ?? 0)),
    sliders: new FakeSliders((spec) => spec.width ?? 0),
    controls: { requestRedraw() {}, drawOverlay() {} },
  })
  controls.update(phone, { drawTool: (id: string) => picked.push(id) } as never)
  const palette = (controls as unknown as { palette: Palette }).palette
  const tap = (kind: string, id: string) => {
    const item = palette
      .getLayout()
      ?.items.find((it) => it.kind === kind && it.id === id)
    expect(item).toBeDefined()
    const x = (item?.x ?? 0) + (item?.width ?? 0) / 2
    const y = (item?.y ?? 0) + (item?.height ?? 0) / 2
    palette.pointerDown(x, y)
    palette.pointerUp(x, y)
  }
  return { controls, buttons, palette, tap }
}

test("a short pane's Hide folds only the palette, leaving the tool row", () => {
  const { controls, buttons, palette, tap } = drawingStage()
  // A landscape phone's short pane: the palette covers the tool row.
  const frame = { bounds: { width: 375, height: 300 }, dpr: 1 }
  controls.drawOverlay(frame as UIKitOverlayFrame)
  const tray = palette.getLayout()
  expect((tray?.y ?? 0) + (tray?.height ?? 0)).toBeLessThanOrEqual(300)
  tap('action', 'hide')
  controls.drawOverlay(frame as UIKitOverlayFrame)
  expect(palette.isShown).toBe(false)
  expect(buttons.ids).toEqual(
    expect.arrayContaining(['draw', 'save-mask', 'send']),
  )
  // Tools brings the palette back.
  const toggle = buttons.specs.get('tools') as unknown as { onClick(): void }
  toggle.onClick()
  controls.drawOverlay(frame as UIKitOverlayFrame)
  expect(palette.isShown).toBe(true)
  expect(buttons.ids).toContain('draw')
})

test('a tall pane keeps Hide folding everything', () => {
  const { controls, buttons, palette, tap } = drawingStage()
  const frame = { bounds: { width: 375, height: 700 }, dpr: 1 }
  controls.drawOverlay(frame as UIKitOverlayFrame)
  tap('action', 'hide')
  controls.drawOverlay(frame as UIKitOverlayFrame)
  expect(palette.isShown).toBe(false)
  expect(buttons.ids).toEqual(['tools'])
})

test('a palette pick lets go of the arrow keys', () => {
  const picked: string[] = []
  const { controls, palette, tap } = drawingStage(picked)
  controls.drawOverlay({
    bounds: { width: 375, height: 700 },
    dpr: 1,
  } as UIKitOverlayFrame)
  tap('tool', 'wand')
  expect(picked).toEqual(['wand'])
  expect(palette.keyDown({ key: 'ArrowRight' })).toBe(false)
})
