import { describe, expect, test } from 'bun:test'
import {
  applyBundleView,
  type BundleViewState,
  buildBundleViewState,
  bundleViewVolumeIds,
  focusedViewState,
} from './bundle'

const state = (viewMode: string) => ({ viewMode }) as BundleViewState

describe('focusedViewState', () => {
  test('reads the focused pane, else the first', () => {
    const panes = {
      a: { document: state('axial') },
      b: { document: state('3d') },
    }
    expect(focusedViewState({ panes, focus: 'b' })?.viewMode).toBe('3d')
    expect(focusedViewState({ panes })?.viewMode).toBe('axial')
    expect(focusedViewState(null)).toBeUndefined()
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
    const view = buildBundleViewState({
      baseId: 'cut',
      overlayIds: ['stat'],
      atlasId: 'aal',
      layerSettings: {
        stat: { colormap: 'warm', window: { min: 2, max: 6 } },
        gone: { opacity: 0.2 },
      },
      viewMode: 'render',
      clipPlanes: [],
      crosshairPos: [1, 2, 3],
      camera,
      hiddenLabels: { aal: [4, 5] },
      annotations: { whole: [{ id: 'a' }], cut: [], other: [{ id: 'b' }] },
      stack: {
        levels: ['whole', 'cut'],
        blocks: { whole: { grid: 2 } as never },
      },
      controls: { shapes: true, 'shape-tool': 'arrow' },
    })
    expect(bundleViewVolumeIds(view)).toEqual(['cut', 'stat', 'aal', 'whole'])
    // Annotations on volumes the bundle doesn't carry, or with no shapes, drop.
    expect(view.annotations).toEqual({ whole: [{ id: 'a' }] })

    const saved: BundleViewState = JSON.parse(JSON.stringify(view))
    const applied = applyBundleView(saved, (id) =>
      id === 'stat' ? undefined : `new-${id}`,
    )
    expect(applied.baseId).toBe('new-cut')
    expect(applied.overlayIds.size).toBe(0)
    expect(applied.atlasId).toBe('new-aal')
    expect(applied.hiddenLabels).toEqual({ 'new-aal': [4, 5] })
    expect(applied.annotations).toEqual({ 'new-whole': [{ id: 'a' }] })
    expect(applied.camera).toEqual(camera)
    expect(applied.crosshairPos).toEqual([1, 2, 3])
    expect(applied.stack).toEqual({
      levels: ['new-whole', 'new-cut'],
      blocks: { 'new-whole': { grid: 2 } as never },
    })
    expect(saved.controls).toEqual({ shapes: true, 'shape-tool': 'arrow' })
  })
})
