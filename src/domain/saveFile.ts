import { invoke, isTauri } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'

/** `write_file`'s raw body: u32 LE path length, the UTF-8 path, the bytes. */
export function writeFileBody(path: string, data: Uint8Array): Uint8Array {
  const pathBytes = new TextEncoder().encode(path)
  const body = new Uint8Array(4 + pathBytes.length + data.length)
  new DataView(body.buffer).setUint32(0, pathBytes.length, true)
  body.set(pathBytes, 4)
  body.set(data, 4 + pathBytes.length)
  return body
}

export async function gzip(
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Saves `data` where the person picks (the save dialog), or downloads it in a
 * browser. `fileName` carries the extension. Returns where it went, or null if
 * they cancelled.
 */
export async function saveFile(params: {
  title: string
  fileName: string
  data: Uint8Array<ArrayBuffer> | string
}): Promise<string | null> {
  const fileName = params.fileName.replace(/[^\w.-]+/g, '_')
  const data =
    typeof params.data === 'string'
      ? new TextEncoder().encode(params.data)
      : params.data
  if (!isTauri()) {
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([data]))
    link.download = fileName
    link.click()
    URL.revokeObjectURL(link.href)
    return fileName
  }
  const extension = fileName.split('.').pop() ?? ''
  const path = await save({
    title: params.title,
    defaultPath: fileName,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  })
  if (!path) return null
  await invoke('write_file', writeFileBody(path, data))
  return path
}

/**
 * Picks a NIfTI from the person's disk: the open dialog, or the browser's file
 * picker on the web (where Save downloads, so the file is on their machine).
 * Null if they cancelled.
 */
export async function pickNifti(title: string): Promise<File | null> {
  if (!isTauri()) {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.nii,.nii.gz,.gz'
    return new Promise((resolve) => {
      input.onchange = () => resolve(input.files?.[0] ?? null)
      input.oncancel = () => resolve(null)
      input.click()
    })
  }
  const path = await open({
    title,
    filters: [{ name: 'NIfTI', extensions: ['nii', 'gz'] }],
  })
  if (typeof path !== 'string') return null
  const bytes = await invoke<ArrayBuffer>('read_mask_file', { path })
  return new File([bytes], path.split(/[\\/]/).pop() ?? 'mask.nii.gz')
}
