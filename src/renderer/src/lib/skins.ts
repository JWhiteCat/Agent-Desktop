import { normalizeSkin, type SkinConfig } from '@shared/skins'

const COLOR_VARIABLES = { background: '--bg', panel: '--skin-panel', text: '--text', accent: '--accent' } as const
const VARIABLES = ['--bg', '--skin-panel', '--text', '--text-2', '--muted', '--accent', '--accent-fg', '--skin-opacity', '--skin-blur']

export function applySkin(root: HTMLElement, input: SkinConfig): void {
  const s = normalizeSkin(input)
  for (const key of VARIABLES) root.style.removeProperty(key)
  root.dataset.skin = s.id === 'default' && s.background === 'none' && Object.keys(s.colors).length === 0 && s.opacity === 100 && s.blur === 0 ? 'default' : 'custom'
  root.style.setProperty('--skin-opacity', `${s.opacity}%`)
  root.style.setProperty('--skin-blur', `${s.blur}px`)
  for (const [key, variable] of Object.entries(COLOR_VARIABLES)) {
    const color = s.colors[key as keyof typeof COLOR_VARIABLES]
    if (color) root.style.setProperty(variable, color)
  }
  if (s.colors.text) {
    root.style.setProperty('--text-2', `color-mix(in srgb, ${s.colors.text} 80%, transparent)`)
    root.style.setProperty('--muted', `color-mix(in srgb, ${s.colors.text} 60%, transparent)`)
  }
  if (s.colors.accent) {
    const rgb = s.colors.accent.slice(1).match(/../g)!.map(v => parseInt(v, 16))
    root.style.setProperty('--accent-fg', rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 > 160 ? '#181818' : '#ffffff')
  }
}
