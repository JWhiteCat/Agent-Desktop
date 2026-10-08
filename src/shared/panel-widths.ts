/** Resizable side panels: the app sidebar, the changes panel, and the Grok Bot list. */
export type PanelId = 'sidebar' | 'changes' | 'grokbotList'
export type PanelWidths = Record<PanelId, number>

export interface PanelLimit {
  min: number
  max: number
  default: number
  /** CSS variable the layout reads the width from. */
  cssVar: string
  /** +1 when dragging right widens the panel (a left panel), -1 for a right panel. */
  dir: 1 | -1
}

export const PANEL_LIMITS: Record<PanelId, PanelLimit> = {
  sidebar: { min: 200, max: 480, default: 272, cssVar: '--sidebar-w', dir: 1 },
  changes: { min: 320, max: 1000, default: 460, cssVar: '--changes-w', dir: -1 },
  grokbotList: { min: 180, max: 400, default: 240, cssVar: '--grokbot-list-w', dir: 1 }
}

export const PANEL_IDS = Object.keys(PANEL_LIMITS) as PanelId[]

/** Narrowest the main content area (chat or Grok Bot conversation) may become while panels are open. */
export const MAIN_MIN_WIDTH = 320

/** Shrinks these first when the window is too narrow for every open panel. */
const SHRINK_ORDER: PanelId[] = ['changes', 'grokbotList', 'sidebar']

export function isPanelId(value: unknown): value is PanelId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PANEL_LIMITS, value)
}

export function defaultPanelWidths(): PanelWidths {
  return { sidebar: PANEL_LIMITS.sidebar.default, changes: PANEL_LIMITS.changes.default, grokbotList: PANEL_LIMITS.grokbotList.default }
}

/** A whole-pixel width within the panel's limits. Anything that is not a finite number gives the default. */
export function clampPanelWidth(id: PanelId, width: unknown): number {
  const limit = PANEL_LIMITS[id]
  const n = typeof width === 'number' ? width : typeof width === 'string' && width.trim() ? Number(width) : NaN
  if (!Number.isFinite(n)) return limit.default
  return Math.min(limit.max, Math.max(limit.min, Math.round(n)))
}

/** Saved widths from settings or storage, keeping only known panels with numeric widths. */
export function normalizePanelWidths(raw: unknown): Partial<PanelWidths> {
  const out: Partial<PanelWidths> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPanelId(key) || typeof value !== 'number' || !Number.isFinite(value)) continue
    out[key] = clampPanelWidth(key, value)
  }
  return out
}

/** Saved widths over the defaults. */
export function resolvePanelWidths(raw: unknown): PanelWidths {
  return { ...defaultPanelWidths(), ...normalizePanelWidths(raw) }
}

/**
 * Widths to show for the open panels in a window `viewport` pixels wide. Preferred widths shrink, down to each
 * panel's minimum, until the main area keeps MAIN_MIN_WIDTH; `keep` (the panel being resized) shrinks last.
 * Closed panels keep their preferred width. When even the minimums do not fit, the minimums are used.
 */
export function fitPanelWidths(prefs: PanelWidths, open: Iterable<PanelId>, viewport: number, keep?: PanelId): PanelWidths {
  const out = { ...prefs }
  for (const id of PANEL_IDS) out[id] = clampPanelWidth(id, out[id])
  const shown = new Set(open)
  if (!Number.isFinite(viewport) || viewport <= 0) return out
  let overflow = [...shown].reduce((sum, id) => sum + out[id], 0) + MAIN_MIN_WIDTH - viewport
  const order = SHRINK_ORDER.filter((id) => id !== keep).concat(keep && SHRINK_ORDER.includes(keep) ? [keep] : [])
  for (const id of order) {
    if (overflow <= 0) break
    if (!shown.has(id)) continue
    const cut = Math.min(overflow, out[id] - PANEL_LIMITS[id].min)
    if (cut <= 0) continue
    out[id] -= cut
    overflow -= cut
  }
  return out
}

/** The widest `id` may be dragged to without shrinking the other open panels below their shown widths. */
export function panelDragMax(id: PanelId, shownWidths: PanelWidths, open: Iterable<PanelId>, viewport: number): number {
  const limit = PANEL_LIMITS[id]
  if (!Number.isFinite(viewport) || viewport <= 0) return limit.max
  let others = 0
  for (const other of new Set(open)) if (other !== id) others += shownWidths[other]
  return Math.max(limit.min, Math.min(limit.max, Math.floor(viewport - MAIN_MIN_WIDTH - others)))
}
