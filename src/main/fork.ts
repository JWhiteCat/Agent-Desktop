import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Item } from '@shared/types'

export interface ForkBlob {
  id: string
  data: Buffer
}

/** How to point the duplicated CLI session. `linked: false` means the cut cannot be represented. */
export interface CliForkPlan {
  rootBlobId?: string
  extraBlobs: ForkBlob[]
  linked: boolean
}

interface Field {
  field: number
  start: number
  end: number
  payload?: Buffer
}

interface TurnPoint {
  userText: string
  /** Conversation state before this user message. */
  beforeStateId?: string
  turnBlob: Buffer
}

const AGENT_KINDS = new Set<Item['kind']>(['assistant', 'thinking', 'tool', 'question'])

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0
  let shift = 0
  for (;;) {
    const b = buf[pos++]
    if (b === undefined) throw new Error('truncated varint')
    result += (b & 0x7f) * 2 ** shift
    if (!(b & 0x80)) return [result, pos]
    shift += 7
    if (shift > 49) throw new Error('varint too long')
  }
}

function writeVarint(n: number): Buffer {
  const bytes: number[] = []
  let rest = n
  while (rest > 127) {
    bytes.push((rest & 0x7f) | 0x80)
    rest = Math.floor(rest / 128)
  }
  bytes.push(rest)
  return Buffer.from(bytes)
}

function encodeBytesField(field: number, payload: Buffer): Buffer {
  return Buffer.concat([writeVarint((field << 3) | 2), writeVarint(payload.length), payload])
}

/** Parses a protobuf message. Returns undefined when the buffer is not entirely valid fields. */
function parseFields(buf: Buffer): Field[] | undefined {
  const out: Field[] = []
  let pos = 0
  try {
    while (pos < buf.length) {
      const start = pos
      let key: number
      ;[key, pos] = readVarint(buf, pos)
      const field = Math.floor(key / 8)
      const wire = key & 7
      if (field <= 0) return undefined
      if (wire === 0) {
        ;[, pos] = readVarint(buf, pos)
        out.push({ field, start, end: pos })
      } else if (wire === 2) {
        let len: number
        ;[len, pos] = readVarint(buf, pos)
        if (len < 0 || pos + len > buf.length) return undefined
        const payload = buf.subarray(pos, pos + len)
        pos += len
        out.push({ field, start, end: pos, payload })
      } else if (wire === 1) {
        if (pos + 8 > buf.length) return undefined
        pos += 8
        out.push({ field, start, end: pos })
      } else if (wire === 5) {
        if (pos + 4 > buf.length) return undefined
        pos += 4
        out.push({ field, start, end: pos })
      } else return undefined
    }
  } catch {
    return undefined
  }
  return out
}

function blobIds(buf: Buffer, fieldNo: number): string[] {
  const fields = parseFields(buf)
  if (!fields) return []
  const ids: string[] = []
  for (const f of fields) {
    if (f.field === fieldNo && f.payload && f.payload.length === 32) ids.push(f.payload.toString('hex'))
  }
  return ids
}

function plainText(text: string): string {
  const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)
  return (query ? query[1] : text).replace(/\s+/g, ' ').trim()
}

function sameText(a: string, b: string): boolean {
  const x = plainText(a)
  const y = plainText(b)
  if (!x || !y) return false
  return x === y || x.startsWith(y) || y.startsWith(x)
}

function jsonUserText(data: Buffer): string | undefined {
  if (data[0] !== 0x7b) return undefined
  try {
    const msg = JSON.parse(data.toString('utf8'))
    if (msg?.role !== 'user') return undefined
    const content = msg.content
    const raw =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((p: { type?: string; text?: string }) => p?.type === 'text' && typeof p.text === 'string')
              .map((p: { text: string }) => p.text)
              .join('\n')
          : ''
    return plainText(raw)
  } catch {
    return undefined
  }
}

function openRead(file: string): DatabaseSync {
  return new DatabaseSync(file, { readOnly: true })
}

function loadBlob(db: DatabaseSync, id: string): Buffer | undefined {
  const row = db.prepare('SELECT data FROM blobs WHERE id = ?').get(id) as { data: Uint8Array } | undefined
  return row ? Buffer.from(row.data) : undefined
}

function readStoreMeta(db: DatabaseSync): Record<string, unknown> | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value: string } | undefined
  if (!row) return undefined
  try {
    return JSON.parse(Buffer.from(row.value, 'hex').toString('utf8'))
  } catch {
    return undefined
  }
}

function userMessageOf(db: DatabaseSync, blobId: string): { text: string; beforeStateId?: string } | undefined {
  const data = loadBlob(db, blobId)
  if (!data) return undefined
  const fields = parseFields(data)
  if (!fields) return undefined
  let text = ''
  let textBlobId: string | undefined
  let beforeStateId: string | undefined
  for (const f of fields) {
    if (f.field === 1 && f.payload) text = f.payload.toString('utf8')
    else if (f.field === 10 && f.payload?.length === 32) beforeStateId = f.payload.toString('hex')
    else if (f.field === 18 && f.payload?.length === 32) textBlobId = f.payload.toString('hex')
  }
  if (!plainText(text) && textBlobId) {
    const extra = loadBlob(db, textBlobId)
    if (extra) text = extra.toString('utf8')
  }
  return { text: plainText(text), beforeStateId }
}

function turnsOf(db: DatabaseSync, root: Buffer): TurnPoint[] {
  const turns: TurnPoint[] = []
  for (const turnId of blobIds(root, 8)) {
    const turnBlob = loadBlob(db, turnId)
    if (!turnBlob) continue
    const outer = parseFields(turnBlob)
    const agent = outer?.find((f) => f.field === 1 && f.payload && f.payload.length > 32)
    if (!agent?.payload) continue
    const inner = parseFields(agent.payload)
    const userField = inner?.find((f) => f.field === 1 && f.payload?.length === 32)
    if (!userField?.payload) continue
    const user = userMessageOf(db, userField.payload.toString('hex'))
    if (!user?.text) continue
    turns.push({ userText: user.text, beforeStateId: user.beforeStateId, turnBlob })
  }
  return turns
}

/** Drops assistant steps so the turn is only the user message. */
function stripTurnSteps(turnBlob: Buffer): Buffer | undefined {
  const outer = parseFields(turnBlob)
  if (!outer) return undefined
  const parts: Buffer[] = []
  let changed = false
  for (const span of outer) {
    if (span.field !== 1 || !span.payload) {
      parts.push(turnBlob.subarray(span.start, span.end))
      continue
    }
    const inner = parseFields(span.payload)
    if (!inner) return undefined
    const kept = inner.filter((f) => f.field !== 2 && f.field !== 6 && f.field !== 8)
    if (kept.length === inner.length) {
      parts.push(turnBlob.subarray(span.start, span.end))
      continue
    }
    changed = true
    const rebuilt = Buffer.concat(kept.map((f) => span.payload!.subarray(f.start, f.end)))
    parts.push(encodeBytesField(1, rebuilt))
  }
  if (!changed) return Buffer.from(turnBlob)
  return Buffer.concat(parts)
}

function userJsonId(db: DatabaseSync, before: Buffer, after: Buffer, userText: string): string | undefined {
  const prior = new Set(blobIds(before, 1))
  for (const id of blobIds(after, 1)) {
    if (prior.has(id)) continue
    const data = loadBlob(db, id)
    if (!data) continue
    const text = jsonUserText(data)
    if (text && sameText(text, userText)) return id
  }
  return undefined
}

function isAgentItem(item: Item): boolean {
  return AGENT_KINDS.has(item.kind)
}

/**
 * Picks a CLI conversation checkpoint for a fork.
 * Forking the whole chat keeps the latest root. Forking from a message keeps
 * history through that message and drops everything after it.
 */
export function planCliFork(chatDir: string, items: Item[], throughItemId?: string): CliForkPlan {
  const empty: CliForkPlan = { extraBlobs: [], linked: true }
  if (!throughItemId) return empty
  const cut = items.findIndex((it) => it.id === throughItemId)
  if (cut < 0) return { extraBlobs: [], linked: false }
  const prefix = items.slice(0, cut + 1)
  const uiUsers = prefix.filter((it) => it.kind === 'user')
  if (uiUsers.length === 0) return { extraBlobs: [], linked: false }

  const dbPath = path.join(chatDir, 'store.db')
  if (!fs.existsSync(dbPath)) return { extraBlobs: [], linked: false }
  const db = openRead(dbPath)
  try {
    const meta = readStoreMeta(db)
    const latestId = typeof meta?.latestRootBlobId === 'string' ? meta.latestRootBlobId : ''
    const latest = latestId ? loadBlob(db, latestId) : undefined
    if (!latest) return { extraBlobs: [], linked: false }
    const turns = turnsOf(db, latest)
    if (turns.length === 0) return { extraBlobs: [], linked: false }

    let cursor = 0
    let last = -1
    for (const user of uiUsers) {
      let found = -1
      for (let j = cursor; j < turns.length; j++) {
        if (sameText(turns[j].userText, user.text)) {
          found = j
          break
        }
      }
      if (found < 0) return { extraBlobs: [], linked: false }
      last = found
      cursor = found + 1
    }

    const lastUserIdx = prefix.map((it) => it.kind).lastIndexOf('user')
    const includeResponse = prefix.slice(lastUserIdx + 1).some(isAgentItem)
    const afterCut = items.slice(cut + 1)
    const nextUser = afterCut.findIndex((it) => it.kind === 'user')
    const untilNextUser = nextUser < 0 ? afterCut : afterCut.slice(0, nextUser)
    const midTurn = includeResponse && untilNextUser.some(isAgentItem)
    const turn = turns[last]
    const afterId = last + 1 < turns.length ? turns[last + 1].beforeStateId : latestId

    if (includeResponse && !midTurn) {
      if (!afterId) return { extraBlobs: [], linked: false }
      if (afterId === latestId) return empty
      return { rootBlobId: afterId, extraBlobs: [], linked: true }
    }

    if (!turn.beforeStateId) return { extraBlobs: [], linked: false }
    const before = loadBlob(db, turn.beforeStateId)
    if (!before) return { extraBlobs: [], linked: false }
    const stripped = stripTurnSteps(turn.turnBlob)
    if (!stripped) return { rootBlobId: turn.beforeStateId, extraBlobs: [], linked: true }

    const turnId = sha256(stripped)
    let root = Buffer.concat([before, encodeBytesField(8, Buffer.from(turnId, 'hex'))])
    const after = afterId ? loadBlob(db, afterId) : undefined
    const jsonId = after ? userJsonId(db, before, after, turn.userText) : undefined
    if (jsonId) root = Buffer.concat([root, encodeBytesField(1, Buffer.from(jsonId, 'hex'))])
    const rootId = sha256(root)
    const extraBlobs: ForkBlob[] = [
      { id: turnId, data: stripped },
      { id: rootId, data: root }
    ]
    return { rootBlobId: rootId, extraBlobs, linked: true }
  } catch (err) {
    console.error('[fork] plan failed', err)
    return { extraBlobs: [], linked: false }
  } finally {
    db.close()
  }
}

function readMetaFile(chatDir: string): { cwd?: string } {
  try {
    return JSON.parse(fs.readFileSync(path.join(chatDir, 'meta.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** Copies a Cursor CLI chat directory and retargets it at `plan`. */
export function materializeCliFork(
  chatDir: string,
  plan: CliForkPlan,
  title: string,
  destParent?: string
): { chatId: string; cwd?: string } {
  const dbPath = path.join(chatDir, 'store.db')
  const src = openRead(dbPath)
  const chatId = randomUUID()
  const sessionDir = path.join(destParent ?? path.dirname(chatDir), chatId)
  let dest: DatabaseSync | undefined
  let failed: unknown
  try {
    const meta = readStoreMeta(src)
    if (!meta || typeof meta.latestRootBlobId !== 'string' || !meta.latestRootBlobId) {
      throw new Error('该会话没有可复制的 CLI 记录')
    }
    fs.mkdirSync(sessionDir, { recursive: true })
    dest = new DatabaseSync(path.join(sessionDir, 'store.db'))
    const now = Date.now()
    const cwd = readMetaFile(chatDir).cwd
    const nextMeta = {
      ...meta,
      agentId: chatId,
      name: title,
      createdAt: now,
      latestRootBlobId: plan.rootBlobId || meta.latestRootBlobId
    }
    dest.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    dest.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    const insert = dest.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)')
    const insertExtra = dest.prepare('INSERT OR IGNORE INTO blobs (id, data) VALUES (?, ?)')
    dest.exec('BEGIN')
    for (const row of src.prepare('SELECT id, data FROM blobs').all() as { id: string; data: Uint8Array }[]) {
      insert.run(row.id, row.data)
    }
    for (const blob of plan.extraBlobs) insertExtra.run(blob.id, blob.data)
    dest.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', Buffer.from(JSON.stringify(nextMeta), 'utf8').toString('hex'))
    dest.exec('COMMIT')
    const sidecar = {
      schemaVersion: 1,
      createdAtMs: now,
      updatedAtMs: now,
      hasConversation: true,
      title,
      ...(cwd ? { cwd } : {})
    }
    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(sidecar))
    return { chatId, cwd }
  } catch (err) {
    failed = err
    throw err
  } finally {
    src.close()
    try {
      dest?.close()
    } catch {
      /* the new database may not have been opened */
    }
    if (failed) fs.rmSync(sessionDir, { recursive: true, force: true })
  }
}
