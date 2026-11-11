// shortcut: paths are on the server, so the browser's file picker can't name
// them; ask for one. Replace with a server-side browser (list_dir) when needed.
export async function open(
  options: { title?: string } = {},
): Promise<string | null> {
  return window.prompt(`${options.title ?? 'Open'}: path on the server`)
}

export async function save(
  options: { title?: string } = {},
): Promise<string | null> {
  return window.prompt(`${options.title ?? 'Save'}: path on the server`)
}
