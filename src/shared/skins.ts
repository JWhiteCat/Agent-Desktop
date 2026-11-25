export const SKIN_SCHEME = 'skin-asset'
export type SkinKind = 'image' | 'video' | 'web'
export type SkinPropertyValue = string | number | boolean
export interface SkinProperty {
  type: 'bool' | 'slider' | 'color' | 'combo' | 'textinput'
  text: string
  value: SkinPropertyValue
  min?: number
  max?: number
  step?: number
  options?: { label: string; value: SkinPropertyValue }[]
}
export interface SkinSource {
  id: string
  title: string
  kind: SkinKind
  root: string
  entry: string
  preview?: string
  properties: Record<string, SkinProperty>
}
export interface WallpaperEntry {
  id: string
  title: string
  type: string
  available: boolean
  reason?: string
  source?: SkinSource
}
export interface SkinConfig {
  id: string
  name: string
  background: 'none' | 'gradient' | SkinKind
  sourceId: string
  fit: 'cover' | 'contain'
  colors: Partial<Record<'background' | 'panel' | 'text' | 'accent', string>>
  opacity: number
  blur: number
  overlay: number
  properties: Record<string, SkinPropertyValue>
}
export const DEFAULT_SKIN: SkinConfig = {
  id: 'default', name: '默认', background: 'none', sourceId: '', fit: 'cover',
  colors: {}, opacity: 100, blur: 0, overlay: 0, properties: {}
}
export const BUILTIN_SKINS: readonly SkinConfig[] = [
  DEFAULT_SKIN,
  { ...DEFAULT_SKIN, id: 'frost', name: '磨砂', opacity: 82, blur: 18 },
  { ...DEFAULT_SKIN, id: 'aurora', name: '流光', background: 'gradient', opacity: 78, blur: 16, overlay: 15 },
  {
    ...DEFAULT_SKIN,
    id: 'midnight',
    name: '午夜蓝',
    colors: { background: '#0f172a', panel: '#162033', text: '#e2e8f0', accent: '#38bdf8' }
  },
  {
    ...DEFAULT_SKIN,
    id: 'nord',
    name: '北欧极夜',
    colors: { background: '#1e2430', panel: '#252c3a', text: '#e5e9f0', accent: '#88c0d0' }
  },
  {
    ...DEFAULT_SKIN,
    id: 'warm-paper',
    name: '暖纸墨韵',
    colors: { background: '#faf7f2', panel: '#f2ece2', text: '#2c241d', accent: '#c26d3a' }
  },
  {
    ...DEFAULT_SKIN,
    id: 'forest',
    name: '林间暮色',
    colors: { background: '#111a16', panel: '#17231d', text: '#e4efe8', accent: '#34d399' }
  },
  {
    ...DEFAULT_SKIN,
    id: 'rose-dusk',
    name: '暮光玫瑰',
    colors: { background: '#1a141d', panel: '#231b27', text: '#f3eaf5', accent: '#e879a9' }
  }
]
export const isSourceId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
export const isSkinColor = (value: unknown): value is string => typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value)
const clamp = (v: unknown, min: number, max: number, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback

export function normalizeSkin(value: unknown): SkinConfig {
  const s = (value && typeof value === 'object' ? value : {}) as Partial<SkinConfig>
  const colors: SkinConfig['colors'] = {}
  for (const key of ['background', 'panel', 'text', 'accent'] as const) {
    if (isSkinColor(s.colors?.[key])) colors[key] = s.colors[key]
  }
  const properties: SkinConfig['properties'] = {}
  for (const [key, v] of Object.entries(s.properties ?? {}).slice(0, 512)) {
    if (/^[\w-]{1,100}$/.test(key) && (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 2000))) properties[key] = v
  }
  const sourceId = isSourceId(s.sourceId) ? s.sourceId : ''
  const background = s.background === 'gradient' ? 'gradient' : sourceId && ['image', 'video', 'web'].includes(s.background ?? '') ? s.background! : 'none'
  return {
    id: typeof s.id === 'string' ? s.id.slice(0, 100) : 'default',
    name: typeof s.name === 'string' ? s.name.trim().slice(0, 80) || '自定义皮肤' : DEFAULT_SKIN.name,
    background, sourceId, colors, properties,
    fit: s.fit === 'contain' ? 'contain' : 'cover',
    opacity: clamp(s.opacity, 0, 100, 100), blur: clamp(s.blur, 0, 40, 0), overlay: clamp(s.overlay, 0, 100, 0)
  }
}
export function normalizeSkins(value: unknown): SkinConfig[] {
  const seen = new Set(BUILTIN_SKINS.map(s => s.id))
  return (Array.isArray(value) ? value : []).slice(0, 100).map(normalizeSkin).filter(s => {
    if (!s.id || seen.has(s.id)) return false
    seen.add(s.id)
    return true
  })
}
/** No desktop source identifiers or wallpaper properties are sent to browsers. */
export function remoteSkin(skin: unknown): SkinConfig {
  const s = normalizeSkin(skin)
  return { ...s, background: 'none', sourceId: '', properties: {} }
}
export function skinUrl(source: SkinSource, preview = false): string {
  const file = preview ? source.preview : source.entry
  return file ? `${SKIN_SCHEME}://${source.id}/${file.split(/[\\/]/).map(encodeURIComponent).join('/')}` : ''
}
