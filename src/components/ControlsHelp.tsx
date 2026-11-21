import { Mouse, X } from 'lucide-react'
import { type JSX, useEffect, useRef } from 'react'
import { COARSE_POINTER } from '../domain/stageControls'
import { EXPRESS_VIEW_SHORTCUT } from '../hooks/useNativeMenu'

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform)

/** A menu accelerator as the platform writes it (⇧⌘O or Ctrl+Shift+O). */
function accel(key: string, shift = false, alt = false): string {
  return IS_MAC
    ? `${alt ? '⌥' : ''}${shift ? '⇧' : ''}⌘${key}`
    : `Ctrl+${shift ? 'Shift+' : ''}${alt ? 'Alt+' : ''}${key}`
}

type Row = readonly [keys: string, action: string]

type Section = { title: string; note?: string; rows: Row[] }

const TOUCH: Section = {
  title: 'Touch',
  rows: [
    ['Drag (3D)', 'Rotate'],
    ['Pinch', 'Zoom'],
    ['Tap or drag (2D)', 'Move the crosshair'],
    ['Slice slider', 'Next or previous slice'],
    ['Plane chips + slider', 'Pick and move a clip plane'],
    ['Apple Pencil', 'Draws while Draw is on; a finger moves the crosshair'],
  ],
}

const MOUSE_AND_KEYS: readonly Section[] = [
  {
    title: '3D view',
    rows: [
      ['Wheel', 'Zoom, or move the active clip plane'],
      ['Drag', 'Rotate'],
      ['C', 'Next clip plane (the wheel moves it)'],
      ['1  3  7', 'Coronal, sagittal, axial view'],
      ['Ctrl+1  3  7', 'The opposite side'],
    ],
  },
  {
    title: '2D views',
    rows: [
      ['Wheel', 'Next or previous slice'],
      ['Click or drag', 'Move the crosshair'],
      ['Right-drag', 'Adjust contrast (window/level)'],
      ['H  L', 'Crosshair left, right'],
      ['J  K', 'Crosshair posterior, anterior'],
      ['Ctrl+U  Ctrl+D', 'Crosshair up, down'],
    ],
  },
  {
    title: 'Everywhere',
    rows: [
      ['Wheel on the dataset desktop', 'Zoom the thumbnails'],
      ['Box, then right-click twice', 'Cut out the box between the clicks'],
      ['Esc', 'Leave full screen, measure, shapes or box'],
      ['?', 'This sheet'],
    ],
  },
  {
    title: 'Menu shortcuts',
    note: 'Desktop app',
    rows: [
      [accel('O'), 'Open file'],
      [accel('O', true), 'Open folder'],
      [accel('M', true), 'Open mesh'],
      [accel('O', false, true), 'Open bundle'],
      [accel('E'), 'Export bundle'],
      [EXPRESS_VIEW_SHORTCUT, 'Express or dataset view'],
      [accel('K', true), 'Clear all'],
    ],
  },
]

// A finger first; a hardware keyboard on an iPad still uses the rest.
const SECTIONS = COARSE_POINTER ? [TOUCH, ...MOUSE_AND_KEYS] : MOUSE_AND_KEYS

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)
}

/** `?` (outside text fields) toggles the controls sheet. */
export function useControlsHelpKey(toggle: () => void): void {
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== '?' || isEditableTarget(event.target)) return
      event.preventDefault()
      toggleRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

/** Every mouse, touch and keyboard control in one sheet. */
export function ControlsHelp({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])
  return (
    // Escape closes a modal dialog natively; a click on the backdrop lands on the dialog itself.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape already closes it.
    <dialog
      aria-labelledby="nv-controls-title"
      className="nv-controls-help"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      onClose={onClose}
      ref={ref}
    >
      <header>
        <h2 id="nv-controls-title">
          <Mouse size={16} aria-hidden="true" />{' '}
          {COARSE_POINTER ? 'Controls' : 'Mouse & keyboard'}
        </h2>
        <button
          aria-label="Close"
          className="nv-icon-button"
          onClick={onClose}
          type="button"
        >
          <X size={16} />
        </button>
      </header>
      <p className="nv-controls-hint">
        Viewer keys work while the pointer is over the viewer.
      </p>
      {SECTIONS.map((section) => (
        <section key={section.title}>
          <h3>
            {section.title}
            {section.note ? <small>{section.note}</small> : null}
          </h3>
          <dl>
            {section.rows.map(([keys, action]) => (
              <div key={keys}>
                <dt>
                  <kbd>{keys}</kbd>
                </dt>
                <dd>{action}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </dialog>
  )
}

/** On the 3D view: what the wheel does there, and the way back to zoom. */
export function WheelBadge({
  planeLabel,
  onZoom,
}: {
  /** The clip plane the wheel moves, or undefined when it zooms. */
  planeLabel: string | undefined
  onZoom: () => void
}): JSX.Element {
  if (!planeLabel) {
    return (
      <span
        className="nv-wheel-badge"
        title="Scroll to zoom. Click a clip plane (or press C) to move it with the wheel instead."
      >
        <Mouse size={13} aria-hidden="true" /> Zoom
      </span>
    )
  }
  return (
    <button
      className="nv-wheel-badge is-plane"
      onClick={onZoom}
      title={`The wheel moves the ${planeLabel} clip plane. Click to zoom with it again.`}
      type="button"
    >
      <Mouse size={13} aria-hidden="true" /> {planeLabel} plane
      <X size={12} aria-hidden="true" />
    </button>
  )
}
