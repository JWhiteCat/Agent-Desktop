import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import { Markdown, MarkdownDirectoryContext } from '../src/renderer/src/components/items/Markdown'
import { openMarkdownLink } from '../src/renderer/src/lib/markdown-links'

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

describe('Markdown artifact link rendering', () => {
  it('preserves the reported Windows preview link instead of erasing its href', () => {
    expect(render(`[查看界面预览](${previewPath})`)).toContain(`<a href="${previewPath}">查看界面预览</a>`)
  })

  it('preserves an encoded file URL', () => {
    const href = 'file:///D:/my%20project/preview.png'
    expect(render(`[Preview](${href})`)).toContain(`<a href="${href}">Preview</a>`)
  })

  it.each(['main.ts:12', 'main.ts:12:3'])('preserves relative source location %s with a conversation directory', (href) => {
    expect(render(`[Code](${href})`, 'D:/project/worktree')).toContain(`<a href="${href}">Code</a>`)
  })

  it.each([
    ['javascript:123', ''], ['data:123', ''], ['mailto:123', 'mailto:123']
  ])('keeps the default URL filter for numeric protocol target %s even with a directory', (href, expected) => {
    expect(render(`[Preview](${href})`, 'D:/project/worktree')).toContain(`<a href="${expected}">Preview</a>`)
  })

  it.each(['javascript:alert%281%29', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox%281%29'])
    ('keeps filtering unsafe anchor URLs: %s', (href) => {
      expect(render(`[Preview](${href})`)).toContain('<a href="">Preview</a>')
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
