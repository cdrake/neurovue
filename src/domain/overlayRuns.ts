export type RunTag = {
  runId: string
  title: string
  startedAt: number
  sessionDir: string
}

/** `runs` maps item id to its run tag. Consecutive items of one run (or untagged) share a group. */
export function groupOverlaysByRun<T extends { id: string }>(
  items: T[],
  runs: Record<string, RunTag>,
): Array<{ tag: RunTag | null; items: T[] }> {
  const groups: Array<{ tag: RunTag | null; items: T[] }> = []
  for (const item of items) {
    const tag = runs[item.id] ?? null
    const last = groups[groups.length - 1]
    if (last && last.tag?.runId === tag?.runId) last.items.push(item)
    else groups.push({ tag, items: [item] })
  }
  return groups
}
