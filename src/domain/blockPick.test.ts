import { expect, test } from 'bun:test'
import {
  blockCornersMM,
  blockSizeMM,
  boundingBox,
  focusBrickOpacity,
  isTap,
} from './blockPick'

// 2 mm voxels, origin at (-10, -20, -30) mm.
const matRAS = [2, 0, 0, -10, 0, 2, 0, -20, 0, 0, 2, -30, 0, 0, 0, 1]

test('corners sit on the outer voxel edges of the box', () => {
  const corners = blockCornersMM(matRAS, [4, 0, 2], [3, 5, 1])
  expect(corners).toHaveLength(8)
  // First voxel centre is (4,0,2) -> (-2,-20,-26) mm; its low edge is 1 mm less.
  expect(corners[0]).toEqual([-3, -21, -27])
  // Last voxel centre is (6,4,2) -> (2,-12,-26) mm; its high edge is 1 mm more.
  expect(corners[7]).toEqual([3, -11, -25])
  expect(boundingBox(corners)).toEqual({
    min: [-3, -21, -27],
    max: [3, -11, -25],
  })
})

test('corner bits follow x, y, z', () => {
  const corners = blockCornersMM(matRAS, [0, 0, 0], [1, 1, 1])
  expect(corners[1][0]).toBeGreaterThan(corners[0][0])
  expect(corners[2][1]).toBeGreaterThan(corners[0][1])
  expect(corners[4][2]).toBeGreaterThan(corners[0][2])
})

test('focus keeps one brick and dims the rest', () => {
  expect(focusBrickOpacity(4, 2, 0.25)).toEqual([0.25, 0.25, 1, 0.25])
})

test('a small move is still a tap', () => {
  expect(isTap({ x: 10, y: 10 }, { x: 13, y: 14 })).toBe(true)
  expect(isTap({ x: 10, y: 10 }, { x: 30, y: 10 })).toBe(false)
})

test('block size reads in mm, whatever the voxel size', () => {
  const cornersMM = blockCornersMM(matRAS, [0, 0, 0], [3, 4, 5])
  const selection = {
    itemId: 'a',
    chunkIndex: 0,
    mm: [0, 0, 0],
    cornersMM,
    voxelDims: [3, 4, 5],
  } as const
  expect(
    blockSizeMM({ ...selection, mm: [0, 0, 0], voxelDims: [3, 4, 5] }),
  ).toBe('6 × 8 × 10')
})
