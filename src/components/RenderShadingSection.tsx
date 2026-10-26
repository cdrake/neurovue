import { Sun } from 'lucide-react'
import type { JSX } from 'react'
import {
  matchingShadingPreset,
  type RenderShading,
  SHADING_PRESETS,
} from '../domain/shading'

/** MRIcroGL-style shader presets for the 3D render. */
export function RenderShadingSection({
  shading,
  onChange,
}: {
  shading: RenderShading
  onChange: (shading: RenderShading) => void
}): JSX.Element {
  const presetId = matchingShadingPreset(shading)
  const presetLabel =
    SHADING_PRESETS.find((preset) => preset.id === presetId)?.label ?? 'Custom'

  return (
    <section className="nv-control-section">
      <div className="nv-panel-heading">
        <span>
          <Sun size={15} />
          Shading
        </span>
        <em>{presetLabel}</em>
      </div>

      <fieldset className="nv-block-grid" aria-label="Shading preset">
        {SHADING_PRESETS.map((preset) => (
          <button
            aria-pressed={presetId === preset.id}
            className={`nv-block-grid-option ${presetId === preset.id ? 'is-active' : ''}`}
            key={preset.id}
            onClick={() => onChange(preset.shading)}
            type="button"
          >
            {preset.label}
          </button>
        ))}
      </fieldset>
    </section>
  )
}
