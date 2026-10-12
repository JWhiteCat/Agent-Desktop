import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  MAX_FIND_MATCHES,
  buildTextIndex,
  currentSelectionText,
  findInputKey,
  findMatches,
  findShortcut,
  firstAtOrAfter,
  keepMatchIndex,
  locateMatch,
  prefillQuery,
  stepIndex,
  type IndexNode,
  type TextMatch
} from '../lib/find'
import { useT } from '../lib/i18n'
import { IconArrowDown, IconArrowUp, IconSearch, IconX } from './icons'

const MATCH_HIGHLIGHT = 'agent-find'
const CURRENT_HIGHLIGHT = 'agent-find-current'
const TYPE_DELAY = 150
const UPDATE_DELAY = 250

interface Props {
  /** The view the bar sits in; content changes anywhere in it re-run the search. */
  scope: RefObject<HTMLElement | null>
  /** The conversation body. Only text inside it is searched. */
  body: RefObject<HTMLElement | null>
  /** The element that scrolls the body. */
  scroller: RefObject<HTMLElement | null>
}

interface Status {
  index: number
  total: number
  capped: boolean
}

const EMPTY: Status = { index: -1, total: 0, capped: false }

function highlights(): HighlightRegistry | undefined {
  return typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : undefined
}

function clearHighlights(): void {
  const registry = highlights()
  registry?.delete(MATCH_HIGHLIGHT)
  registry?.delete(CURRENT_HIGHLIGHT)
}

function isMac(): boolean {
  if (window.api?.platform === 'darwin') return true
  return window.api?.platform === 'web' && typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
}

function isVisible(el: IndexNode): boolean {
  const element = el as unknown as Element
  return typeof element.checkVisibility === 'function' ? element.checkVisibility() : true
}

/** Scrolls so the range sits in the vertical middle of the scroller, and into view inside wide code blocks. */
function scrollToRange(range: Range, scroller: HTMLElement | null): void {
  const element = range.startContainer.parentElement
  element?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  if (!scroller) return
  const rect = range.getBoundingClientRect()
  const box = scroller.getBoundingClientRect()
  if (!rect.width && !rect.height) return
  scroller.scrollTop += rect.top - box.top - (scroller.clientHeight - rect.height) / 2
}

/**
 * Find in conversation (Ctrl+F / ⌘F). Highlights use the CSS Custom Highlight API, so the message DOM is never
 * changed. Without it, the bar still counts matches and scrolls to the current one.
 */
export function FindBar({ scope, body, scroller }: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [term, setTerm] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [status, setStatus] = useState<Status>(EMPTY)
  const input = useRef<HTMLInputElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const ranges = useRef<Range[]>([])
  const matches = useRef<TextMatch[]>([])
  const text = useRef('')
  const current = useRef(-1)
  const returnFocus = useRef<HTMLElement | null>(null)
  const live = useRef({ open, term, matchCase, wholeWord })
  live.current = { open, term, matchCase, wholeWord }

  const paint = useCallback(() => {
    const registry = highlights()
    if (!registry) return
    const list = ranges.current
    const index = current.current
    registry.set(MATCH_HIGHLIGHT, new Highlight(...list.filter((_, i) => i !== index)))
    const active = new Highlight(...(index >= 0 && list[index] ? [list[index]] : []))
    active.priority = 1
    registry.set(CURRENT_HIGHLIGHT, active)
  }, [])

  const select = useCallback(
    (index: number, scroll: boolean) => {
      current.current = index
      paint()
      const range = ranges.current[index]
      if (scroll && range) scrollToRange(range, scroller.current)
    },
    [paint, scroller]
  )

  /** `fresh` starts at the first match in view and scrolls to it; `keep` stays on the current match without scrolling. */
  const run = useCallback(
    (mode: 'fresh' | 'keep') => {
      const { open, term, matchCase, wholeWord } = live.current
      const root = body.current
      if (!open || !root || !term) {
        ranges.current = []
        matches.current = []
        current.current = -1
        clearHighlights()
        setStatus(EMPTY)
        return
      }
      const previous = matches.current[current.current]
      const previousText = previous ? text.current.slice(previous.start, previous.end) : undefined
      const index = buildTextIndex(root as unknown as IndexNode, isVisible)
      const found = findMatches(index.text, term, { matchCase, wholeWord })
      const list: Range[] = []
      const kept: TextMatch[] = []
      for (const match of found) {
        const pos = locateMatch(index, match)
        if (!pos) continue
        try {
          const range = document.createRange()
          range.setStart(pos.startNode as unknown as Node, pos.startOffset)
          range.setEnd(pos.endNode as unknown as Node, pos.endOffset)
          list.push(range)
          kept.push(match)
        } catch {
          /* The node changed while indexing; the next update picks it up. */
        }
      }
      ranges.current = list
      matches.current = kept
      text.current = index.text
      let next: number
      if (mode === 'keep') {
        next = keepMatchIndex(previous && { ...previous, text: previousText }, kept, index.text)
      } else {
        const top = scroller.current?.getBoundingClientRect().top ?? 0
        next = firstAtOrAfter(list.length, (i) => list[i].getBoundingClientRect().top, top)
      }
      select(next, mode === 'fresh')
      setStatus({ index: next, total: list.length, capped: found.length >= MAX_FIND_MATCHES })
    },
    [body, scroller, select]
  )

  const step = useCallback(
    (dir: 1 | -1) => {
      const total = ranges.current.length
      if (!total) return
      const next = stepIndex(current.current, total, dir)
      select(next, true)
      setStatus((s) => ({ ...s, index: next }))
    },
    [select]
  )

  const focusInput = () =>
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.select()
    })

  const show = useCallback(() => {
    const active = document.activeElement as HTMLElement | null
    if (!bar.current?.contains(active)) returnFocus.current = active
    const prefill = prefillQuery(currentSelectionText(active, window.getSelection()))
    if (prefill) {
      setQuery(prefill)
      setTerm(prefill)
    }
    setOpen(true)
    focusInput()
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    ranges.current = []
    matches.current = []
    current.current = -1
    clearHighlights()
    setStatus(EMPTY)
    const back = returnFocus.current
    returnFocus.current = null
    if (back?.isConnected && back !== document.body) back.focus()
  }, [])

  useEffect(() => {
    if (query === term) return
    const timer = setTimeout(() => setTerm(query), TYPE_DELAY)
    return () => clearTimeout(timer)
  }, [query, term])

  useEffect(() => {
    run('fresh')
  }, [open, term, matchCase, wholeWord, run])

  // Streaming replies and polling change the body while the bar is open.
  useEffect(() => {
    const target = scope.current
    if (!open || !term || !target || typeof MutationObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new MutationObserver((records) => {
      if (records.every((r) => bar.current?.contains(r.target))) return
      timer ??= setTimeout(() => {
        timer = undefined
        run('keep')
      }, UPDATE_DELAY)
    })
    observer.observe(target, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [open, term, matchCase, wholeWord, scope, run])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = findShortcut(e, isMac(), live.current.open)
      if (!action || !body.current) return
      const inBar = !!bar.current?.contains(e.target as Node)
      if (action === 'open') {
        e.preventDefault()
        show()
      } else if (action === 'close') {
        if (inBar || document.querySelector('.modal-backdrop')) return
        const active = document.activeElement
        if (active && active !== document.body && !scroller.current?.contains(active)) return
        e.preventDefault()
        close()
      } else {
        e.preventDefault()
        if (!live.current.open) show()
        else step(action === 'next' ? 1 : -1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [body, scroller, show, close, step])

  useEffect(() => clearHighlights, [])

  if (!open) return null
  const count = term ? (status.total ? `${status.index + 1} / ${status.total}${status.capped ? '+' : ''}` : t('无结果')) : ''
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()
  return (
    <div className="find-bar no-drag" ref={bar} role="search">
      <IconSearch size={14} className="find-icon" />
      <input
        ref={input}
        className={term && !status.total ? 'no-match' : ''}
        value={query}
        spellCheck={false}
        placeholder={t('在对话中查找')}
        aria-label={t('在对话中查找')}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          const action = findInputKey({ ...e, isComposing: e.nativeEvent.isComposing })
          if (!action) return
          e.preventDefault()
          if (action === 'close') close()
          else {
            if (query !== term) {
              setTerm(query)
              return
            }
            step(action === 'next' ? 1 : -1)
          }
        }}
      />
      <span className="find-count" aria-live="polite">
        {count}
      </span>
      <button
        type="button"
        className={`find-toggle ${matchCase ? 'active' : ''}`}
        aria-pressed={matchCase}
        title={t('区分大小写')}
        aria-label={t('区分大小写')}
        onMouseDown={keepFocus}
        onClick={() => setMatchCase((v) => !v)}
      >
        Aa
      </button>
      <button
        type="button"
        className={`find-toggle find-word ${wholeWord ? 'active' : ''}`}
        aria-pressed={wholeWord}
        title={t('全词匹配')}
        aria-label={t('全词匹配')}
        onMouseDown={keepFocus}
        onClick={() => setWholeWord((v) => !v)}
      >
        ab
      </button>
      <button type="button" className="icon-btn tiny" title={t('上一个 (Shift+Enter)')} aria-label={t('上一个 (Shift+Enter)')} disabled={!status.total} onMouseDown={keepFocus} onClick={() => step(-1)}>
        <IconArrowUp size={14} />
      </button>
      <button type="button" className="icon-btn tiny" title={t('下一个 (Enter)')} aria-label={t('下一个 (Enter)')} disabled={!status.total} onMouseDown={keepFocus} onClick={() => step(1)}>
        <IconArrowDown size={14} />
      </button>
      <button type="button" className="icon-btn tiny" title={t('关闭 (Esc)')} aria-label={t('关闭 (Esc)')} onMouseDown={keepFocus} onClick={close}>
        <IconX size={14} />
      </button>
    </div>
  )
}
