import { expect, test } from 'bun:test'
import { interpolateMaskSlices } from './maskInterpolation'

const dims = [10, 10, 5] as const

function paintSquare(
  bitmap: Uint8Array,
  z: number,
  x0: number,
  size: number,
  label: number,
): void {
  for (let y = 2; y < 2 + size; y++) {
    for (let x = x0; x < x0 + size; x++) bitmap[z * 100 + y * 10 + x] = label
  }
}

function sliceCount(bitmap: Uint8Array, z: number, label: number): number {
  return bitmap
    .subarray(z * 100, (z + 1) * 100)
    .filter((value) => value === label).length
}

test('copies a shape through the gap between two equal slices', () => {
  const bitmap = new Uint8Array(500)
  paintSquare(bitmap, 0, 2, 4, 1)
  paintSquare(bitmap, 4, 2, 4, 1)
  expect(interpolateMaskSlices(bitmap, dims, 2)).toBe(48)
  for (const z of [1, 2, 3]) expect(sliceCount(bitmap, z, 1)).toBe(16)
})

test('morphs a moving shape and keeps labels apart', () => {
  const bitmap = new Uint8Array(500)
  paintSquare(bitmap, 0, 0, 4, 2)
  paintSquare(bitmap, 4, 2, 4, 2)
  // Another label on one slice only: nothing to interpolate to.
  bitmap[2 * 100 + 9 * 10 + 9] = 5
  interpolateMaskSlices(bitmap, dims, 2)
  // Halfway, the square (columns 0…3, then 2…5) sits at columns 1…4.
  expect([...bitmap.subarray(230, 240)]).toEqual([0, 2, 2, 2, 2, 0, 0, 0, 0, 0])
  expect(sliceCount(bitmap, 2, 5)).toBe(1)
})

test('interpolates along x too', () => {
  const bitmap = new Uint8Array(500)
  bitmap[2 * 100 + 3 * 10 + 1] = 1
  bitmap[2 * 100 + 3 * 10 + 7] = 1
  expect(interpolateMaskSlices(bitmap, dims, 0)).toBe(5)
  expect([...bitmap.subarray(230, 240)]).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 0, 0])
})
