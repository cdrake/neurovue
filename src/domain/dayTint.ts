// The chrome's accent glow follows the local time of day (night indigo, dawn
// rose, daytime amber, golden hour, dusk violet). Only the app background and
// bars use it; the viewer keeps neutral colors so image data reads true.

type Rgb = readonly [number, number, number]

// [hour, color], ascending; wraps from the last key back to the first.
const KEYS: readonly (readonly [number, Rgb])[] = [
  [2, [92, 108, 224]], // night
  [6, [222, 124, 148]], // dawn
  [9, [215, 166, 66]], // day (the house amber)
  [16, [215, 166, 66]],
  [18.5, [236, 128, 60]], // golden hour
  [20.5, [172, 104, 214]], // dusk
]

/** The tint for a local hour in [0, 24), as "r g b" for rgb(var(--day-tint) / a). */
export function dayTint(hour: number): string {
  const next = Math.max(
    0,
    KEYS.findIndex(([h]) => h > hour),
  )
  const [h1, c1] = KEYS[next] as (typeof KEYS)[number]
  const [h0, c0] = KEYS[
    (next + KEYS.length - 1) % KEYS.length
  ] as (typeof KEYS)[number]
  const span = (h1 - h0 + 24) % 24 || 24
  const t = ((hour - h0 + 24) % 24) / span
  return c0.map((v, k) => Math.round(v + ((c1[k] as number) - v) * t)).join(' ')
}

/** Daylight in [0, 1]: 0 from 19:30 to 05:30, peaking at 12:30. */
export function dayLight(hour: number): number {
  return (
    Math.round(Math.max(0, Math.sin((Math.PI * (hour - 5.5)) / 14)) * 100) / 100
  )
}

/** Sets --day-tint and --day-light now and every 5 minutes (steps that small are not visible). */
export function startDayTint(
  root: HTMLElement = document.documentElement,
): void {
  const moreContrast = matchMedia('(prefers-contrast: more)')
  const update = () => {
    const now = new Date()
    const hour = now.getHours() + now.getMinutes() / 60
    // Increase Contrast keeps the dark night base without the glow.
    const plain = moreContrast.matches
    root.style.setProperty('--day-tint', plain ? '0 0 0' : dayTint(hour))
    root.style.setProperty('--day-light', plain ? '0' : String(dayLight(hour)))
  }
  update()
  moreContrast.addEventListener('change', update)
  setInterval(update, 5 * 60_000)
}
