// 3D render shading. MRIcroGL and Surfice pick a look from a short list of
// shaders; NiiVue builds the same looks from a few volume settings, so NeuroVue
// offers them as presets over those settings.
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
  /**
   * How the volume is drawn: the composite ray march, a maximum-intensity
   * projection, or NiiVue's cinematic path tracer (soft shadows and ambient
   * occlusion, refined over a few frames).
   */
  renderMode: 'composite' | 'mip' | 'cinematic'
}

export type ShadingPresetId = 'standard' | 'lit' | 'mip' | 'cinematic'

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
      renderMode: 'composite',
    },
  },
  {
    id: 'lit',
    label: 'Lit',
    shading: {
      illumination: 0.6,
      gradientOpacity: 0,
      silhouette: 0,
      renderMode: 'composite',
    },
  },
  {
    id: 'mip',
    label: 'MIP',
    shading: {
      illumination: 0,
      gradientOpacity: 0,
      silhouette: 0,
      renderMode: 'mip',
    },
  },
  {
    id: 'cinematic',
    label: 'Cinematic',
    shading: {
      illumination: 0,
      gradientOpacity: 0,
      silhouette: 0,
      renderMode: 'cinematic',
    },
  },
]

export const DEFAULT_RENDER_SHADING: RenderShading = SHADING_PRESETS[0].shading

/** The preset these settings match exactly, or null if none does. */
export function matchingShadingPreset(
  shading: RenderShading,
): ShadingPresetId | null {
  const preset = SHADING_PRESETS.find(
    ({ shading: candidate }) =>
      candidate.illumination === shading.illumination &&
      candidate.gradientOpacity === shading.gradientOpacity &&
      candidate.silhouette === shading.silhouette &&
      candidate.renderMode === shading.renderMode,
  )
  return preset?.id ?? null
}
