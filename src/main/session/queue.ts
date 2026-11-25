import { t as translate } from '@shared/i18n'
import { isCliProvider, type MessageQueue, type QueuedMessage, type SendRequest } from '@shared/types'
import { attachmentsFor } from '../attachments'
import { newId } from '../id'
import type { Store } from '../store'

export interface QueueTurnOutcome {
  interrupted: boolean
  planned: boolean
  agent: boolean
}

export interface SessionQueueHost {
  store: Pick<Store, 'dataDir' | 'thread' | 'threads' | 'items'>
  isActive: (threadId: string) => boolean
  isShuttingDown: () => boolean
  stop: (threadId: string) => void
  dispatch: (req: SendRequest) => Promise<void>
  onStateChange: () => void
}

/**
 * Owns per-thread follow-up message queues (in memory only): enqueueing, reordering,
 * immediate send promotion, pause/plan-hold state, and post-turn draining.
 */
export class SessionQueue {
  private queues = new Map<string, MessageQueue>()

  constructor(private readonly host: SessionQueueHost) {}

  snapshot(): Record<string, MessageQueue> {
    const out: Record<string, MessageQueue> = {}
    for (const [id, queue] of this.queues) out[id] = { ...queue, items: [...queue.items] }
    return out
  }

  has(threadId: string): boolean {
    return this.queues.has(threadId)
  }

  clearAll(): void {
    this.queues.clear()
  }

  /** Drops the queue of a conversation that is being deleted. */
  clear(threadId: string): void {
    if (this.queues.delete(threadId)) this.host.onStateChange()
  }

  enqueue(req: SendRequest): void {
    const thread = this.host.store.thread(req.threadId)
    if (!thread) throw new Error(translate('对话不存在'))
    if (req.attachmentIds !== undefined && !Array.isArray(req.attachmentIds)) throw new Error(translate('附件参数无效'))
    const attachments = req.attachmentIds?.length ? attachmentsFor(this.host.store).resolveMany(req.attachmentIds) : []
    if (typeof req.prompt !== 'string' || (!req.prompt.trim() && !attachments.length)) {
      throw new Error(translate('请输入消息或添加附件'))
    }
    const immediate = req.delivery === 'now'
    const item: QueuedMessage = {
      id: newId(),
      prompt: req.prompt,
      attachments,
      model: req.model,
      mode: req.mode,
      force: req.force,
      ...(isCliProvider(req.cli) ? { cli: req.cli } : {}),
      ...(immediate ? { immediate } : {}),
      createdAt: Date.now()
    }
    const queue = this.queues.get(req.threadId) ?? { items: [] }
    const items = [...queue.items]
    if (immediate) {
      const at = items.findIndex((it) => !it.immediate)
      items.splice(at < 0 ? items.length : at, 0, item)
    } else {
      items.push(item)
    }
    this.set(req.threadId, { ...queue, items })
    if (immediate) this.host.stop(req.threadId)
  }

  remove(threadId: string, messageId: string): void {
    const queue = this.queues.get(threadId)
    if (!queue) return
    const next = queue.items.filter((item) => item.id !== messageId)
    if (next.length === queue.items.length) return
    this.set(threadId, { items: next, paused: queue.paused, waitingForPlan: queue.waitingForPlan })
  }

  reorder(threadId: string, ids: string[]): void {
    const queue = this.queues.get(threadId)
    if (!queue || !Array.isArray(ids)) return
    const byId = new Map(queue.items.map((item) => [item.id, item]))
    const ordered = ids.map((id) => byId.get(id)).filter((item): item is QueuedMessage => !!item)
    const rest = queue.items.filter((item) => !ids.includes(item.id))
    this.set(threadId, { ...queue, items: [...ordered, ...rest] })
  }

  /** Moves a queued message to the front; a running turn is stopped so it goes next. */
  sendNow(threadId: string, messageId: string): void {
    const queue = this.queues.get(threadId)
    const item = queue?.items.find((it) => it.id === messageId)
    if (!queue || !item) throw new Error(translate('排队消息不存在'))
    const rest = queue.items.filter((it) => it.id !== messageId)
    this.set(threadId, { items: [{ ...item, immediate: true }, ...rest], paused: queue.paused, waitingForPlan: queue.waitingForPlan })
    // A turn still starting is cancelled too; its cancelled startup drains this head next.
    if (this.host.isActive(threadId)) this.host.stop(threadId)
    else this.dispatchHead(threadId)
  }

  /** Pauses a queue after a send failed before starting a turn (so no endRun drains it),
   *  or dispatches an immediate head queued with "now". */
  pauseIfIdle(threadId: string): void {
    this.drain(threadId, { interrupted: true, planned: false, agent: false })
  }

  /**
   * Called after a turn ends. A head sent with "now" always goes next. Otherwise stopped or failed turns
   * pause the queue, and a turn that ends in Plan mode with a plan holds it until an Agent turn completes.
   */
  drain(threadId: string, turn: QueueTurnOutcome): void {
    const queue = this.queues.get(threadId)
    // A send that is still starting drains the queue when its own turn ends.
    if (!queue || this.host.isShuttingDown() || this.host.isActive(threadId)) return
    if (!this.host.store.thread(threadId)) {
      this.queues.delete(threadId)
      return
    }
    if (!queue.items[0]?.immediate) {
      if (turn.interrupted) {
        if (!queue.paused) this.set(threadId, { ...queue, paused: true })
        return
      }
      if (turn.planned) {
        if (!queue.waitingForPlan || queue.paused) this.set(threadId, { ...queue, paused: undefined, waitingForPlan: true })
        return
      }
      if (queue.waitingForPlan && !turn.agent) return
    }
    this.dispatchHead(threadId)
  }

  private set(threadId: string, queue: MessageQueue, notify = true): void {
    if (queue.items.length) this.queues.set(threadId, queue)
    else this.queues.delete(threadId)
    if (notify) this.host.onStateChange()
  }

  private dispatchHead(threadId: string): void {
    const queue = this.queues.get(threadId)
    const head = queue?.items[0]
    if (!queue || !head) return
    const req: SendRequest = {
      threadId,
      prompt: head.prompt,
      model: head.model,
      mode: head.mode,
      force: head.force,
      ...(head.attachments.length ? { attachmentIds: head.attachments.map((a) => a.id) } : {}),
      ...(head.cli ? { cli: head.cli } : {})
    }
    // Remove head before dispatch so re-entrant callers see the remaining queue,
    // without broadcasting a transient idle state before dispatch() starts the run.
    this.set(threadId, { items: queue.items.slice(1) }, false)
    let dispatched: Promise<void>
    try {
      dispatched = this.host.dispatch(req)
    } catch (err) {
      dispatched = Promise.reject(err)
    }
    void dispatched.then(
      () => {
        this.host.onStateChange()
      },
      (err) => {
        if (!this.host.store.thread(threadId)) return
        const current = this.queues.get(threadId) ?? { items: [] }
        this.set(threadId, {
          items: [{ ...head, immediate: undefined }, ...current.items],
          paused: true,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    )
  }
}
