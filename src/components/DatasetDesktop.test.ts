import { expect, test } from 'bun:test'
import type { DesktopItem } from '../domain/desktop'
import { desktopGridFit } from './DatasetDesktop'

const TILE = 1024
const GAP = 96
const items = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `v${i}` }) as DesktopItem)

// Rendered height of a sources-only grid at zoom 100%, incl. world margins + label.
function renderedHeight(
  count: number,
  fit: { columns: number; tilePx: number },
) {
  const rows = Math.ceil(count / fit.columns)
  return 44 + 52 + fit.tilePx * (rows + (rows - 1) * (GAP / TILE))
}

test('a single tile never exceeds a short, wide pane', () => {
  const fit = desktopGridFit(1400, 260, items(1), TILE, GAP)
  expect(renderedHeight(1, fit)).toBeLessThanOrEqual(260 + 0.01)
})

test('a few results fit the whole pane on both axes', () => {
  for (const [w, h, n] of [
    [900, 500, 3],
    [500, 900, 6],
    [1200, 400, 12],
  ]) {
    const fit = desktopGridFit(w, h, items(n), TILE, GAP)
    expect(fit.tilePx).toBeGreaterThanOrEqual(112)
    expect(renderedHeight(n, fit)).toBeLessThanOrEqual(h + 0.01)
    const width = fit.tilePx * (fit.columns + (fit.columns - 1) * (GAP / TILE))
    expect(width).toBeLessThanOrEqual(w - 44 + 0.01)
  }
})

test('large datasets fall back to readable tiles that scroll', () => {
  const fit = desktopGridFit(900, 600, items(500), TILE, GAP)
  expect(fit.columns).toBe(8)
  expect(fit.tilePx).toBeGreaterThanOrEqual(56)
})
