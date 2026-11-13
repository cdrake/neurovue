import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useEffect, useRef } from 'react'

/** Actions the desktop menus can send (see `neurovue_menu` in lib.rs). */
export type NativeMenuAction =
  | 'express-view'
  | 'open-file'
  | 'open-folder'
  | 'open-mesh'
  | 'open-bundle'
  | 'open-sample'
  | 'export-bundle'
  | 'share'
  | 'pipelines'
  | 'clear-all'

export type NativeMenuHandlers = Record<
  NativeMenuAction,
  () => void | Promise<void>
>

/**
 * Routes clicks in the desktop File and View menus to the same handlers the toolbar
 * uses. The menu bar exists only on desktop, so on iOS (and in a plain
 * browser) no event ever arrives and this is a no-op.
 */
export function useNativeMenu(handlers: NativeMenuHandlers): void {
  // Handlers are recreated every render; read the latest through a ref so the
  // listener is registered once.
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null

    // This window's own: the host sends a menu click to the window in front,
    // and the global `listen` would hear clicks meant for the others too.
    void Promise.resolve()
      .then(() =>
        getCurrentWebviewWindow().listen<string>('neurovue-menu', (event) => {
          const handler = handlersRef.current[event.payload as NativeMenuAction]
          if (handler) void handler()
        }),
      )
      .then((nextUnlisten) => {
        if (cancelled) nextUnlisten()
        else unlisten = nextUnlisten
      })
      .catch(() => {
        unlisten = null
      })

    // A plain browser has no menu bar, so its one shortcut is bound here.
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.altKey &&
        (event.metaKey || event.ctrlKey) &&
        event.code === 'KeyV'
      ) {
        event.preventDefault()
        void handlersRef.current['express-view']()
      }
    }
    const inBrowser = !isTauri()
    if (inBrowser) window.addEventListener('keydown', onKeyDown)

    return () => {
      cancelled = true
      unlisten?.()
      if (inBrowser) window.removeEventListener('keydown', onKeyDown)
    }
  }, [])
}

/** The layout switch's shortcut as this platform writes it. */
export const EXPRESS_VIEW_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform)
  ? '⌥⌘V'
  : 'Ctrl+Alt+V'

/**
 * Keeps the View menu's switch named for the view it leads to (Dataset View
 * in express, Express View otherwise). The menu bar is shared by every
 * window, so each one renames it when it comes to the front.
 */
export function useExpressMenuLabel(express: boolean): void {
  useEffect(() => {
    // No such command on mobile or in a plain browser; nothing to rename.
    const sync = () =>
      invoke('set_express_menu_label', { express }).catch(() => {})
    void sync()
    let unlisten: (() => void) | null = null
    let cancelled = false
    void Promise.resolve()
      .then(() =>
        getCurrentWebviewWindow().onFocusChanged(({ payload: focused }) => {
          if (focused) void sync()
        }),
      )
      .then((next) => {
        if (cancelled) next()
        else unlisten = next
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [express])
}
