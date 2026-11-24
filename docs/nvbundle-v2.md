# nvbundle v2: documents that save everything

Status: PRs 1-4 (container, round trip, deck, NVDocument panes) implemented; the rest is proposal. Extends `.nvbundle` v1 (`src/domain/bundle.ts`, `export_bundle`/`read_bundle` in
`src-tauri/src/volumetric_server.rs`) and the `nvbundle: "2"` already planned in
[provenance.md](provenance.md). No new format.

## Goals

One file that reopens exactly what the author saw, on any device:

- every viewer (NiiVue instance) in the document, their layout and sync;
- each viewer's full scene: layers, camera, shading, meshes, shapes, the live drawing, whole-slide
  images;
- control state (draw/shape/measure tool, pen, brush, wand, magnifier, levels);
- an ordered sequence of saved views (a deck or guided tour) with titles, notes and thumbnails;
- integrity and provenance unchanged: data hashes don't move when views are edited.

Non-goals: device preferences (below), and re-running subprocesses (niimath and terminal outputs
travel as data with `derivation`, never as commands).

## Findings that shape it

- **One NiiVue instance today** (`NiivueStage.tsx`, `new NiiVue`). Multi-viewer is new, so the
  format needs `views[]` of `panes[]`, not one `view`.
- **NVDocument** (mono `niivue/src/NVDocument.ts`, v11) is a complete single-viewer scene with
  migration, sparse settings, URL-linked volumes (`linkData`) and `resolveUrl` rebasing. It has no
  multi-instance, layout, sync, deck, hash or app/extension slot, and `serialize` drops unknown
  keys. Use it per pane; put everything else beside it.
- **UIKit keeps no state.** Controls render `StageControlsState`; `stageControlStates` /
  `setStageControl` (`src/domain/stageControlSurface.ts`) is already a JSON `{id: value}` surface
  with a replay path. Serialize that, not UIKit specs.
- **v1 import is partial.** Dropped today: live draw layer, meshes, shading, camera/pan,
  block drill-down, legend toggles, tool state. Annotations attach to the base only. Integrity
  failures only warn. `backend` is written but (correctly) ignored.
- **Prior art:** Neuroglancer (layout tree by id), 3D Slicer `.mrb` (data/display split, zip of
  scene + data), OHIF hanging protocols (stages, sync groups), DICOM GSPS (presentation references
  data by id), ODF/EPUB (`mimetype` first), glTF (`extensions`, `extensionsUsed/Required`,
  `extras`), OME-NGFF (whole-slide pyramids).

## Container

- Canonical form: a **Stored** (uncompressed) zip, as v1 already writes. Volumes are read in place;
  bounded memory on iOS. A directory is a desktop working form only; the zip is what travels.
- First entry `mimetype`, uncompressed, `application/vnd.neurovue.bundle+zip` (ODF/EPUB trick, so
  `file` and sniffers identify it). Then parts, then `manifest.json` last (a zip cut short has no
  manifest, so it never reads as complete).
- All paths bundle-relative; no `..`, no absolute or source paths (iOS sandbox; Rust already
  enforces).

```
mimetype
thumbs/<id>.png  per view; doubles as the Quick Look / share preview
views/<id>.json  one saved view: panes, layout, sync, controls
data/            volumes and sidecars (opened as the dataset)
drawings/        live drawings, each over a `base` volume
meshes/          surfaces and tracts
slides/<id>.zarr whole-slide images, OME-Zarr
prov/            provenance.md's PROV-JSON + hash-chained log
manifest.json
```

## Manifest

```jsonc
{
  "nvbundle": "2",
  "created": "…", "generator": "NeuroVue 0.3.0",
  "resources": [            // generalizes v1 volumes[]
    { "id": "t1", "kind": "volume", "data": "data/t1.nii.gz", "mediaType": "application/x-nifti",
      "sha256": "…", "bytes": 123, "shape": [], "dtype": "", "role": "base",
      "derivedFrom": [], "derivation": {}, "generatedBy": {} },
    { "id": "draw1", "kind": "drawing", "data": "drawings/draw1.nii", "base": "t1", "sha256": "…" },
    { "id": "lh", "kind": "mesh", "data": "meshes/lh.pial.gii", "sha256": "…" },
    { "id": "wsi", "kind": "slide", "data": "slides/wsi.zarr", "sha256": "…" }
  ],
  "views": [                // ordered: the deck. v1 = one entry.
    { "id": "v1", "data": "views/v1.json", "sha256": "…", "title": "", "notes": "",
      "thumbnail": "thumbs/v1.png" }
  ],
  "start": "v1",
  "extensionsUsed": [], "extensionsRequired": [],
  "extensions": {}, "extras": {}
}
```

- Everything references resources by `id`; the manifest is the parts list (no OPC `.rels`).
- View files are hashed too (v1 doesn't hash the view).
- Hashes are per part, so editing views leaves data hashes and provenance intact.

## A view

```jsonc
{
  "panes": {
    "a": {
      "document": { /* NVDocumentData, JSON encoding (documentJson.ts), linkData mode;
                      volume/mesh urls are resource ids resolved via resolveUrl */ },
      "app": {    // NeuroVue state NVDocument has no slot for
        "layers": { "base": "t1", "overlays": [], "atlas": null },
        "hidden": { "t1": 0.8 },                // hidden layer → opacity it returns to
        "viewMode": "multiplanar", "clipPlanes": [], "crosshairMm": [0, 0, 0],
        "blocks": {}, "stack": { "levels": [], "blocks": {} },  // drill-down
        "shading": {}, "annotations": { "t1": [] }, "drawing": "v1_drawing"
      },
      "controls": { "version": 1, "values": { "shapes": true, "shape-tool": "arrow", "pen": "1" } }
    },
    "b": { /* … */ }
  },
  "layout": { "type": "row", "weights": [2, 1], "children": ["a", "b"] },
  "sync": [ { "kind": "crosshair", "members": ["a", "b"] } ],
  "focus": "a"
}
```

- **Panes** are NVDocuments so mono owns scene serialization and migration; NeuroVue adds only
  `app`. The document is `serializeDocument({ linkData: true, format: 'json', linkUrl })` minus
  its drawing bitmap (the drawing is its own part); `linkUrl` maps each volume to its volume id
  and each mesh to its part id, and camera keys are always saved. It holds colormaps, windows,
  opacities, legend toggles (`hiddenLabels`), camera and mesh looks. NeuroVue still loads the
  volumes itself (its pyramid and voxel ceiling), reading those back rather than calling
  `loadDocument`. The crosshair stays in `app` in mm (the document's is a fraction). Tracts embed
  their data (mono doesn't link them yet).
- **Layout** is a logical tree with weights, never pixels. A compact width (iPhone, Slide Over) may
  show it as tabs or one pane at a time; the author's layout is a request, not a requirement.
- **Sync** mirrors NiiVue's `broadcastTo`/`SyncOpts` (crosshair, zoom/pan, camera, 2D/3D) as named
  groups.
- **Controls** are `stageControlStates` ids → values, replayed through `setStageControl` after
  volumes load: toggles (draw/measure/shapes) first, then their tools; skip buttons, disabled
  controls and values not in the current options; ignore unknown ids. They're a *hint*: a deck
  step can open with "shapes, arrow, red", and an app or user setting may ignore it. Ids become
  persisted API, so renames go in a table.
- **Lazy loading:** only `start` (or the focused pane) mounts. Phones never mount every view or
  pane of a deck at once; GPU memory scales with mounted panes, not document size.

## Document vs device preference

| Travels in the document | Stays on the device (never exported) |
|---|---|
| layers, roles, colormaps, windows, opacity | GPU backend (move `backend` out of the view) |
| camera, pan/zoom, crosshair, clip planes, shading | UI mode, split %, pane sizes, side tab |
| meshes, live drawing, shapes on any layer | palette fold, tools hidden, panel collapse |
| blocks and drill-down, legend toggles | terminal, interpreter, recents, last dir |
| panes, layout, sync, deck order and notes | volume filters, niimath panel inputs |
| control hint (tool, pen, brush, wand, levels) | magnifier, active clip plane, wheel mode |

## Extensions and versioning

- Any object may carry `extensions: {"org.lab.foo": {…}}` (reverse-DNS) and free-form `extras`.
  Top-level `extensionsUsed` / `extensionsRequired`.
- Unknown required extension, or a newer major `nvbundle`: refuse to open and say why (read-only
  opening is a later option).
- Unknown keys and parts survive a round trip: `#[serde(flatten)] extra` on Rust structs, spread the
  original object under edits in TS, copy unknown parts byte for byte. One test injects unknown
  keys and parts, saves, and checks they're still there.
- `nvbundle` is the major version (breaking only); additive fields don't bump it. v1 predates any
  users, so a reader refuses other majors rather than migrating; later majors get a migration
  chain once bundles exist in the wild.
- Integrity: a hash mismatch on a resource opens read-only with the failing parts named (v1 only
  warns).

## Plan (separate PRs)

1. **Container and manifest v2:** `mimetype` entry, `resources[]` (volumes + drawings + meshes),
   hashed `views[]`, refuse other formats, round-trip test for unknown keys; move `backend` to prefs.
2. **Complete single-pane round trip:** export the live draw layer, meshes, shading, camera/pan,
   block drill-down, legend toggles, annotations on any layer; `controls` hint via
   `stageControlStates`/`setStageControl`.
3. **Deck:** save/insert/reorder views with title, notes, thumbnail; present mode (next/previous,
   touch and keyboard); Quick Look uses `thumbs/`.
4. **Panes in NVDocument:** switch `document` to mono NVDocument JSON with linkData once
   mono links meshes and maps URLs to resource ids on save (mono PR).
5. **Multiple viewers:** layout tree, sync groups, lazy mounting; compact-width presentation. The
   largest change: `NiivueStage` assumes one instance.
6. **Slides:** OME-Zarr whole-slide resources and NVDocument `slidePlane` in panes.
7. **Interop (later):** RO-Crate export of the manifest + PROV.

Decided: the `controls` hint applies on every open, not only in present mode. Deck steps are full
snapshots, not panes shared by id: simpler and robust to reordering, and parts are deduplicated by
hash. Each step's drawing and meshes are its own parts (`v2_drawing`, `v2_<mesh>`); identical bytes
are stored once. Entries are written in the order above, `thumbs/v1.png` right after `mimetype`: Quick Look
reads the start view's thumbnail from the head of the file. `manifest.json` goes last.
