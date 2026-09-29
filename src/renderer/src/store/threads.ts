import type { Item, QuestionAnswer, ThreadMeta } from '@shared/types'
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
function loadThreadItems(id: string): Promise<void> {
  const pending = itemLoads.get(id)
  if (pending) return pending.promise
  const updates = new Map<string, Item>()
  const promise = window.api.getItems(id).then((items) => {
    setState((s) => ({ items: { ...s.items, [id]: mergeItems(items, updates.values()) } }))
  }).finally(() => itemLoads.delete(id))
  itemLoads.set(id, { promise, updates })
  return promise
}

export async function openThread(id: string): Promise<void> {
  setState({ view: { kind: 'thread', id } })
  const thread = getState().app.threads.find((t) => t.id === id)
  if (thread) rememberProject(thread.projectId)
  const state = getState()
  const idle = !state.app.running.includes(id)
  if (!state.items[id] || (thread?.source === 'cli' && idle)) {
    await loadThreadItems(id)
  }
  if (thread?.unread) window.api.updateThread(id, { unread: false })
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
    toast(`已分叉为「${thread.title}」`)
  } catch (err) {
    toast(errorText(err), 'error')
  }
}

export async function syncThreadFromCli(id: string): Promise<void> {
  try {
    const items = await window.api.syncFromCli(id)
    setState((s) => ({ items: { ...s.items, [id]: items } }))
    toast(`已从 CLI 同步 ${items.length} 条记录`)
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
