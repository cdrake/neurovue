// Keeps the page's recent console output and WebGPU errors so an agent can
// read them (the console_log tool) without opening Web Inspector, which a
// release build of the macOS app does not offer.
//
// WebKit reports a WebGPU validation error to its own inspector, not through
// console.*, so wrapping the console alone would miss exactly the errors that
// matter here. install() also wraps GPUAdapter.prototype.requestDevice and
// listens on every device it hands out: uncapturederror and lost.

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'gpu'

export interface ConsoleEntry {
  /** Milliseconds since the epoch. */
  time: number
  level: ConsoleLevel
  text: string
}

const MAX_ENTRIES = 500
const MAX_TEXT = 2000
const entries: ConsoleEntry[] = []
let dropped = 0
let installed = false

function format(value: unknown): string {
  if (value instanceof Error)
    return value.stack || `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function record(level: ConsoleLevel, parts: unknown[]): void {
  let text = parts.map(format).join(' ')
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}…`
  entries.push({ time: Date.now(), level, text })
  if (entries.length > MAX_ENTRIES) {
    entries.shift()
    dropped++
  }
}

function watchDevice(device: GPUDevice): void {
  device.addEventListener('uncapturederror', (event) => {
    const error = (event as GPUUncapturedErrorEvent).error
    record('gpu', [
      `${error.constructor?.name ?? 'GPUError'}: ${error.message}`,
    ])
  })
  void device.lost.then((info) => {
    record('gpu', [`device lost (${info.reason}): ${info.message}`])
  })
}

/** Starts capturing; call once, before anything logs or asks for a GPU device. */
export function install(): void {
  if (installed) return
  installed = true
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      record(level, args)
      original(...args)
    }
  }
  window.addEventListener('error', (event) => {
    record('error', [event.error ?? event.message])
  })
  window.addEventListener('unhandledrejection', (event) => {
    record('error', ['unhandled rejection:', event.reason])
  })
  const adapterProto = (
    globalThis as { GPUAdapter?: { prototype: GPUAdapter } }
  ).GPUAdapter?.prototype
  if (adapterProto) {
    const requestDevice = adapterProto.requestDevice
    adapterProto.requestDevice = async function (
      this: GPUAdapter,
      ...args: Parameters<GPUAdapter['requestDevice']>
    ) {
      const device = await requestDevice.apply(this, args)
      watchDevice(device)
      return device
    }
  }
}

export interface ConsoleQuery {
  /** Only these levels; all otherwise. */
  levels?: ConsoleLevel[]
  /** Only entries at or after this time (ms since the epoch). */
  since?: number
  /** At most this many, the newest. */
  limit?: number
  /** Empty the buffer after reading. */
  clear?: boolean
}

export function read(query: ConsoleQuery = {}): {
  entries: ConsoleEntry[]
  dropped: number
  now: number
} {
  let list = entries.filter(
    (entry) =>
      (!query.levels || query.levels.includes(entry.level)) &&
      (query.since === undefined || entry.time >= query.since),
  )
  if (query.limit !== undefined) list = list.slice(-query.limit)
  const result = { entries: list, dropped, now: Date.now() }
  if (query.clear) {
    entries.length = 0
    dropped = 0
  }
  return result
}
