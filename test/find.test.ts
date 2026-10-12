import { describe, expect, it } from 'vitest'
import {
  MAX_FIND_PREFILL,
  buildTextIndex,
  currentSelectionText,
  escapeRegExp,
  findInputKey,
  findMatches,
  findShortcut,
  firstAtOrAfter,
  keepMatchIndex,
  locateMatch,
  prefillQuery,
  stepIndex,
  type FindKey,
  type IndexNode
} from '../src/renderer/src/lib/find'

type Fake = IndexNode & { childNodes: Fake[] }
const el = (nodeName: string, childNodes: Fake[] = [], attrs: Record<string, string> = {}): Fake => ({
  nodeType: 1,
  nodeName,
  nodeValue: null,
  childNodes,
  getAttribute: (name: string) => attrs[name] ?? null
})
const tx = (value: string): Fake => ({ nodeType: 3, nodeName: '#text', nodeValue: value, childNodes: [] })
const texts = (text: string, matches: { start: number; end: number }[]) => matches.map((m) => text.slice(m.start, m.end))

describe('findMatches', () => {
  it('matches case-insensitively by default and exactly with match case', () => {
    expect(texts('Foo foo FOO', findMatches('Foo foo FOO', 'foo'))).toEqual(['Foo', 'foo', 'FOO'])
    expect(texts('Foo foo FOO', findMatches('Foo foo FOO', 'foo', { matchCase: true }))).toEqual(['foo'])
    expect(findMatches('ÄRGER ärger', 'ärger')).toHaveLength(2)
  })

  it('treats the query as plain text', () => {
    expect(escapeRegExp('a.b*(c)[d]{e}|f^$\\/+?')).toBe('a\\.b\\*\\(c\\)\\[d\\]\\{e\\}\\|f\\^\\$\\\\\\/\\+\\?')
    expect(texts('a.b axb c++ (x) -', findMatches('a.b axb c++ (x) -', 'a.b'))).toEqual(['a.b'])
    expect(findMatches('c++ and c+', 'c++')).toEqual([{ start: 0, end: 3 }])
    expect(findMatches('x (x) -y-', '(x)')).toEqual([{ start: 2, end: 5 }])
    expect(findMatches('-y-', '-')).toHaveLength(2)
  })

  it('does not overlap matches and respects the limit', () => {
    expect(findMatches('aaaa', 'aa')).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }])
    expect(findMatches('a a a a', 'a', {}, 3)).toHaveLength(3)
    expect(findMatches('anything', '')).toEqual([])
  })

  it('matches whole words, including non-Latin letters', () => {
    const text = 'cat concat cat_x cat. Cat'
    expect(texts(text, findMatches(text, 'cat', { wholeWord: true }))).toEqual(['cat', 'cat', 'Cat'])
    expect(findMatches('über überall', 'über', { wholeWord: true })).toEqual([{ start: 0, end: 4 }])
    expect(findMatches('搜索 搜索框', '搜索', { wholeWord: true })).toEqual([{ start: 0, end: 2 }])
    expect(findMatches('搜索结果', '搜索')).toEqual([{ start: 0, end: 2 }])
  })
})

describe('buildTextIndex', () => {
  it('joins inline text and separates blocks', () => {
    const root = el('DIV', [el('P', [tx('Hello '), el('STRONG', [tx('wor')]), tx('ld')]), el('P', [tx('next')]), el('PRE', [el('CODE', [el('SPAN', [tx('const')]), tx(' x')])])])
    const index = buildTextIndex(root)
    expect(index.text).toBe('Hello world\nnext\nconst x')
    expect(index.segments.map((s) => [s.start, s.end])).toEqual([[0, 6], [6, 9], [9, 11], [12, 16], [17, 22], [22, 24]])
  })

  it('breaks lines at <br> and skips controls, hidden and invisible content', () => {
    const root = el('DIV', [
      el('P', [tx('one'), el('BR'), tx('two')]),
      el('BUTTON', [tx('Copy')]),
      el('svg', [tx('icon')]),
      el('SPAN', [tx('aria')], { 'aria-hidden': 'true' }),
      el('DIV', [tx('skip')], { 'data-find-skip': '' }),
      el('DIV', [tx('hidden')], { hidden: '' }),
      el('DIV', [tx('collapsed')], { class: 'gone' }),
      el('P', [tx('three')])
    ])
    const index = buildTextIndex(root, (node) => node.getAttribute?.('class') !== 'gone')
    expect(index.text).toBe('one\ntwo\nthree')
  })

  it('maps matches back to text nodes, across inline elements but not across blocks', () => {
    const a = tx('Hello ')
    const b = tx('wor')
    const c = tx('ld')
    const d = tx('next')
    const index = buildTextIndex(el('DIV', [el('P', [a, el('EM', [b]), c]), el('P', [d])]))
    expect(locateMatch(index, { start: 1, end: 4 })).toEqual({ startNode: a, startOffset: 1, endNode: a, endOffset: 4 })
    expect(locateMatch(index, { start: 6, end: 11 })).toEqual({ startNode: b, startOffset: 0, endNode: c, endOffset: 2 })
    expect(locateMatch(index, { start: 3, end: 9 })).toEqual({ startNode: a, startOffset: 3, endNode: b, endOffset: 3 })
    expect(locateMatch(index, { start: 12, end: 16 })).toEqual({ startNode: d, startOffset: 0, endNode: d, endOffset: 4 })
    expect(locateMatch(index, { start: 11, end: 13 })).toBeUndefined()
    const found = findMatches(index.text, 'world')
    expect(found).toEqual([{ start: 6, end: 11 }])
    expect(findMatches(index.text, 'ld next')).toEqual([])
  })
})

describe('match navigation', () => {
  it('wraps in both directions', () => {
    expect(stepIndex(0, 3, 1)).toBe(1)
    expect(stepIndex(2, 3, 1)).toBe(0)
    expect(stepIndex(0, 3, -1)).toBe(2)
    expect(stepIndex(-1, 3, 1)).toBe(0)
    expect(stepIndex(-1, 3, -1)).toBe(2)
    expect(stepIndex(0, 0, 1)).toBe(-1)
  })

  it('keeps the current match when text is appended or changed', () => {
    const before = 'foo bar foo baz foo'
    const prev = { start: 8, end: 11, text: 'foo' }
    const appended = before + ' foo'
    expect(keepMatchIndex(prev, findMatches(appended, 'foo'), appended)).toBe(1)
    const removed = 'foo bar baz foo'
    expect(keepMatchIndex(prev, findMatches(removed, 'foo'), removed)).toBe(1)
    expect(keepMatchIndex({ start: 100, end: 103 }, findMatches(before, 'foo'))).toBe(2)
    expect(keepMatchIndex(undefined, findMatches(before, 'foo'))).toBe(0)
    expect(keepMatchIndex(prev, [])).toBe(-1)
    const shifted = 'Foo bar FOO baz foo'
    expect(keepMatchIndex({ start: 8, end: 11, text: 'foo' }, findMatches(shifted, 'foo'), shifted)).toBe(1)
  })

  it('starts at the first match at or below the top of the view', () => {
    const tops = [-300, -10, 40, 500]
    expect(firstAtOrAfter(tops.length, (i) => tops[i], 0)).toBe(2)
    expect(firstAtOrAfter(tops.length, (i) => tops[i], -1000)).toBe(0)
    expect(firstAtOrAfter(tops.length, (i) => tops[i], 1000)).toBe(3)
    expect(firstAtOrAfter(0, () => 0, 0)).toBe(-1)
  })
})

describe('prefill', () => {
  it('uses the first non-empty line of the selection', () => {
    expect(prefillQuery('  hello world \nsecond')).toBe('hello world')
    expect(prefillQuery('\n\n  second\r\nthird')).toBe('second')
    expect(prefillQuery('x'.repeat(500))).toHaveLength(MAX_FIND_PREFILL)
    expect(prefillQuery(null)).toBe('')
  })

  it('reads the selection inside an input or textarea before the document selection', () => {
    const doc = { toString: () => 'page text' } as Selection
    const area = { tagName: 'TEXTAREA', value: 'abc def', selectionStart: 4, selectionEnd: 7 } as unknown as Element
    expect(currentSelectionText(area, doc)).toBe('def')
    const empty = { tagName: 'INPUT', value: 'abc', selectionStart: 1, selectionEnd: 1 } as unknown as Element
    expect(currentSelectionText(empty, doc)).toBe('page text')
    expect(currentSelectionText({ tagName: 'DIV' } as Element, doc)).toBe('page text')
    expect(currentSelectionText(null, null)).toBe('')
  })
})

describe('find keys', () => {
  const key = (k: string, mods: Partial<FindKey> = {}): FindKey => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods })

  it('opens with Ctrl+F, or ⌘F on macOS', () => {
    expect(findShortcut(key('f', { ctrlKey: true }), false, false)).toBe('open')
    expect(findShortcut(key('F', { ctrlKey: true }), false, true)).toBe('open')
    expect(findShortcut(key('f', { metaKey: true }), true, false)).toBe('open')
    expect(findShortcut(key('f', { ctrlKey: true }), true, false)).toBeUndefined()
    expect(findShortcut(key('f', { metaKey: true }), false, false)).toBeUndefined()
    expect(findShortcut(key('f'), false, false)).toBeUndefined()
  })

  it('leaves Ctrl+Shift+F to sidebar search and Ctrl+Alt+F alone', () => {
    expect(findShortcut(key('F', { ctrlKey: true, shiftKey: true }), false, false)).toBeUndefined()
    expect(findShortcut(key('f', { ctrlKey: true, altKey: true }), false, false)).toBeUndefined()
  })

  it('steps with F3, Shift+F3, and ⌘G / ⌘⇧G on macOS', () => {
    expect(findShortcut(key('F3'), false, true)).toBe('next')
    expect(findShortcut(key('F3', { shiftKey: true }), false, true)).toBe('prev')
    expect(findShortcut(key('F3', { ctrlKey: true }), false, true)).toBeUndefined()
    expect(findShortcut(key('g', { metaKey: true }), true, true)).toBe('next')
    expect(findShortcut(key('G', { metaKey: true, shiftKey: true }), true, true)).toBe('prev')
    expect(findShortcut(key('g', { ctrlKey: true }), false, true)).toBeUndefined()
  })

  it('closes with Esc only while open', () => {
    expect(findShortcut(key('Escape'), false, true)).toBe('close')
    expect(findShortcut(key('Escape'), false, false)).toBeUndefined()
    expect(findShortcut(key('Escape', { shiftKey: true }), false, true)).toBeUndefined()
  })

  it('handles Enter, Shift+Enter and Esc in the find box, but not while composing', () => {
    expect(findInputKey(key('Enter'))).toBe('next')
    expect(findInputKey(key('Enter', { shiftKey: true }))).toBe('prev')
    expect(findInputKey(key('Enter', { ctrlKey: true }))).toBeUndefined()
    expect(findInputKey(key('Escape'))).toBe('close')
    expect(findInputKey({ ...key('Enter'), isComposing: true })).toBeUndefined()
    expect(findInputKey(key('a'))).toBeUndefined()
  })
})
