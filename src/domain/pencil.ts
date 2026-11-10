// Apple Pencil on the iPad, through the app's pencil plugin
// (src-tauri/plugins/pencil): what a double-tap or squeeze asks for, and the
// Pencil Pro's haptics. Anywhere else both do nothing.
import { addPluginListener, invoke, isTauri } from '@tauri-apps/api/core'

/** The action the person chose for the gesture in Settings > Apple Pencil. */
export type PencilAction =
  | 'switchEraser'
  | 'switchPrevious'
  | 'showColorPalette'
  | 'showInkAttributes'
  | 'showContextualPalette'
  | 'runSystemShortcut'
  | 'ignore'

/** Where the pencil was, in the page's CSS pixels. */
export interface PencilPoint {
  x: number
  y: number
}

// The app on a touch screen: the iPad. A Mac reports no touch points.
function hasPencil(): boolean {
  return isTauri() && navigator.maxTouchPoints > 1
}

/**
 * Calls `onAction` for each double-tap or squeeze of the pencil; returns a
 * function that stops listening.
 */
export function listenToPencil(
  onAction: (action: PencilAction, at: PencilPoint) => void,
): () => void {
  if (!hasPencil()) return () => {}
  const listeners = (['tap', 'squeeze'] as const).map((gesture) =>
    addPluginListener<{ action: PencilAction } & PencilPoint>(
      'pencil',
      gesture,
      ({ action, x, y }) => onAction(action, { x, y }),
    ).catch(() => null),
  )
  return () => {
    for (const listener of listeners) {
      void listener.then((registered) => registered?.unregister())
    }
  }
}

/**
 * A Pencil Pro's tap in the hand at `at`: `path` when a stroke is done,
 * `alignment` when the tool changes.
 */
export function pencilFeedback(
  kind: 'path' | 'alignment',
  at: PencilPoint,
): void {
  if (!hasPencil()) return
  invoke('plugin:pencil|feedback', { kind, ...at }).catch(() => {})
}
