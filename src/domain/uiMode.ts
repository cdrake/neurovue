// The window layout. `full` is the dataset workbench (browser, filters,
// inspector tabs, terminal). `simple` is the MRIcroGL/Surfice layout: one
// viewer and one tool panel, for looking at an image rather than a dataset.

export type UiMode = 'full' | 'simple'

const UI_MODE_KEY = 'neurovue.uiMode.v1'

/**
 * The layout the user last picked, else `fallback`. The desktop opens on the
 * simple viewer; iOS keeps the workbench, which has no layout toggle there.
 */
export function loadRememberedUiMode(fallback: UiMode): UiMode {
  try {
    const stored = window.localStorage.getItem(UI_MODE_KEY)
    return stored === 'full' || stored === 'simple' ? stored : fallback
  } catch {
    return fallback
  }
}

export function rememberUiMode(mode: UiMode): void {
  try {
    window.localStorage.setItem(UI_MODE_KEY, mode)
  } catch {
    // localStorage may be disabled — the choice just won't survive a relaunch.
  }
}
