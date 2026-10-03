import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { repairCodexMcpTools } from '../src/main/codex-history'
import { Store } from '../src/main/store'
import type { Item, ToolItem } from '../src/shared/types'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => electron.userData } }))

const chatId = '00000000-0000-0000-0000-000000000001'
let tempDir = ''
let rolloutFile = ''
const stores: Store[] = []

function legacyTool(patch: Partial<ToolItem> = {}): ToolItem {
  return {
    id: 'tool-item', kind: 'tool', tool: 'shell', callId: 'exec-1', status: 'error', startedAt: 10, endedAt: 20,
    args: { server: 'codex_apps', tool: 'github.search_prs', arguments: { query: 'repo:owner/repo' } },
    result: { result: { content: [{ type: 'text', text: '{"issues":[]}' }] }, error: null },
    ...patch
  }
}

function writeCompletion(patch: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(rolloutFile), { recursive: true })
  fs.writeFileSync(rolloutFile, JSON.stringify({
    type: 'event_msg', payload: { type: 'item_completed', item: {
      type: 'McpToolCall', id: 'exec-1', server: 'codex_apps', tool: 'github.search_prs',
      status: 'completed', result: { content: [{ type: 'text', text: '{"issues":[]}' }], isError: false }, error: null,
      ...patch
    } }
  }))
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-tool-repair-'))
  electron.userData = path.join(tempDir, 'app')
  vi.stubEnv('CODEX_HOME', path.join(tempDir, 'codex'))
  rolloutFile = path.join(tempDir, 'codex', 'sessions', `rollout-test-${chatId}.jsonl`)
})

afterEach(() => {
  for (const store of stores.splice(0)) store.flush()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  const dir = path.resolve(tempDir)
  if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('agent-desktop-tool-repair-')) {
    throw new Error(`Unexpected test directory: ${dir}`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('legacy Codex MCP repair', () => {
  it('repairs proven successful calls without replacing saved content and is idempotent', () => {
    const tool = legacyTool()
    const before = structuredClone(tool)
    const items: Item[] = [{ id: 'message', kind: 'assistant', text: 'Keep this answer.' }, tool]
    writeCompletion()
    expect(repairCodexMcpTools(chatId, items)).toBe(true)
    expect(tool).toEqual({ ...before, tool: 'mcp.codex_apps.github.search_prs', status: 'success' })
    expect(items[0]).toEqual({ id: 'message', kind: 'assistant', text: 'Keep this answer.' })
    const read = vi.spyOn(fs, 'readFileSync')
    expect(repairCodexMcpTools(chatId, items)).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })

  it.each([
    { status: 'failed', error: null },
    { status: 'completed', result: { isError: true }, error: null },
    { status: 'completed', error: { message: 'connection failed' } }
  ])('preserves native failures ($status, $error)', (native) => {
    const tool = legacyTool()
    writeCompletion(native)
    expect(repairCodexMcpTools(chatId, [tool])).toBe(true)
    expect(tool).toMatchObject({ tool: 'mcp.codex_apps.github.search_prs', status: 'error' })
  })

  it.each([
    { id: 'different-call' }, { server: 'different-server' }, { tool: 'different-tool' },
    { status: 'inProgress' }, { status: undefined }
  ])('keeps an unproven legacy status unchanged (%j)', (native) => {
    const tool = legacyTool()
    const before = structuredClone(tool)
    writeCompletion(native)
    expect(repairCodexMcpTools(chatId, [tool])).toBe(false)
    expect(tool).toEqual(before)
  })

  it('leaves items unchanged when the original log is missing', () => {
    const tool = legacyTool()
    const before = structuredClone(tool)
    expect(repairCodexMcpTools(chatId, [tool])).toBe(false)
    expect(tool).toEqual(before)
  })

  it('matches a native callId alias and ignores malformed log lines', () => {
    const tool = legacyTool()
    writeCompletion({ id: undefined, callId: tool.callId })
    fs.appendFileSync(rolloutFile, '\n{"torn":')
    expect(repairCodexMcpTools(chatId, [tool])).toBe(true)
    expect(tool.status).toBe('success')
  })

  it('does not read rollouts for actual shell commands or already classified calls', () => {
    const read = vi.spyOn(fs, 'readFileSync')
    expect(repairCodexMcpTools(chatId, [
      legacyTool({ args: { command: 'echo ok', server: 'codex_apps', tool: 'github.search_prs' } }),
      legacyTool({ tool: 'mcp.codex_apps.github.search_prs' }),
      legacyTool({ args: { command: 'echo ok' } })
    ])).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })

  it('repairs and persists a Codex thread once on load', () => {
    writeCompletion()
    const first = new Store()
    stores.push(first)
    const project = first.addProject(tempDir)
    const thread = first.createThread({ projectId: project.id, chatId, cli: 'codex', title: 'MCP', mode: 'agent', source: 'app' })
    first.setItems(thread.id, [legacyTool()])
    first.flush()
    const reloaded = new Store()
    stores.push(reloaded)
    const read = vi.spyOn(fs, 'readFileSync')
    const items = reloaded.items(thread.id)
    expect(items[0]).toMatchObject({ tool: 'mcp.codex_apps.github.search_prs', status: 'success' })
    expect(read.mock.calls.filter(([file]) => file === rolloutFile)).toHaveLength(1)
    expect(reloaded.items(thread.id)).toBe(items)
    expect(read.mock.calls.filter(([file]) => file === rolloutFile)).toHaveLength(1)
    reloaded.flush()
    expect(JSON.parse(fs.readFileSync(path.join(reloaded.dataDir, 'threads', `${thread.id}.json`), 'utf8'))).toEqual(items)
  })
})
