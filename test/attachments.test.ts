import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AttachmentStore, attachmentMime } from '../src/main/attachments'
import { MAX_ATTACHMENT_BYTES } from '../src/shared/attachments'
import type { Item, ThreadMeta } from '../src/shared/types'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK7sAAAAASUVORK5CYII='

describe('managed attachments', () => {
  let dir: string
  let storage: AttachmentStore
  let threads: ThreadMeta[]
  let items: Record<string, Item[]>

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-attachments-test-'))
    threads = []
    items = {}
    storage = new AttachmentStore({ dataDir: dir, threads, items: (id) => items[id] ?? [] })
  })

  afterEach(() => {
    const resolved = path.resolve(dir)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agent-desktop-attachments-test-')) throw new Error('Unexpected test directory')
    fs.rmSync(resolved, { recursive: true, force: true })
  })

  const upload = (name = '说明.txt', bytes = Buffer.from('原文件内容')) => storage.upload({ name, mimeType: 'text/plain', data: bytes.toString('base64') })

  it('keeps original bytes and Chinese names outside transcript metadata', () => {
    const ref = upload()
    expect(ref).toMatchObject({ name: '说明.txt', mimeType: 'text/plain', size: Buffer.byteLength('原文件内容') })
    expect(Object.keys(ref).sort()).toEqual(['id', 'mimeType', 'name', 'size'])
    expect(storage.read(ref.id)).toEqual({ data: Buffer.from('原文件内容').toString('base64'), mimeType: 'text/plain' })
    expect(path.relative(dir, storage.pathFor(ref.id))).toMatch(/^attachments[\\/]/)
  })

  it('detects image types from bytes, and treats a forged image label as a file', () => {
    const image = storage.upload({ name: '截图.png', mimeType: '', data: PNG })
    expect(image.mimeType).toBe('image/png')
    const forged = storage.upload({ name: 'bad.png', mimeType: 'image/png', data: Buffer.from('<script>bad()</script>').toString('base64') })
    expect(forged.mimeType).toBe('application/octet-stream')
    expect(attachmentMime(Buffer.from('not a PNG'), 'IMAGE/PNG')).toBe('application/octet-stream')
    expect(attachmentMime(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), '')).toBe('image/jpeg')
    expect(attachmentMime(Buffer.from('RIFF0000WEBP'), '')).toBe('image/webp')
    expect(attachmentMime(Buffer.from('GIF89a0000000'), '')).toBe('image/gif')
  })

  it.each(['../../说明.txt', 'C:\\secret\\说明.txt', 'CON.txt', '_metadata.json', '_metadata.json.tmp', '_METADATA.JSON', '_Metadata.Json.Tmp'])('saves %s safely inside its own attachment directory', (name) => {
    const ref = upload(name)
    const file = storage.pathFor(ref.id)
    expect(path.dirname(file)).toBe(path.join(dir, 'attachments', ref.id))
    expect(storage.read(ref.id).data).toBe(Buffer.from('原文件内容').toString('base64'))
  })

  it.each(['a', '!!!!', 'ab==', 'AAAA====', 'data:text/plain;base64,YQ=='])('rejects malformed base64 %s', (data) => {
    expect(() => storage.upload({ name: 'bad', mimeType: '', data })).toThrow()
  })

  it('accepts the exact size boundary and rejects an over-limit byte', () => {
    const first = upload('first.bin', Buffer.alloc(MAX_ATTACHMENT_BYTES))
    const second = upload('second.bin', Buffer.alloc(MAX_ATTACHMENT_BYTES))
    expect(storage.resolveMany([first.id, second.id])).toHaveLength(2)
    expect(() => storage.upload({ name: 'large', mimeType: '', data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') })).toThrow(/10 MiB/)
    const third = upload('extra.txt', Buffer.from('x'))
    expect(() => storage.resolveMany([first.id, second.id, third.id])).toThrow(/20 MiB/)
  })

  it('permits empty files and bounds attachment counts and IDs', () => {
    const ref = upload('empty.txt', Buffer.alloc(0))
    expect(storage.read(ref.id).data).toBe('')
    expect(() => storage.resolveMany([ref.id, ref.id])).toThrow()
    expect(() => storage.resolveMany(Array.from({ length: 11 }, (_, i) => String(i)))).toThrow()
    expect(() => storage.read('../state.json')).toThrow()
    expect(() => storage.read('00000000-0000-0000-0000-000000000000')).toThrow()
    const unicodeName = upload('说明'.repeat(90) + '.txt')
    expect(Buffer.byteLength(unicodeName.name)).toBeLessThanOrEqual(240)
    expect(unicodeName.name.endsWith('.txt')).toBe(true)
    expect(storage.read(unicodeName.id).data).toBeTruthy()
  })

  it('allows only an exact managed original in scoped Read checks', () => {
    const ref = upload()
    const original = storage.pathFor(ref.id)
    expect(storage.scopedRead(original, dir, [ref])).toBe(true)
    expect(storage.scopedRead(path.relative(dir, original), dir, [ref])).toBe(true)
    expect(storage.scopedRead(original, dir, [])).toBe(false)
    const other = upload('other.txt')
    expect(storage.scopedRead(storage.pathFor(other.id), dir, [ref, other], original)).toBe(false)
    expect(storage.scopedRead(path.relative(dir, original), dir, [ref, other], original)).toBe(true)
    const outside = path.join(dir, 'unrelated.txt')
    fs.writeFileSync(outside, 'not uploaded')
    expect(storage.scopedRead(outside, dir, [ref])).toBe(false)
  })

  it('reports a missing or altered original instead of sending stale metadata', () => {
    const ref = upload()
    fs.writeFileSync(storage.pathFor(ref.id), 'changed')
    expect(() => storage.read(ref.id)).toThrow()
    expect(() => storage.resolveMany([ref.id])).toThrow()
  })

  it('retains a shared fork original until its final reference is removed', () => {
    const ref = upload()
    threads.push({ id: 'source' } as ThreadMeta, { id: 'fork' } as ThreadMeta)
    items.source = [{ id: 'one', kind: 'user', text: '', createdAt: 1, attachments: [ref] }]
    items.fork = structuredClone(items.source)
    storage.retain([ref.id])
    threads.splice(0, 1)
    storage.removeUnreferenced([ref.id])
    expect(storage.read(ref.id).data).toBeTruthy()
    threads.splice(0, 1)
    storage.removeUnreferenced([ref.id])
    expect(() => storage.read(ref.id)).toThrow()
  })

  it('removes staged files only after 24 hours', () => {
    const ref = upload()
    storage.collectGarbage(Date.now() + 23 * 60 * 60 * 1000)
    expect(storage.read(ref.id).data).toBeTruthy()
    storage.collectGarbage(Date.now() + 25 * 60 * 60 * 1000)
    expect(() => storage.read(ref.id)).toThrow()
  })
})
