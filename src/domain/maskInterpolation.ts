// Shape-based slice interpolation (Raya & Udupa): fill the slices between two
// painted ones by blending each label's signed distance maps, so an outline
// morphs smoothly from one slice to the next instead of fading.

// Larger than any in-slice distance: a label filling its whole slice.
const FAR = 1e10

/** 1D squared distance transform (Felzenszwalb & Huttenlocher), in place. */
function edt1d(
  f: Float64Array,
  n: number,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
): void {
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
  f.set(d.subarray(0, n))
}

/** Squared distance from each pixel to the nearest pixel where `isFeature`. */
function squaredDistance(
  isFeature: Uint8Array,
  width: number,
  height: number,
): Float64Array {
  const grid = new Float64Array(width * height)
  for (let i = 0; i < grid.length; i++) grid[i] = isFeature[i] ? 0 : FAR
  const n = Math.max(width, height)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x]
    edt1d(f, height, d, v, z)
    for (let y = 0; y < height; y++) grid[y * width + x] = f[y]
  }
  for (let y = 0; y < height; y++) {
    const row = grid.subarray(y * width, (y + 1) * width)
    edt1d(row, width, d, v, z)
  }
  return grid
}

/** Negative inside the label, positive outside, in pixels. */
function signedDistance(
  isInside: Uint8Array,
  width: number,
  height: number,
): Float64Array {
  const isOutside = isInside.map((inside) => (inside ? 0 : 1))
  const toInside = squaredDistance(isInside, width, height)
  const toOutside = squaredDistance(isOutside, width, height)
  for (let i = 0; i < toInside.length; i++) {
    toInside[i] = Math.sqrt(toInside[i]) - Math.sqrt(toOutside[i])
  }
  return toInside
}

/**
 * Fills the empty voxels between painted slices along `axis` (0 x, 1 y, 2 z of
 * the RAS bitmap), label by label, never over existing ink. Returns how many
 * voxels it filled.
 */
export function interpolateMaskSlices(
  bitmap: Uint8Array,
  dims: readonly [number, number, number],
  axis: 0 | 1 | 2,
): number {
  const strides = [1, dims[0], dims[0] * dims[1]]
  const [uAxis, vAxis] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1]
  const width = dims[uAxis]
  const height = dims[vAxis]
  const uStride = strides[uAxis]
  const vStride = strides[vAxis]
  const sStride = strides[axis]
  const sliceCount = dims[axis]

  // Which labels each slice holds.
  const hasLabel = new Uint8Array(256 * sliceCount)
  for (let s = 0; s < sliceCount; s++) {
    for (let v = 0; v < height; v++) {
      const base = s * sStride + v * vStride
      for (let u = 0; u < width; u++) {
        hasLabel[bitmap[base + u * uStride] * sliceCount + s] = 1
      }
    }
  }

  const isInside = new Uint8Array(width * height)
  const labelSlice = (s: number, label: number): Float64Array => {
    for (let v = 0; v < height; v++) {
      const base = s * sStride + v * vStride
      for (let u = 0; u < width; u++) {
        isInside[v * width + u] = bitmap[base + u * uStride] === label ? 1 : 0
      }
    }
    return signedDistance(isInside, width, height)
  }

  let filled = 0
  for (let label = 1; label < 256; label++) {
    const row = label * sliceCount
    let low = -1
    let lowDistance: Float64Array | null = null
    for (let high = 0; high < sliceCount; high++) {
      if (!hasLabel[row + high]) continue
      if (low >= 0 && high - low > 1) {
        lowDistance ??= labelSlice(low, label)
        const highDistance = labelSlice(high, label)
        for (let s = low + 1; s < high; s++) {
          const w = (s - low) / (high - low)
          for (let v = 0; v < height; v++) {
            const base = s * sStride + v * vStride
            for (let u = 0; u < width; u++) {
              const i = v * width + u
              const voxel = base + u * uStride
              if (
                bitmap[voxel] === 0 &&
                (1 - w) * lowDistance[i] + w * highDistance[i] < 0
              ) {
                bitmap[voxel] = label
                filled++
              }
            }
          }
        }
        lowDistance = highDistance
      } else {
        lowDistance = null
      }
      low = high
    }
  }
  return filled
}
