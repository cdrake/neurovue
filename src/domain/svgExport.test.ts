import { expect, test } from 'bun:test'
import { composeSliceSVG, sliceIndexAt } from './svgExport'

// 2 mm voxels, voxel 0 at (-10, -20, -30) mm, 10 × 20 × 30 voxels.
const matRAS = [2, 0, 0, -10, 0, 2, 0, -20, 0, 0, 2, -30, 0, 0, 0, 1]
const dimsRAS = [3, 10, 20, 30]
const drawing =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 20" width="10" height="20">\n  <rect x="1" y="2" width="3" height="1" fill="#ff0000" />\n</svg>\n'
const shapes =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 6" width="8" height="6">\n  <g data-slice-type="0" data-slice-plane="AXIAL" data-origin-mm="-4 6" transform="translate(0 0)">\n    <path d="M 0 0 L 8 6 Z" />\n  </g>\n</svg>\n'

test('finds the slice through a depth', () => {
  expect(sliceIndexAt(0, matRAS, -30)).toBe(0)
  expect(sliceIndexAt(0, matRAS, -9.2)).toBe(10)
  expect(sliceIndexAt(2, matRAS, -4)).toBe(3)
})

test('puts mask and shapes in one world-mm frame, y up', () => {
  const svg = composeSliceSVG({
    sliceType: 0,
    matRAS,
    dimsRAS,
    sliceIndex: 5,
    drawing,
    shapes,
  })
  // Axial: x is R (-11…9 mm), y is −A (A spans -21…19 mm).
  expect(svg).toContain('viewBox="-11 -19 20 40"')
  expect(svg).toContain('width="20mm" height="40mm"')
  expect(svg).toContain('matrix(2 0 0 -2 -11 21)')
  expect(svg).toContain('<rect x="1" y="2"')
  expect(svg).toContain('translate(-4 -6)')
  expect(svg).toContain('<path d="M 0 0 L 8 6 Z" />')
  expect(svg?.match(/<svg/g)).toHaveLength(1)
})

test('is null for an empty slice', () => {
  const empty =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 20" width="10" height="20">\n</svg>\n'
  const none =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="1" height="1">\n</svg>\n'
  expect(
    composeSliceSVG({
      sliceType: 0,
      matRAS,
      dimsRAS,
      sliceIndex: 0,
      drawing: empty,
      shapes: none,
    }),
  ).toBeNull()
})
