import type { UIKitOverlayRenderer } from '@niivue/niivue'
import {
  type MMPoint,
  type PointLabelPlacement,
  type UIKitFont,
  UIKitPointLabelOverlay,
} from '@niivue/uikit'

/** What a viewer needs to show point labels: NiiVue's projection and overlay hook. */
export interface PointLabelViewer {
  mmToRenderCanvas?(mm: [number, number, number]): [number, number] | null
  explodedMM?(mm: [number, number, number]): [number, number, number]
  registerOverlayRenderer?(renderer: UIKitOverlayRenderer): () => void
  drawScene(): void
}

// Labels an agent placed with set_labels. They belong to the window, not to a
// viewer: NiivueStage recreates NiiVue on every layer change, and each new
// one draws them again.
let placements: PointLabelPlacement[] = []
const shown = new Set<{
  overlay: UIKitPointLabelOverlay
  nv: PointLabelViewer
}>()

/** Replaces this window's point labels; an empty list takes them down. */
export function setPointLabels(
  labels: readonly { text: string; mm: readonly number[] }[],
): void {
  // The brick outline (boxMM) is left out: the dimmed bricks already say it.
  placements = labels.map(({ text, mm }) => ({
    text,
    mm: [mm[0], mm[1], mm[2]],
  }))
  for (const { overlay, nv } of shown) {
    overlay.setLabels(placements)
    nv.drawScene()
  }
}

/**
 * Draws this window's point labels on `nv`, following the render as it turns
 * and a spread volume as it explodes. Returns the detach function, or null
 * when this NiiVue build can't project or draw overlays.
 */
export function attachPointLabels(
  nv: PointLabelViewer,
  font: UIKitFont,
): (() => void) | null {
  const { mmToRenderCanvas, registerOverlayRenderer } = nv
  if (!mmToRenderCanvas || !registerOverlayRenderer) return null
  const project = (mm: MMPoint) => {
    const point: [number, number, number] = [mm[0], mm[1], mm[2]]
    return mmToRenderCanvas.call(nv, nv.explodedMM?.(point) ?? point)
  }
  const overlay = new UIKitPointLabelOverlay(font, project, placements)
  const entry = { overlay, nv }
  shown.add(entry)
  const unregister = registerOverlayRenderer.call(nv, overlay)
  return () => {
    shown.delete(entry)
    unregister()
    overlay.destroy()
  }
}
