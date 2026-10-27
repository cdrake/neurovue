/**
 * NeuroVue's tools as NeuroFlow tool documents (tools/*.neuroflow.json), and
 * how they become MCP tools under NeuroFlow RFC 0009 and RFC 0011: the name,
 * title and annotations from the `neuroflow/mcp` block, the description with
 * the `neuroflow/usage` sections, `x-neuroflow-type` on every input, and a
 * remedy on a failure the document knows.
 */
import type { ToolReply } from '@niivue/nv-mcp/server'
import type { ZodType } from 'zod'
import addOverlayPath from './tools/add-overlay-path.neuroflow.json'
import dataset from './tools/dataset.neuroflow.json'
import loadSurfaces from './tools/load-surfaces.neuroflow.json'
import loadTracts from './tools/load-tracts.neuroflow.json'
import openPath from './tools/open-path.neuroflow.json'
import openWindow from './tools/open-window.neuroflow.json'
import selectVolume from './tools/select-volume.neuroflow.json'

interface Failure {
  match: { exitCode?: number; contains?: string }
  meaning: string
  remedy: string
  retry?: string
}

export interface ToolDocument {
  id: string
  description: string
  inputs: Record<
    string,
    { type: string; description: string; optional?: boolean }
  >
  extensions: {
    'neuroflow/mcp': {
      name: string
      title: string
      annotations: Record<string, boolean>
    }
    'neuroflow/usage'?: {
      useWhen?: string[]
      avoidWhen?: { when: string; instead?: string }[]
      preconditions?: string[]
      effects?: string[]
      duration?: { typicalSeconds: number; maxSeconds?: number }
      failures?: Failure[]
    }
  }
}

export const DOCUMENTS = {
  openPath,
  dataset,
  selectVolume,
  addOverlayPath,
  loadSurfaces,
  loadTracts,
  openWindow,
} satisfies Record<string, ToolDocument>

/** The MCP tool name of each document, by id, for `instead`. */
const NAMES = new Map<string, string>(
  Object.values(DOCUMENTS).map((doc) => [
    doc.id,
    doc.extensions['neuroflow/mcp'].name,
  ]),
)

// RFC 0011: the rendered description should stay under this; whole sections
// go from the end until it does.
const MAX_DESCRIPTION = 1500

/** The MCP description: the document's, then its usage sections (RFC 0011). */
export function toolDescription(doc: ToolDocument): string {
  const usage = doc.extensions['neuroflow/usage'] ?? {}
  const sections = [
    usage.useWhen?.length && `Use when: ${usage.useWhen.join('; ')}`,
    usage.avoidWhen?.length &&
      `Avoid when: ${usage.avoidWhen
        .map(({ when, instead }) =>
          instead ? `${when} (use ${NAMES.get(instead) ?? instead})` : when,
        )
        .join('; ')}`,
    usage.preconditions?.length &&
      `Requires: ${usage.preconditions.join('; ')}`,
    usage.effects?.length && `Effects: ${usage.effects.join('; ')}`,
    usage.duration &&
      `Typical time: ~${usage.duration.typicalSeconds} s${
        usage.duration.maxSeconds
          ? ` (up to ${usage.duration.maxSeconds} s)`
          : ''
      }`,
  ].filter((section): section is string => Boolean(section))
  for (;;) {
    const text = [doc.description, ...sections].join('\n')
    if (text.length < MAX_DESCRIPTION || sections.length === 0) return text
    sections.pop()
  }
}

/**
 * The input schema: `shapes` gives each declared input's Zod type, and this
 * adds its description and `x-neuroflow-type` (RFC 0009 §1.2).
 */
export function inputSchema(
  doc: ToolDocument,
  shapes: Record<string, ZodType>,
): Record<string, ZodType> {
  return Object.fromEntries(
    Object.entries(shapes).map(([key, shape]) => {
      const input = doc.inputs[key]
      if (!input) throw new Error(`${doc.id} declares no input ${key}`)
      const typed = shape.meta({
        description: input.description,
        'x-neuroflow-type': input.type,
      })
      return [key, input.optional ? typed.optional() : typed]
    }),
  )
}

/**
 * A failed call's reply with the remedy of the first `failures` entry whose
 * `contains` is in the error (RFC 0011). Advice only: nothing is retried.
 */
export function withRemedy(doc: ToolDocument, reply: ToolReply): ToolReply {
  if (!reply.isError) return reply
  const text = reply.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
  const failure = doc.extensions['neuroflow/usage']?.failures?.find(
    ({ match }) =>
      match.exitCode === undefined &&
      match.contains &&
      text.includes(match.contains),
  )
  if (!failure) return reply
  const { meaning, remedy, retry } = failure
  return {
    ...reply,
    content: [...reply.content, { type: 'text', text: `${meaning} ${remedy}` }],
    structuredContent: { remedy: { meaning, remedy, retry } },
  }
}
