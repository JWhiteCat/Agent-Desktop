import { normalizeSkin, type SkinConfig } from '@shared/skins'

const COLOR_VARIABLES = { background: '--bg', panel: '--skin-panel', text: '--text', accent: '--accent' } as const
const VARIABLES = [
  '--bg', '--skin-panel', '--bg-elev', '--bg-subtle', '--bg-bubble', '--bg-code',
  '--bg-hover', '--bg-active', '--border', '--border-strong',
  '--text', '--text-2', '--muted', '--accent', '--accent-fg', '--skin-opacity', '--skin-blur'
]

function luminance(hex: string): number {
  const rgb = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16))
  return rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114
}

export function applySkin(root: HTMLElement, input: SkinConfig): void {
  const s = normalizeSkin(input)
  for (const key of VARIABLES) root.style.removeProperty(key)
  delete root.dataset.skinTone
  root.dataset.skin = s.id === 'default' && s.background === 'none' && Object.keys(s.colors).length === 0 && s.opacity === 100 && s.blur === 0 ? 'default' : 'custom'
  root.style.setProperty('--skin-opacity', `${s.opacity}%`)
  root.style.setProperty('--skin-blur', `${s.blur}px`)
  for (const [key, variable] of Object.entries(COLOR_VARIABLES)) {
    const color = s.colors[key as keyof typeof COLOR_VARIABLES]
    if (color) root.style.setProperty(variable, color)
  }
  const surface = s.colors.panel ?? s.colors.background
  if (surface) {
    const dark = luminance(surface) < 128
    root.dataset.skinTone = dark ? 'dark' : 'light'
    const bg = s.colors.background ?? surface
    const ink = s.colors.text ?? (dark ? '#f3f4f6' : '#111827')
    root.style.setProperty('--bg-elev', dark ? `color-mix(in srgb, ${surface} 92%, #ffffff)` : `color-mix(in srgb, ${bg} 96%, #ffffff)`)
    root.style.setProperty('--bg-subtle', `color-mix(in srgb, ${surface} 93%, ${dark ? '#ffffff' : '#000000'})`)
    root.style.setProperty('--bg-bubble', `color-mix(in srgb, ${surface} ${dark ? '86%' : '90%'}, ${dark ? '#ffffff' : '#000000'})`)
    root.style.setProperty('--bg-code', `color-mix(in srgb, ${bg} ${dark ? '88%' : '94%'}, #000000)`)
    root.style.setProperty('--bg-hover', `color-mix(in srgb, ${ink} ${dark ? '7%' : '5%'}, transparent)`)
    root.style.setProperty('--bg-active', `color-mix(in srgb, ${ink} ${dark ? '12%' : '8.5%'}, transparent)`)
    root.style.setProperty('--border', `color-mix(in srgb, ${ink} ${dark ? '11%' : '9%'}, transparent)`)
    root.style.setProperty('--border-strong', `color-mix(in srgb, ${ink} ${dark ? '20%' : '16%'}, transparent)`)
  }
  if (s.colors.text) {
    root.style.setProperty('--text-2', `color-mix(in srgb, ${s.colors.text} 78%, transparent)`)
    root.style.setProperty('--muted', `color-mix(in srgb, ${s.colors.text} 56%, transparent)`)
  }
  if (s.colors.accent) {
    root.style.setProperty('--accent-fg', luminance(s.colors.accent) > 160 ? '#111827' : '#ffffff')
  }
}
