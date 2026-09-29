import type { AgentEvent } from '@shared/types'
import { threadCli } from '@shared/types'
import { quotaSnapshot } from '@shared/turn-quota'
import { resolveCodexApiKey } from '../codex'
import { loadCodexAccountUsage } from '../codex-account'
import type { CodexTurnUsageReader } from '../codex-turn-usage'
import type { Store } from '../store'

interface CodexUsageRefresh {
  resultId: string
  sessionId: string
  at: number
  pending: boolean
  timer?: ReturnType<typeof setTimeout>
}

const CODEX_USAGE_RETRY_MS = [30_000, 120_000, 300_000]

type UsageStore = Pick<Store, 'thread' | 'items' | 'markItemsDirty' | 'settings'>

/** Owns delayed usage writes and retries without owning a CLI process or turn. */
export class SessionUsage {
  private refreshes = new Map<string, CodexUsageRefresh>()
  private stopped = false

  constructor(
    private readonly store: UsageStore,
    private readonly emit: (event: AgentEvent) => void,
    private readonly isRunning: (threadId: string) => boolean,
    private readonly readCodexAccount = loadCodexAccountUsage
  ) {}

  stop(): void {
    this.stopped = true
    for (const threadId of this.refreshes.keys()) this.cancel(threadId)
  }

  /** Opening a saved conversation also refreshes the latest session consumption. */
  refreshLatest(threadId: string): void {
    const thread = this.store.thread(threadId)
    if (!thread?.chatId || threadCli(thread) !== 'codex' || this.isRunning(threadId)) return
    if (resolveCodexApiKey(this.store.settings.codexApiKey)) return
    const item = [...this.store.items(threadId)].reverse().find((item) => item.kind === 'result')
    if (!item || (item.cli && item.cli !== 'codex')) return
    void this.saveAccountUsage(threadId, item.id, thread.chatId, this.store.settings.codexPath)
  }

  /** Late rollout writes update only their own result, without delaying task completion. */
  async saveTurnUsage(threadId: string, resultId: string, reader: CodexTurnUsageReader): Promise<void> {
    const recorded = await reader.finish()
    if (!recorded || !this.store.thread(threadId)) return
    const items = this.store.items(threadId)
    const item = items.find((item) => item.kind === 'result' && item.id === resultId)
    if (item?.kind !== 'result') return
    Object.assign(item, { usage: recorded.usage, usageId: recorded.usageId, usageComplete: recorded.completed })
    if (recorded.quotaSnapshot && (!item.quotaSnapshot || recorded.quotaSnapshot.sampledAt > item.quotaSnapshot.sampledAt)) {
      item.quotaSnapshot = recorded.quotaSnapshot
    }
    this.store.markItemsDirty(threadId)
    this.emit({ type: 'items', threadId, items: [item] })
  }

  cancel(threadId: string): void {
    clearTimeout(this.refreshes.get(threadId)?.timer)
    this.refreshes.delete(threadId)
  }

  /** Read attributed session usage after completion; accounting may arrive later. */
  async saveAccountUsage(threadId: string, resultId: string, sessionId: string, customPath: string, retry = 0): Promise<void> {
    if (this.stopped) return
    const previous = this.refreshes.get(threadId)
    if (previous?.resultId === resultId && previous.sessionId === sessionId && (previous.pending || Date.now() - previous.at < 30_000)) return
    this.cancel(threadId)
    const refresh: CodexUsageRefresh = { resultId, sessionId, at: Date.now(), pending: true }
    this.refreshes.set(threadId, refresh)
    let needsRetry = true
    try {
      const { quota, quotaSampledAt, threadUsage, sessionUsage } = await this.readCodexAccount(customPath, sessionId)
      if (this.refreshes.get(threadId) !== refresh) return
      const thread = this.store.thread(threadId)
      if (!thread || thread.chatId !== sessionId || threadCli(thread) !== 'codex') return
      needsRetry = sessionUsage ? sessionUsage.status !== 'available' : !threadUsage
      const snapshot = quota && quotaSampledAt !== undefined ? quotaSnapshot(quota, quotaSampledAt) : undefined
      if (!snapshot && !threadUsage && !sessionUsage) return
      // The user may have deleted or re-imported the transcript while the request was in flight.
      const items = this.store.items(threadId)
      const index = items.findIndex((item) => item.id === resultId && item.kind === 'result')
      const item = items[index]
      if (item?.kind !== 'result') return
      const updated = {
        ...item,
        ...(snapshot && (!item.quotaSnapshot || snapshot.sampledAt >= item.quotaSnapshot.sampledAt) ? { quotaSnapshot: snapshot } : {}),
        ...(threadUsage ? { codexThreadUsage: threadUsage } : {}),
        ...(sessionUsage ? { codexSessionUsage: sessionUsage } : {})
      }
      items[index] = updated
      this.store.markItemsDirty(threadId)
      this.emit({ type: 'items', threadId, items: [updated] })
    } catch {
      // Account usage is optional; a failed refresh must not fail the completed task.
    } finally {
      refresh.pending = false
      refresh.at = Date.now()
      if (needsRetry && retry < CODEX_USAGE_RETRY_MS.length && this.canRetryCodexUsage(threadId, refresh)) {
        refresh.timer = setTimeout(() => {
          refresh.timer = undefined
          if (!this.canRetryCodexUsage(threadId, refresh)) return
          void this.saveAccountUsage(threadId, resultId, sessionId, this.store.settings.codexPath, retry + 1)
        }, CODEX_USAGE_RETRY_MS[retry])
        refresh.timer.unref?.()
      }
    }
  }

  private canRetryCodexUsage(threadId: string, refresh: CodexUsageRefresh): boolean {
    if (this.refreshes.get(threadId) !== refresh || this.isRunning(threadId)) return false
    const thread = this.store.thread(threadId)
    if (!thread || thread.chatId !== refresh.sessionId || threadCli(thread) !== 'codex') return false
    if (resolveCodexApiKey(this.store.settings.codexApiKey)) return false
    const latest = [...this.store.items(threadId)].reverse().find((item) => item.kind === 'result')
    return latest?.id === refresh.resultId
  }
}
