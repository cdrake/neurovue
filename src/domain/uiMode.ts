// The window layout. `full` is the dataset workbench (browser, filters,
// inspector tabs, terminal). `simple` is the MRIcroGL/Surfice layout: one
// viewer and one tool panel, for looking at an image rather than a dataset.

export type UiMode = 'full' | 'simple'

const UI_MODE_KEY = 'neurovue.uiMode.v1'

/** The layout the user last picked, else the full workbench. */
export function loadRememberedUiMode(): UiMode {
  try {
    return window.localStorage.getItem(UI_MODE_KEY) === 'simple'
      ? 'simple'
      : 'full'
  } catch {
    return 'full'
  }
}

export function rememberUiMode(mode: UiMode): void {
  try {
    window.localStorage.setItem(UI_MODE_KEY, mode)
  } catch {
    // localStorage may be disabled — the choice just won't survive a relaunch.
  }
}
