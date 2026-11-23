type Triple = readonly [number, number, number]

/**
 * Flags each slice along RAS `axis` (0..2) that holds a nonzero voxel of
 * `img`. `dims` is the RAS grid; `start` and `steps` map a RAS voxel to its
 * index in `img` (NiiVue's img2RASstart summed, and img2RASstep). A drawing
 * bitmap is already RAS, so the defaults fit it.
 */
export function markPaintedSlices(
  flags: Uint8Array,
  img: ArrayLike<number>,
  dims: Triple,
  axis: number,
  start = 0,
  steps: Triple = [1, dims[0], dims[0] * dims[1]],
): void {
  const [u, v] = [0, 1, 2].filter((a) => a !== axis)
  const uStep = steps[u]
  for (let slice = 0; slice < dims[axis]; slice++) {
    if (flags[slice]) continue
    const base = start + slice * steps[axis]
    scan: for (let j = 0; j < dims[v]; j++) {
      const row = base + j * steps[v]
      for (let i = 0; i < dims[u]; i++) {
        if (img[row + i * uStep] !== 0) {
          flags[slice] = 1
          break scan
        }
      }
    }
  }
}

/** The flagged slices as inclusive [first, last] runs. */
export function sliceRuns(flags: Uint8Array): [number, number][] {
  const runs: [number, number][] = []
  flags.forEach((flag, slice) => {
    if (!flag) return
    const last = runs[runs.length - 1]
    if (last && last[1] === slice - 1) last[1] = slice
    else runs.push([slice, slice])
  })
  return runs
}
