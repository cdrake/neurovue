import { describe, expect, test } from 'bun:test'
import type { BundleViewState } from './bundle'
import { type DeckStep, remapBundleView, stageDeck } from './deck'
import type { MeshLayer } from './meshes'

const view = (base: string): BundleViewState => ({
  version: 1,
  scene: { crosshairPos: null, clipPlanes: [] },
  volumes: [
    { id: base, role: 'base' },
    { id: 'gone', role: 'overlay' },
  ],
  viewMode: 'axial',
  annotations: { [base]: [{}], gone: [{}] },
  stack: { levels: [base, 'gone', 'lo'], blocks: { lo: {} as never } },
})

const mesh: MeshLayer = {
  id: 'mesh-1',
  name: 'lh.pial',
  file: new File(['surface'], 'lh.pial'),
  color: [1, 0, 0],
  opacity: 0.5,
  visible: true,
}

const step = (
  base: string,
  drawing: Blob | null,
  meshes: MeshLayer[],
): DeckStep => ({
  key: base,
  title: base,
  notes: '',
  view: view(base),
  thumbnail: null,
  drawing: async () => drawing,
  meshes: async () => meshes,
})

describe('stageDeck', () => {
  test('names parts per step and stages a shared mesh once', async () => {
    const staged: string[] = []
    const { views, parts, volumeIds } = await stageDeck(
      [step('t1', new Blob(['d']), [mesh]), step('t2', null, [mesh])],
      async (bytes) => {
        staged.push(new TextDecoder().decode(bytes))
        return `sha${staged.length}`
      },
    )
    expect(staged).toEqual(['d', 'surface'])
    expect(parts.map((part) => [part.id, part.sha256])).toEqual([
      ['v1_drawing', 'sha1'],
      ['v1_mesh-1', 'sha2'],
      ['v2_mesh-1', 'sha2'],
    ])
    expect(views[0].document.drawing).toBe('v1_drawing')
    expect(views[1].document.drawing).toBeUndefined()
    expect(views[1].document.meshes?.[0]).toEqual({
      id: 'v2_mesh-1',
      color: [1, 0, 0],
      opacity: 0.5,
      visible: true,
    })
    expect(volumeIds).toEqual(['t1', 'gone', 'lo', 't2'])
  })
})

describe('remapBundleView', () => {
  test('maps volume ids and drops the ones that did not load', () => {
    const ids: Record<string, string> = { t1: 'a', lo: 'b' }
    const mapped = remapBundleView(view('t1'), (id) => ids[id])
    expect(mapped.volumes.map((volume) => volume.id)).toEqual(['a'])
    expect(Object.keys(mapped.annotations ?? {})).toEqual(['a'])
    expect(mapped.stack?.levels).toEqual(['a', 'b'])
    expect(Object.keys(mapped.stack?.blocks ?? {})).toEqual(['b'])
  })
})
