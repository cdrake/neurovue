import {
  type CSSProperties,
  type Dispatch,
  type JSX,
  type MutableRefObject,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import type { DesktopItem, DesktopManifest, WorldRect } from '../domain/desktop'
import { isDerivedItem, volumeDisplayLabel } from '../domain/volumeFacets'
import {
  DESKTOP_PREVIEW_TIERS,
  PREVIEW_TIER_SETTLE_MS,
  previewImageForSize,
  previewLevelForSize,
  SIDEBAR_PREVIEW_SIZE,
  StablePreviewImage,
} from './StablePreviewImage'

export const MIN_DESKTOP_ZOOM = 0.5
export const MAX_DESKTOP_ZOOM = 4

// Browse-grid sizing at zoom 100%: fit as many columns as keep tiles at least
// MIN_GRID_TILE_PX wide (up to MAX_GRID_COLUMNS), then let the rest scroll
// vertically. Shrinking every tile until the whole dataset fits turned large
// datasets into unreadable dots.
const GRID_STAGE_PADDING_PX = 44
const MIN_GRID_TILE_PX = 56
const MAX_GRID_TILE_PX = 240
const MAX_GRID_COLUMNS = 8
// Fit the whole dataset in the pane only while tiles stay at least this wide
// (the width labels need); below it, scrolling readable tiles beats a wall of dots.
const FIT_ALL_MIN_TILE_PX = 112
// Filter transitions: slide/fade tiles so users keep their bearings.
const TILE_TRANSITION_MS = 250
const TILE_TRANSITION_MAX_TILES = 200
// Rendered room above the first row for the section label chip.
const GRID_SECTION_LABEL_PX = 52

interface DesktopDragState {
  pointerId: number
  startX: number
  startY: number
  scrollLeft: number
  scrollTop: number
  moved: boolean
}

interface MinimapViewport {
  left: number
  top: number
  width: number
  height: number
}

export function DatasetDesktop({
  manifest,
  datasetName,
  items,
  selected,
  zoom,
  onZoom,
  onSelect,
}: {
  manifest: DesktopManifest | null
  /** Plain dataset name for the pane title (BIDS name or folder name). */
  datasetName?: string
  items: DesktopItem[]
  selected: DesktopItem | null
  zoom: number
  onZoom: (zoom: number) => void
  onSelect: (item: DesktopItem) => void
}): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const minimapRef = useRef<HTMLButtonElement | null>(null)
  const zoomRef = useRef(zoom)
  const worldRef = useRef<HTMLDivElement | null>(null)
  // Last user scroll; read in the layout effect, scrollTop is already clamped to the new world.
  const scrolledRef = useRef({ x: 0, y: 0 })
  // Tile rects (px, relative to the world) from the last committed layout.
  const lastLayoutRef = useRef<{
    key: string
    rects: Map<string, PxRect>
  } | null>(null)
  const dragRef = useRef<DesktopDragState | null>(null)
  const suppressClickRef = useRef(false)
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const [viewport, setViewport] = useState<MinimapViewport>({
    left: 0,
    top: 0,
    width: 100,
    height: 100,
  })
  const world = manifest?.world ?? {
    width: 1,
    height: 1,
    units: 'desktop-px',
    columns: 0,
    rows: 0,
  }
  const tileSize = manifest?.tileSize ?? 1024
  const gap = manifest?.gap ?? 96
  const gridFit = useMemo(
    () =>
      desktopGridFit(stageSize.width, stageSize.height, items, tileSize, gap),
    [gap, items, stageSize.height, stageSize.width, tileSize],
  )
  const desktopLayout = useMemo(
    () => normalizeDesktopLayout(items, world, tileSize, gap, gridFit),
    [gap, gridFit, items, tileSize, world],
  )
  const layoutItems = desktopLayout.items
  const layoutWorld = desktopLayout.world
  const selectedLayoutItem = selected
    ? (layoutItems.find((item) => item.id === selected.id) ?? selected)
    : null
  const selectedStyle = selectedLayoutItem
    ? worldRectStyle(selectedLayoutItem.bounds, layoutWorld)
    : undefined
  const targetPreviewSize = useMemo(
    () => desktopPreviewSize(layoutWorld, tileSize, gridFit.tilePx, zoom),
    [gridFit.tilePx, layoutWorld, tileSize, zoom],
  )
  const [previewSize, setPreviewSize] = useState<number>(SIDEBAR_PREVIEW_SIZE)
  const previewLevel = previewLevelForSize(previewSize, layoutItems[0])
  const hasLayoutItems = layoutItems.length > 0
  const worldSize = useMemo<CSSProperties>(
    () =>
      hasLayoutItems
        ? fittedWorldSize(layoutWorld, tileSize, gridFit.tilePx, zoom)
        : // Nothing to lay out: keep a visible box for the empty-state text.
          {
            width: `${Math.max(stageSize.width - GRID_STAGE_PADDING_PX, 180)}px`,
            height: '160px',
          },
    [
      gridFit.tilePx,
      hasLayoutItems,
      layoutWorld,
      stageSize.width,
      tileSize,
      zoom,
    ],
  )
  const minimapMapStyle = useMemo(
    () => minimapMapBox(layoutWorld),
    [layoutWorld],
  )
  const sections = useMemo(
    () => desktopSections(layoutItems, layoutWorld),
    [layoutItems, layoutWorld],
  )
  const derivedSourceId =
    selectedLayoutItem && isDerivedItem(selectedLayoutItem)
      ? selectedLayoutItem.derivedFrom
      : null
  const derivedSource = derivedSourceId
    ? (layoutItems.find((item) => item.id === derivedSourceId) ?? null)
    : null
  const sourceStyle = derivedSource
    ? worldRectStyle(derivedSource.bounds, layoutWorld)
    : undefined
  // Nothing to navigate when one tile or the whole grid fits; it would only cover tiles.
  const showMinimap =
    items.length > 1 &&
    (Number.parseFloat(String(worldSize.width)) >
      stageSize.width - GRID_STAGE_PADDING_PX ||
      Number.parseFloat(String(worldSize.height)) >
        stageSize.height - GRID_STAGE_PADDING_PX)
  const isOverview =
    renderedDesktopTileSize(worldSize, layoutWorld, tileSize) <
    FIT_ALL_MIN_TILE_PX

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  // A new shown set (open or filter; App resets zoom in the same commit) starts
  // at the top and animates from the previous layout.
  const shownKey = useMemo(
    () => items.map((item) => item.id).join('\n'),
    [items],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: worldSize is a trigger; rects are re-measured whenever the rendered world changes.
  useLayoutEffect(() => {
    const worldElement = worldRef.current
    const stage = stageRef.current
    if (!worldElement || !stage) return
    const rects = new Map(
      layoutItems.map((item) => [
        item.id,
        pxRect(
          item.bounds,
          layoutWorld,
          worldElement.clientWidth,
          worldElement.clientHeight,
        ),
      ]),
    )
    const last = lastLayoutRef.current
    lastLayoutRef.current = { key: shownKey, rects }
    if (!last || last.key === shownKey) return
    const scrolled = scrolledRef.current
    stage.scrollTo(0, 0)
    animateDesktopTiles(
      worldElement,
      last.rects,
      rects,
      scrolled,
      stage.clientWidth,
      stage.clientHeight,
    )
  }, [layoutItems, layoutWorld, shownKey, worldSize])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setPreviewSize(targetPreviewSize)
    }, PREVIEW_TIER_SETTLE_MS)

    return () => window.clearTimeout(timeout)
  }, [targetPreviewSize])

  // biome-ignore lint/correctness/useExhaustiveDependencies: showMinimap mounts/unmounts the minimap, so its wheel listener must be re-attached.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const stageElement = stage
    const minimap = minimapRef.current

    function onWheel(event: WheelEvent): void {
      zoomRef.current = zoomDesktopWithWheel(
        event,
        stageElement,
        zoomRef.current,
        onZoom,
      )
    }

    stageElement.addEventListener('wheel', onWheel, { passive: false })
    minimap?.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      stageElement.removeEventListener('wheel', onWheel)
      minimap?.removeEventListener('wheel', onWheel)
    }
  }, [onZoom, showMinimap])

  // biome-ignore lint/correctness/useExhaustiveDependencies: these are triggers; the visible viewport is re-measured from the DOM after any layout, size or zoom change.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      updateDesktopViewport(stageRef.current, setViewport)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [layoutItems.length, stageSize.height, stageSize.width, worldSize, zoom])

  function handleStageKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const stage = stageRef.current
    if (!stage) return
    const panStep = 80
    switch (event.key) {
      case 'ArrowLeft':
        stage.scrollLeft -= panStep
        break
      case 'ArrowRight':
        stage.scrollLeft += panStep
        break
      case 'ArrowUp':
        stage.scrollTop -= panStep
        break
      case 'ArrowDown':
        stage.scrollTop += panStep
        break
      case '+':
      case '=':
        onZoom(zoomBy(zoomRef.current, 1.25))
        break
      case '-':
      case '_':
        onZoom(zoomBy(zoomRef.current, 0.8))
        break
      case '0':
        onZoom(1)
        break
      default:
        return
    }
    event.preventDefault()
  }

  return (
    <div className={`nv-osd-stage ${isOverview ? 'is-overview' : ''}`}>
      {/* biome-ignore lint/a11y/useSemanticElements: a scrollable, keyboard-pannable surface; <fieldset> doesn't fit a scroll container. */}
      <div
        aria-label="Dataset grid. Arrow keys pan; plus and minus zoom; 0 resets zoom."
        className={`nv-osd-scrollport ${isPanning ? 'is-panning' : ''}`}
        onClickCapture={(event) =>
          suppressDesktopClickAfterDrag(event, suppressClickRef)
        }
        onKeyDown={handleStageKeyDown}
        onPointerDown={(event) =>
          beginDesktopPan(event, dragRef, suppressClickRef, setIsPanning)
        }
        onScroll={(event) => {
          scrolledRef.current = {
            x: event.currentTarget.scrollLeft,
            y: event.currentTarget.scrollTop,
          }
          updateDesktopViewport(stageRef.current, setViewport)
        }}
        ref={stageRef}
        role="group"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the grid pans with arrow keys, so it must be focusable.
        tabIndex={0}
      >
        <StageResizeObserver stageRef={stageRef} onResize={setStageSize} />
        <div className="nv-osd-world" ref={worldRef} style={worldSize}>
          {sections.map((section) => (
            <div
              aria-hidden="true"
              className={`nv-osd-section nv-osd-section-${section.id}`}
              key={section.id}
              style={worldRectStyle(section.bounds, layoutWorld)}
            />
          ))}
          {layoutItems.map((item) => (
            <button
              className={desktopTileClassName(item, selected, derivedSourceId)}
              data-volume-id={item.id}
              key={item.id}
              onClick={() => onSelect(item)}
              style={worldRectStyle(item.bounds, layoutWorld)}
              title={item.label}
              type="button"
            >
              <StablePreviewImage
                src={previewImageForSize(item, previewSize)}
                frameClassName="nv-osd-image-frame"
                draggable={false}
              />
              {isDerivedItem(item) ? (
                <span className="nv-osd-index">Derived</span>
              ) : null}
              <span className="nv-osd-label">{volumeDisplayLabel(item)}</span>
            </button>
          ))}
          {sections.map((section) => (
            <div
              aria-hidden="true"
              className={`nv-osd-section-label nv-osd-section-label-${section.id}`}
              key={`${section.id}-label`}
              style={worldRectStyle(section.bounds, layoutWorld)}
            >
              <span>{section.label}</span>
              <em>{section.count}</em>
            </div>
          ))}
          {layoutItems.length === 0 ? (
            <div className="nv-empty-state">No matching volumes.</div>
          ) : null}
        </div>
      </div>

      <div className="nv-stage-title nv-osd-title" aria-hidden="true">
        <span>Browse</span>
        <strong>{datasetName || 'Dataset'}</strong>
        <em>{`${Math.round(zoom * 100)}%`}</em>
      </div>

      <footer className="nv-osd-footer" aria-hidden="true">
        {/* Preview tier and grid size are diagnostics: tooltip only. */}
        <div
          className="nv-hud"
          title={`Preview level L${previewLevel} · ${previewSize} px thumbnails · grid ${layoutWorld.width} x ${layoutWorld.height}`}
        >
          <span>zoom {Math.round(zoom * 100)}%</span>
          <span>{layoutItems.length} shown</span>
        </div>
        {derivedSource ? (
          <div className="nv-osd-source-key">
            <span className="nv-osd-source-swatch" />
            <strong>Original</strong>
            <span>{derivedSource.label}</span>
          </div>
        ) : null}
      </footer>

      {showMinimap ? (
        <button
          aria-label="Jump to this part of the grid"
          className="nv-minimap"
          onClick={(event) =>
            jumpDesktopToMinimapPoint(event, stageRef, setViewport)
          }
          onPointerDown={(event) => event.stopPropagation()}
          ref={minimapRef}
          title="Jump to this part of the grid"
          type="button"
        >
          <span
            className="nv-minimap-map"
            aria-hidden="true"
            style={minimapMapStyle}
          >
            {sourceStyle ? (
              <span className="nv-minimap-source" style={sourceStyle} />
            ) : null}
            {selectedStyle ? (
              <span className="nv-minimap-selection" style={selectedStyle} />
            ) : null}
            <span
              className="nv-minimap-window"
              style={minimapViewportStyle(viewport)}
            />
          </span>
        </button>
      ) : null}
    </div>
  )
}

export function zoomBy(zoom: number, factor: number): number {
  return clamp(
    Number((zoom * factor).toFixed(2)),
    MIN_DESKTOP_ZOOM,
    MAX_DESKTOP_ZOOM,
  )
}

function desktopTileClassName(
  item: DesktopItem,
  selected: DesktopItem | null,
  derivedSourceId: string | null | undefined,
): string {
  return [
    'nv-osd-tile',
    selected?.id === item.id ? 'is-selected' : '',
    isDerivedItem(item) ? 'is-derived' : '',
    derivedSourceId === item.id ? 'is-derived-source' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

function StageResizeObserver({
  stageRef,
  onResize,
}: {
  stageRef: RefObject<HTMLDivElement | null>
  onResize: (size: { width: number; height: number }) => void
}): null {
  const lastSizeRef = useRef({ width: 0, height: 0 })

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const stageElement = stage

    function update(): void {
      const nextSize = {
        width: stageElement.clientWidth,
        height: stageElement.clientHeight,
      }
      const lastSize = lastSizeRef.current
      if (
        lastSize.width === nextSize.width &&
        lastSize.height === nextSize.height
      )
        return
      lastSizeRef.current = nextSize
      onResize(nextSize)
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(stageElement)
    return () => observer.disconnect()
  }, [onResize, stageRef])

  return null
}

function beginDesktopPan(
  event: ReactPointerEvent<HTMLDivElement>,
  dragRef: MutableRefObject<DesktopDragState | null>,
  suppressClickRef: MutableRefObject<boolean>,
  setIsPanning: (isPanning: boolean) => void,
): void {
  if (event.button !== 0) return
  const stage = event.currentTarget
  const pointerId = event.pointerId

  dragRef.current = {
    pointerId,
    startX: event.clientX,
    startY: event.clientY,
    scrollLeft: stage.scrollLeft,
    scrollTop: stage.scrollTop,
    moved: false,
  }

  function onMove(moveEvent: PointerEvent): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== pointerId) return

    const deltaX = moveEvent.clientX - drag.startX
    const deltaY = moveEvent.clientY - drag.startY
    const hasMoved = Math.hypot(deltaX, deltaY) > 3
    if (!hasMoved && !drag.moved) return

    moveEvent.preventDefault()
    stage.scrollLeft = drag.scrollLeft - deltaX
    stage.scrollTop = drag.scrollTop - deltaY
    if (!drag.moved) {
      drag.moved = true
      setIsPanning(true)
    }
  }

  function onEnd(): void {
    const drag = dragRef.current
    if (drag?.pointerId === pointerId) {
      suppressClickRef.current = drag.moved
      dragRef.current = null
      setIsPanning(false)
    }

    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onEnd)
    window.removeEventListener('pointercancel', onEnd)
  }

  window.addEventListener('pointermove', onMove, { passive: false })
  window.addEventListener('pointerup', onEnd)
  window.addEventListener('pointercancel', onEnd)
}

function suppressDesktopClickAfterDrag(
  event: ReactMouseEvent<HTMLDivElement>,
  suppressClickRef: MutableRefObject<boolean>,
): void {
  if (!suppressClickRef.current) return
  suppressClickRef.current = false
  event.preventDefault()
  event.stopPropagation()
}

function zoomDesktopWithWheel(
  event: WheelEvent,
  stage: HTMLDivElement,
  zoom: number,
  onZoom: (zoom: number) => void,
): number {
  event.preventDefault()
  const nextZoom = zoomBy(zoom, event.deltaY < 0 ? 1.12 : 0.89)
  if (nextZoom === zoom) return zoom

  const rect = stage.getBoundingClientRect()
  const viewportX = event.clientX - rect.left
  const viewportY = event.clientY - rect.top
  const anchorX = stage.scrollLeft + viewportX
  const anchorY = stage.scrollTop + viewportY
  const ratio = nextZoom / zoom

  flushSync(() => {
    onZoom(nextZoom)
  })
  stage.scrollLeft = anchorX * ratio - viewportX
  stage.scrollTop = anchorY * ratio - viewportY

  return nextZoom
}

function jumpDesktopToMinimapPoint(
  event: ReactMouseEvent<HTMLElement>,
  stageRef: RefObject<HTMLDivElement | null>,
  setViewport: Dispatch<SetStateAction<MinimapViewport>>,
): void {
  const stage = stageRef.current
  if (!stage) return

  event.preventDefault()
  event.stopPropagation()

  const minimap = event.currentTarget
  const map = minimap.querySelector<HTMLElement>('.nv-minimap-map')
  const rect = (map ?? minimap).getBoundingClientRect()
  const x = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1)
  const y = clamp((event.clientY - rect.top) / Math.max(rect.height, 1), 0, 1)

  centerDesktopAtFraction(stage, x, y)
  updateDesktopViewport(stage, setViewport)
}

function centerDesktopAtFraction(
  stage: HTMLDivElement,
  x: number,
  y: number,
): void {
  const maxScrollLeft = Math.max(stage.scrollWidth - stage.clientWidth, 0)
  const maxScrollTop = Math.max(stage.scrollHeight - stage.clientHeight, 0)

  stage.scrollLeft = clamp(
    x * stage.scrollWidth - stage.clientWidth / 2,
    0,
    maxScrollLeft,
  )
  stage.scrollTop = clamp(
    y * stage.scrollHeight - stage.clientHeight / 2,
    0,
    maxScrollTop,
  )
}

function updateDesktopViewport(
  stage: HTMLDivElement | null,
  setViewport: Dispatch<SetStateAction<MinimapViewport>>,
): void {
  if (!stage) return
  const next = desktopViewportFromStage(stage)
  setViewport((current) =>
    sameMinimapViewport(current, next) ? current : next,
  )
}

function desktopViewportFromStage(stage: HTMLDivElement): MinimapViewport {
  const scrollWidth = Math.max(stage.scrollWidth, stage.clientWidth, 1)
  const scrollHeight = Math.max(stage.scrollHeight, stage.clientHeight, 1)
  const width = clamp((stage.clientWidth / scrollWidth) * 100, 0, 100)
  const height = clamp((stage.clientHeight / scrollHeight) * 100, 0, 100)

  return {
    left: clamp((stage.scrollLeft / scrollWidth) * 100, 0, 100 - width),
    top: clamp((stage.scrollTop / scrollHeight) * 100, 0, 100 - height),
    width,
    height,
  }
}

function sameMinimapViewport(
  left: MinimapViewport,
  right: MinimapViewport,
): boolean {
  return (
    Math.abs(left.left - right.left) < 0.1 &&
    Math.abs(left.top - right.top) < 0.1 &&
    Math.abs(left.width - right.width) < 0.1 &&
    Math.abs(left.height - right.height) < 0.1
  )
}

function minimapViewportStyle(viewport: MinimapViewport): CSSProperties {
  return {
    left: `${viewport.left}%`,
    top: `${viewport.top}%`,
    width: `${viewport.width}%`,
    height: `${viewport.height}%`,
  }
}

function normalizeDesktopLayout(
  items: DesktopItem[],
  world: DesktopManifest['world'],
  tileSize: number,
  gap: number,
  gridFit: DesktopGridFit,
): { items: DesktopItem[]; world: DesktopManifest['world'] } {
  if (items.length === 0) return { items, world }
  const sources = items.filter((item) => !isDerivedItem(item))
  const derivatives = items.filter((item) => isDerivedItem(item))
  const columns = gridFit.columns
  const sourceRows = layoutRows(sources.length, columns)
  const derivedRows = layoutRows(derivatives.length, columns)
  const pitch = tileSize + gap
  const sourceHeight = layoutGridHeight(sourceRows, tileSize, gap)
  const derivedHeight = layoutGridHeight(derivedRows, tileSize, gap)
  // Headroom for the fixed-size section-label chip, converted from rendered
  // pixels to world units at the zoom-100% tile scale.
  const sectionLabelSpace = Math.round(
    (GRID_SECTION_LABEL_PX * tileSize) / Math.max(gridFit.tilePx, 1),
  )
  const sectionGap = Math.max(Math.round(tileSize / 2), gap)
  const sourceTop = sectionLabelSpace
  const derivedTop =
    derivatives.length > 0
      ? sourceTop + sourceHeight + sectionGap + sectionLabelSpace
      : 0
  const nextBounds = new Map<string, WorldRect>()

  function placeGroup(group: DesktopItem[], top: number): void {
    group.forEach((item, index) => {
      const col = index % columns
      const row = Math.floor(index / columns)
      nextBounds.set(item.id, {
        x: col * pitch,
        y: top + row * pitch,
        width: tileSize,
        height: tileSize,
      })
    })
  }

  placeGroup(sources, sourceTop)
  placeGroup(derivatives, derivedTop)

  const width = columns * tileSize + Math.max(columns - 1, 0) * gap
  const height = Math.max(
    derivatives.length > 0
      ? derivedTop + derivedHeight
      : sourceTop + sourceHeight,
    tileSize,
  )

  return {
    items: items.map((item) => ({
      ...item,
      bounds: nextBounds.get(item.id) ?? item.bounds,
    })),
    world: {
      ...world,
      width,
      height,
      columns,
      rows: sourceRows + derivedRows,
    },
  }
}

interface DesktopGridFit {
  columns: number
  // Rendered tile width in CSS px at zoom 100%.
  tilePx: number
}

export function desktopGridFit(
  stageWidth: number,
  stageHeight: number,
  items: DesktopItem[],
  tileSize: number,
  gap: number,
): DesktopGridFit {
  const available = Math.max(stageWidth - GRID_STAGE_PADDING_PX, 180)
  const availableHeight = Math.max(stageHeight - GRID_STAGE_PADDING_PX, 120)
  const gapRatio = gap / Math.max(tileSize, 1)
  let sources = 0
  for (const item of items) if (!isDerivedItem(item)) sources += 1
  const derived = items.length - sources
  const layoutCount = Math.max(sources, derived, 1)

  // First choice: the column count giving the largest tile at which the whole
  // grid (rows, gaps, section labels) fits the pane on both axes.
  const labelHeight = GRID_SECTION_LABEL_PX * (derived > 0 ? 2 : 1)
  let best: DesktopGridFit | null = null
  for (
    let columns = 1;
    columns <= Math.min(MAX_GRID_COLUMNS, layoutCount);
    columns++
  ) {
    const tilePx = Math.min(
      MAX_GRID_TILE_PX,
      available / (columns + (columns - 1) * gapRatio),
      (availableHeight - labelHeight) /
        gridHeightInTiles(sources, derived, columns, gapRatio),
    )
    if (!best || tilePx > best.tilePx) best = { columns, tilePx }
  }
  if (best && best.tilePx >= FIT_ALL_MIN_TILE_PX) return best

  // Too many to fit readably: fill the width and scroll vertically, but never
  // let one tile be taller than the pane.
  const fitColumns = clamp(
    Math.floor(
      (available + MIN_GRID_TILE_PX * gapRatio) /
        (MIN_GRID_TILE_PX * (1 + gapRatio)),
    ),
    1,
    MAX_GRID_COLUMNS,
  )
  const columns = Math.min(fitColumns, layoutCount)
  const tilePx = Math.min(
    MAX_GRID_TILE_PX,
    available / (columns + Math.max(columns - 1, 0) * gapRatio),
    Math.max(availableHeight - GRID_SECTION_LABEL_PX, MIN_GRID_TILE_PX),
  )
  return { columns, tilePx }
}

// Rendered grid height in tile widths, mirroring normalizeDesktopLayout.
function gridHeightInTiles(
  sources: number,
  derived: number,
  columns: number,
  gapRatio: number,
): number {
  const rowsHeight = (rows: number) => rows + Math.max(rows - 1, 0) * gapRatio
  const sourceRows = layoutRows(sources, columns)
  if (derived === 0) return Math.max(rowsHeight(sourceRows), 1)
  return (
    rowsHeight(sourceRows) +
    Math.max(0.5, gapRatio) +
    rowsHeight(layoutRows(derived, columns))
  )
}

function layoutRows(count: number, columns: number): number {
  return count === 0 ? 0 : Math.ceil(count / Math.max(columns, 1))
}

function layoutGridHeight(rows: number, tileSize: number, gap: number): number {
  return rows === 0 ? 0 : rows * tileSize + Math.max(rows - 1, 0) * gap
}

function desktopSections(
  items: DesktopItem[],
  world: DesktopManifest['world'],
): Array<{
  id: 'sources' | 'derived'
  label: string
  count: number
  bounds: WorldRect
}> {
  return [
    desktopSectionForRole(
      items.filter((item) => !isDerivedItem(item)),
      world,
      'sources',
      'Source volumes',
    ),
    desktopSectionForRole(
      items.filter((item) => isDerivedItem(item)),
      world,
      'derived',
      'Working derivatives',
    ),
  ].filter(
    (
      section,
    ): section is {
      id: 'sources' | 'derived'
      label: string
      count: number
      bounds: WorldRect
    } => Boolean(section),
  )
}

function desktopSectionForRole(
  items: DesktopItem[],
  world: DesktopManifest['world'],
  id: 'sources' | 'derived',
  label: string,
): {
  id: 'sources' | 'derived'
  label: string
  count: number
  bounds: WorldRect
} | null {
  if (items.length === 0) return null
  const minY = Math.min(...items.map((item) => item.bounds.y))
  const maxY = Math.max(
    ...items.map((item) => item.bounds.y + item.bounds.height),
  )
  const headerSpace = (items[0]?.bounds.height ?? 1024) * 2
  const topPadding = Math.min(headerSpace, minY)
  const bottomPadding = 56

  return {
    id,
    label,
    count: items.length,
    bounds: {
      x: 0,
      y: Math.max(0, minY - topPadding),
      width: Math.max(world.width, 1),
      height: Math.max(maxY - minY + topPadding + bottomPadding, 1),
    },
  }
}

interface PxRect {
  x: number
  y: number
  width: number
}

function pxRect(
  rect: WorldRect,
  world: DesktopManifest['world'],
  worldWidthPx: number,
  worldHeightPx: number,
): PxRect {
  return {
    x: (rect.x / Math.max(world.width, 1)) * worldWidthPx,
    y: (rect.y / Math.max(world.height, 1)) * worldHeightPx,
    width: (rect.width / Math.max(world.width, 1)) * worldWidthPx,
  }
}

// FLIP: kept tiles slide/scale from their old spot, new ones fade in. Only tiles
// in the (just reset) viewport animate, capped so big datasets stay snappy.
function animateDesktopTiles(
  worldElement: HTMLElement,
  from: Map<string, PxRect>,
  to: Map<string, PxRect>,
  // Old rects were on screen at this scroll offset, since reset to 0.
  scrolled: { x: number; y: number },
  viewWidth: number,
  viewHeight: number,
): void {
  if (
    typeof worldElement.animate !== 'function' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
    return
  let budget = TILE_TRANSITION_MAX_TILES
  for (const tile of worldElement.querySelectorAll<HTMLElement>(
    '[data-volume-id]',
  )) {
    const id = tile.dataset.volumeId ?? ''
    const next = to.get(id)
    if (!next || next.x > viewWidth || next.y > viewHeight) continue
    if (budget-- <= 0) break
    const prev = from.get(id)
    const timing = {
      duration: TILE_TRANSITION_MS,
      easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
    }
    if (!prev) {
      tile.animate([{ opacity: 0 }, { opacity: 1 }], timing)
      continue
    }
    const scale = prev.width / Math.max(next.width, 1)
    tile.animate(
      [
        {
          transformOrigin: '0 0',
          transform: `translate(${prev.x - scrolled.x - next.x}px, ${prev.y - scrolled.y - next.y}px) scale(${scale})`,
        },
        { transformOrigin: '0 0', transform: 'none' },
      ],
      timing,
    )
  }
}

function worldRectStyle(
  rect: WorldRect,
  world: DesktopManifest['world'],
): CSSProperties {
  const width = Math.max(world.width, 1)
  const height = Math.max(world.height, 1)

  return {
    left: `${(rect.x / width) * 100}%`,
    top: `${(rect.y / height) * 100}%`,
    width: `${(rect.width / width) * 100}%`,
    height: `${(rect.height / height) * 100}%`,
  }
}

function fittedWorldSize(
  world: DesktopManifest['world'],
  tileSize: number,
  tilePx: number,
  zoom: number,
): CSSProperties {
  const dimensions = fittedWorldDimensions(world, tileSize, tilePx, zoom)
  return {
    width: `${dimensions.width}px`,
    height: `${dimensions.height}px`,
  }
}

function renderedDesktopTileSize(
  worldSize: CSSProperties,
  world: DesktopManifest['world'],
  tileSize: number,
): number {
  const renderedWorldWidth = Number.parseFloat(String(worldSize.width ?? '0'))
  const renderedWorldHeight = Number.parseFloat(String(worldSize.height ?? '0'))
  const tileWidth = (renderedWorldWidth * tileSize) / Math.max(world.width, 1)
  const tileHeight =
    (renderedWorldHeight * tileSize) / Math.max(world.height, 1)

  return Math.min(tileWidth, tileHeight)
}

function fittedWorldDimensions(
  world: DesktopManifest['world'],
  tileSize: number,
  tilePx: number,
  zoom: number,
): { width: number; height: number } {
  const scale = (tilePx / Math.max(tileSize, 1)) * zoom
  return {
    width: Math.max(1, world.width) * scale,
    height: Math.max(1, world.height) * scale,
  }
}

function desktopPreviewSize(
  world: DesktopManifest['world'],
  tileSize: number,
  tilePx: number,
  zoom: number,
): number {
  const dimensions = fittedWorldDimensions(world, tileSize, tilePx, zoom)
  const renderedTileWidth =
    (dimensions.width * tileSize) / Math.max(world.width, 1)
  const renderedTileHeight =
    (dimensions.height * tileSize) / Math.max(world.height, 1)
  const density =
    typeof window === 'undefined'
      ? 1
      : Math.max(window.devicePixelRatio || 1, 1)
  const targetPixels = Math.max(renderedTileWidth, renderedTileHeight) * density

  return (
    DESKTOP_PREVIEW_TIERS.find((tier) => tier >= targetPixels) ??
    DESKTOP_PREVIEW_TIERS[DESKTOP_PREVIEW_TIERS.length - 1]
  )
}

// Inner area of the fixed 148x108 minimap button (10px inset on each side).
const MINIMAP_INNER_WIDTH = 128
const MINIMAP_INNER_HEIGHT = 88

// Size the minimap to the grid's aspect ratio (centred in the button) so the
// selection and viewport markers aren't squashed when the grid is much taller
// than wide.
function minimapMapBox(world: DesktopManifest['world']): CSSProperties {
  const aspect = Math.max(world.width, 1) / Math.max(world.height, 1)
  let width = MINIMAP_INNER_WIDTH
  let height = width / aspect
  if (height > MINIMAP_INNER_HEIGHT) {
    height = MINIMAP_INNER_HEIGHT
    width = Math.max(height * aspect, 8)
  }
  return {
    inset: 'auto',
    left: `${10 + (MINIMAP_INNER_WIDTH - width) / 2}px`,
    top: `${10 + (MINIMAP_INNER_HEIGHT - height) / 2}px`,
    width: `${width}px`,
    height: `${height}px`,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
