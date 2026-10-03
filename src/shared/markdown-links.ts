const DRIVE_PATH = /^\/?([a-z]:)[\\/]/i
const SCHEME = /^[a-z][a-z\d+.-]*:/i
const NETWORK_PATH = /^[\\/]{2}/
const CONTROL = /[\u0000-\u001f\u007f]/

function decodePath(value: string): string | undefined {
  try {
    // A bare percent sign can be part of a filename; decode URI escapes once.
    return decodeURIComponent(value.replace(/%(?![\da-f]{2})/gi, '%25'))
  } catch {
    return undefined
  }
}

function withoutPosition(value: string): string {
  return value.replace(/#L\d+(?:C\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '')
}

function normalizeAbsolute(value: string): string | undefined {
  if (!value || CONTROL.test(value) || NETWORK_PATH.test(value)) return undefined
  const drive = DRIVE_PATH.exec(value)
  if (!drive && !value.startsWith('/')) return undefined
  const separator = drive ? '\\' : '/'
  const root = drive ? drive[1] + separator : '/'
  const tail = drive ? value.slice(drive[0].length).replace(/\\/g, '/') : value.slice(1)
  const parts: string[] = []
  for (const part of tail.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return root + parts.join(separator)
}

/** Resolve a Markdown file link without Node APIs, including Windows links on remote browsers. */
export function localPathFromLink(href: string, cwd?: string): string | undefined {
  const raw = href.trim()
  if (!raw || CONTROL.test(raw)) return undefined

  let encodedPath = raw
  if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw)
      if (url.hostname && url.hostname.toLowerCase() !== 'localhost') return undefined
      // URI fragments and queries are not part of a filename. Encoded # and ? are.
      encodedPath = url.pathname
    } catch {
      return undefined
    }
  }

  const original = decodePath(encodedPath)
  if (!original || CONTROL.test(original) || NETWORK_PATH.test(original)) return undefined
  const target = decodePath(withoutPosition(encodedPath))
  if (!target || CONTROL.test(target) || NETWORK_PATH.test(target)) return undefined
  // Check schemes before stripping positions: javascript:123 is not a file reference.
  // A bare filename with an extension, such as main.ts:12, is intentionally allowed.
  if (SCHEME.test(original) && !DRIVE_PATH.test(original) &&
      (target === original || !/^[^:/\\]+\.[^:/\\]+$/.test(target))) return undefined
  const absolute = normalizeAbsolute(target)
  if (absolute) return absolute
  if (SCHEME.test(target) || /^[\\#?]/.test(target)) return undefined
  const base = cwd && normalizeAbsolute(cwd)
  if (!base) return undefined
  const relative = DRIVE_PATH.test(base) ? target.replace(/\\/g, '/') : target
  return normalizeAbsolute(`${base}/${relative}`)
}

/** Extra safe URL schemes/paths allowed only for Markdown anchors, never image sources. */
export function isLocalFileLink(href: string, cwd?: string): boolean {
  return localPathFromLink(href, cwd) !== undefined
}
