// A deck: an ordered list of saved views (steps) a bundle carries and present
// mode walks through. Each step is a full snapshot (docs/nvbundle-v2.md); its
// drawing and meshes load only when it's shown or exported.

import {
  type BundleExportView,
  type BundlePane,
  type BundlePart,
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
  view: BundlePane
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
    const app = { ...step.view.app }
    const base = app.layers.base
    const drawing = await step.drawing()
    if (drawing) {
      app.drawing = `${prefix}_drawing`
      parts.push({
        kind: 'drawing',
        id: app.drawing,
        name: `${base}_drawing.nii.gz`,
        base,
        sha256: await stageBlob(drawing),
      })
    } else {
      delete app.drawing
    }
    // One at a time: a mesh can be hundreds of MB.
    const partIds = new Map<string, string>()
    for (const mesh of await step.meshes()) {
      const id = `${prefix}_${mesh.id}`
      partIds.set(mesh.id, id)
      parts.push({
        kind: 'mesh',
        id,
        name: mesh.name,
        sha256: await stageBlob(mesh.file),
      })
    }
    // The document links each mesh by mesh id; the bundle names it by part.
    const document = {
      ...step.view.document,
      meshes: step.view.document.meshes?.map((mesh) => ({
        ...mesh,
        url: (mesh.url && partIds.get(mesh.url)) ?? mesh.url,
      })),
    }
    const pane: BundlePane = { ...step.view, document, app }
    const thumbnail = step.thumbnail
      ? await stageBlob(await (await fetch(step.thumbnail)).blob())
      : undefined
    views.push({ title: step.title, notes: step.notes, pane, thumbnail })
    for (const id of bundleViewVolumeIds(step.view)) volumeIds.add(id)
  }
  return { views, parts, volumeIds: [...volumeIds] }
}

/** A recorded pane in this session's ids; volumes that didn't load drop out. */
export function remapBundleView(
  pane: BundlePane,
  idFor: (recordedId: string) => string | undefined,
): BundlePane {
  const mapKeys = <T>(record: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(record).flatMap(([id, value]) => {
        const mapped = idFor(id)
        return mapped ? [[mapped, value]] : []
      }),
    )
  const { app } = pane
  return {
    ...pane,
    document: {
      ...pane.document,
      volumes: pane.document.volumes?.flatMap((volume) => {
        const url = volume.url && idFor(volume.url)
        return url ? [{ ...volume, url }] : []
      }),
    },
    app: {
      ...app,
      layers: {
        base: idFor(app.layers.base) ?? app.layers.base,
        overlays: app.layers.overlays.flatMap((id) => idFor(id) ?? []),
        atlas: (app.layers.atlas && idFor(app.layers.atlas)) || null,
      },
      ...(app.hidden ? { hidden: mapKeys(app.hidden) } : {}),
      ...(app.annotations ? { annotations: mapKeys(app.annotations) } : {}),
      ...(app.stack
        ? {
            stack: {
              levels: app.stack.levels.flatMap((id) => idFor(id) ?? []),
              blocks: mapKeys(app.stack.blocks),
            },
          }
        : {}),
    },
  }
}
