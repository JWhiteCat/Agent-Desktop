import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.dir } }))
import { Store } from '../src/main/store'
import { imageCapture, readToolImage } from '../src/main/tool-images'
import { attachmentsFor } from '../src/main/attachments'
import type { ToolItem } from '../src/shared/types'

it('persists tool snapshots through Store restart and removes bytes only after the final fork is deleted', () => {
  fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-image-store-'))
  let first: Store | undefined, restarted: Store | undefined
  try {
    first = new Store()
    const project = first.addProject(fixture.dir)
    first.createThread({ id: 'original', projectId: project.id, title: 'Image', cli: 'cursor', mode: 'ask', source: 'app' })
    const item: ToolItem = { id: 'image-tool', callId: 'c', kind: 'tool', tool: 'read', args: {}, startedAt: 1, status: 'success' }
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK7sAAAAASUVORK5CYII='
    imageCapture(first, fixture.dir)(item, { type: 'image', data, mimeType: 'image/png' })
    first.setItems('original', [item]); first.flush()
    restarted = new Store()
    expect(readToolImage(restarted, 'original', item.id, item.images![0].id).data).toBe(data)
    restarted.createThread({ id: 'fork', projectId: project.id, title: 'Fork', cli: 'cursor', mode: 'ask', source: 'app' })
    restarted.setItems('fork', structuredClone(restarted.items('original')))
    restarted.deleteThread('original')
    expect(readToolImage(restarted, 'fork', item.id, item.images![0].id).data).toBe(data)
    restarted.deleteThread('fork')
    expect(() => attachmentsFor(restarted!).read(item.images![0].id)).toThrow()
  } finally {
    first?.flush(); restarted?.flush()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})
