You are giving a live demo of NeuroVue, a desktop neuroimaging viewer, to a
person watching the screen. Drive it only through the `{{SERVER}}` MCP server.
Don't run shell commands and don't use any other tools. Every NeuroVue tool
takes `tab`; name it on every call instead of relying on `use_tab`.

The demo files are in `{{DATA}}`:
- `bids`: a small BIDS dataset of two subjects, with T1w, T2w, PDw, angio,
  FLAIR, BOLD and ASL volumes. sub-02's T1w,
  `bids/sub-02/anat/sub-02_T1w.nii.gz`, is registered to MNI152 space, as
  are the three files below.
- `spmMotor.nii.gz`: a motor-task statistical map
- `BrainMesh_ICBM152.lh.mz3`: a left-hemisphere surface
- `dpsv.trx`: a tractogram

Before each numbered step, say in one short sentence what you are about to
show.

1. Call `list_tabs`. If no tab is connected, stop and tell the person to open
   NeuroVue and turn on View > Allow AI Agents. Otherwise call the first tab A.
2. Tab A, the activation window. Start from the dataset:
   - `focus_window`
   - `open_path` with the `bids` folder
   - `filter_dataset` with `image_types` ["T1w"], so the dataset pane lists
     only the T1-weighted volumes
   - `zoom_dataset` with `zoom` 2.5 and `volume` set to sub-02's T1w id, from
     what `filter_dataset` returned, so its thumbnail fills the pane
   - `select_volume` with that id: the MNI-registered T1w is now the base
   - `set_window_mode` with `express`, to put the dataset pane away and give
     the viewer the whole window
   - `add_overlay_path` with `spmMotor.nii.gz`
   - make the overlay easy to read with `set_volume`: a warm colormap, with
     values below 3 left out
   - `set_view` to the multiplanar layout with the render tile showing
3. Open the second window, B, with `open_window`, titled "Codex demo: tracts".
   In tab B:
   - `focus_window`
   - `open_path` with sub-02's T1w file, the same MNI-registered volume
   - `load_surfaces` with `BrainMesh_ICBM152.lh.mz3`
   - `load_tracts` with `dpsv.trx`
   - `set_view` to show the render alone
   - the T1w, drawn solid in the render, hides the surface and tracts:
     set its opacity to 0 with `set_volume`, and draw the surface with the
     `outline` shader using `set_mesh`
4. Switch back to A:
   - `focus_window`
   - move the crosshair to the strongest motor activation you can find, using
     `where_am_i` and `go_to_point`
   - `screenshot`
5. Switch to B:
   - `focus_window`
   - turn the render so the left hemisphere faces the viewer, with `set_camera`
     (azimuth 90 looks at the left side, 270 at the right)
   - `screenshot`
6. Switch to A and explode it:
   - `focus_window`
   - `set_view` to show the render alone
   - spread the T1w's bricks apart with `set_volume` and `spread` 1.5
   - turn the render to azimuth 270, so the right hemisphere faces the viewer
   - `set_labels` with one label, "Motor peak", at the strongest activation's
     millimetres, and `dim_others` 0.2 to fade the bricks without a label
   - `screenshot`
   - take the labels down with `set_labels` and `clear`, close the bricks up
     again with `spread` 1, and `set_view` back to the
     multiplanar layout
   - spin the render one full turn with `animate`: azimuth 360 past the
     current one, `angles` "literal" (or it takes the short way, and doesn't
     move), `duration_ms` 10000, `easing` "linear"
7. Save A's scene and open it again:
   - `save` the whole scene as a document, with `filename` set to
     `{{DOCUMENT}}`'s file name; it lands in the Downloads folder
   - empty the window with `remove_volume` and `all`
   - `open_path` with `{{DOCUMENT}}`, which brings back the T1w and the
     overlay with its colormap and threshold
   - `screenshot`
8. `use_tab` with A, so A answers later calls.

If a call fails, read the advice it returns, fix that one step and go on. Don't
start over. Finish with a short summary: what each of the two windows shows,
and where the crosshair in A ended up, in MNI millimetres.
