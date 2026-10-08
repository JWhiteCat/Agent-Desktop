import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from '../src/renderer/src/lib/clipboard'

afterEach(() => vi.unstubAllGlobals())

function fallbackDocument(copyResult = true) {
  const parent = { parentElement: null, scrollLeft: 12, scrollTop: 34 }
  const active = {
    tagName: 'TEXTAREA', parentElement: parent,
    selectionStart: 2, selectionEnd: 8, selectionDirection: 'backward',
    focus: vi.fn(), setSelectionRange: vi.fn()
  }
  const savedRange = { saved: true }
  const anchor = {}, focus = {}
  const selection = {
    rangeCount: 1, anchorNode: anchor, anchorOffset: 8, focusNode: focus, focusOffset: 2,
    getRangeAt: vi.fn(() => ({ cloneRange: vi.fn(() => savedRange) })),
    removeAllRanges: vi.fn(), addRange: vi.fn(), setBaseAndExtent: vi.fn()
  }
  const textarea = {
    value: '', style: { cssText: '' }, setAttribute: vi.fn(), remove: vi.fn(),
    focus: vi.fn(() => {
      documentMock.activeElement = textarea as unknown as typeof active
      windowMock.scrollY = 700
      parent.scrollTop = 900
    }),
    select: vi.fn()
  }
  const documentMock = {
    activeElement: active,
    body: { appendChild: vi.fn() },
    createElement: vi.fn(() => textarea),
    getSelection: vi.fn(() => selection),
    execCommand: vi.fn(() => copyResult)
  }
  const windowMock = { scrollX: 10, scrollY: 20, scrollTo: vi.fn() }
  vi.stubGlobal('navigator', {})
  vi.stubGlobal('document', documentMock)
  vi.stubGlobal('window', windowMock)
  return { active, parent, selection, savedRange, anchor, focus, textarea, documentMock, windowMock }
}

describe('client clipboard copying', () => {
  it('uses the current browser Clipboard API without creating fallback elements', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const createElement = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('document', { createElement })

    await copyText('https://example.com/file?a=1#part')

    expect(writeText).toHaveBeenCalledExactlyOnceWith('https://example.com/file?a=1#part')
    expect(createElement).not.toHaveBeenCalled()
  })

  it('falls back on HTTP clients and restores input/DOM selection, focus and scrolling', async () => {
    const state = fallbackDocument()
    await copyText('D:\\my project\\README.md')

    expect(state.textarea.value).toBe('D:\\my project\\README.md')
    expect(state.documentMock.body.appendChild).toHaveBeenCalledExactlyOnceWith(state.textarea)
    expect(state.textarea.select).toHaveBeenCalledOnce()
    expect(state.documentMock.execCommand).toHaveBeenCalledExactlyOnceWith('copy')
    expect(state.textarea.remove).toHaveBeenCalledOnce()
    expect(state.active.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
    expect(state.active.setSelectionRange).toHaveBeenCalledExactlyOnceWith(2, 8, 'backward')
    expect(state.selection.removeAllRanges).toHaveBeenCalledOnce()
    expect(state.selection.addRange).toHaveBeenCalledExactlyOnceWith(state.savedRange)
    expect(state.selection.setBaseAndExtent).toHaveBeenCalledExactlyOnceWith(state.anchor, 8, state.focus, 2)
    expect(state.parent.scrollTop).toBe(34)
    expect(state.parent.scrollLeft).toBe(12)
    expect(state.windowMock.scrollTo).toHaveBeenCalledExactlyOnceWith(10, 20)
  })

  it('falls back after the Clipboard API rejects permission', async () => {
    const state = fallbackDocument()
    const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    await copyText('https://example.com')

    expect(writeText).toHaveBeenCalledExactlyOnceWith('https://example.com')
    expect(state.documentMock.execCommand).toHaveBeenCalledExactlyOnceWith('copy')
    expect(state.textarea.remove).toHaveBeenCalledOnce()
  })

  it('rejects an unsuccessful fallback and still cleans up and restores selection', async () => {
    const state = fallbackDocument(false)
    await expect(copyText('/tmp/file')).rejects.toThrow('Clipboard copying failed')
    expect(state.textarea.remove).toHaveBeenCalledOnce()
    expect(state.active.focus).toHaveBeenCalledOnce()
    expect(state.active.setSelectionRange).toHaveBeenCalledExactlyOnceWith(2, 8, 'backward')
    expect(state.selection.addRange).toHaveBeenCalledExactlyOnceWith(state.savedRange)
    expect(state.windowMock.scrollTo).toHaveBeenCalledExactlyOnceWith(10, 20)
  })

  it('cleans up and restores focus when execCommand throws', async () => {
    const state = fallbackDocument()
    state.documentMock.execCommand.mockImplementation(() => { throw new Error('Blocked') })

    await expect(copyText('a')).rejects.toThrow('Blocked')

    expect(state.textarea.remove).toHaveBeenCalledOnce()
    expect(state.active.focus).toHaveBeenCalledOnce()
    expect(state.selection.addRange).toHaveBeenCalledExactlyOnceWith(state.savedRange)
  })

  it('copies when the document has no active element or DOM selection', async () => {
    const state = fallbackDocument()
    vi.stubGlobal('document', {
      ...state.documentMock,
      activeElement: null,
      getSelection: () => null
    })

    await copyText('https://example.com')

    expect(state.documentMock.execCommand).toHaveBeenCalledExactlyOnceWith('copy')
    expect(state.textarea.remove).toHaveBeenCalledOnce()
    expect(state.active.focus).not.toHaveBeenCalled()
  })

  it('reports when neither browser copy mechanism is available', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', { body: {} })
    await expect(copyText('a')).rejects.toThrow('Clipboard copying is unavailable')
  })
})
