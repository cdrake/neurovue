import { describe, expect, test } from 'bun:test'
import {
  applyBundleView,
  type BundlePane,
  buildBundlePane,
  bundleViewVolumeIds,
  focusedPane,
} from './bundle'

const pane = (viewMode: string) =>
  ({ app: { viewMode } }) as unknown as BundlePane

describe('focusedPane', () => {
  test('reads the focused pane, else the first', () => {
    const panes = { a: pane('axial'), b: pane('3d') }
    expect(focusedPane({ panes, focus: 'b' })?.app.viewMode).toBe('3d')
    expect(focusedPane({ panes })?.app.viewMode).toBe('axial')
    expect(focusedPane(null)).toBeUndefined()
  })
})

describe('a saved view round trip', () => {
  test('restores layers, camera, legend, stack and annotations on new ids', () => {
    const camera = {
      azimuth: 110,
      elevation: 15,
      scaleMultiplier: 1.5,
      pan2Dxyzmm: [1, 2, 3, 2] as [number, number, number, number],
    }
    const built = buildBundlePane({
      // As the stage's linked serializeDocument gives it.
      document: {
        scene: camera,
        volumes: [
          { url: 'cut', colormap: 'gray', opacity: 0 },
          { url: 'stat', colormap: 'warm', calMin: 2, calMax: 6 },
          { url: 'aal', colormap: 'gray', hiddenLabels: [4, 5] },
        ],
      },
      baseId: 'cut',
      overlayIds: ['stat'],
      atlasId: 'aal',
      layerSettings: { cut: { hidden: true, opacity: 0.4 } },
      viewMode: 'render',
      clipPlanes: [],
      crosshairMm: [1, 2, 3],
      annotations: { whole: [{ id: 'a' }], cut: [], other: [{ id: 'b' }] },
      stack: {
        levels: ['whole', 'cut'],
        blocks: { whole: { grid: 2 } as never },
      },
      controls: { shapes: true, 'shape-tool': 'arrow' },
    })
    expect(bundleViewVolumeIds(built)).toEqual(['cut', 'stat', 'aal', 'whole'])
    // Annotations on volumes the bundle doesn't carry, or with no shapes, drop.
    expect(built.app.annotations).toEqual({ whole: [{ id: 'a' }] })
    expect(built.app.hidden).toEqual({ cut: 0.4 })

    const saved: BundlePane = JSON.parse(JSON.stringify(built))
    const applied = applyBundleView(saved, (id) =>
      id === 'stat' ? undefined : `new-${id}`,
    )
    expect(applied.baseId).toBe('new-cut')
    expect(applied.overlayIds.size).toBe(0)
    expect(applied.atlasId).toBe('new-aal')
    // Hidden keeps its opacity; the atlas keeps its label colormap.
    expect(applied.layerSettings).toEqual({
      'new-cut': { colormap: 'gray', opacity: 0.4, hidden: true },
    })
    expect(applied.hiddenLabels).toEqual({ 'new-aal': [4, 5] })
    expect(applied.annotations).toEqual({ 'new-whole': [{ id: 'a' }] })
    expect(applied.camera).toEqual(camera)
    expect(applied.crosshairPos).toEqual([1, 2, 3])
    expect(applied.stack).toEqual({
      levels: ['new-whole', 'new-cut'],
      blocks: { 'new-whole': { grid: 2 } as never },
    })
    expect(saved.controls).toEqual({
      version: 1,
      values: { shapes: true, 'shape-tool': 'arrow' },
    })
  })

  test('without a viewer, lists the layers by id', () => {
    const built = buildBundlePane({
      document: null,
      baseId: 'a',
      overlayIds: ['b', 'a'],
      atlasId: null,
      layerSettings: {},
      viewMode: 'axial',
      clipPlanes: [],
      crosshairMm: null,
    })
    expect(built.document.volumes).toEqual([{ url: 'a' }, { url: 'b' }])
  })
})
