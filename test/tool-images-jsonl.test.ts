import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexImageEvidence } from '../src/main/codex-tool-images'
import { prepareToolImages } from '../src/main/tool-images'
import type { Item, ThreadMeta, ToolItem } from '../src/shared/types'

// Minimal valid 1x1 PNG (67 bytes).
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const dir of tempDirs.splice(0)) {
    const resolved = path.resolve(dir)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agent-desktop-img-jsonl-')) {
      throw new Error(`Unexpected test directory: ${resolved}`)
    }
    fs.rmSync(resolved, { recursive: true, force: true })
  }
})

describe('torn JSONL resilience in image evidence scanners', () => {
  it('retains matched Codex ImageView evidence when a live rollout contains torn JSONL lines', async () => {
    const root = makeTempDir('agent-desktop-img-jsonl-codex-')
    const cwd = path.join(root, 'repo')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(cwd, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    const imageFile = path.join(outside, 'capture.png')
    fs.writeFileSync(imageFile, PNG_1X1)

    const codexHome = path.join(root, 'codex-home')
    const sessionsDir = path.join(codexHome, 'sessions', '2026', '09', '01')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const chatId = '11111111-2222-3333-4444-555555555555'
    const rollout = path.join(sessionsDir, `rollout-2026-09-01-${chatId}.jsonl`)
    fs.writeFileSync(rollout, [
      JSON.stringify({ type: 'session_meta', payload: { id: chatId, cwd } }),
      '{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"torn-before"',
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: chatId,
          item: { type: 'ImageView', id: 'img-call-1', path: imageFile }
        }
      }),
      '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"ImageView","id":"img-call-1"'
    ].join('\n'))
    vi.stubEnv('CODEX_HOME', codexHome)

    const evidence = await codexImageEvidence(chatId, 'img-call-1', imageFile, cwd)
    expect(evidence).toEqual({ path: path.resolve(imageFile) })
  })

  it('recovers Antigravity read_file image evidence despite torn JSONL lines in transcript.jsonl', async () => {
    const root = makeTempDir('agent-desktop-img-jsonl-agy-')
    const dataDir = path.join(root, 'app-data')
    const cwd = path.join(root, 'repo')
    const outside = path.join(root, 'outside')
    const agyData = path.join(root, 'agy-data')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.mkdirSync(cwd, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })

    const imageFile = path.join(outside, 'screenshot.png')
    fs.writeFileSync(imageFile, PNG_1X1)

    const chatId = 'agy-conv-123'
    const logsDir = path.join(agyData, 'brain', chatId, '.system_generated', 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), [
      '{"type":"PLANNER_RESPONSE","tool_calls":[{"name":"read_file","args":{"Path":"truncated',
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'read_file', args: { Path: imageFile } }]
      }),
      '{"type":"TOOL_RESULT","status":"DONE","partial":true',
      JSON.stringify({
        type: 'TOOL_RESULT',
        status: 'DONE',
        media: [{ mime_type: 'image/png', uri: imageFile }]
      })
    ].join('\n'))
    vi.stubEnv('ANTIGRAVITY_CLI_DATA_DIR', agyData)

    const thread: ThreadMeta = {
      id: 'thread-agy',
      projectId: 'proj-1',
      title: 'Inspect image',
      cli: 'antigravity',
      source: 'app',
      chatId,
      cwd,
      mode: 'agent',
      model: 'gemini-3.8-pro-high',
      createdAt: 1,
      updatedAt: 1
    }
    const toolItem: ToolItem = {
      id: 'tool-1',
      kind: 'tool',
      callId: 'call-read-1',
      tool: 'read_file',
      args: { Path: imageFile },
      status: 'success',
      startedAt: 1
    }
    const items: Item[] = [toolItem]
    const store = {
      dataDir,
      threads: [thread],
      thread: (id: string) => id === thread.id ? thread : undefined,
      project: () => ({ id: 'proj-1', path: cwd }),
      items: () => items,
      markItemsDirty: vi.fn()
    }

    const result = await prepareToolImages(store as any, thread.id, toolItem.id)
    expect(result.error).toBeUndefined()
    expect(result.images).toHaveLength(1)
    expect(result.images[0]).toMatchObject({ mimeType: 'image/png', sourceKind: 'file' })
  })
})
