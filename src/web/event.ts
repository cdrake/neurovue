// Stands in for @tauri-apps/api/event in the web build (vite --mode web).
// neurovue-web queues the events the desktop app would emit (Pipelines
// progress, run ids) and the page polls for them over the same /rpc channel as
// every other call: no websocket or server-sent events, so it works through
// Neurodesk's proxy and a future custom-protocol transport alike.
import { invoke } from './core'

type EventMessage<T> = { event: string; id: number; payload: T }
type Handler = (message: EventMessage<unknown>) => void
type Page = { next: number; events: EventMessage<unknown>[] }

// The only events neurovue-web emits. Listeners for anything else (terminal,
// AirDrop, opened files: desktop-only features) never fire, and don't poll:
// steady polling would also keep resetting Neurodesk's idle-stop timer.
const SERVER_EVENTS = new Set(['neuroflow:progress', 'neuroflow:request-id'])

const FAST_POLL_MS = 400
const IDLE_POLL_MS = 2000
// Empty polls before slowing down.
const IDLE_AFTER = 10

const handlers = new Map<string, Set<Handler>>()
let cursor: number | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let emptyPolls = 0

function listenerCount(): number {
  let count = 0
  for (const set of handlers.values()) count += set.size
  return count
}

function schedule(): void {
  if (timer !== null || listenerCount() === 0) return
  const delay = emptyPolls >= IDLE_AFTER ? IDLE_POLL_MS : FAST_POLL_MS
  timer = setTimeout(() => {
    timer = null
    void poll()
  }, delay)
}

async function poll(): Promise<void> {
  try {
    const page = await invoke<Page>('web_events', { after: cursor })
    cursor = page.next
    emptyPolls = page.events.length === 0 ? emptyPolls + 1 : 0
    for (const message of page.events) {
      for (const handler of handlers.get(message.event) ?? []) {
        try {
          handler(message)
        } catch (error) {
          console.error(`event handler for ${message.event} failed`, error)
        }
      }
    }
  } catch {
    // Server restarting or unreachable: keep trying, slowly.
    emptyPolls = IDLE_AFTER
  }
  schedule()
}

export async function listen<T>(
  event: string,
  handler: (message: EventMessage<T>) => void,
): Promise<() => void> {
  if (!SERVER_EVENTS.has(event)) return () => {}
  // The first listener takes the server's current position, so it sees only
  // what happens after it subscribed (as a Tauri listener would).
  if (cursor === null) {
    cursor = (await invoke<Page>('web_events', {})).next
  }
  let set = handlers.get(event)
  if (!set) {
    set = new Set()
    handlers.set(event, set)
  }
  const entry = handler as Handler
  set.add(entry)
  emptyPolls = 0
  schedule()
  return () => {
    handlers.get(event)?.delete(entry)
    if (listenerCount() === 0 && timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
}
