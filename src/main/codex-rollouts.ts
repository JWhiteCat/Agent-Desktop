import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const codexSessionsRoot = (): string =>
  path.join(process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex'), 'sessions')

/** Codex rollout names end with the session id. A few files keep a different id inside the header. */
const SESSION_ID_IN_NAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** `session_id` contains the letters id; this matches only the payload id field near the start of the file. */
const PAYLOAD_ID_IN_PREFIX = /(?<![A-Za-z_])"id"\s*:\s*"([^"\\]+)"/

let aliasRoot = ''
let rolloutAliases = new Map<string, string>()
let aliasIndex: Promise<void> | undefined

function useAliasRoot(): Map<string, string> {
  const root = codexSessionsRoot()
  if (root !== aliasRoot) {
    aliasRoot = root
    rolloutAliases = new Map()
    aliasIndex = undefined
  }
  return rolloutAliases
}

function sessionIdInName(filename: string): string | undefined {
  return SESSION_ID_IN_NAME.exec(filename)?.[1]
}

/** Remember a header id that is not already the filename, so later lookups skip another full scan. */
export function rememberRolloutAlias(file: string, sessionId: string | undefined): void {
  if (!sessionId) return
  const named = sessionIdInName(path.basename(file))
  if (!named || named === sessionId) return
  useAliasRoot().set(sessionId, file)
}

function scheduleAliasIndex(): void {
  const aliases = useAliasRoot()
  if (aliasIndex) return
  const root = aliasRoot
  aliasIndex = indexAliasRollouts(root, aliases).then(() => undefined, () => undefined)
}

/** Header ids are in the first 2KB, so this never reads the rest of a rollout. */
async function indexAliasRollouts(root: string, aliases: Map<string, string>): Promise<void> {
  const named = walkRollouts(root).filter((file) => sessionIdInName(path.basename(file)))
  let cursor = 0
  const run = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= named.length || codexSessionsRoot() !== root) return
      const file = named[index]
      const id = await readPrefixedSessionId(file)
      if (codexSessionsRoot() !== root) return
      const embedded = sessionIdInName(path.basename(file))
      if (id && embedded && id !== embedded) aliases.set(id, file)
    }
  }
  const width = Math.min(32, named.length)
  if (width === 0) return
  await Promise.all(Array.from({ length: width }, () => run()))
}

async function readPrefixedSessionId(file: string): Promise<string | undefined> {
  try {
    const handle = await fs.promises.open(file, 'r')
    try {
      const buf = Buffer.alloc(2048)
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      return buf.subarray(0, bytesRead).toString('utf8').match(PAYLOAD_ID_IN_PREFIX)?.[1]
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

export interface CodexSessionMeta {
  id?: string
  cwd?: string
  createdAt?: number
}

export function codexTimeOf(row: any): number | undefined {
  const raw = row?.timestamp ?? row?.createdAt ?? row?.created_at
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? Math.floor(raw * 1000) : Math.floor(raw)
  if (typeof raw === 'string') {
    const ms = Date.parse(raw)
    if (!Number.isNaN(ms)) return ms
  }
  return undefined
}

export function codexSessionMeta(text: string): CodexSessionMeta | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const payload = row?.type === 'session_meta' ? row.payload : row?.payload?.type === 'session_meta' ? row.payload : undefined
    if (!payload || typeof payload !== 'object') continue
    const id = typeof payload.id === 'string' ? payload.id : undefined
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined
    return { id, cwd, createdAt: codexTimeOf(payload) ?? codexTimeOf(row) }
  }
  return undefined
}

export function findCodexRollout(chatId: string): string | undefined {
  const root = codexSessionsRoot()
  if (!fs.existsSync(root)) return undefined
  const aliases = useAliasRoot()
  const cached = aliases.get(chatId)
  if (cached) {
    if (fs.existsSync(cached)) return cached
    aliases.delete(chatId)
  }
  // Match filenames before opening anything. Reading every rollout here blocks the
  // Codex prompt; most session ids are already in the filename, and the first record
  // is often larger than a small fixed read, so those reads both stall and miss.
  const unnamed: string[] = []
  const named = findNamedRollout(root, chatId, unnamed)
  if (named) return named
  for (const file of unnamed) {
    try {
      const meta = codexSessionMeta(readFirstRecord(file))
      rememberRolloutAlias(file, meta?.id)
      if (meta?.id === chatId) return file
    } catch {
      /* skip an unreadable rollout */
    }
  }
  if (SESSION_UUID.test(chatId)) scheduleAliasIndex()
  const alias = aliases.get(chatId)
  return alias && fs.existsSync(alias) ? alias : undefined
}

function findNamedRollout(dir: string, chatId: string, unnamed: string[]): string | undefined {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findNamedRollout(full, chatId, unnamed)
      if (found) return found
      continue
    }
    if (!entry.isFile() || !/^rollout-.*\.jsonl$/i.test(entry.name)) continue
    if (entry.name.includes(chatId)) return full
    if (!sessionIdInName(entry.name)) unnamed.push(full)
  }
  return undefined
}

export function walkRollouts(dir: string): string[] {
  const out: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkRollouts(full))
    else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) out.push(full)
  }
  return out
}

export function readRolloutHead(file: string, max: number): string {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(max)
    const n = fs.readSync(fd, buf, 0, max, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/** The session id lives in the first JSONL record, which can be far larger than 8KB. */
function readFirstRecord(file: string, max = 256_000): string {
  const fd = fs.openSync(file, 'r')
  try {
    const chunks: Buffer[] = []
    let total = 0
    const buf = Buffer.alloc(8192)
    while (total < max) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, max - total), total)
      if (n <= 0) break
      const newline = buf.subarray(0, n).indexOf(0x0a)
      if (newline >= 0) {
        chunks.push(Buffer.from(buf.subarray(0, newline)))
        break
      }
      chunks.push(Buffer.from(buf.subarray(0, n)))
      total += n
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}
