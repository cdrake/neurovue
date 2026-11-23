// A deck: an ordered list of saved views (steps) a bundle carries and present
// mode walks through. Each step is a full snapshot (docs/nvbundle-v2.md); its
// drawing and meshes load only when it's shown or exported.

import {
  type BundleExportView,
  type BundlePart,
  type BundleViewState,
  bundleViewVolumeIds,
  stageBundleBytes,
} from './bundle'
import type { MeshLayer } from './meshes'

export interface DeckStep {
  /** Stable within the session, for React keys; not exported. */
  key: string
  title: string
  notes: string
  /** In this session's volume ids. */
  view: BundleViewState
  /** An object or data URL of the PNG. */
  thumbnail: string | null
  /** The step's drawing as NIfTI (gzipped when saved here). */
  drawing: () => Promise<Blob | null>
  meshes: () => Promise<MeshLayer[]>
}

export async function gzip(bytes: Uint8Array): Promise<Blob> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('gzip'))
  return new Response(stream).blob()
}

/** Runs `load` once, on first call. */
export function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | undefined
  return () => {
    loaded ??= load()
    return loaded
  }
}

/**
 * Hands every step's drawing, meshes and thumbnail to the host. Parts are
 * named per step (`v2_mesh-1`) so each view finds its own; a mesh shared by
 * steps is staged once and the host writes its bytes once.
 */
export async function stageDeck(
  steps: readonly DeckStep[],
  stage: (bytes: Uint8Array) => Promise<string> = stageBundleBytes,
): Promise<{
  views: BundleExportView[]
  parts: BundlePart[]
  volumeIds: string[]
}> {
  const shas = new Map<Blob, Promise<string>>()
  const stageBlob = (blob: Blob) => {
    let sha = shas.get(blob)
    if (!sha) {
      sha = blob.arrayBuffer().then((buffer) => stage(new Uint8Array(buffer)))
      shas.set(blob, sha)
    }
    return sha
  }
  const views: BundleExportView[] = []
  const parts: BundlePart[] = []
  const volumeIds = new Set<string>()
  for (const [index, step] of steps.entries()) {
    const prefix = `v${index + 1}`
    const document: BundleViewState = { ...step.view }
    const base = step.view.volumes.find((volume) => volume.role === 'base')
    const drawing = await step.drawing()
    if (drawing && base) {
      document.drawing = `${prefix}_drawing`
      parts.push({
        kind: 'drawing',
        id: document.drawing,
        name: `${base.id}_drawing.nii.gz`,
        base: base.id,
        sha256: await stageBlob(drawing),
      })
    } else {
      delete document.drawing
    }
    // One at a time: a mesh can be hundreds of MB.
    const meshes = await step.meshes()
    document.meshes = []
    for (const mesh of meshes) {
      const id = `${prefix}_${mesh.id}`
      parts.push({
        kind: 'mesh',
        id,
        name: mesh.name,
        sha256: await stageBlob(mesh.file),
      })
      const { color, opacity, visible } = mesh
      document.meshes.push({ id, color, opacity, visible })
    }
    if (!meshes.length) delete document.meshes
    const thumbnail = step.thumbnail
      ? await stageBlob(await (await fetch(step.thumbnail)).blob())
      : undefined
    views.push({ title: step.title, notes: step.notes, document, thumbnail })
    for (const id of bundleViewVolumeIds(step.view)) volumeIds.add(id)
  }
  return { views, parts, volumeIds: [...volumeIds] }
}

/** A recorded view in this session's ids; volumes that didn't load drop out. */
export function remapBundleView(
  view: BundleViewState,
  idFor: (recordedId: string) => string | undefined,
): BundleViewState {
  const mapKeys = <T>(record: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(record).flatMap(([id, value]) => {
        const mapped = idFor(id)
        return mapped ? [[mapped, value]] : []
      }),
    )
  return {
    ...view,
    volumes: view.volumes.flatMap((volume) => {
      const id = idFor(volume.id)
      return id ? [{ ...volume, id }] : []
    }),
    ...(view.annotations ? { annotations: mapKeys(view.annotations) } : {}),
    ...(view.stack
      ? {
          stack: {
            levels: view.stack.levels.flatMap((id) => idFor(id) ?? []),
            blocks: mapKeys(view.stack.blocks),
          },
        }
      : {}),
  }
}
