import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  GalleryVerticalEnd,
  Play,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { type JSX, useEffect, useRef } from 'react'
import type { DeckStep } from '../domain/deck'
import { isEditableTarget } from './ControlsHelp'

/** The deck's steps: save the current view after the shown step, edit, reorder, show, present. */
export function DeckPanel({
  steps,
  current,
  canAdd,
  onAdd,
  onEdit,
  onMove,
  onRemove,
  onShow,
  onPresent,
}: {
  steps: readonly DeckStep[]
  current: number
  canAdd: boolean
  onAdd: () => void
  onEdit: (key: string, patch: Pick<DeckStep, 'title' | 'notes'>) => void
  onMove: (index: number, by: -1 | 1) => void
  onRemove: (key: string) => void
  onShow: (index: number) => void
  onPresent: () => void
}): JSX.Element {
  return (
    <section className="nv-control-section nv-layer-panel nv-deck">
      <div className="nv-panel-heading">
        <span>
          <GalleryVerticalEnd size={15} />
          Deck
        </span>
        <em>{steps.length > 0 ? steps.length : 'none'}</em>
      </div>
      {steps.length > 0 ? (
        <ol className="nv-deck-steps">
          {steps.map((step, index) => (
            <li
              className={index === current ? 'is-current' : ''}
              key={step.key}
            >
              <button
                aria-label={`Show step ${index + 1}`}
                className="nv-deck-thumb"
                onClick={() => onShow(index)}
                type="button"
              >
                {step.thumbnail ? <img alt="" src={step.thumbnail} /> : null}
                <span>{index + 1}</span>
              </button>
              <div className="nv-deck-text">
                <input
                  aria-label={`Title of step ${index + 1}`}
                  placeholder="Title"
                  value={step.title}
                  onChange={(event) =>
                    onEdit(step.key, {
                      title: event.target.value,
                      notes: step.notes,
                    })
                  }
                />
                <textarea
                  aria-label={`Notes for step ${index + 1}`}
                  placeholder="Notes"
                  rows={2}
                  value={step.notes}
                  onChange={(event) =>
                    onEdit(step.key, {
                      title: step.title,
                      notes: event.target.value,
                    })
                  }
                />
              </div>
              <div className="nv-deck-actions">
                <button
                  aria-label={`Move step ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => onMove(index, -1)}
                  type="button"
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  aria-label={`Move step ${index + 1} down`}
                  disabled={index === steps.length - 1}
                  onClick={() => onMove(index, 1)}
                  type="button"
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  aria-label={`Delete step ${index + 1}`}
                  onClick={() => onRemove(step.key)}
                  type="button"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="nv-deck-buttons">
        <button
          className="nv-layer-load-button"
          disabled={!canAdd}
          onClick={onAdd}
          title="Save what's on screen as a step after the shown one"
          type="button"
        >
          <Plus size={14} />
          <span>Add view</span>
        </button>
        <button
          className="nv-layer-load-button"
          disabled={steps.length === 0}
          onClick={onPresent}
          type="button"
        >
          <Play size={14} />
          <span>Present</span>
        </button>
      </div>
    </section>
  )
}

/** Present mode's bar: previous, where we are, the notes, next, exit. */
export function PresentBar({
  steps,
  current,
  onShow,
  onExit,
}: {
  steps: readonly DeckStep[]
  current: number
  onShow: (index: number) => void
  onExit: () => void
}): JSX.Element {
  const step = steps[current]
  const go = (by: number) => {
    const next = current + by
    if (next >= 0 && next < steps.length) onShow(next)
  }
  const goRef = useRef(go)
  goRef.current = go
  const exitRef = useRef(onExit)
  exitRef.current = onExit
  useEffect(() => {
    // Capture, ahead of the stage's own keys (arrows move slices there).
    function onKeyDown(event: KeyboardEvent): void {
      if (isEditableTarget(event.target)) return
      const by = {
        ArrowRight: 1,
        PageDown: 1,
        ' ': 1,
        ArrowLeft: -1,
        PageUp: -1,
      }[event.key]
      if (by) goRef.current(by)
      else if (event.key === 'Escape') exitRef.current()
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
  return (
    <div className="nv-present-bar">
      <button
        aria-label="Previous step"
        disabled={current <= 0}
        onClick={() => go(-1)}
        type="button"
      >
        <ChevronLeft size={20} />
      </button>
      <div className="nv-present-text" aria-live="polite">
        <strong>
          {current + 1} / {steps.length}
          {step?.title ? ` · ${step.title}` : ''}
        </strong>
        {step?.notes ? <p>{step.notes}</p> : null}
      </div>
      <button
        aria-label="Next step"
        disabled={current >= steps.length - 1}
        onClick={() => go(1)}
        type="button"
      >
        <ChevronRight size={20} />
      </button>
      <button aria-label="Exit present mode" onClick={onExit} type="button">
        <X size={20} />
      </button>
    </div>
  )
}
