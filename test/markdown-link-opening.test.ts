import { createElement } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as jsxDevRuntime from 'react/jsx-dev-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import { Markdown, MarkdownDirectoryContext } from '../src/renderer/src/components/items/Markdown'
import { openMarkdownLink } from '../src/renderer/src/lib/markdown-links'

vi.mock('react/jsx-runtime', { spy: true })
vi.mock('react/jsx-dev-runtime', { spy: true })

const feedback = vi.hoisted(() => ({ toast: vi.fn() }))

vi.mock('../src/renderer/src/store/feedback', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/renderer/src/store/feedback')>(),
  toast: feedback.toast
}))

const previewPath = 'D:/projects/game/artifacts/strategy-panel-1920x1080.png'
const nativePreviewPath = 'D:\\projects\\game\\artifacts\\strategy-panel-1920x1080.png'
const api = { openPath: vi.fn(), openExternal: vi.fn(), isRemote: false }

beforeEach(() => {
  setLanguage('zh-CN', 'zh-CN')
  feedback.toast.mockClear()
  api.openPath.mockReset().mockResolvedValue(undefined)
  api.openExternal.mockReset().mockResolvedValue(undefined)
  api.isRemote = false
  vi.stubGlobal('window', { api })
})

afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('system', 'zh-CN')
})

function render(text: string, cwd?: string): string {
  return renderToStaticMarkup(createElement(MarkdownDirectoryContext.Provider, { value: cwd },
    createElement(Markdown, { text })))
}

function expectAnchor(html: string, href: string, label: string): void {
  const anchor = /<a\b[^>]*>.*?<\/a>/.exec(html)?.[0]
  expect(anchor).toContain(`href="${href}"`)
  expect(anchor).toContain(`>${label}</a>`)
}

/** Capture the actual rendered anchor without replacing Markdown or its opener. */
async function renderedLinkAnchor(text: string, cwd?: string) {
  type AnchorProps = {
    onClick?: (event: { preventDefault: () => void }) => void
    onContextMenu?: (event: {
      preventDefault: () => void; stopPropagation: () => void; defaultPrevented: boolean
      clientX: number; clientY: number
    }) => void
  }
  const anchors: AnchorProps[] = []
  const original = await vi.importActual<typeof jsxRuntime>('react/jsx-runtime')
  const originalDev = await vi.importActual<typeof jsxDevRuntime>('react/jsx-dev-runtime')
  const spy = vi.mocked(jsxRuntime.jsx).mockImplementation((type, props, key) => {
    if (type === 'a') anchors.push(props as AnchorProps)
    return original.jsx(type, props, key)
  })
  const devSpy = jsxDevRuntime.jsxDEV && vi.mocked(jsxDevRuntime.jsxDEV).mockImplementation((type, props, key, ...args) => {
    if (type === 'a') anchors.push(props as AnchorProps)
    return originalDev.jsxDEV(type, props, key, ...args)
  })
  try {
    render(text, cwd)
    expect(anchors).toHaveLength(1)
    expect(anchors[0].onClick).toBeTypeOf('function')
    return anchors[0]
  } finally {
    spy.mockRestore()
    devSpy?.mockRestore()
  }
}

async function renderedLinkClick(text: string, cwd?: string) {
  return (await renderedLinkAnchor(text, cwd)).onClick!
}

describe('Markdown artifact link rendering', () => {
  it('preserves the reported Windows preview link instead of erasing its href', () => {
    const html = render(`[查看界面预览](${previewPath})`)
    expectAnchor(html, previewPath, '查看界面预览')
    expect(html).toContain(`<span class="hover-tip-copy">${nativePreviewPath}</span>`)
  })

  it('preserves an encoded file URL', () => {
    const href = 'file:///D:/my%20project/preview.png'
    const html = render(`[Preview](${href})`)
    expectAnchor(html, href, 'Preview')
    expect(html).toContain('<span class="hover-tip-copy">D:\\my project\\preview.png</span>')
  })

  it.each(['main.ts:12', 'main.ts:12:3'])('preserves relative source location %s with a conversation directory', (href) => {
    const html = render(`[Code](${href})`, 'D:/project/worktree')
    expectAnchor(html, href, 'Code')
    expect(html).toContain('<span class="hover-tip-copy">D:\\project\\worktree\\main.ts</span>')
  })

  it('displays a relative artifact as the full decoded path inside its worktree', () => {
    const href = 'artifacts/preview%20%E9%A2%84%E8%A7%88.png'
    const html = render(`[Preview](${href})`, 'D:/project/worktree')
    expectAnchor(html, href, 'Preview')
    expect(html).toContain('<span class="hover-tip-copy">D:\\project\\worktree\\artifacts\\preview 预览.png</span>')
  })

  it('displays a complete web URL while retaining its query and fragment', () => {
    const href = 'https://example.com/preview?theme=dark#panel'
    const html = render(`[Website](${href})`, 'D:/project/worktree')
    expectAnchor(html, href, 'Website')
    expect(html).toContain(`<span class="hover-tip-copy">${href}</span>`)
  })

  it.each([
    ['javascript:123', ''], ['data:123', ''], ['mailto:123', 'mailto:123']
  ])('keeps the default URL filter for numeric protocol target %s even with a directory', (href, expected) => {
    const html = render(`[Preview](${href})`, 'D:/project/worktree')
    expectAnchor(html, expected, 'Preview')
    if (!expected) expect(html).not.toContain('hover-tip-copy')
  })

  it.each(['javascript:alert%281%29', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox%281%29'])
    ('keeps filtering unsafe anchor URLs: %s', (href) => {
      const html = render(`[Preview](${href})`)
      expectAnchor(html, '', 'Preview')
      expect(html).not.toContain('hover-tip-copy')
    })

  it('does not relax the URL filter for image sources', () => {
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const href of [previewPath, 'file:///D:/preview.png', 'javascript:alert%281%29', 'data:image/svg+xml;base64,PHN2Zz4=']) {
        const html = render(`![Preview](${href})`)
        expect(html).toContain('<img alt="Preview"/>')
        expect(html).not.toContain('src=')
      }
    } finally {
      warning.mockRestore()
    }
  })
})

describe('opening Markdown links', () => {
  it('captures right-click on a rendered file link without invoking either opener', async () => {
    const anchor = await renderedLinkAnchor('[Preview](artifacts/preview%20image.png)', 'D:/project/worktree')
    const event = {
      preventDefault: vi.fn(), stopPropagation: vi.fn(), defaultPrevented: false,
      clientX: 120, clientY: 240
    }

    expect(anchor.onContextMenu).toBeTypeOf('function')
    anchor.onContextMenu!(event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(api.openPath).not.toHaveBeenCalled()
    expect(api.openExternal).not.toHaveBeenCalled()
    expect(feedback.toast).not.toHaveBeenCalled()
  })

  it('routes a rendered relative link through the conversation directory and prevents browser navigation', async () => {
    const click = await renderedLinkClick('[Preview](artifacts/preview%20image.png)', 'D:/project/worktree')
    const preventDefault = vi.fn()
    expect(api.openPath).not.toHaveBeenCalled()
    expect(api.openExternal).not.toHaveBeenCalled()

    click({ preventDefault })

    expect(preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(api.openPath).toHaveBeenCalledExactlyOnceWith('D:\\project\\worktree\\artifacts\\preview image.png'))
    expect(api.openExternal).not.toHaveBeenCalled()
  })

  it('routes a rendered web link through the external opener without local file access', async () => {
    const click = await renderedLinkClick('[Website](https://example.com/preview)', 'D:/project/worktree')
    const preventDefault = vi.fn()

    click({ preventDefault })

    expect(preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(api.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/preview'))
    expect(api.openPath).not.toHaveBeenCalled()
  })

  it('keeps a rendered unsafe link from navigating or invoking either opener', async () => {
    const click = await renderedLinkClick('[Preview](javascript:alert%281%29)', 'D:/project/worktree')
    const preventDefault = vi.fn()

    click({ preventDefault })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(api.openPath).not.toHaveBeenCalled()
    expect(api.openExternal).not.toHaveBeenCalled()
    expect(feedback.toast).toHaveBeenCalledExactlyOnceWith('无法打开此链接：不支持的地址格式', 'error')
  })

  it('opens the reported preview using the local file API', async () => {
    await openMarkdownLink(previewPath)

    expect(api.openPath).toHaveBeenCalledExactlyOnceWith(nativePreviewPath)
    expect(api.openExternal).not.toHaveBeenCalled()
    expect(feedback.toast).not.toHaveBeenCalled()
  })

  it('resolves relative artifact links against the conversation directory', async () => {
    await openMarkdownLink('artifacts/preview%20image.png', 'D:/project/worktree')

    expect(api.openPath).toHaveBeenCalledExactlyOnceWith('D:\\project\\worktree\\artifacts\\preview image.png')
    expect(api.openExternal).not.toHaveBeenCalled()
  })

  it('opens a source file in the conversation directory without its line position', async () => {
    await openMarkdownLink('main.ts:12', 'D:/project/worktree')

    expect(api.openPath).toHaveBeenCalledExactlyOnceWith('D:\\project\\worktree\\main.ts')
    expect(api.openExternal).not.toHaveBeenCalled()
  })

  it('converts a file URL to a decoded path before opening it', async () => {
    await openMarkdownLink('file:///D:/project/preview%20image.png')

    expect(api.openPath).toHaveBeenCalledExactlyOnceWith('D:\\project\\preview image.png')
    expect(api.openExternal).not.toHaveBeenCalled()
  })

  it.each(['https://example.com/preview', 'HTTP://localhost:5173/preview'])('opens web URL %s externally', async (href) => {
    await openMarkdownLink(href, 'D:/project')

    expect(api.openExternal).toHaveBeenCalledExactlyOnceWith(href)
    expect(api.openPath).not.toHaveBeenCalled()
    expect(feedback.toast).not.toHaveBeenCalled()
  })

  it.each([
    undefined, '', 'javascript:alert(1)', 'data:text/html,preview', 'mailto:author@example.com',
    'javascript:123', 'data:123', 'mailto:123'
  ])
    ('reports unsupported URL %s without invoking an opener', async (href) => {
      await openMarkdownLink(href, 'D:/project')

      expect(api.openPath).not.toHaveBeenCalled()
      expect(api.openExternal).not.toHaveBeenCalled()
      expect(feedback.toast).toHaveBeenCalledExactlyOnceWith('无法打开此链接：不支持的地址格式', 'error')
    })

  it('explains that a remote preview was opened on the desktop', async () => {
    api.isRemote = true

    await openMarkdownLink(previewPath)

    expect(api.openPath).toHaveBeenCalledExactlyOnceWith(nativePreviewPath)
    expect(feedback.toast).toHaveBeenCalledExactlyOnceWith('已在桌面端打开文件')
  })

  it('shows local opening failures instead of rejecting silently', async () => {
    api.isRemote = true
    api.openPath.mockRejectedValueOnce(new Error("Error invoking remote method 'shell:openPath': Error: File not found"))

    await expect(openMarkdownLink(previewPath)).resolves.toBeUndefined()

    expect(feedback.toast).toHaveBeenCalledExactlyOnceWith('无法打开链接：File not found', 'error')
    expect(api.openExternal).not.toHaveBeenCalled()
  })

  it('shows external browser opening failures', async () => {
    api.openExternal.mockRejectedValueOnce(new Error('Browser unavailable'))

    await expect(openMarkdownLink('https://example.com/preview')).resolves.toBeUndefined()

    expect(feedback.toast).toHaveBeenCalledExactlyOnceWith('无法打开链接：Browser unavailable', 'error')
  })
})
