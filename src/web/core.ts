// Stands in for @tauri-apps/api/core in the web build (vite --mode web):
// commands go to neurovue-web's /rpc. Relative URL, so a proxy prefix works.
export function isTauri(): boolean {
  return false
}

// Neurodesk stops an idle app and answers 503 while it restarts it on the next
// request. The request never reached neurovue-web (which doesn't answer 503
// itself), so it is safe to resend; give the restart up to ~30 s.
const RESTART_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 8000, 8000]

export async function invoke<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const body = JSON.stringify(args)
  let response: Response
  for (let attempt = 0; ; attempt++) {
    response = await fetch(`rpc/${command}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const delay = RESTART_RETRY_DELAYS_MS[attempt]
    if (response.status !== 503 || delay === undefined) break
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  // Tauri rejects with the command's error string; keep that shape.
  if (!response.ok) throw await response.text()
  const type = response.headers.get('content-type') ?? ''
  return (
    type.includes('json') ? response.json() : response.arrayBuffer()
  ) as Promise<T>
}

export class Channel<T> {
  onmessage: (message: T) => void = () => {}
}

export async function addPluginListener(): Promise<{
  unregister: () => Promise<void>
}> {
  return { unregister: async () => {} }
}
