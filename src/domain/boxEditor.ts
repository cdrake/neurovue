// An editable sub-volume box for touch, pencil and mouse alike: it appears as
// soon as Box is on, shows on every 2D slice that cuts it (and as NiiVue's
// focus box on the 3D render), and a drag on a slice moves an edge, a corner
// (two edges) or, from inside, the whole box. Cut out commits it.

import {
  chunkExplodeEnabled,
  type FocusBox,
  type NVImage,
  projectMMToCanvas,
  SLICE_TYPE,
  type SliceTile,
  type UIKitOverlayFrame,
} from '@niivue/niivue'
import { buildRect, type RectData, UIKitRectOverlay } from '@niivue/uikit'

export type Vec3 = [number, number, number]

export interface Box {
  min: Vec3
  max: Vec3
}

/** What a press grabbed: edges (an axis's min or max face) or the whole box. */
export type Grab =
  | { kind: 'edges'; edges: { axis: number; end: 'min' | 'max' }[] }
  | { kind: 'move'; axes: [number, number] }

/** A 2D slice as the grab test sees it. */
export interface SlicePlane {
  /** The world axis normal to the slice. */
  axis: number
  /** The slice's position along that axis, mm. */
  depth: number
  project(mm: Vec3): [number, number]
}

const COLOR = [1, 0.85, 0, 1]
const THICKNESS_CSS = 2
const HANDLE_CSS = 12
/** Grab reach around an edge: a fingertip, in CSS px. */
const REACH_CSS = 22
/** The thinnest box an edge drag leaves, mm. */
const MIN_EXTENT_MM = 1

// As UIKit's selector: an exploded volume's bricks don't sit where the box is.
const isExploded = (vol: NVImage): boolean =>
  !!vol.chunkPlan && chunkExplodeEnabled(vol.chunkExplode)

const dominantAxis = (v: ArrayLike<number>): number =>
  [0, 1, 2].reduce((best, a) => (Math.abs(v[a]) > Math.abs(v[best]) ? a : best))

const inPlaneAxes = (axis: number): [number, number] =>
  [0, 1, 2].filter((a) => a !== axis) as [number, number]

function pointAt(
  plane: SlicePlane,
  a: number,
  va: number,
  b: number,
  vb: number,
): [number, number] {
  const mm: Vec3 = [0, 0, 0]
  mm[plane.axis] = plane.depth
  mm[a] = va
  mm[b] = vb
  return plane.project(mm)
}

function distanceToSegment(
  p: readonly number[],
  s: [number, number],
  e: [number, number],
): number {
  const dx = e[0] - s[0]
  const dy = e[1] - s[1]
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq
    ? Math.max(
        0,
        Math.min(1, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / lengthSq),
      )
    : 0
  return Math.hypot(p[0] - (s[0] + t * dx), p[1] - (s[1] + t * dy))
}

/** The box's canvas rect on a slice, or null when the slice misses it. */
export function sliceRect(
  plane: SlicePlane,
  box: Box,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const { axis, depth } = plane
  if (depth < box.min[axis] || depth > box.max[axis]) return null
  const [a, b] = inPlaneAxes(axis)
  const corners = [
    pointAt(plane, a, box.min[a], b, box.min[b]),
    pointAt(plane, a, box.max[a], b, box.max[b]),
  ]
  return {
    x0: Math.min(corners[0][0], corners[1][0]),
    y0: Math.min(corners[0][1], corners[1][1]),
    x1: Math.max(corners[0][0], corners[1][0]),
    y1: Math.max(corners[0][1], corners[1][1]),
  }
}

/**
 * What a press at canvas `p` on `plane` grabs: the nearest edge per in-plane
 * axis within `reach` px (two make a corner), else the inside, else nothing.
 */
export function grabAt(
  plane: SlicePlane,
  box: Box,
  p: readonly number[],
  reach: number,
): Grab | null {
  const rect = sliceRect(plane, box)
  if (!rect) return null
  const [a, b] = inPlaneAxes(plane.axis)
  const edges: { axis: number; end: 'min' | 'max' }[] = []
  for (const [axis, other] of [
    [a, b],
    [b, a],
  ] as const) {
    let best: { end: 'min' | 'max'; d: number } | null = null
    for (const end of ['min', 'max'] as const) {
      const d = distanceToSegment(
        p,
        pointAt(plane, axis, box[end][axis], other, box.min[other]),
        pointAt(plane, axis, box[end][axis], other, box.max[other]),
      )
      if (d <= reach && (!best || d < best.d)) best = { end, d }
    }
    if (best) edges.push({ axis, end: best.end })
  }
  if (edges.length) return { kind: 'edges', edges }
  const inside =
    p[0] >= rect.x0 && p[0] <= rect.x1 && p[1] >= rect.y0 && p[1] <= rect.y1
  return inside ? { kind: 'move', axes: [a, b] } : null
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v))

/** `start` after dragging `grab` from `fromMM` to `toMM`, kept inside `bounds`. */
export function dragBox(
  start: Box,
  grab: Grab,
  fromMM: Vec3,
  toMM: Vec3,
  bounds: Box,
): Box {
  const box: Box = { min: [...start.min], max: [...start.max] }
  if (grab.kind === 'move') {
    for (const a of grab.axes) {
      const delta = clamp(
        toMM[a] - fromMM[a],
        bounds.min[a] - start.min[a],
        bounds.max[a] - start.max[a],
      )
      box.min[a] += delta
      box.max[a] += delta
    }
    return box
  }
  for (const { axis, end } of grab.edges) {
    const v = clamp(toMM[axis], bounds.min[axis], bounds.max[axis])
    if (end === 'min')
      box.min[axis] = Math.min(v, start.max[axis] - MIN_EXTENT_MM)
    else box.max[axis] = Math.max(v, start.min[axis] + MIN_EXTENT_MM)
  }
  return box
}

/** The middle half of the volume's extent along each axis. */
export function defaultBox(bounds: Box): Box {
  const quarter = (a: number) => (bounds.max[a] - bounds.min[a]) / 4
  return {
    min: [0, 1, 2].map((a) => bounds.min[a] + quarter(a)) as Vec3,
    max: [0, 1, 2].map((a) => bounds.max[a] - quarter(a)) as Vec3,
  }
}

/** The parts of NiiVue the editor draws and picks with. */
export interface BoxEditorHost {
  readonly canvas?: HTMLCanvasElement | null
  readonly volumes: NVImage[]
  focusBox: FocusBox | null
  clientToCanvas(clientX: number, clientY: number): [number, number] | null
  canvasToMM(canvasX: number, canvasY: number): Vec3 | null
  getScreenTiles(): readonly SliceTile[]
  drawScene(): void
}

function slicePlane(tile: SliceTile): SlicePlane | null {
  const { mvpMatrix, planeNormal, planePoint, leftTopWidthHeight } = tile
  if (
    tile.axCorSag === SLICE_TYPE.RENDER ||
    !mvpMatrix ||
    !planeNormal ||
    !planePoint ||
    !leftTopWidthHeight
  ) {
    return null
  }
  const axis = dominantAxis(planeNormal)
  return {
    axis,
    depth: planePoint[axis],
    project: (mm) => projectMMToCanvas(mm, mvpMatrix, leftTopWidthHeight),
  }
}

function tileAt(
  tiles: readonly SliceTile[],
  p: readonly number[],
): SliceTile | null {
  return (
    tiles.find((tile) => {
      const r = tile.leftTopWidthHeight
      return (
        r &&
        p[0] >= r[0] &&
        p[0] <= r[0] + r[2] &&
        p[1] >= r[1] &&
        p[1] <= r[1] + r[3]
      )
    }) ?? null
  )
}

export class BoxEditor {
  box: Box
  private readonly bounds: Box
  private readonly rects = new UIKitRectOverlay()

  constructor(private readonly host: BoxEditorHost) {
    const vol = host.volumes[0]
    this.bounds = {
      min: [...vol.extentsMin] as Vec3,
      max: [...vol.extentsMax] as Vec3,
    }
    this.box = defaultBox(this.bounds)
    this.showFocus()
  }

  /** Outline the box on the 3D render too, unless the volume is exploded. */
  private showFocus(): void {
    this.host.focusBox = isExploded(this.host.volumes[0])
      ? null
      : {
          min: this.box.min,
          max: this.box.max,
          color: COLOR,
          thickness: THICKNESS_CSS,
        }
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    const { dpr } = frame
    const rects: RectData[] = []
    const handle = HANDLE_CSS * dpr
    for (const tile of this.host.getScreenTiles()) {
      const plane = slicePlane(tile)
      const rect = plane && sliceRect(plane, this.box)
      if (!rect) continue
      rects.push(
        buildRect({
          x: rect.x0,
          y: rect.y0,
          width: rect.x1 - rect.x0,
          height: rect.y1 - rect.y0,
          borderWidth: THICKNESS_CSS * dpr,
          fill: [0, 0, 0, 0],
          border: COLOR,
        }),
      )
      // A grip at each edge's middle says the edges can be dragged.
      const cx = (rect.x0 + rect.x1) / 2
      const cy = (rect.y0 + rect.y1) / 2
      for (const [x, y] of [
        [cx, rect.y0],
        [cx, rect.y1],
        [rect.x0, cy],
        [rect.x1, cy],
      ]) {
        rects.push(
          buildRect({
            x: x - handle / 2,
            y: y - handle / 2,
            width: handle,
            height: handle,
            radius: 2 * dpr,
            fill: COLOR,
          }),
        )
      }
    }
    this.rects.setRects(rects)
    this.rects.drawOverlay(frame)
  }

  /** Take drags on the slices (presses elsewhere pass through); returns the unwire function. */
  attach(): () => void {
    const canvas = this.host.canvas
    if (!canvas) return () => {}
    let drag: { id: number; grab: Grab; start: Box; fromMM: Vec3 } | null = null
    const toCanvas = (e: PointerEvent) =>
      this.host.clientToCanvas(e.clientX, e.clientY)
    const down = (e: PointerEvent): void => {
      if (drag || e.button > 0) return
      const p = toCanvas(e)
      const tile = p && tileAt(this.host.getScreenTiles(), p)
      const plane = tile && slicePlane(tile)
      const fromMM = p && this.host.canvasToMM(p[0], p[1])
      if (!p || !plane || !fromMM) return
      const reach =
        REACH_CSS * (canvas.width / (canvas.clientWidth || canvas.width))
      const grab = grabAt(plane, this.box, p, reach)
      if (!grab) return
      e.preventDefault()
      e.stopImmediatePropagation()
      canvas.setPointerCapture?.(e.pointerId)
      drag = { id: e.pointerId, grab, start: this.box, fromMM }
    }
    const move = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return
      e.stopImmediatePropagation()
      const p = toCanvas(e)
      const toMM = p && this.host.canvasToMM(p[0], p[1])
      if (!toMM) return
      this.box = dragBox(drag.start, drag.grab, drag.fromMM, toMM, this.bounds)
      this.showFocus()
      this.host.drawScene()
    }
    const up = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return
      e.stopImmediatePropagation()
      drag = null
    }
    const options = { capture: true, passive: false }
    const wiring = [
      ['pointerdown', down],
      ['pointermove', move],
      ['pointerup', up],
      ['pointercancel', up],
    ] as const
    for (const [type, listener] of wiring)
      canvas.addEventListener(type, listener, options)
    this.host.drawScene()
    return () => {
      for (const [type, listener] of wiring)
        canvas.removeEventListener(type, listener, options)
      this.host.focusBox = null
      this.rects.destroy()
    }
  }
}
