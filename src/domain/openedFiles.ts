import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

// Files another app hands NeuroVue, such as an AirDropped bundle or volume on
// iOS (see src-tauri/src/opened.rs). The host keeps them until taken, so one
// that launched the app is still there once the page is ready.

const OPENED_EVENT = 'neurovue-files-opened'

/** The newest file received since the last call, or null. Each open replaces
 *  the dataset, so only the newest of several matters. */
export async function takeOpenedFile(): Promise<string | null> {
  try {
    const paths = await invoke<string[]>('take_opened_files')
    return paths[paths.length - 1] ?? null
  } catch {
    return null
  }
}

/** Where a picked file now lives. The iOS picker copies it into the Inbox,
 *  which iOS purges, so the host moves it into Documents/Received; elsewhere
 *  the path comes back unchanged. */
export async function keepPickedFile(path: string): Promise<string> {
  try {
    return await invoke<string>('keep_picked_file', { path })
  } catch {
    return path
  }
}

/** Calls `onArrival` whenever files arrive while the page is running; returns
 *  the function that stops listening. */
export function onFilesOpened(onArrival: () => void): () => void {
  let stopped = false
  let unlisten: (() => void) | null = null
  void listen(OPENED_EVENT, onArrival)
    .then((nextUnlisten) => {
      if (stopped) nextUnlisten()
      else unlisten = nextUnlisten
    })
    .catch(() => {})
  return () => {
    stopped = true
    unlisten?.()
  }
}
