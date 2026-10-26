// 3D render shading. MRIcroGL and Surfice pick a look from a short list of
// shaders; NiiVue builds the same looks from a few volume settings, so NeuroVue
// offers them as presets over those settings, with a slider for fine-tuning.
// gradientOpacity and silhouette (a Glass look) are wired through but not
// offered yet: in the macOS WKWebView any value above 0 blanks the render,
// though the same code works in Chrome.
// A plain domain type, like BlockSettings, so the viewer and any persistence
// layer can share it without importing a component.

export interface RenderShading {
  /** Surface lighting, 0 (flat) to 1. NiiVue's `volumeIllumination`. */
  illumination: number
  /** Fades homogeneous interiors so edges stand out, 0 to 1. `volumeGradientOpacity`. */
  gradientOpacity: number
  /** Fades view-aligned surfaces into an outline, 0 to 1. `volumeSilhouette`. */
  silhouette: number
  /** Maximum-intensity projection instead of the composite ray march. */
  isMip: boolean
}

export type ShadingPresetId = 'standard' | 'lit' | 'mip'

export const SHADING_PRESETS: ReadonlyArray<{
  id: ShadingPresetId
  label: string
  shading: RenderShading
}> = [
  {
    id: 'standard',
    label: 'Standard',
    shading: {
      illumination: 0,
      gradientOpacity: 0,
      silhouette: 0,
      isMip: false,
    },
  },
  {
    id: 'lit',
    label: 'Lit',
    shading: {
      illumination: 0.6,
      gradientOpacity: 0,
      silhouette: 0,
      isMip: false,
    },
  },
  {
    id: 'mip',
    label: 'MIP',
    shading: {
      illumination: 0,
      gradientOpacity: 0,
      silhouette: 0,
      isMip: true,
    },
  },
]

export const DEFAULT_RENDER_SHADING: RenderShading = SHADING_PRESETS[0].shading

/** The preset these settings match exactly, or null once a slider moved off it. */
export function matchingShadingPreset(
  shading: RenderShading,
): ShadingPresetId | null {
  const preset = SHADING_PRESETS.find(
    ({ shading: candidate }) =>
      candidate.illumination === shading.illumination &&
      candidate.gradientOpacity === shading.gradientOpacity &&
      candidate.silhouette === shading.silhouette &&
      candidate.isMip === shading.isMip,
  )
  return preset?.id ?? null
}
