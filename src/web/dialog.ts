import { invoke } from './core'

type Listing = {
  path: string
  parent: string | null
  // Set when the requested path was a file; `path` is then its folder.
  file: string | null
  // The server lists at most a few thousand entries per folder.
  truncated?: boolean
  entries: { name: string; dir: boolean }[]
}

type OpenOptions = {
  title?: string
  directory?: boolean
  filters?: { name: string; extensions: string[] }[]
}

const LAST_DIR_KEY = 'neurovue-web-dir'

function lastDir(): string {
  try {
    return localStorage.getItem(LAST_DIR_KEY) ?? ''
  } catch {
    return ''
  }
}

function rememberDir(path: string) {
  try {
    localStorage.setItem(LAST_DIR_KEY, path)
  } catch {}
}

// Paths are on the server, so the browser's file picker can't name them; this
// browses the server's folders instead (list_dir).
// shortcut: single selection only (meshes accept one), add multi-select if asked.
export function open(options: OpenOptions = {}): Promise<string | null> {
  const extensions = options.filters?.flatMap((filter) =>
    filter.extensions.map((ext) => `.${ext.toLowerCase()}`),
  )
  const dialog = document.createElement('dialog')
  dialog.style.cssText =
    'width:min(640px,92vw);max-height:80vh;display:flex;flex-direction:column;gap:8px;font:14px system-ui;color-scheme:light dark'
  const heading = document.createElement('h2')
  heading.textContent = options.title ?? 'Open'
  heading.style.cssText = 'margin:0;font-size:16px'
  const location = document.createElement('input')
  location.setAttribute('aria-label', 'Folder on the server')
  location.style.cssText = 'font:inherit;padding:4px'
  const list = document.createElement('ul')
  list.style.cssText =
    'list-style:none;margin:0;padding:0;overflow:auto;min-height:200px;flex:1'
  const error = document.createElement('p')
  error.setAttribute('role', 'alert')
  error.style.cssText = 'margin:0;color:#c33'
  const buttons = document.createElement('div')
  buttons.style.cssText = 'display:flex;justify-content:flex-end;gap:8px'
  const cancel = document.createElement('button')
  cancel.textContent = 'Cancel'
  buttons.append(cancel)
  const chooseFolder = document.createElement('button')
  chooseFolder.textContent = 'Open this folder'
  if (options.directory) buttons.append(chooseFolder)
  dialog.append(heading, location, list, error, buttons)
  document.body.append(dialog)

  return new Promise((resolve) => {
    let current = ''
    const finish = (value: string | null) => {
      if (value) rememberDir(current)
      resolve(value)
      dialog.close()
      dialog.remove()
    }
    const row = (label: string, onClick: () => void) => {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.textContent = label
      button.style.cssText =
        'all:unset;display:block;width:100%;box-sizing:border-box;padding:3px 6px;cursor:pointer'
      button.onclick = onClick
      item.append(button)
      list.append(item)
    }
    const accepts = (name: string) =>
      !options.directory &&
      (!extensions ||
        extensions.some((ext) => name.toLowerCase().endsWith(ext)))
    const show = async (path: string) => {
      try {
        const listing = await invoke<Listing>('list_dir', { path })
        current = listing.path
        if (listing.file && accepts(listing.file)) return finish(listing.file)
        location.value = listing.path
        error.textContent = listing.file
          ? `${listing.file} isn't something this picker can open.`
          : listing.truncated
            ? `This folder has more entries than the picker shows (${listing.entries.length}). Type a path to open one that isn't listed.`
            : ''
        list.replaceChildren()
        if (listing.parent) {
          const parent = listing.parent
          row('📁 ..', () => show(parent))
        }
        for (const { name, dir } of listing.entries) {
          const full = `${listing.path.replace(/\/$/, '')}/${name}`
          if (dir) row(`📁 ${name}`, () => show(full))
          else if (accepts(name)) row(name, () => finish(full))
        }
      } catch (reason) {
        // A remembered folder may be gone; start from home instead.
        if (!current && path) return show('')
        error.textContent = String(reason)
      }
    }
    location.onkeydown = (event) => {
      if (event.key === 'Enter') show(location.value)
    }
    cancel.onclick = () => finish(null)
    chooseFolder.onclick = () => finish(current)
    dialog.oncancel = () => finish(null)
    dialog.showModal()
    show(lastDir())
  })
}

// Export isn't served in the web version, so saving stays a typed path.
export async function save(
  options: { title?: string } = {},
): Promise<string | null> {
  return window.prompt(`${options.title ?? 'Save'}: path on the server`)
}
