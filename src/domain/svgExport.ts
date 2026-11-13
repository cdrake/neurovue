// NiiVue's single-plane slice types and their RAS axes: the two in-plane axes
// (as drawingToSVG's rect x/y and annotationsToSVG's mm x/y) and the depth.
export const PLANES = {
  0: { u: 0, h: 1, depth: 2 }, // axial
  1: { u: 0, h: 2, depth: 1 }, // coronal
  2: { u: 1, h: 2, depth: 0 }, // sagittal
} as const

export type PlaneSliceType = keyof typeof PLANES

export function isPlaneSliceType(
  sliceType: number,
): sliceType is PlaneSliceType {
  return sliceType in PLANES
}

/**
 * The RAS voxel index of the slice through `depthMm`.
 * shortcut: reads the depth axis off matRAS's diagonal, so an oblique volume
 * can pick a neighbouring slice; solve the full affine if that matters.
 */
export function sliceIndexAt(
  sliceType: PlaneSliceType,
  matRAS: ArrayLike<number>,
  depthMm: number,
): number {
  const d = PLANES[sliceType].depth
  return Math.round((depthMm - matRAS[d * 4 + 3]) / matRAS[d * 4 + d])
}

const fmt = (value: number) => String(Math.round(value * 1000) / 1000)

/**
 * One slice's painted mask (`drawingToSVG`, voxel units) and vector shapes
 * (`annotationsToSVG`, plane mm) as one SVG in world mm, y up: x = first
 * in-plane mm axis, y = −second. Null when the slice holds neither.
 */
export function composeSliceSVG(params: {
  sliceType: PlaneSliceType
  /** Row-major RAS voxel → world mm. */
  matRAS: ArrayLike<number>
  /** [n, x, y, z], as NiiVue's dimsRAS. */
  dimsRAS: ArrayLike<number>
  sliceIndex: number
  drawing: string | null
  shapes: string | null
}): string | null {
  const { u, h, depth } = PLANES[params.sliceType]
  const m = (row: number, col: number) => params.matRAS[row * 4 + col]
  const drawing = params.drawing?.includes('<rect') ? params.drawing : null
  const origin = params.shapes?.match(/data-origin-mm="([^ "]+) ([^"]+)"/)
  if (!drawing && !origin) return null

  // Rect (x, y) is voxel (u, h) = (x − ½, y − ½) at depth k: its edge, not centre.
  const k = params.sliceIndex
  const a = m(u, u)
  const c = m(u, h)
  const e = m(u, depth) * k + m(u, 3) - 0.5 * (m(u, u) + m(u, h))
  const b = -m(h, u)
  const d = -m(h, h)
  const f = -(m(h, depth) * k + m(h, 3) - 0.5 * (m(h, u) + m(h, h)))
  const width = params.dimsRAS[u + 1]
  const height = params.dimsRAS[h + 1]
  const xs: number[] = []
  const ys: number[] = []
  for (const [x, y] of [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ]) {
    xs.push(a * x + c * y + e)
    ys.push(b * x + d * y + f)
  }
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const spanX = Math.max(...xs) - minX
  const spanY = Math.max(...ys) - minY

  const inner = (svg: string) => svg.replace(/^\s*<svg[^>]*>|<\/svg>\s*$/g, '')
  const layers: string[] = []
  if (drawing) {
    layers.push(
      `<g id="mask" transform="matrix(${[a, b, c, d, e, f].map(fmt).join(' ')})" shape-rendering="crispEdges">${inner(drawing)}</g>`,
    )
  }
  if (origin && params.shapes) {
    // Paths are panel-local: x − originX, originY − y.
    layers.push(
      `<g id="shapes" transform="translate(${fmt(Number(origin[1]))} ${fmt(-Number(origin[2]))})">${inner(params.shapes)}</g>`,
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${[minX, minY, spanX, spanY].map(fmt).join(' ')}" width="${fmt(spanX)}mm" height="${fmt(spanY)}mm">
${layers.join('\n')}
</svg>
`
}
