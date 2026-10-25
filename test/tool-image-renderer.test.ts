import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import { MAX_ATTACHMENT_BYTES } from '../src/shared/attachments'
import type { ToolItem } from '../src/shared/types'
import { ToolRow } from '../src/renderer/src/components/items/ToolRow'
import { copyBrowserImage, imagePng } from '../src/renderer/src/lib/tool-image-clipboard'

beforeEach(() => setLanguage('zh-CN'))
afterEach(() => { vi.unstubAllGlobals(); setLanguage('system', 'zh-CN') })
const source = (type = 'image/png') => new Blob(['image'], { type })

function decoder(width = 20, height = 10, output: Blob | null = source()) {
  const bitmap = { width, height, close: vi.fn() }
  const context = { drawImage: vi.fn() }
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context), toBlob: vi.fn((cb: (x: Blob | null) => void, _type?: string) => cb(output)) }
  const decode = vi.fn(async () => bitmap)
  vi.stubGlobal('createImageBitmap', decode)
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })
  return { bitmap, context, canvas, decode }
}

describe('tool image PNG conversion', () => {
  it('copies original dimensions, not CSS preview size, then releases decoded bitmap', async () => {
    const { bitmap, context, canvas } = decoder(600, 300)
    const png = await imagePng(source('image/jpeg'))
    expect(png.type).toBe('image/png')
    expect(canvas.width).toBe(600); expect(canvas.height).toBe(300)
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0)
    expect(canvas.toBlob.mock.calls[0][1]).toBe('image/png')
    expect(bitmap.close).toHaveBeenCalledOnce()
  })
  it.each(['image/webp', 'image/gif'])('normalizes %s as a static PNG', async (type) => {
    const { bitmap } = decoder()
    expect((await imagePng(source(type))).type).toBe('image/png')
    expect(bitmap.close).toHaveBeenCalledOnce()
  })
  it.each(['text/html', 'image/svg+xml', 'application/octet-stream'])('rejects unsupported %s before decoding', async (type) => {
    const { decode } = decoder()
    await expect(imagePng(source(type))).rejects.toThrow('格式')
    expect(decode).not.toHaveBeenCalled()
  })
  it('rejects empty and oversized bytes before decoding', async () => {
    const { decode } = decoder()
    await expect(imagePng(new Blob([], { type: 'image/png' }))).rejects.toThrow()
    await expect(imagePng(new Blob([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], { type: 'image/png' }))).rejects.toThrow()
    expect(decode).not.toHaveBeenCalled()
  })
  it.each([[0, 10], [32769, 1], [8000, 8000]])('rejects unsafe dimensions %ix%i and releases bitmap', async (width, height) => {
    const { bitmap, context } = decoder(width, height)
    await expect(imagePng(source())).rejects.toThrow('尺寸')
    expect(context.drawImage).not.toHaveBeenCalled()
    expect(bitmap.close).toHaveBeenCalledOnce()
  })
  it('accepts the pixel limit exactly', async () => {
    const { bitmap } = decoder(8000, 4000)
    await imagePng(source())
    expect(bitmap.close).toHaveBeenCalledOnce()
  })
  it('releases bitmap if canvas unavailable', async () => {
    const { bitmap, canvas } = decoder()
    canvas.getContext.mockReturnValue(null as any)
    await expect(imagePng(source())).rejects.toThrow('解码')
    expect(bitmap.close).toHaveBeenCalledOnce()
  })
  it('releases bitmap on encoder failure', async () => {
    const { bitmap } = decoder(20, 10, null)
    await expect(imagePng(source())).rejects.toThrow('解码')
    expect(bitmap.close).toHaveBeenCalledOnce()
  })
  it('rejects PNG expansion past byte limit and releases bitmap', async () => {
    const { bitmap } = decoder(20, 10, new Blob([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], { type: 'image/png' }))
    await expect(imagePng(source())).rejects.toThrow('10 MiB')
    expect(bitmap.close).toHaveBeenCalledOnce()
  })
  it('reports unavailable browser decoder without attempting network access', async () => {
    vi.stubGlobal('createImageBitmap', undefined)
    await expect(imagePng(source())).rejects.toThrow('浏览器')
  })
})

describe('tool image browser clipboard', () => {
  const setup = (secure = true) => {
    const write = vi.fn(async (_: unknown) => {})
    class Item { constructor(public entries: Record<string, Blob>) {} }
    vi.stubGlobal('ClipboardItem', Item)
    vi.stubGlobal('isSecureContext', secure)
    vi.stubGlobal('navigator', { clipboard: { write } })
    return { write, Item }
  }
  it('writes PNG bytes on the viewing device, not a URL or base64 string', async () => {
    const { write, Item } = setup()
    const png = source()
    await copyBrowserImage(png)
    const value = (write.mock.calls[0][0] as InstanceType<typeof Item>[])[0]
    expect(value).toBeInstanceOf(Item)
    expect(Object.keys(value.entries)).toEqual(['image/png'])
    expect(value.entries['image/png']).toBe(png)
  })
  it('invokes write synchronously within the click activation before waiting', async () => {
    const { write } = setup()
    const pending = copyBrowserImage(source())
    expect(write).toHaveBeenCalledOnce()
    await pending
  })
  it('does not claim success or change to server clipboard after browser denial', async () => {
    const { write } = setup()
    write.mockRejectedValueOnce(new Error('denied'))
    await expect(copyBrowserImage(source())).rejects.toThrow('denied')
    expect(write).toHaveBeenCalledOnce()
  })
  it('rejects insecure contexts without invoking clipboard', async () => {
    const { write } = setup(false)
    await expect(copyBrowserImage(source())).rejects.toThrow('HTTPS')
    expect(write).not.toHaveBeenCalled()
  })
  it('rejects unavailable ClipboardItem and clipboard API', async () => {
    setup(); vi.stubGlobal('ClipboardItem', undefined)
    await expect(copyBrowserImage(source())).rejects.toThrow('HTTPS')
    setup(); vi.stubGlobal('navigator', {})
    await expect(copyBrowserImage(source())).rejects.toThrow('HTTPS')
  })
  it.each(['image/jpeg', 'image/gif', 'text/plain'])('rejects non-PNG %s', async (type) => {
    const { write } = setup()
    await expect(copyBrowserImage(source(type))).rejects.toThrow('PNG')
    expect(write).not.toHaveBeenCalled()
  })
})

describe('collapsed tool rows', () => {
  // SSR covers markup only; tool-images-electron.test.ts exercises mounted effects.
  it('renders the collapsed read summary without image markup', () => {
    const item: ToolItem = { id: 't', kind: 'tool', callId: 'c', tool: 'read', args: { path: '/project/image.png' }, status: 'success', startedAt: 0,
      images: [{ id: 'image', key: 'k', name: 'image.png', mimeType: 'image/png', size: 123, sourceKind: 'file' }] }
    const html = renderToStaticMarkup(createElement(ToolRow, { item, threadId: 'thread' }))
    expect(html).toContain('已读取'); expect(html).toContain('image.png')
    expect(html).not.toContain('<img'); expect(html).not.toContain('tool-images')
  })
})
