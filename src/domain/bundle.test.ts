import { describe, expect, test } from 'bun:test'
import { type BundleViewState, focusedViewState } from './bundle'

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
