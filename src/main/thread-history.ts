import type { Item, ThreadMeta } from '@shared/types'
import { threadCli } from '@shared/types'
import { materializeCliFork, planCliFork } from './fork'
import { findChatDir, readCliTranscript, UNTITLED } from './history'
import { readCodexTranscript } from './codex-history'
import { newId } from './id'
import { titleFrom } from './sessions'
import type { Store } from './store'

const FORK_NOTICE = '未能复制 Cursor CLI 的会话上下文，之后发送的消息会从新会话开始。'
const CODEX_FORK_NOTICE = '已复制对话记录。之后发送的消息会从新的 Codex 会话开始。'

export interface HistoryDeps {
  store: Store
  isRunning(id: string): boolean
  broadcast(): void
}

function previewOf(items: Item[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'assistant') return it.text.replace(/\s+/g, ' ').trim().slice(0, 120)
  }
  return undefined
}

function forkTitle(store: Store, title: string, projectId: string): string {
  const base = title.replace(/^\(\d+\)\s+/, '')
  const taken = new Set(store.threads.filter((t) => t.projectId === projectId).map((t) => t.title))
  let n = 1
  while (taken.has(`(${n}) ${base}`)) n++
  return `(${n}) ${base}`
}

function cloneItems(items: Item[]): Item[] {
  const cloned = structuredClone(items) as Item[]
  for (const it of cloned) {
    // Keep usageId so a forked turn is not counted again.
    it.id = newId()
    if (it.kind === 'question' && it.status === 'pending') it.status = 'skipped'
    if (it.kind === 'tool' && it.status === 'running') it.status = 'error'
    if (it.kind === 'thinking' && !it.done) it.done = true
  }
  return cloned
}

/** Copies a conversation into a new thread. `throughItemId` keeps history only up to that message. */
export function forkThread(deps: HistoryDeps, id: string, throughItemId?: string): { thread: ThreadMeta; items: Item[] } {
  if (deps.isRunning(id)) throw new Error('对话正在运行，请稍后再分叉')
  const src = deps.store.thread(id)
  if (!src) throw new Error('对话不存在')
  const items = deps.store.items(id)
  const cut = throughItemId ? items.findIndex((it) => it.id === throughItemId) : items.length - 1
  if (cut < 0) throw new Error('找不到要分叉的消息')
  const prefix = items.slice(0, cut + 1)
  if (!prefix.some((it) => it.kind === 'user' || it.kind === 'assistant')) throw new Error('没有可以分叉的内容')

  const cloned = cloneItems(prefix)
  const title = forkTitle(deps.store, src.title, src.projectId)
  const cli = threadCli(src)
  let chatId: string | undefined
  let cwd = src.cwd
  if (cli === 'codex') {
    if (src.chatId) cloned.push({ id: newId(), kind: 'notice', level: 'info', text: CODEX_FORK_NOTICE })
  } else if (src.chatId) {
    const dir = findChatDir(src.chatId)
    const plan = dir ? planCliFork(dir, items, throughItemId) : { extraBlobs: [], linked: false }
    if (!dir || !plan.linked) {
      cloned.push({ id: newId(), kind: 'notice', level: 'info', text: FORK_NOTICE })
    } else {
      try {
        const made = materializeCliFork(dir, plan, title)
        chatId = made.chatId
        if (made.cwd) cwd = made.cwd
      } catch (err) {
        console.error('[fork] copy failed', err)
        cloned.push({ id: newId(), kind: 'notice', level: 'info', text: FORK_NOTICE })
      }
    }
  }

  const thread = deps.store.createThread({
    projectId: src.projectId,
    title,
    chatId,
    cwd,
    cli,
    model: src.model,
    modelLabel: src.modelLabel,
    mode: src.mode,
    worktree: src.worktree,
    preview: previewOf(cloned),
    source: 'app',
    ...(chatId ? { syncedAt: Date.now() } : {})
  })
  deps.store.setItems(thread.id, cloned)
  deps.broadcast()
  return { thread, items: cloned }
}

/** Replaces a thread's local items with the transcript stored by the CLI. */
export function syncFromCli(deps: Pick<HistoryDeps, 'store' | 'isRunning'>, threadId: string): Item[] | undefined {
  const t = deps.store.thread(threadId)
  if (!t?.chatId || deps.isRunning(threadId)) return undefined
  const items = threadCli(t) === 'codex' ? readCodexTranscript(t.chatId) : readCliTranscript(t.chatId)
  if (!items) return undefined
  deps.store.setItems(threadId, items)
  const firstUser = items.find((i) => i.kind === 'user')
  deps.store.updateThread(threadId, {
    syncedAt: Date.now(),
    preview: previewOf(items) ?? t.preview,
    ...(t.title === UNTITLED && firstUser?.kind === 'user' ? { title: titleFrom(firstUser.text) } : {})
  })
  return items
}
