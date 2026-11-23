import { describe, expect, test } from 'bun:test'
import { markPaintedSlices, sliceRuns } from './paintedSlices'

describe('painted slices', () => {
  // 3x4x5 RAS grid; voxel (x, y, z) at x + 3y + 12z.
  const dims = [3, 4, 5] as const
  const img = new Uint8Array(60)
  img[2 + 3 * 1 + 12 * 1] = 1 // (2, 1, 1)
  img[0 + 3 * 3 + 12 * 2] = 2 // (0, 3, 2)
  img[1 + 3 * 3 + 12 * 4] = 1 // (1, 3, 4)

  test('finds slices along each axis and merges runs', () => {
    const along = (axis: number) => {
      const flags = new Uint8Array(dims[axis])
      markPaintedSlices(flags, img, dims, axis)
      return sliceRuns(flags)
    }
    expect(along(2)).toEqual([
      [1, 2],
      [4, 4],
    ])
    expect(along(1)).toEqual([
      [1, 1],
      [3, 3],
    ])
    expect(along(0)).toEqual([[0, 2]])
  })

  test('reads a native image through the RAS mapping', () => {
    // The same volume stored with x flipped: RAS x maps to native 2 - x.
    const native = new Uint8Array(60)
    for (let z = 0; z < 5; z++)
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 3; x++)
          native[2 - x + 3 * y + 12 * z] = img[x + 3 * y + 12 * z]
    const flags = new Uint8Array(3)
    markPaintedSlices(flags, native, dims, 0, 2, [-1, 3, 12])
    expect(sliceRuns(flags)).toEqual([[0, 2]])
    const ys = new Uint8Array(4)
    markPaintedSlices(ys, native, dims, 1, 2, [-1, 3, 12])
    expect(sliceRuns(ys)).toEqual([
      [1, 1],
      [3, 3],
    ])
  })
})
