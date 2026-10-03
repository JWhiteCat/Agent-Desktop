import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentRef, CliProvider, Item, UserItem } from '../src/shared/types'
import { attachmentPrompt, parseAttachmentPrompt } from '../src/shared/attachment-message'
import { Store } from '../src/main/store'
import { forkThread, syncFromCli } from '../src/main/thread-history'
import { forkPrompt, parseForkPrompt } from '../src/main/fork-context'
import { readCliTranscript } from '../src/main/history'
import { readCodexTranscript, transcriptItems } from '../src/main/codex-history'
import { claudeTranscriptItems, readClaudeTranscript } from '../src/main/claude-history'
import { claudePlanModePrompt, codexPlanModePrompt, planModePrompt } from '../src/main/acp'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => electron.userData } }))

const messageId = '7e8296a5-a67d-4106-8524-b8cba94a1be3'
const file: AttachmentRef = { id: 'dd95b1f6-c02f-43ce-89cc-8e289da32e14', name: '测试.png', mimeType: 'image/png', size: 100 }

describe('attachment message identity', () => {
  it.each([planModePrompt, codexPlanModePrompt, claudePlanModePrompt])('parses generated markers through client hints and query wrappers', (wrap) => {
    const raw = `<environment_details>workspace</environment_details>\n<user_query>${wrap(attachmentPrompt('Describe <tag>this</tag>.', messageId))}</user_query>`
    expect(parseAttachmentPrompt(raw)).toEqual({ prompt: 'Describe <tag>this</tag>.', managedMessageId: messageId })
  })

  it('retains attachment-only turns and leaves quoted examples and malformed markers untouched', () => {
    const prompt = attachmentPrompt('', messageId)
    expect(parseAttachmentPrompt(prompt)).toEqual({ prompt: '', managedMessageId: messageId })
    for (const raw of [
      `Explain this:\n${prompt}`, `\`\`\`xml\n${prompt}\n\`\`\``, `<example>${prompt}</example>`,
      '<agent_desktop_attachments>{broken}</agent_desktop_attachments>',
      '<agent_desktop_attachments>{"version":2,"messageId":"invalid"}</agent_desktop_attachments>',
      `<user_query>${prompt}`,
      `<agent_desktop_attachments>${JSON.stringify({ version: 1, messageId, attachmentIds: [file.id] })}</agent_desktop_attachments>`
    ]) expect(parseAttachmentPrompt(raw)).toEqual({ prompt: raw })
  })

  it('preserves validated optional metadata in saved fork context and rejects invalid references', () => {
    const item: UserItem = { id: 'user', kind: 'user', text: '', createdAt: 10, managedMessageId: messageId, attachments: [file] }
    expect(parseForkPrompt(forkPrompt([item], 'Continue.'))?.items[0]).toMatchObject({ ...item, id: expect.any(String) })
    for (const invalid of [null, {}, [{ ...file, size: -1 }], [{ ...file, id: '../file' }], [{ ...file, size: '100' }]]) {
      expect(parseForkPrompt(forkPrompt([{ ...item, attachments: invalid } as UserItem], 'Continue.'))).toBeUndefined()
    }
  })

  it.each(['codex', 'codex-events', 'claude'])('retains image-only foreign %s turns', (cli) => {
    const raw = cli === 'claude'
      ? { type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', data: 'AA==' } }] } }
      : cli === 'codex-events'
        ? { type: 'event_msg', payload: { type: 'user_message', message: '', images: ['image'] } }
        : { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] } }
    const items = cli === 'claude' ? claudeTranscriptItems(JSON.stringify(raw)) : transcriptItems(JSON.stringify(raw))
    expect(items).toEqual([{ id: expect.any(String), kind: 'user', text: '[1 张图片]', createdAt: 0 }])
  })
})

describe('attachment transcript trust and forks', () => {
  let store: Store
  let projectId: string
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-attachment-history-'))
    electron.userData = path.join(root, 'app')
    vi.spyOn(os, 'homedir').mockReturnValue(root)
    vi.stubEnv('CODEX_HOME', path.join(root, '.codex'))
    store = new Store()
    projectId = store.addProject(root).id
  })

  afterEach(() => {
    store.flush()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    const dir = path.resolve(root)
    expect(path.dirname(dir)).toBe(path.resolve(os.tmpdir()))
    expect(path.basename(dir)).toMatch(/^agent-desktop-attachment-history-/)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function writeTranscript(cli: CliProvider, chatId: string, prompts: string[], images = false): void {
    if (cli === 'cursor') {
      const dir = path.join(root, '.cursor', 'chats', 'workspace', chatId)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ createdAtMs: 10 }))
      const db = new DatabaseSync(path.join(dir, 'store.db'))
      try {
        db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
        const rootId = 'ff'.repeat(32)
        const ids = prompts.map((_, index) => (index + 1).toString(16).padStart(2, '0').repeat(32))
        db.prepare('INSERT INTO meta VALUES (?, ?)').run('0', Buffer.from(JSON.stringify({ latestRootBlobId: rootId })).toString('hex'))
        db.prepare('INSERT INTO blobs VALUES (?, ?)').run(rootId, Buffer.concat(ids.flatMap((id) => [Buffer.from([10, 32]), Buffer.from(id, 'hex')])))
        for (let index = 0; index < prompts.length; index++) {
          const content: object[] = [{ type: 'text', text: prompts[index] }]
          if (images) content.push({ type: 'image', image: 'data' })
          db.prepare('INSERT INTO blobs VALUES (?, ?)').run(ids[index], Buffer.from(JSON.stringify({ role: 'user', content })))
        }
      } finally { db.close() }
      return
    }
    const dir = cli === 'codex' ? path.join(root, '.codex', 'sessions') : path.join(root, '.claude', 'projects', 'workspace')
    fs.mkdirSync(dir, { recursive: true })
    const rows = prompts.map((prompt) => {
      const content: object[] = [{ type: cli === 'codex' ? 'input_text' : 'text', text: prompt }]
      if (images) content.push({ type: cli === 'codex' ? 'input_image' : 'image', image_url: 'data' })
      return cli === 'codex'
        ? { type: 'response_item', payload: { type: 'message', role: 'user', content } }
        : { type: 'user', message: { content } }
    })
    fs.writeFileSync(path.join(dir, cli === 'codex' ? `rollout-test-${chatId}.jsonl` : `${chatId}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n'))
  }

  function makeThread(cli: CliProvider, items: Item[]) {
    const thread = store.createThread({ projectId, cli, chatId: randomUUID(), title: 'Images', mode: 'agent', source: 'app' })
    store.setItems(thread.id, structuredClone(items))
    return thread
  }

  it.each(['cursor', 'codex', 'claude'] as const)('restores different files by managed identity for repeated %s prompts through repeated sync and restart', (cli) => {
    const users: UserItem[] = [
      { id: 'first', kind: 'user', text: 'Describe', createdAt: 10, managedMessageId: messageId, attachments: [file] },
      { id: 'second', kind: 'user', text: 'Describe', createdAt: 11, managedMessageId: randomUUID(), attachments: [{ ...file, id: randomUUID(), name: 'second.png' }] },
      { id: 'only-file', kind: 'user', text: '', createdAt: 12, managedMessageId: randomUUID(), attachments: [{ ...file, id: randomUUID(), name: 'third.png' }] }
    ]
    const thread = makeThread(cli, users)
    writeTranscript(cli, thread.chatId!, users.map((item) => attachmentPrompt(`${item.text}\nInjected managed file path`, item.managedMessageId!)), true)
    for (let index = 0; index < 2; index++) {
      const synced = syncFromCli({ store, isRunning: () => false }, thread.id)!
      expect(synced.map((item) => item.kind === 'user' ? { text: item.text, attachments: item.attachments, managedMessageId: item.managedMessageId } : {}))
        .toEqual(users.map(({ text, attachments, managedMessageId }) => ({ text, attachments, managedMessageId })))
    }
    store.flush()
    expect(new Store().items(thread.id)).toEqual(store.items(thread.id))
  })

  it.each(['cursor', 'codex', 'claude'] as const)('never trusts a foreign or forged fork attachment in %s import or sync', (cli) => {
    const foreignId = randomUUID()
    const foreign: UserItem = { id: 'foreign', kind: 'user', text: '', createdAt: 10, managedMessageId: foreignId, attachments: [file] }
    makeThread(cli, [foreign])
    const target = makeThread(cli, [])
    writeTranscript(cli, target.chatId!, [forkPrompt([foreign], attachmentPrompt('New request', randomUUID()))])
    const imported = cli === 'cursor' ? readCliTranscript(target.chatId!) : cli === 'codex' ? readCodexTranscript(target.chatId!) : readClaudeTranscript(target.chatId!)
    expect(imported?.filter((item) => item.kind === 'user').every((item) => item.attachments === undefined)).toBe(true)
    expect(imported?.[0]).toMatchObject({ text: '[附件信息不可用]', managedMessageId: foreignId })
    const synced = syncFromCli({ store, isRunning: () => false }, target.id)!
    expect(synced.filter((item) => item.kind === 'user').every((item) => item.attachments === undefined)).toBe(true)
  })

  it.each(['cursor', 'codex', 'claude'] as const)('hides injected historical paths in a text-only %s replay followup after sync', (cli) => {
    const historical: UserItem = { id: 'historical', kind: 'user', text: 'Describe', createdAt: 10, managedMessageId: messageId, attachments: [file] }
    const current: UserItem = { id: 'current', kind: 'user', text: 'Continue.', createdAt: 11, managedMessageId: randomUUID() }
    const target = makeThread(cli, [historical, current])
    writeTranscript(cli, target.chatId!, [forkPrompt([historical], attachmentPrompt('Continue.\nFiles attached in the copied conversation history:\nInjected managed file path', current.managedMessageId!))], true)
    const synced = syncFromCli({ store, isRunning: () => false }, target.id)!.filter((item) => item.kind === 'user')
    expect(synced).toHaveLength(2)
    expect(synced[0]).toMatchObject({ text: 'Describe', attachments: [file], managedMessageId: messageId })
    expect(synced[1]).toMatchObject({ text: 'Continue.', managedMessageId: current.managedMessageId })
    expect(synced[1]).not.toHaveProperty('attachments')
  })

  it('keeps attachment originals and identities on Cursor fallback and native Codex/Claude forks', async () => {
    const user: UserItem = { id: 'user', kind: 'user', text: '', createdAt: 10, managedMessageId: messageId, attachments: [file] }
    const forkSession = vi.fn().mockResolvedValue({ chatId: 'native-fork', cwd: root })
    for (const cli of ['cursor', 'codex', 'claude'] as const) {
      const source = makeThread(cli, [user])
      const fork = await forkThread({ store, isRunning: () => false, forkSession, broadcast: () => undefined }, source.id)
      expect(fork.items[0]).toMatchObject({ ...user, id: expect.any(String) })
      expect(fork.items[0].id).not.toBe(user.id)
      if (cli === 'cursor') {
        expect(fork.thread.chatId).toBeUndefined()
        expect(fork.thread.forkContextThroughItemId).toBe(fork.items[0].id)
      } else expect(fork.thread.chatId).toBe('native-fork')
    }
    expect(forkSession).toHaveBeenCalledTimes(2)
  })
})
