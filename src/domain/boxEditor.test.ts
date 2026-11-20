import { describe, expect, it } from 'bun:test'
import {
  type Box,
  defaultBox,
  dragBox,
  type Grab,
  grabAt,
  type SlicePlane,
  sliceRect,
} from './boxEditor'

// An axial slice at z = 0 drawn 2 px per mm, x right and y down (flipped).
const axial: SlicePlane = {
  axis: 2,
  depth: 0,
  project: (mm) => [100 + 2 * mm[0], 100 - 2 * mm[1]],
}
const box: Box = { min: [-10, -10, -10], max: [10, 10, 10] }
const bounds: Box = { min: [-50, -50, -50], max: [50, 50, 50] }

describe('boxEditor', () => {
  it('outlines the box only on slices that cut it', () => {
    expect(sliceRect(axial, box)).toEqual({ x0: 80, y0: 80, x1: 120, y1: 120 })
    expect(sliceRect({ ...axial, depth: 20 }, box)).toBeNull()
  })

  it('grabs an edge, a corner, the inside, or nothing', () => {
    expect(grabAt(axial, box, [121, 100], 5)).toEqual({
      kind: 'edges',
      edges: [{ axis: 0, end: 'max' }],
    })
    // Screen top is +y (the projection flips y).
    expect(grabAt(axial, box, [79, 79], 5)).toEqual({
      kind: 'edges',
      edges: [
        { axis: 0, end: 'min' },
        { axis: 1, end: 'max' },
      ],
    })
    expect(grabAt(axial, box, [100, 100], 5)).toEqual({
      kind: 'move',
      axes: [0, 1],
    })
    expect(grabAt(axial, box, [200, 200], 5)).toBeNull()
  })

  it('drags edges without inverting the box, and moves it inside bounds', () => {
    const edge: Grab = { kind: 'edges', edges: [{ axis: 0, end: 'max' }] }
    expect(dragBox(box, edge, [10, 0, 0], [30, 0, 0], bounds).max).toEqual([
      30, 10, 10,
    ])
    expect(dragBox(box, edge, [10, 0, 0], [-40, 0, 0], bounds).max[0]).toBe(-9)
    expect(dragBox(box, edge, [10, 0, 0], [90, 0, 0], bounds).max[0]).toBe(50)
    const moved = dragBox(
      box,
      { kind: 'move', axes: [0, 1] },
      [0, 0, 0],
      [100, 5, 99],
      bounds,
    )
    expect(moved).toEqual({ min: [30, -5, -10], max: [50, 15, 10] })
  })

  it('starts as the middle half of the volume', () => {
    expect(defaultBox(bounds)).toEqual({
      min: [-25, -25, -25],
      max: [25, 25, 25],
    })
  })
})
