import { DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE, normalizeFontFamily, normalizeFontSize } from '@shared/appearance'

/** Apply a single font name as a CSS string, keeping system fallbacks and code's monospace stack. */
export function applyTypography(style: Pick<CSSStyleDeclaration, 'setProperty'>, family: unknown, size: unknown): void {
  const font = normalizeFontFamily(family)
  const quoted = font.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  style.setProperty('--font', font ? `"${quoted}", ${DEFAULT_FONT_FAMILY}` : DEFAULT_FONT_FAMILY)
  style.setProperty('--font-scale', String(normalizeFontSize(size) / DEFAULT_FONT_SIZE))
}
