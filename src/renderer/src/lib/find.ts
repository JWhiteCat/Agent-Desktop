/** Find in conversation: text matching, DOM text indexing, and keyboard rules. No DOM is changed. */

export interface FindOptions {
  matchCase?: boolean
  wholeWord?: boolean
}

export interface TextMatch {
  start: number
  end: number
}

/** More matches than this are not highlighted; the count shows "N+". */
export const MAX_FIND_MATCHES = 5000
/** Longest query taken from a text selection. */
export const MAX_FIND_PREFILL = 200

/** Escapes characters that are special in a `u`-flag regular expression. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/** Matches of `query` in `text`, in order and without overlaps. Case-insensitive unless `matchCase`. */
export function findMatches(text: string, query: string, options: FindOptions = {}, limit = MAX_FIND_MATCHES): TextMatch[] {
  if (!query) return []
  const body = escapeRegExp(query)
  const source = options.wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body
  const pattern = new RegExp(source, options.matchCase ? 'gu' : 'giu')
  const out: TextMatch[] = []
  for (let m = pattern.exec(text); m && out.length < limit; m = pattern.exec(text)) {
    if (!m[0].length) {
      pattern.lastIndex++
      continue
    }
    out.push({ start: m.index, end: m.index + m[0].length })
  }
  return out
}

/** A text node and where its text sits in the joined index text. */
export interface TextSegment<N = Text> {
  node: N
  start: number
  end: number
}

export interface TextIndex<N = Text> {
  text: string
  segments: TextSegment<N>[]
}

/** The DOM surface the indexer reads. Real DOM nodes satisfy it; tests pass plain objects. */
export interface IndexNode {
  nodeType: number
  nodeName: string
  nodeValue: string | null
  childNodes: ArrayLike<IndexNode>
  getAttribute?: (name: string) => string | null
}

const TEXT_NODE = 3
const ELEMENT_NODE = 1

/** Elements whose text runs on with the surrounding text, so a match may cross them ("foo **bar**"). */
const INLINE = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM', 'I', 'INS', 'KBD', 'LABEL', 'MARK',
  'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR'
])

/** Controls and non-text content are not conversation text. */
const SKIPPED = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'svg', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME'])

export function isSkippedElement(el: IndexNode): boolean {
  if (SKIPPED.has(el.nodeName) || SKIPPED.has(el.nodeName.toUpperCase())) return true
  const attr = el.getAttribute
  return !!attr && (attr.call(el, 'aria-hidden') === 'true' || attr.call(el, 'data-find-skip') !== null || attr.call(el, 'hidden') !== null)
}

/**
 * Joins the text under `root` in document order. Text in different blocks is separated by a newline, so a match
 * never runs from the end of one paragraph into the next. Skipped and invisible elements are left out.
 */
export function buildTextIndex<N extends IndexNode>(root: N, isVisible: (el: N) => boolean = () => true): TextIndex<N> {
  const segments: TextSegment<N>[] = []
  let text = ''
  let lastBlock: unknown
  const walk = (node: N, block: unknown) => {
    const children = node.childNodes
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as N
      if (child.nodeType === TEXT_NODE) {
        const value = child.nodeValue ?? ''
        if (!value) continue
        if (segments.length && block !== lastBlock) text += '\n'
        lastBlock = block
        segments.push({ node: child, start: text.length, end: text.length + value.length })
        text += value
      } else if (child.nodeType === ELEMENT_NODE) {
        if (isSkippedElement(child) || !isVisible(child)) continue
        if (child.nodeName === 'BR') {
          lastBlock = undefined
          continue
        }
        walk(child, INLINE.has(child.nodeName.toUpperCase()) ? block : child)
      }
    }
  }
  walk(root, root)
  return { text, segments }
}

/** Index of the segment containing `offset`, or -1. `endSide` treats an offset at a segment end as inside it. */
function segmentAt<N>(segments: TextSegment<N>[], offset: number, endSide: boolean): number {
  let lo = 0
  let hi = segments.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = segments[mid]
    if (endSide ? offset <= s.start : offset < s.start) hi = mid - 1
    else if (endSide ? offset > s.end : offset >= s.end) lo = mid + 1
    else return mid
  }
  return -1
}

export interface MatchPosition<N = Text> {
  startNode: N
  startOffset: number
  endNode: N
  endOffset: number
}

/** Node offsets for a match, or undefined when it starts or ends on a block separator. */
export function locateMatch<N>(index: TextIndex<N>, match: TextMatch): MatchPosition<N> | undefined {
  const a = segmentAt(index.segments, match.start, false)
  const b = segmentAt(index.segments, match.end, true)
  if (a < 0 || b < 0 || b < a) return undefined
  const start = index.segments[a]
  const end = index.segments[b]
  return { startNode: start.node, startOffset: match.start - start.start, endNode: end.node, endOffset: match.end - end.start }
}

/** Wraps around in either direction. */
export function stepIndex(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return -1
  if (current < 0) return dir === 1 ? 0 : total - 1
  return (current + dir + total) % total
}

/**
 * The match to keep current after the text changed: the one at the same offset with the same text, else the
 * next one after it, else the last one. Streaming replies append text, so earlier offsets stay put.
 */
export function keepMatchIndex(previous: (TextMatch & { text?: string }) | undefined, matches: TextMatch[], text?: string): number {
  if (!matches.length) return -1
  if (!previous) return 0
  let after = -1
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    if (m.start === previous.start && (previous.text === undefined || text === undefined || text.slice(m.start, m.end) === previous.text)) return i
    if (after < 0 && m.start >= previous.start) after = i
  }
  return after >= 0 ? after : matches.length - 1
}

/** First index whose position is at or after `target`, from positions in ascending order; the last one when none. */
export function firstAtOrAfter(count: number, positionOf: (i: number) => number, target: number): number {
  if (count <= 0) return -1
  let lo = 0
  let hi = count - 1
  let found = count - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (positionOf(mid) >= target) {
      found = mid
      hi = mid - 1
    } else lo = mid + 1
  }
  return found
}

/** A query from selected text: its first line, trimmed of line breaks, at most MAX_FIND_PREFILL characters. */
export function prefillQuery(selected: string | null | undefined): string {
  const line = (selected ?? '').split(/\r?\n/).find((part) => part.trim()) ?? ''
  return line.trim().slice(0, MAX_FIND_PREFILL)
}

/** Selected text in an input or textarea, else in the document. */
export function currentSelectionText(active: Element | null, selection: Selection | null): string {
  const field = active as (HTMLInputElement | HTMLTextAreaElement) | null
  if (field && (field.tagName === 'TEXTAREA' || field.tagName === 'INPUT')) {
    try {
      const { selectionStart, selectionEnd, value } = field
      if (selectionStart !== null && selectionEnd !== null && selectionEnd > selectionStart) return value.slice(selectionStart, selectionEnd)
    } catch {
      /* Some input types have no selection. */
    }
  }
  return selection?.toString() ?? ''
}

export interface FindKey {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export type FindAction = 'open' | 'next' | 'prev' | 'close'

/** Window-level shortcuts: Ctrl+F (⌘F on macOS) opens; F3 / Shift+F3 (and ⌘G / ⌘⇧G on macOS) step; Esc closes. */
export function findShortcut(e: FindKey, mac: boolean, open: boolean): FindAction | undefined {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (mod && !e.altKey && !e.shiftKey && key === 'f') return 'open'
  if (key === 'F3' && !e.ctrlKey && !e.metaKey && !e.altKey) return e.shiftKey ? 'prev' : 'next'
  if (mac && mod && !e.altKey && key === 'g') return e.shiftKey ? 'prev' : 'next'
  if (open && key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) return 'close'
  return undefined
}

/** Keys in the find box: Enter / Shift+Enter step, Esc closes. */
export function findInputKey(e: FindKey & { isComposing?: boolean }): FindAction | undefined {
  if (e.isComposing) return undefined
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) return e.shiftKey ? 'prev' : 'next'
  if (e.key === 'Escape') return 'close'
  return undefined
}
