import type { DesktopItem } from './desktop'
import type { JsonSchema } from './neuroflowClient'

const KINDS: Record<string, 'dataset' | 'volume'> = {
  'neuro:bids-dataset': 'dataset',
  'neuro:volume': 'volume',
  'neuro:label-map': 'volume',
  'neuro:mask': 'volume',
}

/** First required input by `x-neuroflow-type`; never by name. */
export function targetInput(
  inputSchema: JsonSchema,
): { name: string; kind: 'dataset' | 'volume' } | null {
  const props = (inputSchema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >
  const required = (inputSchema.required ?? []) as string[]
  for (const name of required) {
    const kind = KINDS[String(props[name]?.['x-neuroflow-type'])]
    if (kind) return { name, kind }
  }
  return null
}

export type BatchTarget = {
  key: string
  label: string
  path: string
  itemId: string | null
}

/** DesktopItem plus the on-disk path the host attaches. */
export type TargetItem = Pick<DesktopItem, 'id' | 'label' | 'role'> & {
  sourcePath?: string | null
}

export function resolveTargets(
  kind: 'dataset' | 'volume',
  ctx: {
    datasetRoot: string | null
    bidsName: string | null
    filtered: TargetItem[]
    selected: TargetItem | null
    selectedOnly: boolean
  },
): { targets: BatchTarget[]; blocker: string | null } {
  if (kind === 'dataset') {
    if (!ctx.datasetRoot || !ctx.bidsName)
      return { targets: [], blocker: 'needs a BIDS dataset' }
    const path = ctx.datasetRoot
    return {
      targets: [{ key: path, label: ctx.bidsName, path, itemId: null }],
      blocker: null,
    }
  }
  const pool = ctx.selectedOnly
    ? ctx.selected
      ? [ctx.selected]
      : []
    : ctx.filtered
  const targets = pool
    .filter((i) => i.sourcePath && i.role !== 'overlay')
    .map((i) => ({
      key: i.id,
      label: i.label,
      path: i.sourcePath as string,
      itemId: i.id,
    }))
  return {
    targets,
    blocker: targets.length ? null : 'no volumes match the filters',
  }
}
