import type { JSX } from 'react'
import {
  pressStageButton,
  setStageControl,
  stageControlStates,
} from '../domain/stageControlSurface'
import type {
  StageControlsActions,
  StageControlsState,
} from '../domain/stageControls'

/**
 * The canvas-drawn stage controls as hidden DOM, so VoiceOver, Voice Control
 * and Full Keyboard Access can reach them. Same list and actions as nv-mcp.
 */
export function StageControlsMirror({
  state,
  actions,
}: {
  state: StageControlsState
  actions: StageControlsActions
}): JSX.Element {
  const set = (id: string, value: string | number | boolean): void => {
    setStageControl({ state, actions }, id, { value })
  }
  return (
    <div
      className="nv-visually-hidden"
      role="toolbar"
      aria-label="Viewer controls"
    >
      {stageControlStates(state).map((control) => {
        const disabled = !control.enabled
        switch (control.kind) {
          case 'button':
            return (
              <button
                disabled={disabled}
                key={control.id}
                onClick={() => pressStageButton(actions, control.id)}
                type="button"
              >
                {control.label}
              </button>
            )
          case 'toggle':
            return (
              <button
                aria-pressed={control.value === true}
                disabled={disabled}
                key={control.id}
                onClick={() => set(control.id, control.value !== true)}
                type="button"
              >
                {control.label}
              </button>
            )
          case 'segmented':
            return (
              <fieldset aria-label={control.label} key={control.id}>
                {control.options?.map((option) => (
                  <button
                    aria-pressed={control.value === option.id}
                    disabled={disabled}
                    key={option.id}
                    onClick={() => set(control.id, option.id)}
                    type="button"
                  >
                    {option.label}
                  </button>
                ))}
              </fieldset>
            )
          case 'slider':
            return (
              <input
                aria-label={control.label}
                disabled={disabled}
                key={control.id}
                max={control.max}
                min={control.min}
                onChange={(event) =>
                  set(control.id, Number(event.target.value))
                }
                step={control.step}
                type="range"
                value={Number(control.value)}
              />
            )
          default:
            return null
        }
      })}
    </div>
  )
}
