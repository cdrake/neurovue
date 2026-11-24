import type { ControlValue } from '@niivue/nv-mcp/browser'
import { Channel, invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { open, save } from '@tauri-apps/plugin-dialog'
import type { BlockSettings } from './blocks'
import { type ClipPlane, resolveRuntimeCapabilities } from './desktop'
import { keepPickedFile } from './openedFiles'
import type { RenderShading } from './shading'

// A NeuroVue bundle (`.nvbundle`) is a self-describing, transport-agnostic
// hand-off of one or more volumes plus the views set up over them. See the Rust
// `export_bundle` for the on-disk layout (manifest.json + data/ + views/) and
// docs/nvbundle-v2.md.
//
// Each view's pane holds a NiiVue document (NVDocument JSON, linkData) whose
// volumes and meshes link to bundle data by id, plus the NeuroVue state the
// document has no field for (`app`) and the tools' control values.

/** App-side per-layer settings (matches `LayerSettings` in `App.tsx`). */
export interface BundleLayerSettings {
  colormap?: string
  opacity?: number
  hidden?: boolean
  window?: { min: number; max: number }
}

/** The 3D camera and 2D pan/zoom, named after `NVDocumentData.scene`. */
export interface BundleCamera {
  azimuth: number
  elevation: number
  scaleMultiplier: number
  /** 2D pan (x, y, z mm) and zoom (w). */
  pan2Dxyzmm: [number, number, number, number]
}

/** Camera keys a sparse document would drop at their defaults. */
export const BUNDLE_CAMERA_KEYS = [
  'scene.azimuth',
  'scene.elevation',
  'scene.scaleMultiplier',
  'scene.pan2Dxyzmm',
]

/** Cut sub-volumes, whole volume first, and the blocks each was left at. */
export interface BundleSubvolumeStack {
  levels: string[]
  blocks: Record<string, BlockSettings>
}

/**
 * The parts of a NiiVue document (mono `NVDocumentData`, as JSON) NeuroVue
 * reads back. A volume's `url` is its NeuroVue volume id; a mesh's is its
 * bundle part id (its mesh id before export).
 */
export interface BundleDocument {
  scene?: Partial<BundleCamera>
  volumes?: Array<{
    url?: string
    colormap?: string
    opacity?: number
    calMin?: number
    calMax?: number
    hiddenLabels?: number[]
  }>
  meshes?: Array<{
    url?: string
    color?: number[]
    opacity?: number
    visible?: boolean
  }>
  [key: string]: unknown
}

/** NeuroVue state a NiiVue document has no field for. */
export interface BundleAppState {
  layers: { base: string; overlays: string[]; atlas: string | null }
  /** Hidden layers render at opacity 0; this keeps the opacity they return to
   *  (null: the default). */
  hidden?: Record<string, number | null>
  viewMode: string
  /** Enabled clip planes, NeuroVue's shape. */
  clipPlanes: ClipPlane[]
  /** RAS+ world mm; the document's `scene.crosshairPos` is a fraction. */
  crosshairMm: [number, number, number] | null
  blocks?: BlockSettings
  /** Vector shapes and measurements per base volume id, as NiiVue's getAnnotationsJSON. */
  annotations?: Record<string, unknown[]>
  shading?: RenderShading
  stack?: BundleSubvolumeStack
  /** The resource id of the view's drawing. */
  drawing?: string
}

/** One viewer in a saved view (docs/nvbundle-v2.md). */
export interface BundlePane {
  document: BundleDocument
  app: BundleAppState
  /** The tools' stage control values (`stageControlStates` ids), replayed on open. */
  controls?: { version: 1; values: Record<string, ControlValue> }
}

/** A drawing or mesh staged for an export (see `stageBundlePart`). */
export interface BundlePart {
  sha256: string
  kind: 'drawing' | 'mesh'
  id: string
  name: string
  base?: string
}

/** What the export commands take for one step (Rust `BundleView`). */
export interface BundleExportView {
  title: string
  notes: string
  pane: BundlePane
  thumbnail?: string
}

/** Hands a drawing's, mesh's or thumbnail's bytes to the host ahead of an
 *  export; the export then names them by the returned SHA-256. */
export function stageBundleBytes(bytes: Uint8Array): Promise<string> {
  return invoke<string>('stage_bundle_part', bytes)
}

/**
 * Assemble a pane from the stage's document and the app's layer state. Without
 * a document (no viewer yet), the volumes are listed by id with no display state.
 */
export function buildBundlePane(params: {
  document: BundleDocument | null
  baseId: string
  overlayIds: string[]
  atlasId: string | null
  layerSettings: Record<string, BundleLayerSettings>
  viewMode: string
  clipPlanes: ClipPlane[]
  crosshairMm: [number, number, number] | null
  blocks?: BlockSettings
  annotations?: Record<string, unknown[]>
  shading?: RenderShading
  stack?: BundleSubvolumeStack
  controls?: Record<string, ControlValue>
}): BundlePane {
  const overlays = [...new Set(params.overlayIds)].filter(
    (id) => id !== params.baseId,
  )
  const atlas =
    params.atlasId &&
    params.atlasId !== params.baseId &&
    !overlays.includes(params.atlasId)
      ? params.atlasId
      : null
  const layerIds = [params.baseId, ...overlays, ...(atlas ? [atlas] : [])]
  const hidden = Object.fromEntries(
    layerIds.flatMap((id) => {
      const settings = params.layerSettings[id]
      return settings?.hidden ? [[id, settings.opacity ?? null]] : []
    }),
  )

  // The stack's levels travel as volumes too, so annotations may sit on any of them.
  const stack =
    params.stack && params.stack.levels.length > 1 ? params.stack : undefined
  const exported = new Set([...layerIds, ...(stack?.levels ?? [])])
  const annotations = Object.fromEntries(
    Object.entries(params.annotations ?? {}).filter(
      ([id, shapes]) => exported.has(id) && shapes.length > 0,
    ),
  )
  return {
    document: params.document ?? {
      volumes: layerIds.map((url) => ({ url })),
    },
    app: {
      layers: { base: params.baseId, overlays, atlas },
      ...(Object.keys(hidden).length ? { hidden } : {}),
      viewMode: params.viewMode,
      clipPlanes: params.clipPlanes.filter((plane) => plane.enabled),
      crosshairMm: params.crosshairMm,
      ...(params.blocks ? { blocks: params.blocks } : {}),
      ...(Object.keys(annotations).length ? { annotations } : {}),
      ...(params.shading ? { shading: params.shading } : {}),
      ...(stack ? { stack } : {}),
    },
    ...(params.controls
      ? { controls: { version: 1, values: params.controls } }
      : {}),
  }
}

/** Volume ids a pane's bundle carries: its layers, then any other stack levels. */
export function bundleViewVolumeIds(pane: BundlePane): string[] {
  const { base, overlays, atlas } = pane.app.layers
  const ids = [base, ...overlays, ...(atlas ? [atlas] : [])]
  return [
    ...ids,
    ...(pane.app.stack?.levels ?? []).filter((id) => !ids.includes(id)),
  ]
}

/** App state a saved view restores, with ids already mapped to this session's. */
export interface AppliedBundleView {
  layerSettings: Record<string, BundleLayerSettings>
  baseId: string | null
  overlayIds: Set<string>
  atlasId: string | null
  hiddenLabels: Record<string, number[]>
  annotations: Record<string, unknown[]>
  crosshairPos: [number, number, number] | null
  camera: BundleCamera | null
  stack: BundleSubvolumeStack | null
}

/**
 * Map a saved pane onto this session: `idFor` gives a recorded volume id's
 * loaded id, or undefined when that volume didn't load (it's then skipped).
 */
export function applyBundleView(
  pane: BundlePane,
  idFor: (recordedId: string) => string | undefined,
): AppliedBundleView {
  const { app, document } = pane
  const applied: AppliedBundleView = {
    layerSettings: {},
    baseId: null,
    overlayIds: new Set(),
    atlasId: null,
    hiddenLabels: {},
    annotations: {},
    crosshairPos: app.crosshairMm,
    camera: null,
    stack: null,
  }
  for (const volume of document.volumes ?? []) {
    const url = volume.url
    const id = url && idFor(url)
    if (!url || !id) continue
    const settings: BundleLayerSettings = {}
    // The atlas draws with its label colormap, not this one.
    if (volume.colormap !== undefined && url !== app.layers.atlas) {
      settings.colormap = volume.colormap
    }
    if (app.hidden && url in app.hidden) {
      const opacity = app.hidden[url]
      if (opacity !== null) settings.opacity = opacity
      settings.hidden = true
    } else if (volume.opacity !== undefined) {
      settings.opacity = volume.opacity
    }
    if (volume.calMin !== undefined && volume.calMax !== undefined) {
      settings.window = { min: volume.calMin, max: volume.calMax }
    }
    if (Object.keys(settings).length > 0) applied.layerSettings[id] = settings
    if (volume.hiddenLabels?.length)
      applied.hiddenLabels[id] = volume.hiddenLabels
  }
  applied.baseId = idFor(app.layers.base) ?? null
  for (const overlay of app.layers.overlays) {
    const id = idFor(overlay)
    if (id) applied.overlayIds.add(id)
  }
  applied.atlasId = (app.layers.atlas && idFor(app.layers.atlas)) || null
  for (const [recordedId, shapes] of Object.entries(app.annotations ?? {})) {
    const id = idFor(recordedId)
    if (id) applied.annotations[id] = shapes
  }
  const { azimuth, elevation, scaleMultiplier, pan2Dxyzmm } =
    document.scene ?? {}
  if (
    azimuth !== undefined &&
    elevation !== undefined &&
    scaleMultiplier !== undefined &&
    pan2Dxyzmm?.length === 4
  ) {
    applied.camera = { azimuth, elevation, scaleMultiplier, pan2Dxyzmm }
  }
  if (app.stack) {
    const levels = app.stack.levels.flatMap((level) => idFor(level) ?? [])
    const blocks: Record<string, BlockSettings> = {}
    for (const [recordedId, settings] of Object.entries(app.stack.blocks)) {
      const id = idFor(recordedId)
      if (id) blocks[id] = settings
    }
    if (levels.length > 1) applied.stack = { levels, blocks }
  }
  return applied
}

export interface ExportBundleResult {
  bundlePath: string
  volumeCount: number
  totalBytes: number
}

/**
 * Prompt for a destination and write the selected volumes + view as a bundle.
 * Returns `null` if the user cancels the save dialog.
 */
export async function exportDatasetBundle(params: {
  defaultName: string
  volumeIds: string[]
  parts: BundlePart[]
  views: BundleExportView[]
}): Promise<ExportBundleResult | null> {
  if (!(await resolveRuntimeCapabilities()).fileDialogsAvailable) {
    return shareViewViaAirDrop({
      name: params.defaultName,
      volumeIds: params.volumeIds,
      parts: params.parts,
      views: params.views,
    })
  }
  const destPath = await save({
    title: 'Export NeuroVue bundle',
    defaultPath: `${sanitizeBundleName(params.defaultName)}.nvbundle`,
    filters: [{ name: 'NeuroVue bundle', extensions: ['nvbundle'] }],
  })
  if (!destPath) return null

  return invoke<ExportBundleResult>('export_dataset_bundle', {
    destPath,
    volumeIds: params.volumeIds,
    parts: params.parts,
    views: params.views,
    // Timestamp stays on the JS side (matches the savePatch convention and
    // avoids a time-format crate on the Rust side).
    createdAt: new Date().toISOString(),
  })
}

/**
 * Export the current view to a staged bundle and hand it to the macOS AirDrop
 * sheet (no save dialog — the bundle is staged under the app cache). macOS only;
 * gate the UI on `RuntimeCapabilities.airdropAvailable`.
 */
export async function shareViewViaAirDrop(params: {
  name: string
  volumeIds: string[]
  parts: BundlePart[]
  views: BundleExportView[]
}): Promise<ExportBundleResult> {
  return invoke<ExportBundleResult>('share_view_via_airdrop', {
    volumeIds: params.volumeIds,
    parts: params.parts,
    views: params.views,
    createdAt: new Date().toISOString(),
    name: params.name,
  })
}

/** A device on the network running NeuroVue that can take a send (see
 *  src-tauri/src/bonjour.rs). */
export interface SendTarget {
  name: string
  host: string
  port: number
}

/** The devices that answer a short network browse; empty where sending
 *  isn't supported. */
export async function listSendTargets(): Promise<SendTarget[]> {
  try {
    return await invoke<SendTarget[]>('list_send_targets')
  } catch {
    return []
  }
}

/** Whether this device listens for sends (see enable_receiving). */
export async function isReceiving(): Promise<boolean> {
  return invoke<boolean>('is_receiving').catch(() => true)
}

/** Listens for sends from now on, and at every later launch. */
export async function enableReceiving(): Promise<void> {
  await invoke('enable_receiving')
}

/** Deletes NeuroVue's own copies and caches; resolves to the cleared dirs. */
export async function clearStoredData(): Promise<string[]> {
  return invoke<string[]>('clear_stored_data')
}

/** Sends the dataset to `target` as a bundle. `onOffered` gets the code both
 *  ends show, once the bundle is staged and the person there is being asked. Resolves once they
 *  have accepted it and it has arrived; rejects with a status-line sentence
 *  if they decline or it fails. */
export async function sendViewToDevice(params: {
  target: SendTarget
  name: string
  volumeIds: string[]
  parts: BundlePart[]
  views: BundleExportView[]
  onOffered: (code: string) => void
}): Promise<ExportBundleResult> {
  const onOffered = new Channel<string>()
  onOffered.onmessage = params.onOffered
  return invoke<ExportBundleResult>('send_view_to_device', {
    target: params.target,
    volumeIds: params.volumeIds,
    parts: params.parts,
    views: params.views,
    createdAt: new Date().toISOString(),
    name: params.name,
    onOffered,
  })
}

/**
 * Sends a drawing (NIfTI bytes) back to `target`, tagged with the volume it
 * was drawn on, and resolves once it has been accepted there. The bytes go as
 * a raw body behind a length-prefixed JSON header (see the Rust command), so
 * the code both ends show comes back as an event rather than on a channel.
 */
export async function sendDrawingToDevice(params: {
  target: SendTarget
  base: DrawingBase
  drawing: Uint8Array
  onOffered: (code: string) => void
}): Promise<void> {
  const meta = new TextEncoder().encode(
    JSON.stringify({
      target: params.target,
      base: params.base,
      createdAt: new Date().toISOString(),
    }),
  )
  const body = new Uint8Array(4 + meta.length + params.drawing.length)
  new DataView(body.buffer).setUint32(0, meta.length, true)
  body.set(meta, 4)
  body.set(params.drawing, 4 + meta.length)
  const unlisten = await getCurrentWebviewWindow().listen<string>(
    'neurovue-send-code',
    (event) => params.onOffered(event.payload),
  )
  try {
    await invoke('send_drawing_to_device', body)
  } finally {
    unlisten()
  }
}

/** Lays a received drawing over its base volume; returns the new volume id. */
export async function attachDrawing(params: {
  drawingPath: string
  base: DrawingBase
}): Promise<string> {
  return invoke<string>('attach_drawing', {
    drawingPath: params.drawingPath,
    baseId: params.base.id,
    baseSha256: params.base.sha256,
    baseLabel: params.base.label,
  })
}

/** Human-readable byte size for status messages ("1.4 GB", "820 MB"). */
export function formatBundleBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3))
  const value = bytes / 1000 ** exponent
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`
}

function sanitizeBundleName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'neurovue-bundle'
}

// ── Import / reload ────────────────────────────────────────────────────────

export type BundleVerifyStatus =
  | 'ok'
  | 'mismatch'
  | 'missing'
  | 'unreadable'
  | 'invalid'

export interface BundleVerifyEntry {
  data: string
  expected: string
  actual: string | null
  status: BundleVerifyStatus
}

/**
 * One data file a bundle carries (see Rust `export_bundle`).
 */
export interface BundleResource {
  id: string
  kind: 'volume' | 'drawing' | 'mesh'
  role?: string
  /** A drawing's volume. */
  base?: string
  label?: string
  data: string
  sha256?: string
}

/** A saved view's entry in the manifest; the deck is their order. */
export interface BundleViewEntry {
  id: string
  data?: string
  sha256?: string
  title?: string
  notes?: string
  thumbnail?: string | null
}

/** A deck step as `read_bundle` returns it, thumbnail inline. */
export interface BundleReadView {
  id: string
  title?: string | null
  notes?: string | null
  /** A PNG data URL. */
  thumbnail: string | null
  view: BundleView | null
}

/** A saved view: its viewers, keyed by id (docs/nvbundle-v2.md). */
export interface BundleView {
  panes: Record<string, BundlePane>
  focus?: string
}

/** The volume a drawing was made on, as its bundle recorded it. */
export interface DrawingBase {
  id: string
  sha256: string
  label: string
}

export interface BundleManifest {
  nvbundle?: string
  /** "drawing" for a drawing sent back from an iPad; a dataset otherwise. */
  kind?: string
  /** A drawing's base volume (kind "drawing" only). */
  base?: DrawingBase
  source?: {
    datasetName?: string | null
    datasetDoi?: string | null
    datasetRoot?: string | null
  }
  resources: BundleResource[]
  views?: BundleViewEntry[]
  start?: string
}

export interface BundleReadResult {
  manifest: BundleManifest
  /** The start view, already read from the bundle; null when it has none. */
  view: BundleView | null
  /** Every step, in deck order; absent for a NiiVue document. */
  views?: BundleReadView[]
  bundlePath: string
  dataDir: string
  verification: BundleVerifyEntry[]
  allVerified: boolean
}

const BUNDLE_EXTENSION = 'nvbundle'

/** Whether `path` names a bundle, so it opens via import rather than as a dir. */
export function isBundlePath(path: string): boolean {
  return path.toLowerCase().endsWith(`.${BUNDLE_EXTENSION}`)
}

const DOCUMENT_EXTENSION = 'nvd'

/** Whether `path` names a NiiVue document (`.nvd`), which opens like a bundle. */
export function isDocumentPath(path: string): boolean {
  return path.toLowerCase().endsWith(`.${DOCUMENT_EXTENSION}`)
}

/** Prompt for a bundle or NiiVue document to open. Returns null if cancelled. */
export async function pickBundle(): Promise<string | null> {
  const selected = await open({
    directory: false,
    multiple: false,
    title: 'Open NeuroVue bundle',
    filters: [
      {
        name: 'NeuroVue bundle or NiiVue document',
        extensions: [BUNDLE_EXTENSION, DOCUMENT_EXTENSION],
      },
    ],
  })
  return typeof selected === 'string' ? keepPickedFile(selected) : null
}

/**
 * Read + hash-verify a bundle's manifest (no volumes loaded yet). A NiiVue
 * document reads as a bundle too: its embedded volumes are written out as
 * files, with its colormaps, opacities and windows as the view.
 */
export async function readBundle(path: string): Promise<BundleReadResult> {
  const command = isDocumentPath(path)
    ? 'read_document_manifest'
    : 'read_bundle_manifest'
  return invoke<BundleReadResult>(command, { path })
}

/**
 * The server volume ids a bundle's data files get once its `data/` dir is
 * opened as a dataset, keyed by data path. Mirrors Rust `volume_id()` +
 * `disambiguate_volume_ids()`: the filename stem (relative to the `data/` root,
 * which is flat) minus the `.nii` / `.nii.gz` extension; when stems collide
 * (`x.nii` beside `x.nii.gz`), the first filename in sort order keeps the plain
 * stem and each later one gets `~` + the 8-hex FNV-1a hash of its filename.
 */
export function bundleVolumeIds(dataRelPaths: string[]): Map<string, string> {
  const fileNames = new Map(
    dataRelPaths.map((path) => [path, path.split('/').pop() ?? path]),
  )
  const stems = new Map(
    [...fileNames].map(([path, name]) => [
      path,
      name.replace(/\.nii\.gz$/, '').replace(/\.nii$/, ''),
    ]),
  )
  const taken = new Set(stems.values())
  const kept = new Set<string>()
  const ids = new Map<string, string>()
  const ordered = [...fileNames].sort(([, a], [, b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  for (const [path, name] of ordered) {
    const stem = stems.get(path) ?? name
    if (!kept.has(stem)) {
      kept.add(stem)
      ids.set(path, stem)
      continue
    }
    const base = `${stem}~${fnv1a32Hex(name)}`
    let candidate = base
    for (let suffix = 2; taken.has(candidate); suffix++) {
      candidate = `${base}_${suffix}`
    }
    taken.add(candidate)
    kept.add(candidate)
    ids.set(path, candidate)
  }
  return ids
}

/** 32-bit FNV-1a over UTF-8 bytes as 8 hex digits; matches Rust `fnv1a_32`. */
function fnv1a32Hex(value: string): string {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** A saved view's focused viewer, else its first. */
export function focusedPane(view: BundleView | null): BundlePane | undefined {
  if (!view) return undefined
  return view.panes[view.focus ?? ''] ?? Object.values(view.panes)[0]
}

/** Count the files in a verification list that failed the integrity check. */
export function bundleVerifyFailures(
  verification: BundleVerifyEntry[],
): BundleVerifyEntry[] {
  return verification.filter((entry) => entry.status !== 'ok')
}
