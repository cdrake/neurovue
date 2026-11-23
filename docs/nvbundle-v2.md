# nvbundle v2: documents that save everything

Status: proposal. Extends `.nvbundle` v1 (`src/domain/bundle.ts`, `export_bundle`/`read_bundle` in
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
  `file` and sniffers identify it). Then `manifest.json`, then parts.
- All paths bundle-relative; no `..`, no absolute or source paths (iOS sandbox; Rust already
  enforces).

```
mimetype
manifest.json
data/            volumes, meshes, drawings, sidecars (v1 layout)
slides/<id>.zarr whole-slide images, OME-Zarr
views/<id>.json  one saved view: panes, layout, sync, controls
thumbs/<id>.png  per view; doubles as the Quick Look / share preview
prov/            provenance.md's PROV-JSON + hash-chained log
```

## Manifest

```jsonc
{
  "nvbundle": "2",
  "$schema": "https://neurovue.org/schema/nvbundle/2.json",
  "created": "…", "generator": "NeuroVue 0.3.0",
  "resources": [            // generalizes v1 volumes[]
    { "id": "t1", "kind": "volume", "path": "data/t1.nii.gz", "mediaType": "application/x-nifti",
      "sha256": "…", "bytes": 123, "shape": [], "dtype": "", "role": "base",
      "derivedFrom": [], "derivation": {}, "generatedBy": {} },
    { "id": "draw1", "kind": "drawing", "path": "data/draw1.nii.gz", "base": "t1", "sha256": "…" },
    { "id": "lh", "kind": "mesh", "path": "data/lh.pial.gii", "sha256": "…" },
    { "id": "wsi", "kind": "slide", "path": "slides/wsi.zarr", "sha256": "…" }
  ],
  "views": [                // ordered: the deck. v1 = one entry.
    { "id": "v1", "path": "views/v1.json", "sha256": "…", "title": "", "notes": "",
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
        "blocks": {}, "blockPath": [],          // drill-down
        "shading": {}, "legendHidden": [],
        "annotationsBase": "t1"
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
  `app`. Until mono's `json(embedImages=false)` lands, `document` may be the v1 `BundleViewState`
  shape (`"documentKind": "neurovue-view-1"`).
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
- Unknown required extension, or a newer major `nvbundle`: open read-only and say why.
- Unknown keys and parts survive a round trip: `#[serde(flatten)] extra` on Rust structs, spread the
  original object under edits in TS, copy unknown parts byte for byte. One test injects unknown
  keys and parts, saves, and checks they're still there.
- `nvbundle` is the major version (breaking only); additive fields don't bump it. Read runs the
  migration chain v1→v2; write is always latest. v1 → one view, one pane, `document` = its
  `BundleViewState`, `controls` absent.
- Integrity: a hash mismatch on a resource opens read-only with the failing parts named (v1 only
  warns).

## Plan (separate PRs)

1. **Container and manifest v2:** `mimetype` entry, `resources[]` (volumes + drawings + meshes),
   hashed `views[]`, v1 migration, round-trip test for unknown keys; move `backend` to prefs.
2. **Complete single-pane round trip:** export the live draw layer, meshes, shading, camera/pan,
   block drill-down, legend toggles, annotations on any layer; `controls` hint via
   `stageControlStates`/`setStageControl`.
3. **Deck:** save/insert/reorder views with title, notes, thumbnail; present mode (next/previous,
   touch and keyboard); Quick Look uses `thumbs/`.
4. **Panes in NVDocument:** switch `document` to mono NVDocument JSON with linkData once
   `json(embedImages=false)` ships (mono PR).
5. **Multiple viewers:** layout tree, sync groups, lazy mounting; compact-width presentation. The
   largest change: `NiivueStage` assumes one instance.
6. **Slides:** OME-Zarr whole-slide resources and NVDocument `slidePlane` in panes.
7. **Interop (later):** RO-Crate export of the manifest + PROV.

Open questions: should the `controls` hint apply by default or only in present mode? Do deck
steps share panes by id (one layer stack, many camera states) or stay full snapshots? Snapshots are
simpler and robust to reordering; data is deduplicated by resource id anyway.
