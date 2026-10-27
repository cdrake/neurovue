// Surface meshes (the Surfice half of NeuroVue). Unlike volumes they skip the
// local server: the host reads the file's bytes and the viewer hands them to
// NiiVue as a File, which picks the parser from the name's extension. A plain
// domain type, like RenderShading, so the panel and the viewer share it.

import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

export interface MeshLayer {
  id: string
  name: string
  file: File
  /** RGB, 0 to 1. */
  color: [number, number, number]
  /** 0 (invisible) to 1 (opaque). */
  opacity: number
  visible: boolean
}

/**
 * Mirrors `MESH_EXTENSIONS` in lib.rs; FreeSurfer surfaces end in their type.
 * NiiVue reads tracts (trk, tck, trx) as meshes too.
 */
export const MESH_EXTENSIONS = [
  'asc',
  'byu',
  'dfs',
  'geo',
  'gii',
  'ico',
  'mz3',
  'nv',
  'obj',
  'off',
  'ply',
  'srf',
  'stl',
  'vtk',
  'wrl',
  'x3d',
  'cbor',
  'white',
  'pial',
  'inflated',
  'sphere',
  'orig',
  'smoothwm',
  'qsphere',
  'trk',
  'tck',
  'trx',
]

// Surfice-style defaults: the first mesh is bone white, later ones take
// distinct hues so overlapping surfaces stay tellable apart.
const MESH_COLORS: ReadonlyArray<[number, number, number]> = [
  [0.9, 0.86, 0.8],
  [0.95, 0.55, 0.35],
  [0.4, 0.7, 0.95],
  [0.55, 0.85, 0.5],
  [0.85, 0.55, 0.9],
  [0.95, 0.85, 0.4],
]

let nextMeshId = 0

function baseName(path: string): string {
  const decoded = path.startsWith('file://')
    ? decodeURIComponent(path.slice('file://'.length))
    : path
  return decoded.split(/[\\/]/).pop() || decoded
}

/** Read one mesh file through the host into a NiiVue-ready layer. */
export async function readMeshLayer(
  path: string,
  index: number,
): Promise<MeshLayer> {
  const bytes = await invoke<ArrayBuffer>('read_mesh_file', { path })
  const name = baseName(path)
  nextMeshId += 1
  return {
    id: `mesh-${nextMeshId}`,
    name,
    file: new File([bytes], name),
    color: MESH_COLORS[index % MESH_COLORS.length],
    opacity: 1,
    visible: true,
  }
}

/**
 * Pick one or more mesh files. `existingCount` offsets the default colors so
 * new meshes don't repeat the ones already shown. Null when cancelled.
 */
export async function openMeshFiles(
  existingCount: number,
): Promise<MeshLayer[] | null> {
  const selected = await open({
    directory: false,
    multiple: true,
    title: 'Open surface mesh',
    filters: [{ name: 'Meshes and tracts', extensions: MESH_EXTENSIONS }],
  })
  if (!selected) return null
  const paths = Array.isArray(selected) ? selected : [selected]
  if (paths.length === 0) return null
  return Promise.all(
    paths.map((path, index) => readMeshLayer(path, existingCount + index)),
  )
}

/** `#rrggbb` for an `<input type="color">`. */
export function meshColorHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b]
    .map((channel) =>
      Math.round(Math.min(1, Math.max(0, channel)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

export function meshColorFromHex(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ]
}
