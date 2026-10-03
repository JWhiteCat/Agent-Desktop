import type { Item, QuestionAnswer, ThreadMeta } from '@shared/types'
import { t } from '@shared/i18n'
import { errorText, toast } from './feedback'
import { LAST_PROJECT_KEY } from './persistence'
import { getState, setState, type SendOptions } from './state'

export function rememberProject(projectId: string): void {
  localStorage.setItem(LAST_PROJECT_KEY, projectId)
  setState({ lastProjectId: projectId })
}

function mergeItems(current: Item[], updates: Iterable<Item>): Item[] {
  const next = current.slice()
  const index = new Map(next.map((item, i) => [item.id, i]))
  for (const item of updates) {
    const i = index.get(item.id)
    if (i === undefined) {
      index.set(item.id, next.length)
      next.push(item)
    } else next[i] = item
  }
  return next
}

const itemLoads = new Map<string, { promise: Promise<void>; updates: Map<string, Item> }>()
const staleItemIds = new Set<string>()
const readRequests = new Set<string>()

/** Only an ended conversation actually displayed in the foreground has been read. */
export async function markDisplayedThreadRead(): Promise<void> {
  const state = getState()
  if (state.view.kind !== 'thread' || !document.hasFocus() || document.visibilityState !== 'visible') return
  const id = state.view.id
  const thread = state.app.threads.find((thread) => thread.id === id)
  if (!thread?.unread || state.app.running.includes(id) || !state.items[id] ||
    itemLoads.has(id) || staleItemIds.has(id) || readRequests.has(id)) return

  readRequests.add(id)
  try {
    await window.api.updateThread(id, { unread: false })
  } catch (err) {
    toast(errorText(err), 'error')
  } finally {
    readRequests.delete(id)
  }
}

/** The history request and its live updates share one owner so a late snapshot cannot erase events. */
export function receiveItems(threadId: string, items: Item[]): void {
  const loading = itemLoads.get(threadId)
  if (loading) for (const item of items) loading.updates.set(item.id, item)
  setState((s) => {
    const current = s.items[threadId]
    if (!current) return {}
    return { items: { ...s.items, [threadId]: mergeItems(current, items) } }
  })
}

/** Apply events received during a history request after its snapshot, including the first load. */
function loadThreadItems(id: string, refresh = false): Promise<void> {
  const pending = itemLoads.get(id)
  if (pending && !refresh) return pending.promise
  staleItemIds.add(id)
  const updates = new Map<string, Item>()
  const promise = window.api.getItems(id).then((items) => {
    if (itemLoads.get(id)?.promise !== promise) return
    setState((s) => ({ items: { ...s.items, [id]: mergeItems(items, updates.values()) } }))
    staleItemIds.delete(id)
  }).finally(() => {
    if (itemLoads.get(id)?.promise === promise) itemLoads.delete(id)
  })
  itemLoads.set(id, { promise, updates })
  return promise
}

/** Reconnects must replace in-flight snapshots from the old connection too. */
export async function refreshThreadItems(): Promise<void> {
  const state = getState()
  const ids = state.app.threads
    .filter((thread) => state.items[thread.id] || itemLoads.has(thread.id) ||
      (state.view.kind === 'thread' && state.view.id === thread.id))
    .map((thread) => thread.id)
  for (const id of ids) staleItemIds.add(id)
  await Promise.all(ids.map(async (id) => {
    await loadThreadItems(id, true)
    const view = getState().view
    if (view.kind === 'thread' && view.id === id) await markDisplayedThreadRead()
  }))
}

export async function openThread(id: string): Promise<void> {
  setState({ view: { kind: 'thread', id } })
  const thread = getState().app.threads.find((t) => t.id === id)
  if (thread) rememberProject(thread.projectId)
  const state = getState()
  const idle = !state.app.running.includes(id)
  if (!state.items[id] || staleItemIds.has(id) || (thread?.source === 'cli' && idle)) {
    await loadThreadItems(id)
  }
  await markDisplayedThreadRead()
}

export async function forkThread(threadId: string, throughItemId?: string): Promise<void> {
  try {
    const result = await window.api.forkThread(threadId, throughItemId)
    const thread = result.thread
    setState((s) => ({
      app: s.app.threads.some((t) => t.id === thread.id) ? s.app : { ...s.app, threads: [...s.app.threads, thread] },
      items: { ...s.items, [thread.id]: result.items },
      view: { kind: 'thread', id: thread.id }
    }))
    rememberProject(thread.projectId)
    toast(t('已分叉为「{title}」', { title: thread.title }))
  } catch (err) {
    toast(errorText(err), 'error')
  }
}

export async function syncThreadFromCli(id: string): Promise<void> {
  try {
    const items = await window.api.syncFromCli(id)
    setState((s) => ({ items: { ...s.items, [id]: items } }))
    toast(t('已从 CLI 同步 {count} 条记录', { count: items.length }))
  } catch (err) {
    toast(errorText(err), 'error')
  }
}

export function goHome(projectId?: string): void {
  const state = getState()
  const pid = projectId ?? state.lastProjectId ?? state.app.projects[0]?.id
  if (pid) rememberProject(pid)
  setState({ view: { kind: 'home', projectId: pid } })
}

export async function answerQuestion(threadId: string, questionId: string, answers: QuestionAnswer[] | null): Promise<void> {
  try {
    await window.api.answerQuestion(threadId, questionId, answers)
  } catch (err) {
    toast(errorText(err), 'error')
    throw err
  }
}

export async function sendMessage(threadId: string, prompt: string, opts: SendOptions): Promise<void> {
  if (!getState().items[threadId]) {
    await loadThreadItems(threadId)
  }
  const { cli, ...rest } = opts
  try {
    await window.api.send({ threadId, prompt, ...rest, ...(cli ? { cli } : {}) })
  } catch (err) {
    toast(errorText(err), 'error')
    throw err
  }
}

export async function startThread(projectId: string, prompt: string, opts: SendOptions): Promise<ThreadMeta> {
  const thread = await window.api.createThread(projectId, opts.mode, opts.model, opts.force, opts.cli)
  setState((s) => ({
    app: s.app.threads.some((t) => t.id === thread.id) ? s.app : { ...s.app, threads: [...s.app.threads, thread] },
    items: { ...s.items, [thread.id]: [] },
    view: { kind: 'thread', id: thread.id }
  }))
  rememberProject(projectId)
  await sendMessage(thread.id, prompt, opts)
  return thread
}

export async function addProjectInteractive(): Promise<string | undefined> {
  try {
    const p = await window.api.pickProject()
    if (p) {
      rememberProject(p.id)
      return p.id
    }
  } catch (err) {
    toast(errorText(err), 'error')
  }
  return undefined
}
