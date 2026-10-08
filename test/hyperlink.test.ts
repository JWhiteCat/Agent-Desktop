import { createElement, type ComponentProps, type MouseEvent, type KeyboardEvent } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as jsxDevRuntime from 'react/jsx-dev-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import { Hyperlink } from '../src/renderer/src/components/Hyperlink'
import { ContextMenu, type MenuItem } from '../src/renderer/src/components/Menu'

vi.mock('react/jsx-runtime', { spy: true })
vi.mock('react/jsx-dev-runtime', { spy: true })

const actions = vi.hoisted(() => ({ copyText: vi.fn(), toast: vi.fn() }))

vi.mock('../src/renderer/src/lib/clipboard', () => ({ copyText: actions.copyText }))
vi.mock('../src/renderer/src/store/feedback', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/renderer/src/store/feedback')>(),
  toast: actions.toast
}))

type HyperlinkProps = ComponentProps<typeof Hyperlink>
type AnchorProps = ComponentProps<'a'>
type ContextMenuProps = ComponentProps<typeof ContextMenu>

const api = { openPath: vi.fn(), openExternal: vi.fn(), isRemote: false }
const getSelection = vi.fn<() => Pick<Selection, 'toString'> | null>()

beforeEach(() => {
  setLanguage('zh-CN', 'zh-CN')
  actions.copyText.mockReset().mockResolvedValue(undefined)
  actions.toast.mockReset()
  api.openPath.mockReset()
  api.openExternal.mockReset()
  api.isRemote = false
  getSelection.mockReset().mockReturnValue(null)
  vi.stubGlobal('window', { api, getSelection })
})

afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('system', 'zh-CN')
})

/** Inspect the real anchor and menu actions without replacing either component. */
async function renderedLink(props: HyperlinkProps) {
  const anchors: AnchorProps[] = []
  const menus: ContextMenuProps[] = []
  const original = await vi.importActual<typeof jsxRuntime>('react/jsx-runtime')
  const originalDev = await vi.importActual<typeof jsxDevRuntime>('react/jsx-dev-runtime')
  const capture = (type: unknown, elementProps: unknown) => {
    if (type === 'a') anchors.push(elementProps as AnchorProps)
    if (type === ContextMenu) menus.push(elementProps as ContextMenuProps)
  }
  const spy = vi.mocked(jsxRuntime.jsx).mockImplementation((type, elementProps, key) => {
    capture(type, elementProps)
    return original.jsx(type, elementProps, key)
  })
  const devSpy = jsxDevRuntime.jsxDEV && vi.mocked(jsxDevRuntime.jsxDEV).mockImplementation((type, elementProps, key, ...args) => {
    capture(type, elementProps)
    return originalDev.jsxDEV(type, elementProps, key, ...args)
  })
  try {
    const html = renderToStaticMarkup(createElement(Hyperlink, { children: 'Link', ...props }))
    expect(anchors).toHaveLength(1)
    expect(menus).toHaveLength(1)
    expect(menus[0].items).toHaveLength(1)
    return { html, anchor: anchors[0], menu: menus[0], copyItem: menus[0].items[0] as MenuItem }
  } finally {
    spy.mockRestore()
    devSpy?.mockRestore()
  }
}

function contextEvent() {
  const event = {
    defaultPrevented: false,
    preventDefault: vi.fn((): void => { event.defaultPrevented = true }),
    stopPropagation: vi.fn(),
    clientX: 120,
    clientY: 240,
    currentTarget: { getBoundingClientRect: () => ({ left: 12, bottom: 34 }) }
  }
  return event
}

describe('hyperlink addresses', () => {
  it.each([
    ['D:/project/preview%20image.png', undefined, 'D:\\project\\preview image.png'],
    ['file:///D:/my%20project/%E9%A2%84%E8%A7%88.png', undefined, 'D:\\my project\\预览.png'],
    ['artifacts/preview%20image.png', 'D:/project/worktree', 'D:\\project\\worktree\\artifacts\\preview image.png'],
    ['src/main.ts:12:3#L12C3', '/project/worktree', '/project/worktree/src/main.ts'],
    ['https://example.com/path?theme=dark#panel', 'D:/project/worktree', 'https://example.com/path?theme=dark#panel']
  ])('previews and copies the resolved address for %s', async (href, cwd, address) => {
    const { html, anchor, copyItem } = await renderedLink({ href, cwd })
    expect(anchor.href).toBe(href)
    expect(html).toContain(`<span class="hover-tip-copy">${address}</span>`)

    copyItem.onSelect()

    await vi.waitFor(() => expect(actions.copyText).toHaveBeenCalledExactlyOnceWith(address))
    expect(actions.toast).toHaveBeenCalledExactlyOnceWith('已复制链接')
    expect(api.openPath).not.toHaveBeenCalled()
    expect(api.openExternal).not.toHaveBeenCalled()
  })

  it('retains normal anchor attributes and its caller-provided click behavior', async () => {
    const onClick = vi.fn()
    const { html, anchor } = await renderedLink({
      href: 'https://example.com', target: '_blank', rel: 'noopener noreferrer',
      title: 'Original title', className: 'docs-link', 'aria-label': 'Documentation',
      cwd: '/project/worktree', onClick
    })
    expect(anchor.onClick).toBe(onClick)
    expect(anchor.target).toBe('_blank')
    expect(anchor.rel).toBe('noopener noreferrer')
    expect(html).toContain('title="Original title"')
    expect(html).toContain('class="docs-link"')
    expect(html).toContain('aria-label="Documentation"')
    expect(html).not.toContain('cwd=')
  })

  it.each([undefined, ''])('does not preview or capture a context menu for empty href %s', async (href) => {
    const { html, anchor, copyItem } = await renderedLink({ href })
    const event = contextEvent()

    anchor.onContextMenu!(event as unknown as MouseEvent<HTMLAnchorElement>)
    copyItem.onSelect()

    expect(html).not.toContain('hover-tip-copy')
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
    expect(actions.copyText).not.toHaveBeenCalled()
    expect(actions.toast).not.toHaveBeenCalled()
  })
})

describe('hyperlink copy menu', () => {
  it.each(['selected text', ' \n\t '])('lets desktop selection %j use the native context menu', async (text) => {
    getSelection.mockReturnValue({ toString: () => text })
    const onContextMenu = vi.fn()
    const { anchor } = await renderedLink({ href: 'https://example.com', onContextMenu })
    const event = contextEvent()

    anchor.onContextMenu!(event as unknown as MouseEvent<HTMLAnchorElement>)

    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
    expect(actions.copyText).not.toHaveBeenCalled()
    expect(api.openExternal).not.toHaveBeenCalled()
  })

  it.each([null, ''])('retains the desktop link menu for an empty selection %j', async (text) => {
    getSelection.mockReturnValue(text === null ? null : { toString: () => text })
    const { anchor } = await renderedLink({ href: 'https://example.com' })
    const event = contextEvent()

    anchor.onContextMenu!(event as unknown as MouseEvent<HTMLAnchorElement>)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })

  it.each(['selected text', ' \n\t '])('retains the remote link menu for selection %j', async (text) => {
    api.isRemote = true
    getSelection.mockReturnValue({ toString: () => text })
    const { anchor } = await renderedLink({ href: 'https://example.com' })
    const event = contextEvent()

    anchor.onContextMenu!(event as unknown as MouseEvent<HTMLAnchorElement>)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(actions.copyText).not.toHaveBeenCalled()
  })

  it('captures right-click without opening or copying until the menu action is selected', async () => {
    const onClick = vi.fn()
    const onContextMenu = vi.fn()
    const { anchor, copyItem } = await renderedLink({ href: 'https://example.com', onClick, onContextMenu })
    const event = contextEvent()

    anchor.onContextMenu!(event as unknown as MouseEvent<HTMLAnchorElement>)

    expect(copyItem.label).toBe('复制链接')
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(onClick).not.toHaveBeenCalled()
    expect(actions.copyText).not.toHaveBeenCalled()
    expect(api.openPath).not.toHaveBeenCalled()
    expect(api.openExternal).not.toHaveBeenCalled()
  })

  it.each([null, 'selected text'])('respects a caller that prevents the context menu event with selection %j', async (text) => {
    getSelection.mockReturnValue(text === null ? null : { toString: () => text })
    const { anchor } = await renderedLink({
      href: 'https://example.com', onContextMenu: (event) => event.preventDefault()
    })
    const event = contextEvent()

    anchor.onContextMenu!(event as unknown as MouseEvent<HTMLAnchorElement>)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).not.toHaveBeenCalled()
    expect(actions.copyText).not.toHaveBeenCalled()
  })

  it.each([
    ['ContextMenu', false], ['F10', true]
  ])('captures the keyboard menu shortcut %s with shift=%s', async (key, shiftKey) => {
    const { anchor } = await renderedLink({ href: 'https://example.com' })
    const event = { ...contextEvent(), key, shiftKey }

    anchor.onKeyDown!(event as unknown as KeyboardEvent<HTMLAnchorElement>)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(actions.copyText).not.toHaveBeenCalled()
    expect(api.openExternal).not.toHaveBeenCalled()
  })

  it.each([
    ['ContextMenu', false, 'selected text'], ['ContextMenu', false, ' \n\t '],
    ['F10', true, 'selected text'], ['F10', true, ' \n\t ']
  ] as const)('lets desktop selection use the native keyboard menu for %s with shift=%s (%j)', async (key, shiftKey, text) => {
    getSelection.mockReturnValue({ toString: () => text })
    const onKeyDown = vi.fn()
    const { anchor } = await renderedLink({ href: 'https://example.com', onKeyDown })
    const event = { ...contextEvent(), key, shiftKey }

    anchor.onKeyDown!(event as unknown as KeyboardEvent<HTMLAnchorElement>)

    expect(onKeyDown).toHaveBeenCalledExactlyOnceWith(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
    expect(actions.copyText).not.toHaveBeenCalled()
  })

  it.each([
    ['ContextMenu', false], ['F10', true]
  ])('retains the remote keyboard menu for selected text via %s with shift=%s', async (key, shiftKey) => {
    api.isRemote = true
    getSelection.mockReturnValue({ toString: () => 'selected text' })
    const { anchor } = await renderedLink({ href: 'https://example.com' })
    const event = { ...contextEvent(), key, shiftKey }

    anchor.onKeyDown!(event as unknown as KeyboardEvent<HTMLAnchorElement>)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })

  it.each([
    ['ContextMenu', false], ['F10', true]
  ])('respects a caller that prevents the keyboard menu via %s with shift=%s', async (key, shiftKey) => {
    getSelection.mockReturnValue({ toString: () => 'selected text' })
    const { anchor } = await renderedLink({
      href: 'https://example.com', onKeyDown: (event) => event.preventDefault()
    })
    const event = { ...contextEvent(), key, shiftKey }

    anchor.onKeyDown!(event as unknown as KeyboardEvent<HTMLAnchorElement>)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).not.toHaveBeenCalled()
    expect(actions.copyText).not.toHaveBeenCalled()
  })

  it('reports a failed copy without opening the link or showing success', async () => {
    actions.copyText.mockRejectedValueOnce(new Error('Clipboard copying failed'))
    const { copyItem } = await renderedLink({ href: 'https://example.com' })

    copyItem.onSelect()

    await vi.waitFor(() => expect(actions.toast).toHaveBeenCalledExactlyOnceWith('无法复制链接：Clipboard copying failed', 'error'))
    expect(api.openPath).not.toHaveBeenCalled()
    expect(api.openExternal).not.toHaveBeenCalled()
  })

  it('localizes the copy action and its success feedback in English', async () => {
    setLanguage('en')
    const { copyItem } = await renderedLink({ href: 'https://example.com' })
    expect(copyItem.label).toBe('Copy link')

    copyItem.onSelect()

    await vi.waitFor(() => expect(actions.toast).toHaveBeenCalledExactlyOnceWith('Link copied'))
  })

  it('localizes copy failure feedback in English', async () => {
    setLanguage('en')
    actions.copyText.mockRejectedValueOnce(new Error('Unavailable'))
    const { copyItem } = await renderedLink({ href: 'https://example.com' })

    copyItem.onSelect()

    await vi.waitFor(() => expect(actions.toast).toHaveBeenCalledExactlyOnceWith('Could not copy the link: Unavailable', 'error'))
  })
})
