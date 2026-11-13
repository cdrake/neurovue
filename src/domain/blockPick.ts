// Picking one brick of an exploded (block-tiled) volume, so it can become the
// volume being viewed. NiiVue resolves a tap on the 3D render to a brick
// (`pickExplodedBlock`); this module turns that pick into what the rest of the
// app needs: the brick's corners in world mm, which the server maps through the
// source file's own affine to cut the block out at full resolution, whatever
// pyramid level the viewer happens to hold.

/** NiiVue's answer to a tap on an exploded brick (its `ExplodedBlockPick`). */
export interface ExplodedBlockPick {
  volumeIndex: number
  chunkIndex: number
  voxelOrigin: [number, number, number]
  voxelDims: [number, number, number]
  mm: [number, number, number]
  explodedMin: [number, number, number]
  explodedMax: [number, number, number]
}

/** A picked brick of the base volume, ready to be cut out. */
export interface BlockSelection {
  /** The volume (dataset item) the brick belongs to. */
  itemId: string
  /** Index into the base volume's chunk plan; stable across explode changes. */
  chunkIndex: number
  /** A point inside the brick in anatomical (un-exploded) mm. */
  mm: [number, number, number]
  /** The brick's eight corners in anatomical mm, on voxel edges. */
  cornersMM: [number, number, number][]
  /** The brick's size in the loaded volume's voxels. */
  voxelDims: [number, number, number]
}

const CORNER_BITS = [0, 1, 2, 3, 4, 5, 6, 7] as const

/**
 * The eight corners of a voxel box in world mm, through `matRAS` (NiiVue's
 * row-major voxel-to-mm matrix for the RAS voxel grid). The corners sit on the
 * outer voxel edges (half a voxel past the first and last voxel centres), so
 * they cover exactly the box's voxels at any resolution.
 */
export function blockCornersMM(
  matRAS: ArrayLike<number>,
  voxelOrigin: readonly [number, number, number],
  voxelDims: readonly [number, number, number],
): [number, number, number][] {
  return CORNER_BITS.map((corner) => {
    const voxel = [0, 1, 2].map(
      (axis) =>
        voxelOrigin[axis] - 0.5 + ((corner >> axis) & 1 ? voxelDims[axis] : 0),
    )
    return [0, 1, 2].map(
      (row) =>
        matRAS[row * 4] * voxel[0] +
        matRAS[row * 4 + 1] * voxel[1] +
        matRAS[row * 4 + 2] * voxel[2] +
        matRAS[row * 4 + 3],
    ) as [number, number, number]
  })
}

/** The axis-aligned box around some points, e.g. a brick's drawn corners. */
export function boundingBox(points: readonly (readonly number[])[]): {
  min: [number, number, number]
  max: [number, number, number]
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const point of points) {
    for (const axis of [0, 1, 2]) {
      min[axis] = Math.min(min[axis], point[axis])
      max[axis] = Math.max(max[axis], point[axis])
    }
  }
  return { min, max }
}

/** Opacity each brick dims to while another is selected. */
export const UNSELECTED_BRICK_OPACITY = 0.2

/** Per-brick opacities that keep `selected` in focus and dim the rest. */
export function focusBrickOpacity(
  brickCount: number,
  selected: number,
  dimmed = UNSELECTED_BRICK_OPACITY,
): number[] {
  return Array.from({ length: brickCount }, (_, index) =>
    index === selected ? 1 : dimmed,
  )
}

/** The selection a pick on `itemId`'s base volume describes. */
export function blockSelectionFromPick(
  itemId: string,
  pick: ExplodedBlockPick,
  matRAS: ArrayLike<number>,
): BlockSelection {
  return {
    itemId,
    chunkIndex: pick.chunkIndex,
    mm: pick.mm,
    cornersMM: blockCornersMM(matRAS, pick.voxelOrigin, pick.voxelDims),
    voxelDims: pick.voxelDims,
  }
}

/** Whether a press moved little enough to count as a tap, in CSS px. */
export function isTap(
  start: { x: number; y: number },
  end: { x: number; y: number },
  slop = 6,
): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) <= slop
}
