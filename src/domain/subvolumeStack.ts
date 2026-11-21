// The trail of sub-volumes cut one from another (Box ▸ Cut out, or a brick's
// View block): the whole volume first, each cut below the one it came from.
// Moving along it keeps it whole, so the way back down stays one tap away;
// like browser history, a cut from partway up drops the levels below it.

/** The stack after cutting `cutId` out of `fromId`. */
export function pushCut(
  stack: readonly string[],
  fromId: string,
  cutId: string,
): string[] {
  const at = stack.indexOf(fromId)
  return [...(at < 0 ? [fromId] : stack.slice(0, at + 1)), cutId]
}

/** The levels to offer while `shownId` is on the stack, else null. */
export function stackLevels(
  stack: readonly string[],
  shownId: string | undefined,
): { id: string; label: string }[] | null {
  if (stack.length < 2 || !shownId || !stack.includes(shownId)) return null
  return stack.map((id, depth) => ({
    id,
    label: depth === 0 ? 'Whole' : `Block ${depth}`,
  }))
}
