import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  it('lazily upgrades a legacy successful read and marks it dirty', () => {
    items.push(tool()); const result = prepareToolImages(store, 't', 'i')
    expect(result.images).toHaveLength(1); expect(store.markItemsDirty).toHaveBeenCalledWith('t')
    expect(prepareToolImages(store, 't', 'i').images[0].id).toBe(result.images[0].id)
  })
  it('retries a missing legacy image without changing its tool status', () => {
    fs.unlinkSync(path.join(cwd, 'a.png')); items.push(tool())
    expect(prepareToolImages(store, 't', 'i').error).toBeTruthy()
    fs.writeFileSync(path.join(cwd, 'a.png'), Buffer.from(PNG, 'base64'))
    expect(prepareToolImages(store, 't', 'i').images).toHaveLength(1)
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
  it('keeps a warning when running updates contain more images than can be cached', () => {
    const reducer = new StreamReducer(items, imageCapture(store, cwd))
    const content = Array.from({ length: 12 }, (_, i) => ({ ...image, data: Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from([i])]).toString('base64') }))
    reducer.handleAcp({ sessionUpdate: 'tool_call', toolCallId: 'c', rawInput: {}, status: 'in_progress', content })
    reducer.handleAcp({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed' })
    const item = items[0] as ToolItem
    expect(item.images).toHaveLength(10)
    expect(item.imageError).toContain('缓存限制')
    reducer.handleAcp({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed' })
    expect(item.imageError).toContain('缓存限制')
    expect(prepareToolImages(store, 't', item.id).retryable).toBe(false)
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
