import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { repairCodexAssistantMessages } from '../src/main/codex-history'
import { Store } from '../src/main/store'
import type { AssistantItem, Item } from '../src/shared/types'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => electron.userData } }))

const chatId = '00000000-0000-0000-0000-000000000002'
const questions = '```questions\n{"questions":[{"prompt":"Choose","options":["A","B"]}]}\n```'
let tempDir = ''
let rolloutFile = ''
const stores: Store[] = []

function assistant(text: string, patch: Partial<AssistantItem> = {}): AssistantItem {
  return { id: 'saved-assistant', kind: 'assistant', text, ...patch }
}

function native(text: string, patch: Record<string, unknown> = {}): object {
  return { type: 'response_item', payload: {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text }], ...patch
  } }
}

function event(type: string, patch: Record<string, unknown> = {}): object {
  return { type: 'event_msg', payload: { type, ...patch } }
}

function writeRollout(rows: object[]): void {
  fs.mkdirSync(path.dirname(rolloutFile), { recursive: true })
  fs.writeFileSync(rolloutFile, rows.map((row) => JSON.stringify(row)).join('\n'))
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-message-repair-'))
  electron.userData = path.join(tempDir, 'app')
  vi.stubEnv('CODEX_HOME', path.join(tempDir, 'codex'))
  rolloutFile = path.join(tempDir, 'codex', 'sessions', `rollout-test-${chatId}.jsonl`)
})

afterEach(() => {
  for (const store of stores.splice(0)) store.flush()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  const dir = path.resolve(tempDir)
  if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('agent-desktop-message-repair-')) {
    throw new Error(`Unexpected test directory: ${dir}`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('legacy Codex assistant message repair', () => {
  it('restores proven message separators while retaining IDs, tools and usage', () => {
    const first = 'Progress.'
    const last = '\nLater text.'
    const saved = assistant(first + questions + last)
    const tool: Item = { id: 'tool', kind: 'tool', callId: 'call', tool: 'shell', args: { command: 'echo ok' }, status: 'success', startedAt: 1 }
    const result: Item = { id: 'usage', kind: 'result', isError: false, usage: { input_tokens: 10, output_tokens: 2 } }
    const items: Item[] = [saved, tool, result]
    const before = structuredClone(items)
    writeRollout([native(first), native(questions), native(last), event('task_complete')])

    expect(repairCodexAssistantMessages(chatId, items)).toBe(true)
    expect(saved).toEqual({ ...before[0], text: `${first}\n\n${questions}\n\n${last}` })
    expect(items[0]).toBe(saved)
    expect(items[1]).toBe(tool)
    expect(items[2]).toBe(result)
    expect(items.slice(1)).toEqual(before.slice(1))
    expect(repairCodexAssistantMessages(chatId, items)).toBe(false)
    const reloaded: Item[] = JSON.parse(JSON.stringify(items))
    expect(repairCodexAssistantMessages(chatId, reloaded)).toBe(false)
    expect(reloaded).toEqual(items)
  })

  it('preserves original whitespace and concatenates the native text blocks verbatim', () => {
    const first = '  Alpha\r\n '
    const second = '\tBeta  \n'
    const saved = assistant(first + second)
    writeRollout([
      native('', { content: [{ type: 'output_text', text: '  Alpha' }, { type: 'output_text', text: '\r\n ' }] }),
      native(second)
    ])
    expect(repairCodexAssistantMessages(chatId, [saved])).toBe(true)
    expect(saved.text).toBe(`${first}\n\n${second}`)
  })

  it('ignores duplicated agent events and empty reasoning without losing native boundaries', () => {
    const first = 'Progress.'
    const saved = assistant(first + questions)
    writeRollout([
      event('item_completed', { item: { type: 'AgentMessage', content: [{ type: 'Text', text: first }] } }),
      native(first, { phase: 'commentary' }),
      event('item_completed', { item: { type: 'Reasoning', summary_text: [], raw_content: [] } }),
      { type: 'response_item', payload: { type: 'reasoning', summary: [] } },
      { type: 'token_usage_record', payload: { turn_token_usage: { input_tokens: 10 } } },
      event('token_count'),
      event('item_completed', { item: { type: 'AgentMessage', content: [{ type: 'Text', text: questions }] } }),
      native(questions, { phase: 'final_answer' })
    ])
    expect(repairCodexAssistantMessages(chatId, [saved])).toBe(true)
    expect(saved.text).toBe(`${first}\n\n${questions}`)
  })

  it.each([
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'ok' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'ok' } },
    event('user_message', { message: 'next' }),
    event('task_started'),
    event('task_complete'),
    event('task_aborted'),
    event('item_started', { item: { type: 'CommandExecution' } }),
    event('item_completed', { item: { type: 'McpToolCall' } }),
    event('item_completed', { item: { type: 'SubAgentActivity', kind: 'completed' } }),
    event('item_completed', { item: { type: 'UserMessage' } })
  ])('does not join messages across a native user, tool or turn boundary (%j)', (boundary) => {
    const saved = assistant('Progress.' + questions)
    const before = structuredClone(saved)
    writeRollout([native('Progress.'), boundary, native(questions)])
    expect(repairCodexAssistantMessages(chatId, [saved])).toBe(false)
    expect(saved).toEqual(before)
  })

  it('does not infer separators from Markdown syntax or an incomplete native match', () => {
    const texts = ['Progress.' + questions, 'Progress.' + questions.slice(0, -3), 'Unrelated text', `Progress.\n\n${questions}`]
    const items = texts.map((text, index) => assistant(text, { id: String(index) }))
    writeRollout([native('Progress.' + questions)])
    expect(repairCodexAssistantMessages(chatId, items)).toBe(false)
    expect(items.map((item) => item.text)).toEqual(texts)
    writeRollout([native('Progress.'), native(questions)])
    expect(repairCodexAssistantMessages(chatId, items.slice(1))).toBe(false)
    expect(items.map((item) => item.text)).toEqual(texts)
  })

  it('declines ambiguous native partitions and complete single-message matches', () => {
    const saved = assistant('abc')
    writeRollout([native('a'), native('bc'), event('task_complete'), native('ab'), native('c')])
    expect(repairCodexAssistantMessages(chatId, [saved])).toBe(false)
    writeRollout([native('a'), native('bc'), event('task_complete'), native('abc')])
    expect(repairCodexAssistantMessages(chatId, [saved])).toBe(false)
    expect(saved.text).toBe('abc')
  })

  it('accepts repeated equivalent native partitions and stays idempotent with colliding repaired text', () => {
    const saved = assistant('ab')
    writeRollout([
      native('a'), native('b'), event('task_complete'),
      native('a'), native('b'), event('task_complete'),
      native('a\n'), native('\nb')
    ])
    expect(repairCodexAssistantMessages(chatId, [saved])).toBe(true)
    expect(saved.text).toBe('a\n\nb')
    expect(repairCodexAssistantMessages(chatId, [saved])).toBe(false)
    expect(saved.text).toBe('a\n\nb')
  })

  it('leaves history unchanged when a log is missing or an invalid record hides a boundary', () => {
    const saved = assistant('ab')
    expect(repairCodexAssistantMessages(chatId, [saved])).toBe(false)
    writeRollout([native('a'), native('b')])
    fs.writeFileSync(rolloutFile, `${JSON.stringify(native('a'))}\n{"torn":\n${JSON.stringify(native('b'))}`)
    expect(repairCodexAssistantMessages(chatId, [saved])).toBe(false)
    expect(saved.text).toBe('ab')
  })

  it('skips modern message IDs and empty/non-assistant histories before reading the log', () => {
    const saved = assistant('ab', { messageId: 'native-message' })
    writeRollout([native('a'), native('b')])
    const read = vi.spyOn(fs, 'readFileSync')
    expect(repairCodexAssistantMessages(chatId, [saved, assistant(''), { id: 'user', kind: 'user', text: 'ab', createdAt: 1 }])).toBe(false)
    expect(read).not.toHaveBeenCalled()
    expect(saved.text).toBe('ab')
  })

  it('repairs a loaded Codex thread, persists it and keeps repeated reads cached', () => {
    writeRollout([native('Progress.'), native(questions), event('task_complete')])
    const first = new Store()
    stores.push(first)
    const project = first.addProject(tempDir)
    const thread = first.createThread({ projectId: project.id, chatId, cli: 'codex', title: 'Questions', mode: 'plan', source: 'app' })
    first.setItems(thread.id, [assistant('Progress.' + questions)])
    first.flush()

    const reloaded = new Store()
    stores.push(reloaded)
    const read = vi.spyOn(fs, 'readFileSync')
    const items = reloaded.items(thread.id)
    expect(items[0]).toEqual(assistant(`Progress.\n\n${questions}`))
    expect(read.mock.calls.filter(([file]) => file === rolloutFile)).toHaveLength(1)
    expect(reloaded.items(thread.id)).toBe(items)
    expect(read.mock.calls.filter(([file]) => file === rolloutFile)).toHaveLength(1)
    reloaded.flush()
    expect(JSON.parse(fs.readFileSync(path.join(reloaded.dataDir, 'threads', `${thread.id}.json`), 'utf8'))).toEqual(items)

    const nextLoad = new Store()
    stores.push(nextLoad)
    expect(nextLoad.items(thread.id)).toEqual(items)
    nextLoad.flush()
    expect(JSON.parse(fs.readFileSync(path.join(nextLoad.dataDir, 'threads', `${thread.id}.json`), 'utf8'))).toEqual(items)
  })

  it.each(['cursor', 'claude'] as const)('does not repair other CLI threads (%s)', (cli) => {
    writeRollout([native('a'), native('b')])
    const first = new Store()
    stores.push(first)
    const project = first.addProject(tempDir)
    const thread = first.createThread({ projectId: project.id, chatId, cli, title: 'Keep', mode: 'agent', source: 'app' })
    first.setItems(thread.id, [assistant('ab')])
    first.flush()
    const reloaded = new Store()
    stores.push(reloaded)
    const read = vi.spyOn(fs, 'readFileSync')
    expect(reloaded.items(thread.id)).toEqual([assistant('ab')])
    expect(read.mock.calls.filter(([file]) => file === rolloutFile)).toHaveLength(0)
  })
})
