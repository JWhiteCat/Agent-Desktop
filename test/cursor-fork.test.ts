import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '@shared/types'
import { materializeCliFork, planCliFork } from '../src/main/fork'
import { forkPrompt } from '../src/main/fork-context'

const temporaryDirs: string[] = []
const databases: DatabaseSync[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function varint(value: number): Buffer {
  const bytes: number[] = []
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0))
    value = Math.floor(value / 128)
  } while (value)
  return Buffer.from(bytes)
}

function field(number: number, value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes])
}

function references(data: Buffer, number: number): string[] {
  const ids: string[] = []
  let offset = 0
  function read(): number {
    let value = 0
    let shift = 0
    let byte: number
    do {
      byte = data[offset++]
      value += (byte & 127) * 2 ** shift
      shift += 7
    } while (byte & 128)
    return value
  }
  while (offset < data.length) {
    const key = read()
    const length = read()
    if (key === number * 8 + 2) ids.push(data.subarray(offset, offset + length).toString('hex'))
    offset += length
  }
  return ids
}

function fixture(prompts = ['first question', 'second question']) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-cursor-fork-'))
  temporaryDirs.push(parent)
  const source = path.join(parent, 'source')
  fs.mkdirSync(source)
  const db = new DatabaseSync(path.join(source, 'store.db'))
  databases.push(db)
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  const put = (data: Buffer): string => {
    const id = createHash('sha256').update(data).digest('hex')
    db.prepare('INSERT OR IGNORE INTO blobs (id, data) VALUES (?, ?)').run(id, data)
    return id
  }
  const ref = (number: number, id: string): Buffer => field(number, Buffer.from(id, 'hex'))
  let root = Buffer.alloc(0)
  const roots = [put(root)]
  const users: string[] = []
  const items: Item[] = []
  for (const [index, prompt] of prompts.entries()) {
    const user = put(Buffer.from(JSON.stringify({ role: 'user', content: `<user_query>${prompt}</user_query>` })))
    users.push(user)
    const answer = `answer ${index + 1}`
    const assistant = put(Buffer.from(JSON.stringify({ role: 'assistant', content: answer })))
    const userProto = put(Buffer.concat([field(1, prompt), ref(10, roots[index])]))
    const step = put(field(1, answer))
    const turn = put(field(1, Buffer.concat([ref(1, userProto), ref(2, step)])))
    root = Buffer.concat([root, ref(1, user), ref(1, assistant), ref(8, turn)])
    roots.push(put(root))
    items.push({ id: `u${index + 1}`, kind: 'user', text: prompt, createdAt: index })
    items.push({ id: `a${index + 1}`, kind: 'assistant', text: answer })
  }
  const meta = { agentId: 'source', name: 'original', createdAt: 123, latestRootBlobId: roots.at(-1), mode: 'default' }
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', Buffer.from(JSON.stringify(meta)).toString('hex'))
  fs.writeFileSync(path.join(source, 'meta.json'), JSON.stringify({ cwd: parent, title: 'original' }))
  return { parent, source, db, items, roots, users, meta, put }
}

function readFork(parent: string, chatId: string) {
  const db = new DatabaseSync(path.join(parent, chatId, 'store.db'), { readOnly: true })
  databases.push(db)
  const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value: string }
  const meta = JSON.parse(Buffer.from(row.value, 'hex').toString())
  const blob = (id: string): Buffer => Buffer.from((db.prepare('SELECT data FROM blobs WHERE id = ?').get(id) as { data: Uint8Array }).data)
  const root = blob(meta.latestRootBlobId)
  const messages = references(root, 1).map((id) => JSON.parse(blob(id).toString()))
  return { db, meta, blob, root, messages }
}

describe('Cursor conversation forks', () => {
  it('requests replay when storage has not saved all displayed turns yet', () => {
    const source = fixture()
    const stale = { ...source.meta, latestRootBlobId: source.roots[1] }
    source.db.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(Buffer.from(JSON.stringify(stale)).toString('hex'))
    expect(planCliFork(source.source, source.items).linked).toBe(false)
  })

  it('requests replay when the CLI contains later turns absent from the displayed chat', () => {
    const source = fixture()
    expect(planCliFork(source.source, source.items.slice(0, 2)).linked).toBe(false)
  })

  it('requires displayed answers to match persisted answers for whole and message forks', () => {
    const source = fixture()
    source.items[1] = { id: 'a1', kind: 'assistant', text: 'different answer' }
    expect(planCliFork(source.source, source.items).linked).toBe(false)
    expect(planCliFork(source.source, source.items, 'a1').linked).toBe(false)
  })

  it('compares response text across UI segments while ignoring non-message items', () => {
    const source = fixture()
    source.items.splice(1, 1,
      { id: 'part1', kind: 'assistant', text: 'answer' },
      { id: 'thought', kind: 'thinking', text: 'internal reasoning', done: true, startedAt: 0 },
      { id: 'note', kind: 'notice', text: 'status', level: 'info' },
      { id: 'part2', kind: 'assistant', text: '1' })
    expect(planCliFork(source.source, source.items)).toMatchObject({ linked: true, rootBlobId: source.roots.at(-1) })
  })

  it('recognizes history previously carried in a fork replay envelope', () => {
    const history: Item[] = [
      { id: 'old-user', kind: 'user', text: 'original question', createdAt: 0 },
      { id: 'old-answer', kind: 'assistant', text: 'original answer' }
    ]
    const source = fixture([forkPrompt(history, 'next question')])
    const displayed: Item[] = [...history, { id: 'new-user', kind: 'user', text: 'next question', createdAt: 1 }, source.items[1]]
    expect(planCliFork(source.source, displayed)).toMatchObject({ linked: true, rootBlobId: source.roots.at(-1) })
  })

  it('pins the validated root if the original CLI advances before copying', () => {
    const source = fixture()
    const earlier = { ...source.meta, latestRootBlobId: source.roots[1] }
    source.db.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(Buffer.from(JSON.stringify(earlier)).toString('hex'))
    const plan = planCliFork(source.source, source.items.slice(0, 2))
    source.db.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(Buffer.from(JSON.stringify(source.meta)).toString('hex'))
    const fork = materializeCliFork(source.source, plan, 'pinned fork')
    expect(readFork(source.parent, fork.chatId).messages).toHaveLength(2)
  })

  it('copies native context from an open WAL database into an independent session', () => {
    const source = fixture()
    const count = source.db.prepare('SELECT COUNT(*) AS count FROM blobs').get()
    const plan = planCliFork(source.source, source.items)
    const fork = materializeCliFork(source.source, plan, 'copied conversation')
    const copy = readFork(source.parent, fork.chatId)
    expect(fork.chatId).not.toBe('source')
    expect(fork.cwd).toBe(source.parent)
    expect(copy.meta).toMatchObject({ agentId: fork.chatId, name: 'copied conversation', latestRootBlobId: source.roots.at(-1) })
    expect(copy.messages.map((message) => message.content)).toEqual([
      '<user_query>first question</user_query>', 'answer 1', '<user_query>second question</user_query>', 'answer 2'
    ])
    expect(copy.db.prepare('SELECT COUNT(*) AS count FROM blobs').get()).toEqual(count)
    expect(source.db.prepare('SELECT COUNT(*) AS count FROM blobs').get()).toEqual(count)
    const originalMeta = source.db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value: string }
    expect(JSON.parse(Buffer.from(originalMeta.value, 'hex').toString())).toEqual(source.meta)
  })

  it('keeps a completed response while excluding later turns', () => {
    const source = fixture()
    const plan = planCliFork(source.source, source.items, 'a1')
    expect(plan).toMatchObject({ linked: true, rootBlobId: source.roots[1] })
    const fork = materializeCliFork(source.source, plan, 'first turn')
    const copy = readFork(source.parent, fork.chatId)
    expect(copy.messages.map((message) => message.content)).toEqual(['<user_query>first question</user_query>', 'answer 1'])
  })

  it('copies a user-message cut into both model messages and CLI turn history', () => {
    const source = fixture()
    const plan = planCliFork(source.source, source.items, 'u2')
    expect(plan.linked).toBe(true)
    const fork = materializeCliFork(source.source, plan, 'through second user')
    const copy = readFork(source.parent, fork.chatId)
    expect(copy.messages.map((message) => message.content)).toEqual([
      '<user_query>first question</user_query>', 'answer 1', '<user_query>second question</user_query>'
    ])
    const turns = references(copy.root, 8)
    expect(turns).toHaveLength(2)
    const lastTurn = copy.blob(turns[1])
    const agent = Buffer.from(references(lastTurn, 1)[0], 'hex')
    expect(references(agent, 1)).toHaveLength(1)
    expect(references(agent, 2)).toHaveLength(0)
  })

  it('requests replay for cuts partway through a response instead of dropping all assistant steps', () => {
    const source = fixture()
    source.items.splice(1, 0, { id: 'partial', kind: 'assistant', text: 'partial answer' })
    expect(planCliFork(source.source, source.items, 'partial').linked).toBe(false)
  })

  it('does not match a different prompt that only shares a prefix', () => {
    const source = fixture(['first question with extra instructions'])
    source.items[0] = { id: 'u1', kind: 'user', text: 'first question', createdAt: 0 }
    expect(planCliFork(source.source, source.items, 'a1').linked).toBe(false)
  })

  it('requests replay when a user cut has no model-context message', () => {
    const source = fixture()
    source.db.prepare('DELETE FROM blobs WHERE id = ?').run(source.users[1])
    expect(planCliFork(source.source, source.items, 'u2').linked).toBe(false)
  })

  it('requests replay when the completed-turn checkpoint is missing', () => {
    const source = fixture()
    source.db.prepare('DELETE FROM blobs WHERE id = ?').run(source.roots[1])
    expect(planCliFork(source.source, source.items, 'a1').linked).toBe(false)
  })

  it('rejects copying a root that is absent from the source store', () => {
    const source = fixture()
    source.db.prepare('DELETE FROM blobs WHERE id = ?').run(source.roots.at(-1)!)
    expect(() => materializeCliFork(source.source, { extraBlobs: [], linked: true }, 'invalid')).toThrow('CLI 上下文缺失')
    expect(fs.readdirSync(source.parent)).toEqual(['source'])
  })

  it('rejects a source whose root points to missing conversation messages', () => {
    const source = fixture()
    source.db.prepare('DELETE FROM blobs WHERE id = ?').run(source.users[0])
    expect(() => materializeCliFork(source.source, { extraBlobs: [], linked: true }, 'invalid')).toThrow('CLI 上下文缺失')
    expect(fs.readdirSync(source.parent)).toEqual(['source'])
  })

  it('does not materialize a plan that cannot preserve the selected prefix', () => {
    const source = fixture()
    expect(() => materializeCliFork(source.source, { extraBlobs: [], linked: false }, 'invalid')).toThrow('不能复制')
    expect(fs.readdirSync(source.parent)).toEqual(['source'])
  })

  it('returns an unsupported plan for an unreadable store', () => {
    const source = fixture()
    source.db.exec('DROP TABLE meta')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(planCliFork(source.source, source.items, 'u1').linked).toBe(false)
  })
})
