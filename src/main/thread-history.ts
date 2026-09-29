import type { Item, ResultItem, ThreadMeta } from '@shared/types'
import { threadCli } from '@shared/types'
import { materializeCliFork, planCliFork } from './fork'
import { readClaudeTranscript } from './claude-history'
import { findChatDir, readCliTranscript, UNTITLED } from './history'
import { readCodexTranscript } from './codex-history'
import { newId } from './id'
import { titleFrom } from './sessions'
import type { Store } from './store'

const FORK_NOTICE = '已复制所选对话记录。下次发送时会将这些历史作为上下文传给新会话。'

export interface HistoryDeps {
  store: Store
  isRunning(id: string): boolean
  forkSession(id: string): Promise<{ chatId: string; cwd: string }>
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

/** CLI history has fresh item IDs; only a unique Codex usage ID identifies the same turn. */
function preserveQuotaEstimates(previous: Item[], imported: Item[]): void {
  const uniqueResults = (items: Item[]): Map<string, ResultItem | undefined> => {
    const results = new Map<string, ResultItem | undefined>()
    for (const item of items) {
      if (item.kind !== 'result' || (item.cli && item.cli !== 'codex') || !item.usageId) continue
      results.set(item.usageId, results.has(item.usageId) ? undefined : item)
    }
    return results
  }
  const saved = uniqueResults(previous)
  for (const [usageId, item] of uniqueResults(imported)) {
    const estimate = saved.get(usageId)?.weeklyQuotaEstimate
    if (item && estimate) item.weeklyQuotaEstimate = structuredClone(estimate)
  }
}

/** Copies a conversation into a new thread. `throughItemId` keeps history only up to that message. */
export async function forkThread(deps: HistoryDeps, id: string, throughItemId?: string): Promise<{ thread: ThreadMeta; items: Item[] }> {
  if (deps.isRunning(id)) throw new Error('对话正在运行，请稍后再分叉')
  const source = deps.store.thread(id)
  if (!source) throw new Error('对话不存在')
  const src = { ...source }
  const items = deps.store.items(id)
  const cut = throughItemId ? items.findIndex((it) => it.id === throughItemId) : items.length - 1
  if (cut < 0) throw new Error('找不到要分叉的消息')
  const prefix = items.slice(0, cut + 1)
  if (!prefix.some((it) => it.kind === 'user' || it.kind === 'assistant')) throw new Error('没有可以分叉的内容')

  const cloned = cloneItems(prefix)
  const snapshot = JSON.stringify(items)
  let title = forkTitle(deps.store, src.title, src.projectId)
  const cli = threadCli(src)
  let chatId: string | undefined
  let cwd = src.cwd
  if (src.chatId && !src.forkContextThroughItemId) {
    try {
      if (cli === 'cursor') {
        const dir = findChatDir(src.chatId)
        const plan = dir ? planCliFork(dir, items, throughItemId) : undefined
        if (dir && plan?.linked) {
          const made = materializeCliFork(dir, plan, title)
          chatId = made.chatId
          if (made.cwd) cwd = made.cwd
        }
      } else if (!throughItemId) {
        const made = await deps.forkSession(id)
        // The source may have advanced while the adapter was starting. Keep the
        // snapshot selected at click time instead of loading newer CLI history.
        const current = deps.store.thread(id)
        if (current?.chatId === src.chatId && threadCli(current) === cli
          && !deps.isRunning(id) && JSON.stringify(deps.store.items(id)) === snapshot) {
          chatId = made.chatId
          cwd = made.cwd
        }
      }
    } catch (err) {
      console.error('[fork] copy failed', err)
    }
  }

  if (!deps.store.thread(id)) throw new Error('原对话已删除')
  title = forkTitle(deps.store, src.title, src.projectId)
  const forkContextThroughItemId = chatId ? undefined : cloned.at(-1)?.id
  if (!chatId) cloned.push({ id: newId(), kind: 'notice', level: 'info', text: FORK_NOTICE })

  const thread = deps.store.createThread({
    projectId: src.projectId,
    title,
    chatId,
    forkContextThroughItemId,
    cwd,
    cli,
    model: src.model,
    modelLabel: src.modelLabel,
    mode: src.mode,
    force: src.force,
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
  if (t.forkContextThroughItemId) throw new Error('分叉上下文尚未写入 CLI，请成功发送一条消息后再同步')
  const cli = threadCli(t)
  const items = cli === 'codex' ? readCodexTranscript(t.chatId) : cli === 'claude' ? readClaudeTranscript(t.chatId) : readCliTranscript(t.chatId)
  // A CLI may have created its database before persisting any messages.
  // Keep the local transcript until there is history to replace it with.
  if (!items?.length) return undefined
  if (cli === 'codex') preserveQuotaEstimates(deps.store.items(threadId), items)
  deps.store.setItems(threadId, items)
  const firstUser = items.find((i) => i.kind === 'user')
  deps.store.updateThread(threadId, {
    syncedAt: Date.now(),
    preview: previewOf(items) ?? t.preview,
    ...(t.title === UNTITLED && firstUser?.kind === 'user' ? { title: titleFrom(firstUser.text) } : {})
  })
  return items
}
