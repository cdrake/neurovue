import { describe, expect, test } from 'bun:test'
import {
  createNeuroflowClient,
  isNifti,
  outputArtifacts,
} from './neuroflowClient'

type Call = { cmd: string; args: Record<string, unknown> }
function fake(
  handler: (cmd: string, args: Record<string, unknown>) => unknown,
) {
  const calls: Call[] = []
  const listeners = new Map<string, (e: { payload: unknown }) => void>()
  const invoke = (async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args })
    return handler(cmd, args)
  }) as never
  const listen = (async (
    name: string,
    cb: (e: { payload: unknown }) => void,
  ) => {
    listeners.set(name, cb)
    return () => listeners.delete(name)
  }) as never
  return {
    calls,
    invoke,
    listen,
    emit: (n: string, payload: unknown) => listeners.get(n)?.({ payload }),
  }
}
const ok = (structuredContent: unknown) => ({ structuredContent })

describe('neuroflowClient', () => {
  test('catalog joins tools/list and neuroflow_list by id', async () => {
    const f = fake((_cmd, a) => {
      if (a.method === 'tools/list')
        return {
          tools: [
            { name: 'nf_a', inputSchema: { type: 'object' } },
            { name: 'nf_b', inputSchema: { type: 'object' } },
            { name: 'nf_c', inputSchema: { type: 'object' } },
          ],
        }
      return ok({
        items: [
          { id: 'a', kind: 'tool', title: 'A', mcpName: 'nf_a' },
          { id: 'b', kind: 'workflow', title: 'B', mcpName: 'nf_b' },
        ],
      })
    })
    const c = createNeuroflowClient({ invoke: f.invoke, listen: f.listen })
    const first = await c.catalog()
    await c.catalog()
    expect(first.map((e) => e.mcpName)).toEqual(['nf_a', 'nf_b'])
    expect(first[0].inputSchema).toEqual({ type: 'object' })
    expect(f.calls.filter((x) => x.args.method === 'tools/list').length).toBe(1)
  })

  const entry = (mcpName: string) =>
    ({
      id: mcpName,
      kind: 'tool',
      title: '',
      description: '',
      mcpName,
      inputSchema: {},
    }) as never

  test('run sends a unique progressToken and routes progress to its own run', async () => {
    const f = fake(() => new Promise(() => {}))
    const c = createNeuroflowClient({ invoke: f.invoke, listen: f.listen })
    const got: string[] = []
    const r1 = c.run(entry('x'), {}, () => got.push('one'))
    const r2 = c.run(entry('x'), {}, (p) => got.push(`two:${p.progress}`))
    expect(r1.progressToken).not.toBe(r2.progressToken)
    await Bun.sleep(5)
    const tokens = f.calls.map(
      (x) =>
        (x.args.params as { _meta: { progressToken: string } })._meta
          .progressToken,
    )
    expect(tokens).toEqual([r1.progressToken, r2.progressToken])
    f.emit('neuroflow:progress', {
      progressToken: r2.progressToken,
      progress: 3,
    })
    expect(got).toEqual(['two:3'])
  })

  test('run rejects on isError with the tool text', async () => {
    const f = fake(() => ({
      isError: true,
      content: [{ type: 'text', text: 'boom' }],
    }))
    const c = createNeuroflowClient({ invoke: f.invoke, listen: f.listen })
    await expect(c.run(entry('x'), {}, () => {}).result).rejects.toThrow('boom')
  })

  test('cancel invokes neuroflow_cancel with the request id', async () => {
    const f = fake(() => undefined)
    const c = createNeuroflowClient({ invoke: f.invoke, listen: f.listen })
    await c.cancel(7)
    expect(f.calls).toEqual([
      { cmd: 'neuroflow_cancel', args: { requestId: 7 } },
    ])
  })
})

test('isNifti', () => {
  for (const p of ['a.nii', 'B.NII.GZ', '/x/my scan.nii.gz'])
    expect(isNifti(p)).toBe(true)
  for (const p of ['a.nii.gz.json', 'a.mgz']) expect(isNifti(p)).toBe(false)
})

test('outputArtifacts flattens nested arrays and skips non-artifacts', () => {
  const art = (n: string) => ({
    uri: `u${n}`,
    type: 't',
    path: `/p/${n}`,
    mediaType: 'm',
  })
  const s = {
    runId: 'r',
    status: 'ok',
    provenance: '',
    outputs: { a: art('1'), b: [art('2'), [art('3')]], c: 5, d: { x: 1 } },
  }
  expect(outputArtifacts(s as never).map((a) => a.path)).toEqual([
    '/p/1',
    '/p/2',
    '/p/3',
  ])
})
