import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type CliProvider, type Item, type SendRequest, type ThreadMeta } from '../src/shared/types'
import { MAX_MESSAGE_ATTACHMENT_BYTES, type AttachmentRef } from '../src/shared/attachments'
import { parseAttachmentPrompt } from '../src/shared/attachment-message'
import { parseForkPrompt } from '../src/main/fork-context'
import type { Store } from '../src/main/store'
import { spawnCli } from '../src/main/cli'
import { spawnCodexAcp } from '../src/main/codex'
import { spawnClaudeAcp } from '../src/main/claude'
import { SessionManager } from '../src/main/sessions'

const attachmentStore = vi.hoisted(() => ({
  resolveMany: vi.fn(), pathFor: vi.fn(), read: vi.fn(), scopedRead: vi.fn(), retain: vi.fn()
}))
vi.mock('../src/main/attachments', () => ({ attachmentsFor: () => attachmentStore }))
vi.mock('../src/main/skills', () => ({ syncAllManagedSkills: vi.fn() }))
vi.mock('../src/main/cli', async (original) => ({
  ...await original<typeof import('../src/main/cli')>(),
  resolveCli: vi.fn(() => ({ command: 'mock-agent', prefixArgs: [] })),
  resolveApiKey: vi.fn(() => 'configured-key'),
  spawnCli: vi.fn(),
  killTree: vi.fn((child: ChildProcess) => child.emit('close', 0))
}))
vi.mock('../src/main/codex', async (original) => ({
  ...await original<typeof import('../src/main/codex')>(),
  resolveCodex: vi.fn(() => ({ bundled: true, display: 'Codex', acpEntry: '/mock/codex.js' })),
  resolveCodexApiKey: vi.fn(() => 'configured-key'),
  spawnCodexAcp: vi.fn()
}))
vi.mock('../src/main/claude', async (original) => ({
  ...await original<typeof import('../src/main/claude')>(),
  resolveClaude: vi.fn(() => ({ bundled: true, display: 'Claude', acpEntry: '/mock/claude.js' })),
  resolveClaudeApiKey: vi.fn(() => 'configured-key'),
  spawnClaudeAcp: vi.fn()
}))

const image: AttachmentRef = { id: 'f5a9c682-d5a5-4d13-bad3-1eb65a41a1cf', name: 'screen.png', mimeType: 'image/png', size: 5 }
const document: AttachmentRef = { id: 'aac431a3-8ff5-4718-9528-cf56229f81ec', name: 'report.pdf', mimeType: 'application/pdf', size: 8 }
const originalPath = (id: string) => path.join(os.tmpdir(), 'managed-attachments', id, id === image.id ? 'screen.png' : 'report.pdf')
const managers: SessionManager[] = []

function setup(provider: CliProvider = 'cursor', imageSupport: boolean | null = true) {
  const calls: Array<{ method: string; params: any }> = []
  const reply = vi.fn(async (method: string, _params: any): Promise<any> => {
    if (method === 'initialize') return { agentCapabilities: { promptCapabilities: { image: imageSupport ?? undefined } } }
    if (method === 'session/new') return { sessionId: 'attachment-session' }
    if (method === 'session/prompt') return { stopReason: 'end_turn' }
    return {}
  })
  const stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdout, stderr: new PassThrough(), exitCode: null,
    stdin: new Writable({ write(chunk, _encoding, callback) {
      const message = JSON.parse(chunk.toString())
      calls.push({ method: message.method, params: message.params })
      void reply(message.method, message.params).then((result) => {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
      })
      callback()
    } })
  }) as unknown as ChildProcess
  vi.mocked(spawnCli).mockReturnValue(child)
  vi.mocked(spawnCodexAcp).mockReturnValue(child)
  vi.mocked(spawnClaudeAcp).mockReturnValue(child)
  const items: Item[] = []
  const thread = { id: 'thread', projectId: 'project', title: '新对话', titleKind: 'default', cli: provider, mode: 'ask', source: 'app' } as ThreadMeta
  const store = {
    dataDir: path.join(os.tmpdir(), 'managed-attachments'), threads: [thread],
    settings: { ...DEFAULT_SETTINGS },
    thread: () => thread, project: () => ({ id: 'project', path: os.tmpdir() }),
    items: () => items, markItemsDirty: vi.fn(),
    updateThread: vi.fn((_id: string, patch: Partial<ThreadMeta>) => Object.assign(thread, patch))
  }
  const emit = vi.fn()
  const finished = vi.fn()
  const manager = new SessionManager(store as unknown as Store, emit, vi.fn(), finished)
  managers.push(manager)
  const req: SendRequest = { threadId: 'thread', prompt: 'Review the attachments', model: 'composer-2.5[fast=true]', mode: 'ask', force: false,
    attachmentIds: [image.id, document.id] }
  const send = async () => {
    await manager.send(req)
    await vi.waitFor(() => expect(finished).toHaveBeenCalled())
  }
  return { calls, reply, items, thread, store, emit, manager, req, send, finished }
}

beforeEach(() => {
  vi.clearAllMocks()
  attachmentStore.resolveMany.mockImplementation((ids: string[]) => ids.map((id) => {
    const ref = [image, document].find((ref) => ref.id === id)
    if (!ref) throw new Error('Missing attachment')
    return ref
  }))
  attachmentStore.pathFor.mockImplementation(originalPath)
  attachmentStore.read.mockReturnValue({ data: 'aGVsbG8=', mimeType: 'image/png' })
  attachmentStore.scopedRead.mockReturnValue(false)
})
afterEach(() => {
  for (const manager of managers.splice(0)) manager.stopAll()
})

describe('attachments delivered through ACP sessions', () => {
  it.each(['cursor', 'codex', 'claude'] as const)('delivers image bytes and original file paths to %s without full access', async (provider) => {
    const ctx = setup(provider)
    await ctx.send()
    const prompt = ctx.calls.find((call) => call.method === 'session/prompt')!.params.prompt
    expect(prompt).toHaveLength(3)
    expect(prompt[1]).toMatchObject({ type: 'text', text: expect.stringContaining(JSON.stringify({ id: image.id, name: image.name, copiedUserMessages: [], currentMessage: true })) })
    expect(prompt[2]).toEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' })
    expect(prompt[0].text).toContain(JSON.stringify(originalPath(document.id)))
    expect(prompt[0].text).toContain(`"size":${document.size}`)
    expect(prompt[0].text).not.toContain('aGVsbG8=')
    const user = ctx.items.find((item) => item.kind === 'user')!
    expect(user).toMatchObject({ text: ctx.req.prompt, attachments: [image, document], managedMessageId: expect.any(String) })
    const parsed = parseAttachmentPrompt(prompt[0].text)
    expect(parsed.managedMessageId).toBe(user.kind === 'user' ? user.managedMessageId : undefined)
    expect(attachmentStore.retain).toHaveBeenCalledWith([image.id, document.id])
  })

  it('keeps the negotiated image capability when an idle process is reused', async () => {
    const ctx = setup()
    await ctx.send()
    ctx.finished.mockClear()
    ctx.req.prompt = 'Compare the screenshot again'
    await ctx.send()
    expect(ctx.calls.filter((call) => call.method === 'initialize')).toHaveLength(1)
    expect(ctx.calls.filter((call) => call.method === 'session/prompt').map((call) => call.params.prompt[2]))
      .toEqual([{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }])
  })

  it.each([false, null])('reports unsupported or undeclared image input without sending a text fallback (%s)', async (capability) => {
    const ctx = setup('cursor', capability)
    await ctx.send()
    expect(ctx.calls.some((call) => call.method === 'session/prompt')).toBe(false)
    expect(ctx.items).toContainEqual(expect.objectContaining({ kind: 'notice', level: 'error', text: expect.stringContaining('未声明支持图片输入') }))
  })

  it('sends ordinary files when the provider does not support images', async () => {
    const ctx = setup('claude', false)
    ctx.req.attachmentIds = [document.id]
    await ctx.send()
    const prompt = ctx.calls.find((call) => call.method === 'session/prompt')!.params.prompt
    expect(prompt).toHaveLength(1)
    expect(prompt[0].text).toContain(JSON.stringify(originalPath(document.id)))
    expect(attachmentStore.read).not.toHaveBeenCalled()
  })

  it('uses a filename for an attachment-only message title', async () => {
    const ctx = setup()
    ctx.req.prompt = '  '
    await ctx.send()
    expect(ctx.thread.title).toBe('screen.png')
    expect(ctx.items[0]).toMatchObject({ kind: 'user', text: '  ', attachments: [image, document] })
  })

  it('rejects missing attachments before adding a message or switching providers', async () => {
    const ctx = setup()
    ctx.req.attachmentIds = ['missing']
    ctx.req.cli = 'codex'
    await expect(ctx.manager.send(ctx.req)).rejects.toThrow('Missing attachment')
    expect(ctx.items).toEqual([])
    expect(ctx.thread.cli).toBe('cursor')
    expect(ctx.calls).toEqual([])
    expect(attachmentStore.retain).not.toHaveBeenCalled()
  })

  it('restores historical image bytes once for a fallback fork and regenerates original paths', async () => {
    const ctx = setup()
    ctx.items.push({ id: 'past', kind: 'user', text: 'Describe this image', createdAt: 1, attachments: [image, document] })
    ctx.thread.forkContextThroughItemId = 'past'
    ctx.req.attachmentIds = []
    await ctx.send()
    const first = ctx.calls.find((call) => call.method === 'session/prompt')!.params.prompt
    expect(first[1]).toMatchObject({ type: 'text', text: expect.stringContaining(JSON.stringify({ id: image.id, name: image.name, copiedUserMessages: [1], currentMessage: false })) })
    expect(first[2]).toMatchObject({ type: 'image', data: 'aGVsbG8=' })
    expect(parseForkPrompt(first[0].text)?.items).toHaveLength(1)
    expect(first[0].text).toContain(JSON.stringify(originalPath(document.id)))
    expect(ctx.thread.forkContextThroughItemId).toBeUndefined()
    ctx.finished.mockClear()
    ctx.req.prompt = 'Continue'
    await ctx.send()
    expect(ctx.calls.filter((call) => call.method === 'session/prompt')[1].params.prompt).toEqual([{ type: 'text', text: 'Continue' }])
  })

  it('rejects an oversized combined replay rather than silently omitting historical images', async () => {
    const ctx = setup()
    const large = { ...image, size: MAX_MESSAGE_ATTACHMENT_BYTES + 1 }
    attachmentStore.resolveMany.mockReturnValue([large])
    ctx.items.push({ id: 'past', kind: 'user', text: 'Image', createdAt: 1, attachments: [large] })
    ctx.thread.forkContextThroughItemId = 'past'
    ctx.req.attachmentIds = []
    await ctx.send()
    expect(ctx.calls.some((call) => call.method === 'session/prompt')).toBe(false)
    expect(ctx.items).toContainEqual(expect.objectContaining({ kind: 'notice', text: expect.stringContaining('图片合计超出附件限制') }))
    expect(ctx.thread.forkContextThroughItemId).toBe('past')
  })

  it('labels every historical and current use when the same image is sent once', async () => {
    const ctx = setup()
    ctx.items.push(
      { id: 'past-1', kind: 'user', text: 'First image use', createdAt: 1, attachments: [image] },
      { id: 'past-reply', kind: 'assistant', text: 'An image description' },
      { id: 'past-2', kind: 'user', text: 'Second image use', createdAt: 2, attachments: [image] }
    )
    ctx.thread.forkContextThroughItemId = 'past-2'
    ctx.req.attachmentIds = [image.id]
    await ctx.send()
    const prompt = ctx.calls.find((call) => call.method === 'session/prompt')!.params.prompt
    expect(prompt.filter((block: any) => block.type === 'image')).toHaveLength(1)
    expect(prompt[1]).toMatchObject({ type: 'text', text: expect.stringContaining(JSON.stringify({ id: image.id, name: image.name, copiedUserMessages: [1, 2], currentMessage: true })) })
    expect(prompt[2]).toMatchObject({ type: 'image', data: 'aGVsbG8=' })
  })

  it('does not repeat the original attachments in an automatic plan revision', async () => {
    const ctx = setup('codex')
    ctx.req.mode = 'plan'
    const internal = ctx.manager as any
    ctx.reply.mockImplementation(async (method) => {
      if (method === 'initialize') return { agentCapabilities: { promptCapabilities: { image: true } } }
      if (method === 'session/new') return { sessionId: 'attachment-session' }
      if (method === 'session/prompt') {
        internal.runs.get('thread').planFeedback = 'Use a simpler design'
        return { stopReason: 'end_turn' }
      }
      return {}
    })
    const originalBegin = internal.beginSend.bind(internal)
    const begin = vi.spyOn(internal, 'beginSend').mockImplementationOnce(originalBegin).mockResolvedValue(undefined)
    await ctx.manager.send(ctx.req)
    await vi.waitFor(() => expect(begin).toHaveBeenCalledTimes(2))
    expect(begin.mock.calls[1][0]).toMatchObject({ prompt: 'Use a simpler design', attachmentIds: undefined })
  })
})
