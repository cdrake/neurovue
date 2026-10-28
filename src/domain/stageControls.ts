import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import {
  type ButtonSpec,
  type ButtonStyle,
  type SegmentedSpec,
  type SegmentedStyle,
  type SliderSpec,
  type SliderStyle,
  UIKitButtonOverlay,
  UIKitControls,
  type UIKitFont,
  type UIKitHost,
  UIKitSegmentedOverlay,
  UIKitSliderOverlay,
} from '@niivue/uikit'

type RGBA = readonly [number, number, number, number]

// The app's dark palette (styles.css): panel, muted ink, amber accent.
const PANEL: RGBA = [0.067, 0.067, 0.059, 0.86]
const HOVER: RGBA = [0.13, 0.125, 0.09, 0.92]
const PRESSED: RGBA = [0.04, 0.04, 0.035, 1]
const ACTIVE: RGBA = [0.145, 0.129, 0.071, 0.96]
const AMBER: RGBA = [0.843, 0.651, 0.259, 1]
const AMBER_LINE: RGBA = [0.843, 0.651, 0.259, 0.32]
const MUTED: RGBA = [0.651, 0.631, 0.561, 1]
const INK: RGBA = [0.941, 0.933, 0.886, 1]
const DIM: RGBA = [0.651, 0.631, 0.561, 0.4]

// Every control is one row high, as the HTML chips were.
const CONTROL_HEIGHT = 28

const BUTTON_STYLE: Partial<ButtonStyle> = {
  fill: PANEL,
  hoverFill: HOVER,
  pressedFill: PRESSED,
  disabledFill: [PANEL[0], PANEL[1], PANEL[2], 0.5],
  border: AMBER_LINE,
  borderWidth: 1,
  radius: 4,
  textColor: MUTED,
  disabledTextColor: DIM,
  textSizePx: 12,
  paddingX: 9,
  paddingY: 0,
}
// A tool that is on (Measure, Draw, Erase), as the HTML `is-active` was.
const BUTTON_ON: Partial<ButtonStyle> = {
  fill: ACTIVE,
  hoverFill: ACTIVE,
  border: AMBER,
  textColor: AMBER,
}
const SEGMENTED_STYLE: Partial<SegmentedStyle> = {
  height: CONTROL_HEIGHT,
  paddingX: 8,
  inset: 2,
  radius: 4,
  trackFill: PANEL,
  trackBorder: AMBER_LINE,
  trackBorderWidth: 1,
  selectedFill: ACTIVE,
  hoverFill: HOVER,
  pressedFill: PRESSED,
  textColor: MUTED,
  selectedTextColor: AMBER,
  disabledTextColor: DIM,
  textSizePx: 11,
  dividerColor: [0.2, 0.2, 0.15, 1],
  focusRing: AMBER,
}
const SLIDER_STYLE: Partial<SliderStyle> = {
  trackFill: [0.2, 0.2, 0.15, 0.94],
  trackActiveFill: AMBER,
  thumbFill: INK,
  thumbHoverFill: [1, 1, 1, 1],
  thumbActiveFill: AMBER,
  thumbBorder: AMBER_LINE,
  textColor: INK,
  disabledTextColor: DIM,
  textSizePx: 12,
  textOutlineWidth: 1.5,
  focusRing: AMBER,
}

// Where the controls sit, in CSS pixels, as the HTML ones did.
const EDGE = 14
const TOP = 56
const ROW_GAP = 6
const GAP = 2
const GROUP_GAP = 10
const SWATCH = 28

export interface PenColor {
  value: number
  name: string
  /** CSS hex, as #rrggbb. */
  css: string
}

/** What the stage shows, from NiivueStage's state. Null hides a group. */
export interface StageControlsState {
  viewModes: readonly { id: string; label: string }[]
  viewMode: string
  /** False before a volume is selected: the view modes show, dimmed. */
  hasVolume: boolean
  measure: { active: boolean; enabled: boolean } | null
  draw: {
    active: boolean
    enabled: boolean
    eraser: boolean
    hasDrawing: boolean
    canSend: boolean
  } | null
  palette: {
    colors: readonly PenColor[]
    penValue: number
    sizes: readonly { size: number; name: string }[]
    brushSize: number
    eraser: boolean
  } | null
  slice: { label: string; value: number; max: number } | null
  clip: {
    planes: readonly { id: string; label: string }[]
    /** The plane the slider moves, highlighted only while it is active. */
    activeId: string | null
    slider: { id: string; label: string; depth: number } | null
  } | null
}

/** What the controls do; NiivueStage passes fresh closures each render. */
export interface StageControlsActions {
  viewMode(id: string): void
  measure(): void
  clearMeasurements(): void
  draw(): void
  erase(): void
  undo(): void
  clearDrawing(): void
  send(): void
  pen(value: number): void
  brush(size: number): void
  slice(index: number): void
  clipPlane(id: string): void
  clipDepth(id: string, depth: number): void
}

/**
 * The render stage's own controls (view mode, measure and draw tools, the pen
 * palette, the slice and clip sliders), drawn on the canvas with uikit. One
 * per NiiVue instance: `attach` registers it as an overlay and routes the
 * canvas's pointer and key events to it; `update` takes NiivueStage's state.
 *
 * Layout is in CSS pixels from the canvas edges and is redone when the state
 * or the canvas size changes.
 */
export class StageControls implements UIKitOverlayRenderer {
  private readonly controls = new UIKitControls()
  private readonly buttons: UIKitButtonOverlay
  private readonly segmenteds: UIKitSegmentedOverlay
  private readonly sliders: UIKitSliderOverlay
  private state: StageControlsState | null = null
  private actions: StageControlsActions | null = null
  private stateSignature = ''
  private layoutSignature = ''
  private host: UIKitHost | null = null

  constructor(font: UIKitFont) {
    this.buttons = new UIKitButtonOverlay(font, {
      cssUnits: true,
      style: BUTTON_STYLE,
    })
    this.segmenteds = new UIKitSegmentedOverlay(font, {
      cssUnits: true,
      style: SEGMENTED_STYLE,
    })
    this.sliders = new UIKitSliderOverlay(font, {
      cssUnits: true,
      style: SLIDER_STYLE,
    })
    this.controls.add(this.sliders).add(this.segmenteds).add(this.buttons)
  }

  /**
   * Draw through `register` (NiiVue's registerOverlayRenderer) and take the
   * host canvas's pointer and key events. Returns the detach function.
   */
  attach(
    host: UIKitHost,
    register: (renderer: UIKitOverlayRenderer) => () => void,
  ): () => void {
    this.host = host
    const unregister = register(this)
    const unwire = this.controls.attach(host)
    return () => {
      unwire()
      unregister()
      this.host = null
    }
  }

  /** Take the stage's state; a frame is drawn only when it has changed. */
  update(state: StageControlsState, actions: StageControlsActions): void {
    this.actions = actions
    const signature = JSON.stringify(state)
    if (signature === this.stateSignature) return
    this.state = state
    this.stateSignature = signature
    this.controls.requestRedraw()
  }

  /** Whether a pointer at client (CSS) coordinates is over a control. */
  isOverControl(clientX: number, clientY: number): boolean {
    const point = this.host?.clientToCanvas(clientX, clientY)
    if (!point) return false
    return this.controls.widgets.some((widget) =>
      widget.hitTest(point[0], point[1]),
    )
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    const state = this.state
    if (!state) return
    const width = frame.bounds.width / frame.dpr
    const height = frame.bounds.height / frame.dpr
    const signature = `${width}x${height}x${frame.dpr}|${this.stateSignature}`
    if (signature !== this.layoutSignature) {
      this.layoutSignature = signature
      this.layout(state, width, height, frame)
    }
    this.controls.drawOverlay(frame)
  }

  destroy(): void {
    this.controls.destroy()
  }

  private layout(
    state: StageControlsState,
    width: number,
    height: number,
    frame: UIKitOverlayFrame,
  ): void {
    const buttons: ButtonSpec[] = []
    const segmenteds: SegmentedSpec[] = []
    const sliders: SliderSpec[] = []

    // View mode, top right.
    segmenteds.push({
      id: 'view-mode',
      x: 0,
      y: TOP,
      segments: state.viewModes.map((mode) => ({
        value: mode.id,
        label: mode.label,
      })),
      value: state.viewMode,
      enabled: state.hasVolume,
      onChange: (value) => {
        this.segmenteds.blur()
        this.actions?.viewMode(value)
      },
    })

    // Measure, then draw, along the top left.
    const row: ButtonSpec[] = []
    if (state.measure) {
      row.push(
        this.toolButton('measure', 'Measure', state.measure.enabled, {
          on: state.measure.active,
          click: () => this.actions?.measure(),
        }),
        this.toolButton('clear-measure', 'Clear', state.measure.enabled, {
          click: () => this.actions?.clearMeasurements(),
        }),
      )
    }
    const { draw } = state
    if (draw) {
      row.push(
        this.toolButton('draw', 'Draw', draw.enabled, {
          on: draw.active,
          click: () => this.actions?.draw(),
          groupStart: row.length > 0,
        }),
      )
      if (draw.active) {
        row.push(
          this.toolButton('erase', 'Erase', true, {
            on: draw.eraser,
            click: () => this.actions?.erase(),
          }),
          this.toolButton('undo', 'Undo', draw.hasDrawing, {
            click: () => this.actions?.undo(),
          }),
          this.toolButton('clear-drawing', 'Clear', draw.hasDrawing, {
            click: () => this.actions?.clearDrawing(),
          }),
        )
      }
      if (draw.canSend) {
        row.push(
          this.toolButton('send', 'Send', true, {
            click: () => this.actions?.send(),
            style: { textColor: AMBER, border: AMBER },
          }),
        )
      }
    }
    buttons.push(...row)

    // The pen's colors and brush sizes, under the tools.
    const { palette } = state
    if (palette) {
      for (const color of palette.colors) {
        const fill = hexColor(color.css)
        const on = !palette.eraser && palette.penValue === color.value
        buttons.push({
          id: `pen-${color.value}`,
          label: '',
          x: 0,
          y: 0,
          width: SWATCH,
          height: SWATCH,
          style: {
            fill: [fill[0], fill[1], fill[2], on ? 1 : 0.7],
            hoverFill: fill,
            pressedFill: fill,
            border: on ? INK : AMBER_LINE,
            borderWidth: on ? 2 : 1,
          },
          onClick: () => this.actions?.pen(color.value),
        })
      }
      segmenteds.push({
        id: 'brush',
        x: 0,
        y: 0,
        segments: palette.sizes.map((size) => ({
          value: String(size.size),
          label: size.name,
        })),
        value: String(palette.brushSize),
        onChange: (value) => {
          this.segmenteds.blur()
          this.actions?.brush(Number(value))
        },
      })
    }

    // The slice slider, docked above the colorbar.
    const clearance = overlayClearance(
      frame.bounds.width,
      frame.bounds.height,
      frame.dpr,
    )
    const { slice } = state
    if (slice) {
      const max = slice.max
      sliders.push({
        id: 'slice',
        label: slice.label,
        x: 0,
        y: 0,
        width: Math.min(560, width * 0.82),
        min: 0,
        max,
        step: 1,
        value: slice.value,
        showValue: true,
        format: (value) => `${value + 1} / ${max + 1}`,
        onInput: (value) => this.actions?.slice(value),
      })
    }

    // The clip planes and the active one's depth, in the same place.
    const { clip } = state
    if (clip) {
      segmenteds.push({
        id: 'clip-planes',
        x: 0,
        y: 0,
        segments: clip.planes.map((plane) => ({
          value: plane.id,
          label: plane.label,
        })),
        value: clip.activeId,
        onChange: (value) => {
          this.segmenteds.blur()
          this.actions?.clipPlane(value)
        },
      })
      const plane = clip.slider
      sliders.push({
        id: 'clip-depth',
        label: plane ? `${plane.label} clip` : 'Clip',
        x: 0,
        y: 0,
        width: 120,
        min: -1,
        max: 1,
        step: 0.02,
        value: plane?.depth ?? 0,
        enabled: plane !== null,
        showValue: plane !== null,
        format: (value) => value.toFixed(2),
        onInput: (value) => {
          if (plane) this.actions?.clipDepth(plane.id, value)
        },
      })
    }

    this.reconcile(buttons, segmenteds, sliders)

    // Positions, now the auto-sized controls have measured themselves.
    const modes = this.segmenteds.getLayout('view-mode')
    if (modes) {
      this.segmenteds.updateSegmented('view-mode', {
        x: Math.max(EDGE, width - EDGE - modes.width),
      })
    }
    let x = EDGE
    for (const spec of row) {
      if (spec.id === 'draw' && row[0] !== spec) x += GROUP_GAP - GAP
      this.buttons.updateButton(spec.id, { x, y: TOP })
      x += (this.buttons.getLayout(spec.id)?.width ?? 0) + GAP
    }
    if (palette) {
      const y = TOP + CONTROL_HEIGHT + ROW_GAP
      let px = EDGE
      for (const color of palette.colors) {
        this.buttons.updateButton(`pen-${color.value}`, { x: px, y })
        px += SWATCH + GAP
      }
      this.segmenteds.updateSegmented('brush', { x: px + GROUP_GAP, y })
    }
    const bottom = height - clearance.colorbar - 8
    if (slice) {
      const layout = this.sliders.getLayout('slice')
      const sliderWidth = Math.min(560, width * 0.82)
      this.sliders.updateSlider('slice', {
        x: (width - sliderWidth) / 2,
        y: bottom - (layout?.height ?? CONTROL_HEIGHT),
        width: sliderWidth,
      })
    }
    if (clip) {
      const total = Math.max(
        160,
        Math.min(560, width - 2 * clearance.cube - 24),
      )
      const chips = this.segmenteds.getLayout('clip-planes')
      const chipsWidth = chips?.width ?? 0
      const sliderLayout = this.sliders.getLayout('clip-depth')
      const rowHeight = Math.max(
        chips?.height ?? CONTROL_HEIGHT,
        sliderLayout?.height ?? CONTROL_HEIGHT,
      )
      const left = (width - total) / 2
      const top = bottom - rowHeight
      this.segmenteds.updateSegmented('clip-planes', {
        x: left,
        y: top + (rowHeight - (chips?.height ?? rowHeight)) / 2,
      })
      this.sliders.updateSlider('clip-depth', {
        x: left + chipsWidth + GROUP_GAP,
        y: top + (rowHeight - (sliderLayout?.height ?? rowHeight)) / 2,
        width: Math.max(80, total - chipsWidth - GROUP_GAP),
      })
    }
  }

  private toolButton(
    id: string,
    label: string,
    enabled: boolean,
    options: {
      on?: boolean
      click: () => void
      groupStart?: boolean
      style?: Partial<ButtonStyle>
    },
  ): ButtonSpec {
    return {
      id,
      label,
      x: 0,
      y: TOP,
      height: CONTROL_HEIGHT,
      enabled,
      style: options.on ? BUTTON_ON : options.style,
      onClick: () => {
        // Leave the keyboard to the viewer (arrows page slices).
        this.buttons.blur()
        options.click()
      },
    }
  }

  // Add, patch or remove each control so one being pressed or dragged keeps
  // its state. A slider being dragged keeps its value too: it is the source.
  private reconcile(
    buttons: readonly ButtonSpec[],
    segmenteds: readonly SegmentedSpec[],
    sliders: readonly SliderSpec[],
  ): void {
    const buttonIds = new Set(buttons.map((spec) => spec.id))
    for (const id of this.buttons.ids) {
      if (!buttonIds.has(id)) this.buttons.removeButton(id)
    }
    const existingButtons = new Set(this.buttons.ids)
    for (const spec of buttons) {
      if (existingButtons.has(spec.id)) {
        const { id, ...patch } = spec
        // A spec without a style override clears the last one.
        this.buttons.updateButton(id, { ...patch, style: spec.style ?? {} })
      } else {
        this.buttons.addButton(spec)
      }
    }

    const segmentedIds = new Set(segmenteds.map((spec) => spec.id))
    for (const id of this.segmenteds.ids) {
      if (!segmentedIds.has(id)) this.segmenteds.removeSegmented(id)
    }
    const existingSegmenteds = new Set(this.segmenteds.ids)
    for (const spec of segmenteds) {
      if (existingSegmenteds.has(spec.id)) {
        const { id, value, ...patch } = spec
        this.segmenteds.updateSegmented(id, patch)
        this.segmenteds.setValue(id, value)
      } else {
        this.segmenteds.addSegmented(spec)
      }
    }

    const sliderIds = new Set(sliders.map((spec) => spec.id))
    for (const id of this.sliders.ids) {
      if (!sliderIds.has(id)) this.sliders.removeSlider(id)
    }
    const existingSliders = new Set(this.sliders.ids)
    for (const spec of sliders) {
      if (existingSliders.has(spec.id)) {
        const { id, value, ...patch } = spec
        this.sliders.updateSlider(id, patch)
        if (!this.sliders.isDragging) this.sliders.setValue(id, value)
      } else {
        this.sliders.addSlider(spec)
      }
    }
  }
}

/**
 * How far NiiVue's colorbar reaches up from the bottom, and how wide its
 * orientation cube is, in CSS pixels, so the bottom controls stay clear of
 * both. NiiVue exposes neither, so this mirrors its layout math:
 * colorbarTotalHeight (packages/niivue/src/view/NVColorbar.ts, one row, as
 * only the base layer shows a colorbar; default margin 20 and heightRatio 1.2,
 * font from estimateFontSize in NVUILayout.ts) and orientCubePosition
 * (NVUILayout.ts: size 5% of the tile, centred 1.8 sizes in). Width and height
 * are device pixels.
 */
export function overlayClearance(
  width: number,
  height: number,
  density: number,
): { colorbar: number; cube: number } {
  const fontSize = 13 * Math.max((width * height) / (800 * 600), 1) ** 0.4
  const colorbar =
    20 +
    Math.ceil(1.2 * fontSize) +
    Math.ceil(0.7 * fontSize + Math.max(1, 0.1 * fontSize))
  const cubeEdge = 2.8 * 0.05 * Math.min(width, height - colorbar)
  return {
    colorbar: Math.ceil(colorbar / density),
    cube: Math.ceil(Math.max(0, cubeEdge) / density),
  }
}

function hexColor(css: string): RGBA {
  const value = Number.parseInt(css.slice(1), 16)
  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
    1,
  ]
}
