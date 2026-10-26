import { Sun } from 'lucide-react'
import type { JSX } from 'react'
import {
  matchingShadingPreset,
  type RenderShading,
  SHADING_PRESETS,
} from '../domain/shading'

const SLIDERS: ReadonlyArray<{
  key: 'illumination'
  label: string
  title: string
}> = [
  {
    key: 'illumination',
    label: 'Lighting',
    title: 'Shade surfaces by their normal, from flat (0) to fully lit (1)',
  },
]

/** MRIcroGL-style shader presets plus a lighting slider for the 3D render. */
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

      {SLIDERS.map(({ key, label, title }) => (
        <label className="nv-block-explode" key={key} title={title}>
          <span className="nv-block-explode-label">
            {label}
            <em>{shading.isMip ? '—' : shading[key].toFixed(2)}</em>
          </span>
          <input
            aria-label={label}
            disabled={shading.isMip}
            max={1}
            min={0}
            step={0.05}
            type="range"
            value={shading[key]}
            onChange={(event) =>
              onChange({ ...shading, [key]: Number(event.target.value) })
            }
          />
        </label>
      ))}
    </section>
  )
}
