// Stands in for @tauri-apps/api/core in the web build (vite --mode web):
// commands go to neurovue-web's /rpc. Relative URL, so a proxy prefix works.
export function isTauri(): boolean {
  return false
}

export async function invoke<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(`rpc/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  })
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
