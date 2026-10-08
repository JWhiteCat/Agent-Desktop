import {
  PANEL_IDS,
  PANEL_LIMITS,
  clampPanelWidth,
  defaultPanelWidths,
  fitPanelWidths,
  normalizePanelWidths,
  panelDragMax,
  resolvePanelWidths,
  type PanelId,
  type PanelWidths
} from '@shared/panel-widths'

/** Browser storage for the remote web client, which keeps its own widths instead of the desktop's. */
export const PANEL_WIDTHS_KEY = 'agent-desktop:panelWidths'

export interface PanelLayoutEnv {
  viewport: () => number
  setVar: (name: string, value: string) => void
  save: (widths: PanelWidths) => void
}

/**
 * Preferred and shown widths of the resizable panels. Widths reach the layout as CSS variables, so dragging
 * does not re-render React; preferred widths are saved when a drag or key press ends.
 */
export class PanelLayout {
  private prefs = defaultPanelWidths()
  private shown = defaultPanelWidths()
  private readonly open = new Map<PanelId, number>()
  private readonly listeners = new Set<() => void>()
  private dragging = 0
  /** Resized since the last save. */
  private dirty = false

  constructor(private readonly env: PanelLayoutEnv) {}

  /** Saved widths. Ignored mid-drag or before an unsaved resize is saved, so an older settings echo cannot make the panel jump. */
  load(raw: unknown): void {
    if (this.dragging || this.dirty) return
    this.prefs = resolvePanelWidths(raw)
    this.apply()
  }

  show(id: PanelId): void {
    this.open.set(id, (this.open.get(id) ?? 0) + 1)
    this.apply()
  }

  hide(id: PanelId): void {
    const count = (this.open.get(id) ?? 0) - 1
    if (count > 0) this.open.set(id, count)
    else this.open.delete(id)
    this.apply()
  }

  openPanels(): PanelId[] {
    return [...this.open.keys()]
  }

  /** Recomputes shown widths for the window size and open panels, and writes the CSS variables. `keep`, the panel being resized, shrinks last. */
  apply(keep?: PanelId): PanelWidths {
    this.shown = fitPanelWidths(this.prefs, this.open.keys(), this.env.viewport(), keep)
    for (const id of PANEL_IDS) this.env.setVar(PANEL_LIMITS[id].cssVar, `${this.shown[id]}px`)
    for (const listener of this.listeners) listener()
    return this.shown
  }

  width(id: PanelId): number {
    return this.shown[id]
  }

  preferred(): PanelWidths {
    return { ...this.prefs }
  }

  maxWidth(id: PanelId): number {
    return panelDragMax(id, this.shown, this.open.keys(), this.env.viewport())
  }

  /** Sets the preferred width, limited so the other open panels and the main area keep their space. */
  resize(id: PanelId, width: number): number {
    this.dirty = true
    this.prefs[id] = clampPanelWidth(id, Math.min(width, this.maxWidth(id)))
    return this.apply(id)[id]
  }

  beginDrag(id: PanelId): number {
    this.dragging++
    return this.shown[id]
  }

  endDrag(changed = true): void {
    this.dragging = Math.max(0, this.dragging - 1)
    if (changed) this.save()
    else this.dirty = false
  }

  reset(id: PanelId): number {
    this.prefs[id] = PANEL_LIMITS[id].default
    const width = this.apply(id)[id]
    this.save()
    return width
  }

  save(): void {
    this.dirty = false
    this.env.save(this.preferred())
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export function isWebClient(): boolean {
  return typeof window !== 'undefined' && window.api?.platform === 'web'
}

export function readStoredPanelWidths(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Partial<PanelWidths> {
  try {
    return normalizePanelWidths(JSON.parse(storage?.getItem(PANEL_WIDTHS_KEY) ?? 'null'))
  } catch {
    return {}
  }
}

export function writeStoredPanelWidths(widths: PanelWidths, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(PANEL_WIDTHS_KEY, JSON.stringify(normalizePanelWidths(widths)))
  } catch {
    /* Storage can be unavailable. The widths still apply for this page. */
  }
}

/** The desktop app saves widths in settings (state.json); the remote web client keeps them in its browser. */
export function savePanelWidths(widths: PanelWidths): void {
  if (isWebClient()) writeStoredPanelWidths(widths)
  else void window.api.updateSettings({ panelWidths: normalizePanelWidths(widths) }).catch(() => {})
}

let layout: PanelLayout | undefined

export function panelLayout(): PanelLayout {
  layout ??= new PanelLayout({
    viewport: () => window.innerWidth,
    setVar: (name, value) => document.documentElement.style.setProperty(name, value),
    save: savePanelWidths
  })
  return layout
}
