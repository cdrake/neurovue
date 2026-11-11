// No server push yet in the web build: listeners never fire.
export async function listen(): Promise<() => void> {
  return () => {}
}
