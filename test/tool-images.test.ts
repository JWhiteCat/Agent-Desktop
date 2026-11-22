import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { imageCapture, readToolImage, prepareToolImages, inlineImages, decodeImage, validateImage } from '../src/main/tool-images'
import { attachmentsFor } from '../src/main/attachments'
import { StreamReducer, compact } from '../src/main/reducer'
import { claudeTranscriptItems } from '../src/main/claude-history'
import { transcriptItems } from '../src/main/codex-history'
import { untrustedForkItems } from '../src/main/fork-context'
import type { Item, ToolItem, ThreadMeta } from '../src/shared/types'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK7sAAAAASUVORK5CYII='
const image = { type: 'image', data: PNG, mimeType: 'image/png' }
const tool = (patch: Partial<ToolItem> = {}): ToolItem => ({ id: 'i', callId: 'c', kind: 'tool', tool: 'read', args: { path: 'a.png' }, status: 'success', startedAt: 1, ...patch })
let dir: string, cwd: string, items: Item[], store: any
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-image-test-'))
  cwd = path.join(dir, 'project'); fs.mkdirSync(cwd)
  fs.writeFileSync(path.join(cwd, 'a.png'), Buffer.from(PNG, 'base64'))
  items = []
  const thread = { id: 't', projectId: 'p', cwd } as ThreadMeta
  store = { dataDir: path.join(dir, 'data'), threads: [thread], items: (id: string) => id === 't' ? items : [], thread: (id: string) => id === 't' ? thread : undefined, project: () => ({ path: cwd }), markItemsDirty: vi.fn() }
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('tool image storage and boundaries', () => {
  it('snapshots a successful local read and keeps bytes after original deletion', () => {
    const item = tool(); items.push(item)
    imageCapture(store, cwd)(item, undefined)
    expect(item.images?.[0]).toMatchObject({ name: 'a.png', sourceKind: 'file', sourcePath: path.join(cwd, 'a.png') })
    fs.unlinkSync(path.join(cwd, 'a.png'))
    expect(readToolImage(store, 't', 'i', item.images![0].id).data).toBe(PNG)
    expect(JSON.stringify(item)).not.toContain(PNG)
  })
  it('retains inline ACP and Claude image blocks without copying base64 into metadata', () => {
    const item = tool({ args: {}, tool: 'mcp.image' }); items.push(item)
    imageCapture(store, cwd)(item, [{ type: 'content', content: image }, { type: 'image', source: { type: 'base64', data: PNG, media_type: 'image/png' } }])
    expect(item.images).toHaveLength(1)
    expect(item.images![0].sourceKind).toBe('result')
    expect(item.images![0].sourcePath).toBeUndefined()
    expect(readToolImage(store, 't', 'i', item.images![0].id).path).toContain('attachments')
  })
  it('does not capture a running or failed operation', () => {
    for (const status of ['running', 'error'] as const) { const item = tool({ status }); imageCapture(store, cwd)(item, [image]); expect(item.images).toBeUndefined() }
  })
  it('never treats arbitrary tool path arguments as permission to read files', () => {
    const item = tool({ tool: 'shell' }); imageCapture(store, cwd)(item, undefined); expect(item.images).toBeUndefined()
  })
  it.each(['../secret.png', 'https://example.com/a.png', 'file:///etc/a.png', 'file://remote-host/share/a.png', '//remote-host/share/a.png'])('blocks external path %s', (file) => {
    fs.writeFileSync(path.join(dir, 'secret.png'), Buffer.from(PNG, 'base64'))
    const item = tool({ args: { path: file } }); imageCapture(store, cwd)(item, undefined)
    expect(item.images).toBeUndefined(); expect(item.imageError).toBeTruthy()
  })
  it('blocks symlink escapes', () => {
    fs.writeFileSync(path.join(dir, 'secret.png'), Buffer.from(PNG, 'base64'))
    fs.symlinkSync(path.join(dir, 'secret.png'), path.join(cwd, 'link.png'))
    const item = tool({ args: { path: 'link.png' } }); imageCapture(store, cwd)(item, undefined)
    expect(item.images).toBeUndefined(); expect(item.imageError).toContain('项目')
  })
  it('allows only this conversation managed originals outside cwd', () => {
    const ref = attachmentsFor(store).upload({ name: 'input.png', data: PNG, mimeType: 'image/png' })
    const item = tool({ args: { path: attachmentsFor(store).pathFor(ref.id) } })
    imageCapture(store, cwd)(item, undefined); expect(item.images).toBeUndefined()
    items.push({ kind: 'user', id: 'u', text: '', createdAt: 1, attachments: [ref] }, item)
    imageCapture(store, cwd, items)(item, undefined); expect(item.images).toHaveLength(1)
  })
  it('requires thread, tool and image ownership', () => {
    const item = tool(); items.push(item); imageCapture(store, cwd)(item, undefined)
    expect(() => readToolImage(store, 'other', 'i', item.images![0].id)).toThrow()
    expect(() => readToolImage(store, 't', 'other', item.images![0].id)).toThrow()
    expect(() => readToolImage(store, 't', 'i', 'other')).toThrow()
  })
  it('does not fetch URL image blocks', () => {
    expect(inlineImages({ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } })).toEqual([])
  })
  it('rejects invalid encoding and forged MIME signatures', () => {
    expect(() => decodeImage('a'.repeat(15_000_000))).toThrow()
    expect(() => decodeImage('invalid')).toThrow()
    expect(() => validateImage(Buffer.from('<svg/>'))).toThrow()
    const item = tool({ args: {} }); imageCapture(store, cwd)(item, [{ ...image, data: Buffer.from('fake').toString('base64') }]); expect(item.images).toBeUndefined()
  })
  it('rejects oversized pixel dimensions before decoding', () => {
    const bytes = Buffer.from(PNG, 'base64'); bytes.writeUInt32BE(32768, 16); bytes.writeUInt32BE(32768, 20)
    expect(() => validateImage(bytes)).toThrow('尺寸')
  })
  it('limits multiple images and reports omitted data instead of silent success', () => {
    const item = tool({ args: {} })
    imageCapture(store, cwd)(item, Array.from({ length: 12 }, (_, i) => ({ ...image, data: Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from([i])]).toString('base64') })))
    expect(item.images).toHaveLength(10); expect(item.imageError).toContain('10')
  })
  it('keeps tool refs live during garbage collection, including a fork', () => {
    const item = tool(); items.push(item); imageCapture(store, cwd)(item, undefined)
    const storage = attachmentsFor(store), id = item.images![0].id
    storage.collectGarbage(Date.now() + 100 * 86_400_000)
    expect(storage.read(id).data).toBe(PNG)
    items = [structuredClone({ ...item, id: 'fork-item' })]
    storage.collectGarbage(Date.now() + 100 * 86_400_000)
    expect(storage.read(id).data).toBe(PNG)
    items = []; storage.removeUnreferenced([id]); expect(() => storage.read(id)).toThrow()
  })
  it('strips image references from untrusted fork text', () => {
    const item = tool(); imageCapture(store, cwd)(item, undefined)
    expect((untrustedForkItems([item])[0] as ToolItem).images).toBeUndefined()
  })
  it('lazily upgrades a legacy successful read and marks it dirty', async () => {
    items.push(tool()); const result = await prepareToolImages(store, 't', 'i')
    expect(result.images).toHaveLength(1); expect(store.markItemsDirty).toHaveBeenCalledWith('t')
    expect((await prepareToolImages(store, 't', 'i')).images[0].id).toBe(result.images[0].id)
  })
  it('retries a missing legacy image without changing its tool status', async () => {
    fs.unlinkSync(path.join(cwd, 'a.png')); items.push(tool())
    expect((await prepareToolImages(store, 't', 'i')).error).toBeTruthy()
    fs.writeFileSync(path.join(cwd, 'a.png'), Buffer.from(PNG, 'base64'))
    expect((await prepareToolImages(store, 't', 'i')).images).toHaveLength(1)
    expect((items[0] as ToolItem).status).toBe('success')
  })
  it('preserves original snapshots across read/view_image history normalization', () => {
    const original = tool(); imageCapture(store, cwd)(original, undefined)
    original.imageError = 'partial result'
    fs.unlinkSync(path.join(cwd, 'a.png'))
    const imported = tool({ id: 'new-id', tool: 'view_image' })
    imageCapture(store, cwd, [original])(imported, undefined)
    expect(imported.images).toEqual(original.images)
    expect(imported.imageError).toBe(original.imageError)
  })
})

describe('Codex image previews outside the project', () => {
  const chatId = '00000000-0000-0000-0000-000000000001'
  const callId = 'exec-8f568f97-0d2d-4b08-bf7f-796d185d02da'
  let rollout: string, sourcePath: string, item: ToolItem
  beforeEach(() => {
    const codex = path.join(dir, 'codex')
    vi.stubEnv('CODEX_HOME', codex)
    rollout = path.join(codex, 'sessions', `rollout-test-${chatId}.jsonl`)
    fs.mkdirSync(path.dirname(rollout), { recursive: true })
    sourcePath = path.join(dir, '截图 #1.png')
    fs.writeFileSync(sourcePath, Buffer.from(PNG, 'base64'))
    Object.assign(store.thread('t'), { cli: 'codex', chatId })
    item = tool({ callId, args: { path: sourcePath }, imageError: '图片不在允许的项目范围内' })
    items.push(item)
  })
  afterEach(() => vi.unstubAllEnvs())

  function writeRollout(native: Record<string, unknown> = {}, threadId = chatId, event = 'item_completed') {
    const records = [
      { type: 'session_meta', payload: { id: chatId, cwd } },
      { type: 'event_msg', payload: { type: event, thread_id: threadId, turn_id: 'turn-1', item: {
        type: 'ImageView', id: callId, path: pathToFileURL(sourcePath).href, ...native
      } } }
    ]
    fs.writeFileSync(rollout, records.map((row) => JSON.stringify(row)).join('\n') + '\n')
  }

  it('retries after the native ImageView is recorded and reuses one snapshot across concurrent expansions', async () => {
    const first = await prepareToolImages(store, 't', item.id)
    expect(first).toMatchObject({ images: [], retryable: true })
    writeRollout()
    const [desktop, remote] = await Promise.all([prepareToolImages(store, 't', item.id), prepareToolImages(store, 't', item.id)])
    expect(desktop.error).toBeUndefined()
    expect(desktop.images).toHaveLength(1)
    expect(desktop.images[0]).toMatchObject({ sourceKind: 'file', sourcePath: fs.realpathSync(sourcePath) })
    expect(remote.images).toEqual(desktop.images)
    fs.unlinkSync(sourcePath)
    fs.unlinkSync(rollout)
    const reopened = await prepareToolImages(store, 't', item.id)
    expect(reopened.images).toEqual(desktop.images)
    expect(readToolImage(store, 't', item.id, reopened.images[0].id).data).toBe(PNG)
    expect(JSON.stringify(item)).not.toContain(PNG)
  })

  it.each([
    ['a different call', { id: 'exec-other' }, chatId, 'item_completed'],
    ['a different path', { path: 'file:///other.png' }, chatId, 'item_completed'],
    ['a different tool', { type: 'CommandExecution' }, chatId, 'item_completed'],
    ['a different thread', {}, '00000000-0000-0000-0000-000000000002', 'item_completed'],
    ['an unfinished image view', {}, chatId, 'item_started']
  ] as const)('keeps an external image unavailable for %s', async (_description, native, threadId, event) => {
    writeRollout(native, threadId, event)
    const result = await prepareToolImages(store, 't', item.id)
    expect(result.images).toEqual([])
    expect(result.error).toBeTruthy()
  })

  it('requires the native session id even when the rollout filename matches the chat', async () => {
    writeRollout()
    const differentSession = fs.readFileSync(rollout, 'utf8').replace(chatId, '00000000-0000-0000-0000-000000000002')
    fs.writeFileSync(rollout, differentSession)
    expect((await prepareToolImages(store, 't', item.id)).images).toEqual([])
  })

  it('rejects a recorded external file that now links to a different external image', async () => {
    writeRollout()
    const other = path.join(dir, 'other.png')
    fs.renameSync(sourcePath, other)
    fs.symlinkSync(other, sourcePath)
    expect((await prepareToolImages(store, 't', item.id)).images).toEqual([])
  })

  it('does not attach a pending preview to a replaced transcript item', async () => {
    writeRollout()
    const pending = prepareToolImages(store, 't', item.id)
    const replacement = tool({ id: item.id, callId: 'other', args: { path: sourcePath } })
    items = [replacement]
    await expect(pending).rejects.toThrow()
    expect(item.images).toBeUndefined()
    expect(replacement.images).toBeUndefined()
  })

  it.each([
    ['its matching output', 'call_direct', true],
    ['an unrelated output', 'call_other', false]
  ] as const)('checks a direct view_image against %s after the external source has been deleted', async (_description, outputId, matches) => {
    item.callId = 'call_direct'
    fs.unlinkSync(sourcePath)
    const records = [
      { type: 'session_meta', payload: { id: chatId, cwd } },
      { type: 'response_item', payload: { type: 'function_call', name: 'view_image',
        call_id: item.callId, arguments: JSON.stringify({ path: sourcePath }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: outputId,
        output: [{ type: 'input_image', image_url: `data:image/png;base64,${PNG}` }] } }
    ]
    fs.writeFileSync(rollout, records.map((row) => JSON.stringify(row)).join('\n') + '\n')
    const result = await prepareToolImages(store, 't', item.id)
    if (!matches) {
      expect(result.images).toEqual([])
      expect(result.error).toBeTruthy()
      return
    }
    expect(result.error).toBeUndefined()
    expect(result.images).toHaveLength(1)
    expect(result.images[0].sourceKind).toBe('result')
    expect(readToolImage(store, 't', item.id, result.images[0].id).data).toBe(PNG)
  })

  it('recovers a deleted external screenshot from a single-ImageView Codex exec output', async () => {
    fs.unlinkSync(sourcePath)
    const records = [
      { type: 'session_meta', payload: { id: chatId, cwd } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_exec_1', input: 'view_image' } },
      { type: 'event_msg', payload: { type: 'item_completed', thread_id: chatId, turn_id: 'turn-1', item: {
        type: 'ImageView', id: callId, path: pathToFileURL(sourcePath).href
      } } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_exec_1',
        output: [{ type: 'input_text', text: 'Script completed' }, { type: 'input_image', image_url: `data:image/png;base64,${PNG}` }] } }
    ]
    fs.writeFileSync(rollout, records.map((row) => JSON.stringify(row)).join('\n') + '\n')
    const result = await prepareToolImages(store, 't', item.id)
    expect(result.error).toBeUndefined()
    expect(result.images).toHaveLength(1)
    expect(result.images[0].sourceKind).toBe('result')
    expect(readToolImage(store, 't', item.id, result.images[0].id).data).toBe(PNG)
  })

  it('falls back to the verified file without misattributing a multi-ImageView Codex exec output', async () => {
    const otherBytes = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from([1])]).toString('base64')
    const records = [
      { type: 'session_meta', payload: { id: chatId, cwd } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_exec_multi', input: 'view_image x2' } },
      { type: 'event_msg', payload: { type: 'item_completed', thread_id: chatId, turn_id: 'turn-1', item: {
        type: 'ImageView', id: callId, path: pathToFileURL(sourcePath).href
      } } },
      { type: 'event_msg', payload: { type: 'item_completed', thread_id: chatId, turn_id: 'turn-1', item: {
        type: 'ImageView', id: 'exec-other-view', path: pathToFileURL(path.join(dir, 'second.png')).href
      } } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_exec_multi',
        output: [{ type: 'input_image', image_url: `data:image/png;base64,${otherBytes}` }] } }
    ]
    fs.writeFileSync(rollout, records.map((row) => JSON.stringify(row)).join('\n') + '\n')
    const result = await prepareToolImages(store, 't', item.id)
    expect(result.error).toBeUndefined()
    expect(result.images).toHaveLength(1)
    expect(result.images[0].sourceKind).toBe('file')
    expect(readToolImage(store, 't', item.id, result.images[0].id).data).toBe(PNG)
  })

  it('recovers a historical Codex image after the thread switched to another CLI', async () => {
    const turnId = '01a202b6-c8b5-7f81-824b-c8c374bcd4c4'
    Object.assign(store.thread('t'), { cli: 'antigravity', chatId: 'ag-session-1' })
    items.push({ id: 'res-1', kind: 'result', cli: 'codex', usageId: `codex:${turnId}`, isError: false })
    fs.unlinkSync(sourcePath)
    const records = [
      { type: 'session_meta', payload: { id: chatId, cwd } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_exec_sw', input: 'view_image' } },
      { type: 'event_msg', payload: { type: 'item_completed', thread_id: chatId, turn_id: turnId, item: {
        type: 'ImageView', id: callId, path: pathToFileURL(sourcePath).href
      } } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_exec_sw',
        output: [{ type: 'input_image', image_url: `data:image/png;base64,${PNG}` }] } }
    ]
    fs.writeFileSync(rollout, records.map((row) => JSON.stringify(row)).join('\n') + '\n')
    const result = await prepareToolImages(store, 't', item.id)
    expect(result.error).toBeUndefined()
    expect(result.images).toHaveLength(1)
    expect(result.images[0].sourceKind).toBe('result')
    expect(readToolImage(store, 't', item.id, result.images[0].id).data).toBe(PNG)
  })

  it.runIf(process.platform === 'win32')('matches verified Windows external paths across drive-letter casing differences', async () => {
    const lowerUrl = pathToFileURL(sourcePath).href.replace(/^file:\/\/\/([A-Z]):/, (_, d: string) => `file:///${d.toLowerCase()}:`)
    writeRollout({ path: lowerUrl })
    const result = await prepareToolImages(store, 't', item.id)
    expect(result.error).toBeUndefined()
    expect(result.images).toHaveLength(1)
    expect(readToolImage(store, 't', item.id, result.images[0].id).data).toBe(PNG)
  })
})

describe('Antigravity image paths and conversation scope', () => {
  const agChatId = '480ee055-2b6c-4394-a067-8362f246e072'
  let agDataDir: string, brainDir: string
  beforeEach(() => {
    agDataDir = path.join(dir, 'ag-data')
    brainDir = path.join(agDataDir, 'brain', agChatId)
    fs.mkdirSync(path.join(brainDir, 'scratch'), { recursive: true })
    vi.stubEnv('ANTIGRAVITY_CLI_DATA_DIR', agDataDir)
    Object.assign(store.thread('t'), { cli: 'antigravity', chatId: agChatId })
  })
  afterEach(() => vi.unstubAllEnvs())

  it('allows images in the conversation brain directory and handles Windows leading-slash drive paths', async () => {
    const scratchImg = path.join(brainDir, 'scratch', 'frame_0.png')
    fs.writeFileSync(scratchImg, Buffer.from(PNG, 'base64'))
    const slashPath = process.platform === 'win32' ? `/${scratchImg.replace(/\\/g, '/')}` : scratchImg
    const item = tool({ args: { path: slashPath } })
    items.push(item)
    const result = await prepareToolImages(store, 't', item.id)
    expect(result.error).toBeUndefined()
    expect(result.images).toHaveLength(1)
    expect(readToolImage(store, 't', item.id, result.images[0].id).data).toBe(PNG)
  })

  it('blocks images from another Antigravity conversation brain directory', async () => {
    const otherDir = path.join(agDataDir, 'brain', 'other-session', 'scratch')
    fs.mkdirSync(otherDir, { recursive: true })
    const otherImg = path.join(otherDir, 'secret.png')
    fs.writeFileSync(otherImg, Buffer.from(PNG, 'base64'))
    const item = tool({ args: { Path: otherImg } })
    items.push(item)
    const result = await prepareToolImages(store, 't', item.id)
    expect(result.images).toEqual([])
    expect(result.error).toContain('项目')
  })

  it('allows an external image attested by Antigravity transcript read_file + media', async () => {
    const extImg = path.join(dir, 'temp-preview.png')
    fs.writeFileSync(extImg, Buffer.from(PNG, 'base64'))
    const logsDir = path.join(brainDir, '.system_generated', 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    const rows = [
      { type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { Path: JSON.stringify(extImg) } }] },
      { type: 'GENERIC', status: 'DONE', media: [{ mime_type: 'image/jpeg', uri: pathToFileURL(extImg).href }] }
    ]
    fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const item = tool({ args: { Path: extImg, path: process.platform === 'win32' ? `/${extImg.replace(/\\/g, '/')}` : extImg } })
    items.push(item)
    const result = await prepareToolImages(store, 't', item.id)
    expect(result.error).toBeUndefined()
    expect(result.images).toHaveLength(1)
    expect(readToolImage(store, 't', item.id, result.images[0].id).data).toBe(PNG)
  })

  it('does not overwrite rawInput.Path with ACP locations in StreamReducer', () => {
    const reducer = new StreamReducer(items)
    const winPath = path.join(cwd, 'a.png')
    reducer.handleAcp({
      sessionUpdate: 'tool_call',
      toolCallId: 'ag-1',
      kind: 'read',
      rawInput: { Path: winPath },
      locations: [{ path: process.platform === 'win32' ? `/${winPath.replace(/\\/g, '/')}` : winPath }],
      status: 'completed'
    })
    const item = items[0] as ToolItem
    expect(item.args.Path).toBe(winPath)
    expect(item.args.path).toBeUndefined()
  })
})

describe('image event and history normalization', () => {
  it('captures completed Codex ACP path-only events and ignores duplicate updates', () => {
    const reducer = new StreamReducer(items, imageCapture(store, cwd))
    reducer.handleAcp({ sessionUpdate: 'tool_call', toolCallId: 'c', kind: 'read', title: 'View image', rawInput: { path: 'a.png' }, status: 'completed', content: [{ type: 'content', content: { type: 'resource_link', uri: 'a.png' } }] })
    reducer.handleAcp({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed' })
    expect((items[0] as ToolItem).images).toHaveLength(1)
  })
  it('captures image-only ACP updates before compacting metadata', () => {
    const reducer = new StreamReducer(items, imageCapture(store, cwd))
    reducer.handleAcp({ sessionUpdate: 'tool_call', toolCallId: 'c', kind: 'read', rawInput: {}, status: 'in_progress' })
    reducer.handleAcp({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed', content: [{ type: 'content', content: image }] })
    expect((items[0] as ToolItem).images).toHaveLength(1)
    expect(compact({ content: [image] })).not.toEqual({ content: [image] })
    expect(JSON.stringify(items)).not.toContain(PNG)
  })
  it('retains image content arriving before a status-only completion update', () => {
    const reducer = new StreamReducer(items, imageCapture(store, cwd))
    reducer.handleAcp({ sessionUpdate: 'tool_call', toolCallId: 'c', kind: 'read', rawInput: {}, status: 'in_progress', content: [{ type: 'content', content: image }] })
    expect((items[0] as ToolItem).images).toBeUndefined()
    reducer.handleAcp({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed' })
    expect((items[0] as ToolItem).images).toHaveLength(1)
  })
  it('keeps a warning when running updates contain more images than can be cached', async () => {
    const reducer = new StreamReducer(items, imageCapture(store, cwd))
    const content = Array.from({ length: 12 }, (_, i) => ({ ...image, data: Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from([i])]).toString('base64') }))
    reducer.handleAcp({ sessionUpdate: 'tool_call', toolCallId: 'c', rawInput: {}, status: 'in_progress', content })
    reducer.handleAcp({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed' })
    const item = items[0] as ToolItem
    expect(item.images).toHaveLength(10)
    expect(item.imageError).toContain('缓存限制')
    reducer.handleAcp({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed' })
    expect(item.imageError).toContain('缓存限制')
    expect((await prepareToolImages(store, 't', item.id)).retryable).toBe(false)
  })
  it('captures embedded ACP image resources without persisting their blob in metadata', () => {
    const raw = { type: 'resource', resource: { uri: 'memory:test', mimeType: 'image/png', blob: PNG } }
    const item = tool({ args: {} }); imageCapture(store, cwd)(item, raw)
    expect(item.images).toHaveLength(1)
    expect(JSON.stringify(compact(raw))).not.toContain(PNG)
  })
  it('extracts Claude historical tool-result image bytes', () => {
    const rows = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c', name: 'Read', input: { file_path: 'a.png' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }] } }
    ]
    const parsed = claudeTranscriptItems(rows.map((x) => JSON.stringify(x)).join('\n'), imageCapture(store, cwd))
    expect((parsed.find((x) => x.kind === 'tool') as ToolItem).images).toHaveLength(1)
  })
  it('extracts Codex structured historical output without truncating bytes', () => {
    const rows = [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'view' }] } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c', name: 'view_image', arguments: JSON.stringify({ path: 'a.png' }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: [image] } }
    ]
    const parsed = transcriptItems(rows.map((x) => JSON.stringify(x)).join('\n'), imageCapture(store, cwd))
    expect((parsed.find((x) => x.kind === 'tool') as ToolItem).images).toHaveLength(1)
    expect(JSON.stringify(parsed)).not.toContain(PNG)
  })
})
