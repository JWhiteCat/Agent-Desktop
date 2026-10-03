import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_MESSAGE_ATTACHMENT_BYTES, type AttachmentRef } from '../src/shared/attachments'
import { DEFAULT_SETTINGS, type SendRequest, type ThreadMeta } from '../src/shared/types'
import { setLanguage } from '../src/shared/i18n'
import { attachmentBlob, appendDraftAttachments, fileBase64, isPreviewImage, textSendOptions, uploadDraftAttachments } from '../src/renderer/src/lib/attachments'
import { UserMessage } from '../src/renderer/src/components/items/Messages'

beforeEach(() => setLanguage('zh-CN', 'zh-CN'))
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('system', 'zh-CN')
})

function fileOfSize(name: string, size: number): File {
  return { name, size, type: 'application/octet-stream' } as File
}

describe('attachment drafts', () => {
  it('accepts files at each size boundary, including empty files', () => {
    const drafts = appendDraftAttachments([], [fileOfSize('first', MAX_ATTACHMENT_BYTES), fileOfSize('second', MAX_ATTACHMENT_BYTES)])
    expect(drafts).toHaveLength(2)
    expect(drafts.reduce((sum, draft) => sum + draft.file.size, 0)).toBe(MAX_MESSAGE_ATTACHMENT_BYTES)
    expect(appendDraftAttachments([], [fileOfSize('empty.txt', 0)])).toHaveLength(1)
  })

  it('rejects a complete batch without mutating existing drafts', () => {
    const drafts = appendDraftAttachments([], [fileOfSize('existing', MAX_ATTACHMENT_BYTES)])
    expect(() => appendDraftAttachments(drafts, [fileOfSize('too-big', MAX_ATTACHMENT_BYTES + 1)])).toThrow('10 MiB')
    expect(() => appendDraftAttachments(drafts, [fileOfSize('next', MAX_ATTACHMENT_BYTES), fileOfSize('extra', 1)])).toThrow('20 MiB')
    expect(drafts).toHaveLength(1)
    expect(drafts[0].file.name).toBe('existing')
  })

  it('counts existing files when checking the ten-file limit', () => {
    const drafts = appendDraftAttachments([], Array.from({ length: MAX_ATTACHMENTS }, (_, i) => fileOfSize(`${i}`, 1)))
    expect(() => appendDraftAttachments(drafts, [fileOfSize('extra', 0)])).toThrow('10 个附件')
    expect(new Set(drafts.map((draft) => draft.key)).size).toBe(MAX_ATTACHMENTS)
  })

  it('uploads binary and empty files without converting bytes to text', async () => {
    const bytes = new Uint8Array([0, 255, 128, 65])
    const file = new File([bytes], '图像.bin', { type: 'application/octet-stream' })
    expect(await fileBase64(file)).toBe('AP+AQQ==')
    expect(await fileBase64(new File([], 'empty'))).toBe('')
    expect(new Uint8Array(await attachmentBlob({ data: 'AP+AQQ==', mimeType: file.type }).arrayBuffer())).toEqual(bytes)
  })

  it('retains completed uploads after a later file fails, then resumes without duplication', async () => {
    const drafts = appendDraftAttachments([], [new File(['one'], 'one.txt'), new File(['two'], 'two.txt')])
    const upload = vi.fn()
      .mockResolvedValueOnce({ id: 'one', name: 'one.txt', size: 3, mimeType: 'text/plain' } satisfies AttachmentRef)
      .mockRejectedValueOnce(new Error('Disconnected'))
      .mockResolvedValueOnce({ id: 'two', name: 'two.txt', size: 3, mimeType: 'text/plain' } satisfies AttachmentRef)
    const changed = vi.fn()

    await expect(uploadDraftAttachments(drafts, upload, changed)).rejects.toThrow('Disconnected')
    expect(drafts[0].uploaded?.id).toBe('one')
    expect(drafts[1].status).toBe('error')
    expect(drafts[1].error).toBe('Disconnected')

    await expect(uploadDraftAttachments(drafts, upload, changed)).resolves.toEqual(['one', 'two'])
    expect(upload.mock.calls.map(([request]) => request.name)).toEqual(['one.txt', 'two.txt', 'two.txt'])
    await expect(uploadDraftAttachments(drafts, upload)).resolves.toEqual(['one', 'two'])
    expect(upload).toHaveBeenCalledTimes(3)
    expect(drafts.every((draft) => draft.status === 'ready' && !draft.error)).toBe(true)
  })

  it('strips files from imperative question/plan sends, including explicit patches', () => {
    const opts = { model: 'composer-2.5[fast=true]', mode: 'plan' as const, force: false, attachmentIds: ['draft'] }
    expect(textSendOptions(opts)).toEqual({ model: opts.model, mode: 'plan', force: false })
    expect(textSendOptions(opts, { mode: 'agent', attachmentIds: ['patch'] })).toEqual({ model: opts.model, mode: 'agent', force: false })
    expect(opts.attachmentIds).toEqual(['draft'])
  })

  it('previews only supported raster types and leaves active content as a file', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) expect(isPreviewImage(type)).toBe(true)
    for (const type of ['image/svg+xml', 'text/html', 'application/pdf', 'image/bmp', '']) expect(isPreviewImage(type)).toBe(false)
  })
})

describe('attachment messages', () => {
  const attachment: AttachmentRef = { id: 'file', name: 'design <draft>.pdf', size: 1024, mimeType: 'application/pdf' }

  it('renders attachment-only messages without an empty text bubble and offers a download', () => {
    const html = renderToStaticMarkup(createElement(UserMessage, {
      item: { id: 'user', kind: 'user', text: '', createdAt: 1, attachments: [attachment] }
    }))
    expect(html).toContain('design &lt;draft&gt;.pdf')
    expect(html).toContain('attachment-download')
    expect(html).not.toContain('class="bubble"')
    expect(html).not.toContain('title="复制"')
  })

  it('keeps existing text-only messages unchanged', () => {
    const html = renderToStaticMarkup(createElement(UserMessage, {
      item: { id: 'user', kind: 'user', text: 'Hello', createdAt: 1 }
    }))
    expect(html).toContain('<div class="bubble">Hello</div>')
    expect(html).toContain('title="复制"')
    expect(html).not.toContain('message-attachments')
  })
})

describe('new attachment conversations', () => {
  let state: typeof import('../src/renderer/src/store/state')
  let threads: typeof import('../src/renderer/src/store/threads')
  const created: ThreadMeta = {
    id: 'new', projectId: 'project', title: 'New', cli: 'cursor',
    createdAt: 1, updatedAt: 1, source: 'app', mode: 'agent'
  }
  const opts = { model: 'composer-2.5[fast=true]', mode: 'agent' as const, force: false, attachmentIds: ['file'] }
  const api = { createThread: vi.fn(), send: vi.fn(), getItems: vi.fn(), deleteThread: vi.fn() }

  beforeEach(async () => {
    vi.resetModules()
    vi.resetAllMocks()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
    vi.stubGlobal('window', { api })
    state = await import('../src/renderer/src/store/state')
    threads = await import('../src/renderer/src/store/threads')
    state.setState({
      app: { projects: [], threads: [], settings: DEFAULT_SETTINGS, running: [] },
      view: { kind: 'home', projectId: 'project' }, items: {}
    })
    api.createThread.mockResolvedValue(created)
    api.deleteThread.mockResolvedValue(undefined)
  })

  it('forwards attachments and waits for send acceptance before navigating', async () => {
    let accept!: () => void
    api.send.mockReturnValue(new Promise<void>((resolve) => { accept = resolve }))
    const starting = threads.startThread('project', '', opts)
    await vi.waitFor(() => expect(api.send).toHaveBeenCalledOnce())
    expect(state.getState().view).toEqual({ kind: 'home', projectId: 'project' })
    expect(api.send).toHaveBeenCalledWith({ threadId: 'new', prompt: '', ...opts } satisfies SendRequest)
    accept()
    await starting
    expect(state.getState().view).toEqual({ kind: 'thread', id: 'new' })
    expect(api.deleteThread).not.toHaveBeenCalled()
  })

  it('leaves Home mounted and removes a proven empty thread on first-send rejection', async () => {
    api.send.mockRejectedValue(new Error('No agent'))
    api.getItems.mockResolvedValue([])
    await expect(threads.startThread('project', 'draft', opts)).rejects.toThrow('No agent')
    expect(state.getState().view).toEqual({ kind: 'home', projectId: 'project' })
    expect(api.deleteThread).toHaveBeenCalledExactlyOnceWith('new')
    expect(state.getState().app.threads).toEqual([])
    expect(state.getState().items.new).toBeUndefined()
  })

  it.each(['nonempty', 'disconnected'])('does not delete an uncertain %s new conversation', async (condition) => {
    api.send.mockRejectedValue(new Error('Disconnected'))
    if (condition === 'nonempty') api.getItems.mockResolvedValue([{ kind: 'user', text: 'draft' }])
    else api.getItems.mockRejectedValue(new Error('Disconnected'))
    await expect(threads.startThread('project', 'draft', opts)).rejects.toThrow('Disconnected')
    expect(state.getState().view.kind).toBe('home')
    expect(api.deleteThread).not.toHaveBeenCalled()
    expect(state.getState().app.threads).toContainEqual(created)
  })
})
