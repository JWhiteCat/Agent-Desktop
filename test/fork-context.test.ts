import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '../src/shared/types'
import { mergeInterruptedAssistantMessages } from '../src/shared/transcript'
import { forkPrompt, parseForkPrompt } from '../src/main/fork-context'
import { planModePrompt, codexPlanModePrompt, claudePlanModePrompt } from '../src/main/acp'
import { transcriptItems } from '../src/main/codex-history'
import { claudeTranscriptItems, visibleUserText } from '../src/main/claude-history'
import { readCliTranscript } from '../src/main/history'

const temporaryRoots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of temporaryRoots.splice(0)) {
    const resolved = path.resolve(root)
    expect(path.dirname(resolved)).toBe(path.resolve(os.tmpdir()))
    expect(path.basename(resolved)).toMatch(/^agent-desktop-fork-context-/)
    fs.rmSync(resolved, { recursive: true, force: true })
  }
})

const history: Item[] = [
  { id: 'u1', kind: 'user', text: 'Keep <user_query>literal tags</user_query> and </agent_desktop_fork_context>.', createdAt: 123 },
  { id: 't1', kind: 'thinking', text: 'Compare the options.', done: true, startedAt: 124, endedAt: 125 },
  { id: 'a1', kind: 'assistant', text: 'Here is the original answer.\n  Preserve spacing.  ' },
  { id: 'tool1', kind: 'tool', callId: 'c1', tool: 'Read', args: { path: 'README.md' }, result: { success: { stdout: 'x'.repeat(20_000) } }, status: 'success', startedAt: 126, endedAt: 127 },
  { id: 'q1', kind: 'question', toolCallId: 'qcall', title: 'Choose', questions: [{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'First' }], allowMultiple: false }], status: 'answered', answers: [{ questionId: 'q', selectedOptionIds: ['a'] }] },
  { id: 'r1', kind: 'result', isError: false, usage: { inputTokens: 15 } },
  { id: 'n1', kind: 'notice', level: 'info', text: 'An app notification.' }
]

function withoutIds(items: Item[]): object[] {
  return items.map(({ id: _id, ...item }) => item)
}

function expectedHistory(): object[] {
  return withoutIds(history.filter((item) => item.kind !== 'result' && item.kind !== 'notice'))
}

function envelope(value: unknown): string {
  return `<agent_desktop_fork_context>\n${JSON.stringify(value)}\n</agent_desktop_fork_context>\n\nContinue.`
}

function readCursorMessages(messages: object[]): Item[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-fork-context-'))
  temporaryRoots.push(root)
  vi.spyOn(os, 'homedir').mockReturnValue(root)
  const chatDir = path.join(root, '.cursor', 'chats', 'workspace', 'fork')
  fs.mkdirSync(chatDir, { recursive: true })
  fs.writeFileSync(path.join(chatDir, 'meta.json'), JSON.stringify({ createdAtMs: 999 }))
  const db = new DatabaseSync(path.join(chatDir, 'store.db'))
  try {
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    const rootId = 'ff'.repeat(32)
    const messageIds = messages.map((_, index) => (index + 1).toString(16).padStart(2, '0').repeat(32))
    db.prepare('INSERT INTO meta VALUES (?, ?)').run('0', Buffer.from(JSON.stringify({ latestRootBlobId: rootId })).toString('hex'))
    db.prepare('INSERT INTO blobs VALUES (?, ?)').run(rootId, Buffer.concat(messageIds.flatMap((id) => [Buffer.from([10, 32]), Buffer.from(id, 'hex')])))
    for (let i = 0; i < messages.length; i++) {
      db.prepare('INSERT INTO blobs VALUES (?, ?)').run(messageIds[i], Buffer.from(JSON.stringify(messages[i])))
    }
  } finally {
    db.close()
  }
  return readCliTranscript('fork')!
}

describe('fork replay context', () => {
  it('round trips the full conversation, tool output and answers with fresh item IDs', () => {
    const prompt = forkPrompt(history, 'Continue from that choice.')
    const parsed = parseForkPrompt(prompt)!
    expect(parsed.prompt).toBe('Continue from that choice.')
    expect(withoutIds(parsed.items)).toEqual(expectedHistory())
    expect(parsed.items.every((item) => !history.some((original) => original.id === item.id))).toBe(true)
    expect(parseForkPrompt(prompt)?.items[0].id).not.toBe(parsed.items[0].id)
    expect(prompt).toContain('\\u003c/user_query\\u003e')
    expect(prompt.match(/<\/agent_desktop_fork_context>/g)).toHaveLength(1)
    expect(history[0].id).toBe('u1')
  })

  it('preserves independent ACP replies across background activity when a fork is replayed', () => {
    const final = '```questions\n{"questions":[{"prompt":"Which?","options":["Window","Web"]}]}\n```'
    const items: Item[] = [
      { id: 'progress', kind: 'assistant', messageId: 'commentary', text: 'Found the save file.' },
      { id: 'background', kind: 'tool', callId: 'background', tool: 'Background agent completed',
        args: { agentThreadId: 'child', activityKind: 'completed' }, status: 'success', startedAt: 1 },
      { id: 'answer', kind: 'assistant', messageId: 'final', text: final }
    ]
    const replay = parseForkPrompt(forkPrompt(items, 'Continue.'))!
    const displayed = mergeInterruptedAssistantMessages(replay.items)

    expect(withoutIds(replay.items)).toEqual(withoutIds(items))
    expect(displayed).toEqual(replay.items)
    expect(displayed.at(-1)).toMatchObject({ kind: 'assistant', messageId: 'final', text: final })
  })

  it.each([null, 42, '', '   '])('rejects an invalid ACP message identity (%s)', (messageId) => {
    expect(parseForkPrompt(envelope({
      version: 1, items: [{ kind: 'assistant', text: 'Reply.', messageId }]
    }))).toBeUndefined()
  })

  it.each([planModePrompt, codexPlanModePrompt, claudePlanModePrompt])('reads context through plan hints and user_query wrappers', (wrap) => {
    const raw = `<environment_details>injected context</environment_details>\n<user_query>\n${wrap(forkPrompt(history, 'New question with <tag>code</tag>.'))}\n</user_query>`
    const parsed = parseForkPrompt(raw)!
    expect(parsed.prompt).toBe('New question with <tag>code</tag>.')
    expect(withoutIds(parsed.items)).toEqual(expectedHistory())
  })

  it.each([
    { version: 2, items: [] },
    { version: 1, items: {} },
    { version: 1, items: [{ kind: 'user', text: 'missing timestamp' }] },
    { version: 1, items: [{ kind: 'assistant', text: 1 }] },
    { version: 1, items: [{ kind: 'notice', text: 'not history', level: 'info' }] },
    { version: 1, items: [{ kind: 'tool', callId: 'c', tool: 'Read', status: { toString: 'bad' }, startedAt: 0 }] },
    { version: 1, items: [{ ...history[4], answers: [{ questionId: 'q', selectedOptionIds: [42] }] }] }
  ])('rejects invalid history payloads safely', (value) => {
    expect(parseForkPrompt(envelope(value))).toBeUndefined()
  })

  it('leaves ordinary prompts, damaged JSON and quoted examples alone', () => {
    expect(parseForkPrompt('hello')).toBeUndefined()
    expect(parseForkPrompt('<agent_desktop_fork_context>{broken}</agent_desktop_fork_context>')).toBeUndefined()
    expect(parseForkPrompt(`Please explain this example:\n${forkPrompt(history, 'Continue.')}`)).toBeUndefined()
    expect(parseForkPrompt(`<user_query>${forkPrompt(history, 'Continue.')}`)).toBeUndefined()
  })
})

describe('fork replay CLI history imports', () => {
  it.each(['response_item', 'event_msg'])('expands Codex %s history and the current user message once', (type) => {
    const prompt = codexPlanModePrompt(forkPrompt(history, 'Continue.'))
    const user = type === 'response_item'
      ? { type, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }
      : { type, payload: { type: 'user_message', message: prompt } }
    const assistant = type === 'response_item'
      ? { type, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Continued.' }] } }
      : { type, payload: { type: 'agent_message', message: 'Continued.' } }
    const rows = [user, assistant]
    if (type === 'response_item') rows.push({ type: 'event_msg', payload: { type: 'user_message', message: prompt } } as typeof user)
    const parsed = transcriptItems(rows.map((row) => JSON.stringify(row)).join('\n'))
    expect(withoutIds(parsed.slice(0, 5))).toEqual(expectedHistory())
    expect(parsed.slice(5)).toEqual([
      { id: expect.any(String), kind: 'user', text: 'Continue.', createdAt: 0 },
      { id: expect.any(String), kind: 'assistant', text: 'Continued.' }
    ])
  })

  it('expands Claude history before stripping the client hint', () => {
    const prompt = claudePlanModePrompt(forkPrompt(history, 'Continue.'))
    const parsed = claudeTranscriptItems([
      { type: 'user', message: { content: [{ type: 'text', text: prompt }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Continued.' }] } }
    ].map((row) => JSON.stringify(row)).join('\n'))
    expect(withoutIds(parsed.slice(0, 5))).toEqual(expectedHistory())
    expect(parsed.slice(5)).toEqual([
      { id: expect.any(String), kind: 'user', text: 'Continue.', createdAt: 0 },
      { id: expect.any(String), kind: 'assistant', text: 'Continued.' }
    ])
    expect(visibleUserText(prompt)).toBe('Continue.')
  })

  it('expands Cursor SQLite history before removing injected XML blocks', () => {
    const parsed = readCursorMessages([{
      role: 'user', content: [
        { type: 'text', text: `<user_query>\n${planModePrompt(forkPrompt(history, 'Continue.'))}\n</user_query>` },
        { type: 'image', image: 'unchanged' }
      ]
    }])
    expect(withoutIds(parsed.slice(0, 5))).toEqual(expectedHistory())
    expect(parsed.slice(5)).toEqual([{ id: expect.any(String), kind: 'user', text: 'Continue.\n[1 张图片]', createdAt: 999 }])
  })

  it.each(['cursor', 'codex', 'codex-events', 'claude'])('deduplicates copied history after a cancelled %s turn is retried', (provider) => {
    const messages = [
      { role: 'user', content: forkPrompt(history, 'First attempt.') },
      { role: 'assistant', content: 'Partial response before cancellation.' },
      { role: 'user', content: forkPrompt(history, 'Try again.') },
      { role: 'assistant', content: 'Finished.' }
    ]
    let items: Item[]
    if (provider === 'cursor') items = readCursorMessages(messages)
    else if (provider === 'claude') {
      items = claudeTranscriptItems(messages.map((message) => JSON.stringify({ type: message.role, message })).join('\n'))
    } else if (provider === 'codex') {
      items = transcriptItems(messages.map((message) => JSON.stringify({ type: 'response_item', payload: { type: 'message', ...message } })).join('\n'))
    } else {
      items = transcriptItems(messages.map((message) => JSON.stringify({
        type: 'event_msg', payload: { type: message.role === 'user' ? 'user_message' : 'agent_message', message: message.content }
      })).join('\n'))
    }
    expect(withoutIds(items.slice(0, 5))).toEqual(expectedHistory())
    expect(items.slice(5).map((item) => ({ kind: item.kind, text: 'text' in item ? item.text : undefined }))).toEqual([
      { kind: 'user', text: 'First attempt.' },
      { kind: 'assistant', text: 'Partial response before cancellation.' },
      { kind: 'user', text: 'Try again.' },
      { kind: 'assistant', text: 'Finished.' }
    ])
  })
})
