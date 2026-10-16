export const DEFAULT_FONT_SIZE = 13.5
export const MIN_FONT_SIZE = 10
export const MAX_FONT_SIZE = 24

/** The system font stack used when no custom font family is selected. */
export const DEFAULT_FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', system-ui, sans-serif"

/** A single installed font name. Empty means use the system font stack. */
export function normalizeFontFamily(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 100).trim()
}

/** Font sizes are bounded pixel values in half-pixel increments. */
export function normalizeFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_FONT_SIZE
  return Math.round(Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, value)) * 2) / 2
}
