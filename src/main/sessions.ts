import { imageCapture } from './tool-images'
import { getLocale, localizedMessage, t as translate } from '@shared/i18n'
import { displayThreadTitle } from '@shared/thread-title'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { enabledSkillFingerprint, toAcpMcpServers } from '@shared/agent-config'
import { parseAvailableCommands, type SlashCommand } from '@shared/commands'
import { attachmentPrompt } from '@shared/attachment-message'
import { isImageAttachment, MAX_ATTACHMENTS, MAX_MESSAGE_ATTACHMENT_BYTES, type AttachmentRef } from '@shared/attachments'
import type { AgentEvent, CliProvider, Item, MessageQueue, PrepareRequest, QuestionAnswer, QueuedMessage, SendRequest } from '@shared/types'
import { isCliProvider, threadCli } from '@shared/types'
import { normalizeTurnUsage, preferTurnUsage } from '@shared/turn-usage'
import type { WeeklyQuotaEstimate } from '@shared/turn-quota'
import { AcpConnection } from './acp'
import { exitFailureDetail, killTree, stripAnsi } from './cli'
import { createWorktree } from './git'
import { changedTurnFiles, snapshotTurnFiles } from './turn-files'
import { syncAllManagedSkills } from './skills'
import { newId } from './id'
import { forkPrompt } from './fork-context'
import { attachmentsFor } from './attachments'
import { StreamReducer } from './reducer'
import { TurnTiming } from './turn-timing'
import { loadCodexAccountUsage } from './codex-account'
import { CodexTurnUsageReader } from './codex-turn-usage'
import { SessionUsage } from './session/usage'
import { loadCodexQuota } from './quota'
import { codexProxyOverlay, isCodexRoutingTimeout, refreshCodexProxyEnv } from './system-proxy'
import {
  applySessionOptions, cliLabel, cursorArgs, fingerprintWithCwd, initializeSession, leftPlanMode,
  planPrompt, procFingerprint, providerApiKey, resolveLaunch, spawnProvider, worktreePathFrom, type AgentLaunch
} from './session/provider'
import { abandonQuestions, answerPendingQuestion, onAcpRequest, onIdleAcpRequest, settleQuestion, type InteractionRun } from './session/requests'
import type { Store } from './store'

export { leftPlanMode } from './session/provider'

/** One `agent acp` process kept alive so the next message skips startup and session/load. */
interface AgentProc {
  child: ChildProcess
  acp: AcpConnection
  provider: CliProvider
  sessionId: string
  cwd: string
  /** Worktree the CLI created for `--worktree`. New sessions start there instead of `cwd`. */
  worktree?: string
  fingerprint: string
  stderr: string
  ready: boolean
  /** Set when this process is being torn down and must not be reused. */
  dying: boolean
  force: boolean
  /** Retained when this ACP process is reused for later turns. */
  promptCapabilities?: { image: boolean }
}

interface Run extends InteractionRun {
  proc: AgentProc
  reducer: StreamReducer
  stopped: boolean
  pending: Map<string, Item>
  announcedQuestions: Set<string>
  flushTimer?: NodeJS.Timeout
  /** SwitchMode tool calls seen this turn; their completion carries no kind. */
  switchCalls: Set<string>
  failText?: string
  /** Model selected for this turn, reused by the one automatic continue. */
  model: string
  /** This turn is the single automatic「继续」. It must not send another. */
  autoContinue?: boolean
  /** Terminal UI state for this turn has already been published. */
  settled: boolean
  /** This turn spawned a CLI process instead of reusing the idle one. */
  starting: boolean
  killTimer?: NodeJS.Timeout
  /** Defined only for ChatGPT-authenticated Codex turns; an empty path selects the detected CLI. */
  codexAccountPath?: string
  resultId?: string
  timing?: TurnTiming
  codexUsage?: CodexTurnUsageReader
  weeklyQuotaEstimate?: WeeklyQuotaEstimate
  attachments?: AttachmentRef[]
  managedMessageId?: string
  userItemId?: string
  fileSnapshot?: Awaited<ReturnType<typeof snapshotTurnFiles>>
}

export interface RunFinished {
  threadId: string
  title: string
  stopped: boolean
  failed: boolean
  preview: string
}

export const DEFAULT_TITLE = '新对话'

/** Parent directory of the worktrees this app creates for Codex and Claude conversations. */
export function worktreeRoot(store: Pick<Store, 'dataDir'>): string {
  return path.join(store.dataDir, 'worktrees')
}

export function titleFrom(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/).find((l) => l.trim()) ?? DEFAULT_TITLE
  return line.length > 48 ? `${line.slice(0, 48)}…` : line
}

const CANCEL_KILL_MS = 5000
const COMMAND_WAIT_MS = 2000
const FORK_TIMEOUT_MS = 60_000
/** A real reply can mention these errors. Only a short failure text is the dropped turn. */
const AUTO_CONTINUE_TEXT_LIMIT = 240
const CURSOR_DISCONNECT_NOTICE = 'Cursor 连接中断，正在发送「{word}」。'
const CODEX_CAPACITY_NOTICE = 'Codex 所选模型已满载，正在发送「{word}」。'

/**
 * Cursor reports a dropped model request as `RetriableError: [unavailable] HTTP 502`
 * or `HTTP 503`, or `RetriableError: [canceled] http/2 stream closed ... CANCEL`.
 * The whole text has to be that failure. A longer reply that merely mentions it is left alone.
 */
export function isCursorRetriableDisconnect(text: string | undefined): boolean {
  if (!text) return false
  const clean = text.trim()
  if (!clean || clean.length > AUTO_CONTINUE_TEXT_LIMIT) return false
  return /^(?:Error:\s*)?RetriableError:\s*\[unavailable\]\s*HTTP\s*50[23]$/.test(clean)
    || /^(?:Error:\s*)?RetriableError:\s*\[canceled\]\s*(?:http\/2\s+)?stream closed(?: with error code CANCEL(?: \(0x8\))?)?$/i.test(clean)
}

/**
 * Codex reports `server_is_overloaded` as `Selected model is at capacity. Please try a different model.`
 * The adapter often sends that sentence as the whole assistant reply and still stops with `end_turn`.
 * A longer reply that merely mentions it is left alone.
 */
export function isCodexModelCapacity(text: string | undefined): boolean {
  if (!text) return false
  const clean = text.trim()
  if (!clean || clean.length > AUTO_CONTINUE_TEXT_LIMIT) return false
  return /^(?:Error:\s*)?Selected model is at capacity\.?(?: Please try a different model\.)?$/.test(clean)
}

function isAutomaticContinueFailure(provider: CliProvider, text: string | undefined): boolean {
  if (provider === 'cursor') return isCursorRetriableDisconnect(text)
  if (provider === 'codex') return isCodexModelCapacity(text)
  return false
}

/** English interface language asks the model to continue in English. */
export function automaticContinuePrompt(): string {
  return getLocale() === 'en' ? 'continue' : '继续'
}

function automaticContinueNotice(provider: CliProvider): string {
  return provider === 'codex' ? CODEX_CAPACITY_NOTICE : CURSOR_DISCONNECT_NOTICE
}

export class SessionManager {
  private runs = new Map<string, Run>()
  /** Cancellation remains observable before asynchronous startup creates a process/run. */
  private startups = new Map<string, Set<{ cancelled: boolean }>>()
  /** Sends queued or still preparing before they hand over to `runs`. */
  private pendingSends = new Map<string, number>()
  /** Idle or preparing CLI processes, keyed by thread id. Not included in `running()`. */
  private agents = new Map<string, AgentProc>()
  /** Last slash-command list for a thread. Kept after the process exits, until the thread is deleted. */
  private commandLists = new Map<string, SlashCommand[]>()
  private commandWaiters = new Map<string, Array<() => void>>()
  /** Serializes prepare and send so one thread cannot start two CLI processes. */
  private tails = new Map<string, Promise<void>>()
  /** Follow-ups sent while a thread was active. Kept in memory only. */
  private queues = new Map<string, MessageQueue>()
  private readonly usage: SessionUsage
  private shuttingDown = false

  constructor(
    private readonly store: Store,
    private readonly emit: (ev: AgentEvent) => void,
    private readonly onStateChange: () => void,
    private readonly onFinished: (info: RunFinished) => void,
    readCodexAccount = loadCodexAccountUsage,
    readCodexQuota = loadCodexQuota
  ) {
    this.usage = new SessionUsage(store, emit, (threadId) => this.isRunning(threadId), readCodexAccount, readCodexQuota)
  }

  running(): string[] {
    return [...this.runs.keys()]
  }

  /** Running turns that launched a CLI process. A reused session is omitted. */
  starting(): string[] {
    return [...this.runs].filter(([, run]) => run.starting).map(([id]) => id)
  }

  waitingForInput(): string[] {
    return [...this.runs].filter(([, run]) => !run.settled && !!run.pendingQuestions?.size).map(([id]) => id)
  }

  /** All unfinished sends, including startup and turns waiting for user input. */
  active(): string[] {
    return [...new Set([...this.pendingSends.keys(), ...this.runs.keys()])]
  }

  isRunning(threadId: string): boolean {
    return this.runs.has(threadId)
  }

  /** Opening a saved conversation also refreshes the latest session consumption. */
  refreshCodexUsage(threadId: string): void {
    this.usage.refreshLatest(threadId)
  }

  send(req: SendRequest): Promise<void> {
    const id = req.threadId
    if (req.delivery && this.active().includes(id)) {
      try {
        this.enqueueMessage(req)
        return Promise.resolve()
      } catch (err) {
        return Promise.reject(err)
      }
    }
    this.pendingSends.set(id, (this.pendingSends.get(id) ?? 0) + 1)
    return this.withStartup(id, (cancelled) => this.enqueue(id, () => this.beginSend(req, undefined, cancelled))).finally(() => {
      const remaining = this.pendingSends.get(id)! - 1
      if (remaining === 0) this.pendingSends.delete(id)
      else this.pendingSends.set(id, remaining)
    }).catch((err) => {
      // A send that never started a turn has no endRun to resume the queue.
      const queue = this.queues.get(id)
      if (queue && !this.active().includes(id) && !queue.paused) {
        queue.paused = true
        this.onStateChange()
      }
      throw err
    })
  }

  queued(): Record<string, MessageQueue> {
    const out: Record<string, MessageQueue> = {}
    for (const [id, queue] of this.queues) out[id] = { ...queue, items: [...queue.items] }
    return out
  }

  removeQueued(threadId: string, messageId: string): void {
    const queue = this.queues.get(threadId)
    if (!queue) return
    const next = queue.items.filter((item) => item.id !== messageId)
    if (next.length === queue.items.length) return
    this.setQueue(threadId, { items: next, paused: queue.paused, waitingForPlan: queue.waitingForPlan })
  }

  /** Drops the queue of a conversation that is being deleted. */
  clearQueue(threadId: string): void {
    if (this.queues.delete(threadId)) this.onStateChange()
  }

  reorderQueued(threadId: string, ids: string[]): void {
    const queue = this.queues.get(threadId)
    if (!queue || !Array.isArray(ids)) return
    const byId = new Map(queue.items.map((item) => [item.id, item]))
    const ordered = ids.map((id) => byId.get(id)).filter((item): item is QueuedMessage => !!item)
    const rest = queue.items.filter((item) => !ids.includes(item.id))
    this.setQueue(threadId, { ...queue, items: [...ordered, ...rest] })
  }

  /** Moves a queued message to the front; a running turn is stopped so it goes next. */
  sendQueuedNow(threadId: string, messageId: string): void {
    const queue = this.queues.get(threadId)
    const item = queue?.items.find((it) => it.id === messageId)
    if (!queue || !item) throw new Error(translate('排队消息不存在'))
    const rest = queue.items.filter((it) => it.id !== messageId)
    this.setQueue(threadId, { items: [{ ...item, immediate: true }, ...rest], paused: queue.paused, waitingForPlan: queue.waitingForPlan })
    // A turn still starting is cancelled too; its cancelled startup drains this head next.
    if (this.active().includes(threadId)) this.stop(threadId)
    else this.dispatchQueued(threadId)
  }

  private enqueueMessage(req: SendRequest): void {
    const thread = this.store.thread(req.threadId)
    if (!thread) throw new Error(translate('对话不存在'))
    if (req.attachmentIds !== undefined && !Array.isArray(req.attachmentIds)) throw new Error(translate('附件参数无效'))
    const attachments = req.attachmentIds?.length ? attachmentsFor(this.store).resolveMany(req.attachmentIds) : []
    if (typeof req.prompt !== 'string' || (!req.prompt.trim() && !attachments.length)) throw new Error(translate('请输入消息或添加附件'))
    const immediate = req.delivery === 'now'
    const item: QueuedMessage = {
      id: newId(), prompt: req.prompt, attachments, model: req.model, mode: req.mode, force: req.force,
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
    this.setQueue(req.threadId, { ...queue, items })
    if (immediate) this.stop(req.threadId)
  }

  private setQueue(threadId: string, queue: MessageQueue): void {
    if (queue.items.length) this.queues.set(threadId, queue)
    else this.queues.delete(threadId)
    this.onStateChange()
  }

  /**
   * Called after a turn ends. A head sent with "now" always goes next. Otherwise stopped or failed turns
   * pause the queue, and a turn that ends in Plan mode with a plan holds it until an Agent turn completes.
   */
  private drainQueue(threadId: string, turn: { interrupted: boolean; planned: boolean; agent: boolean }): void {
    const queue = this.queues.get(threadId)
    // A send that is still starting drains the queue when its own turn ends.
    if (!queue || this.shuttingDown || this.active().includes(threadId)) return
    if (!this.store.thread(threadId)) {
      this.queues.delete(threadId)
      return
    }
    if (!queue.items[0].immediate) {
      if (turn.interrupted) {
        if (!queue.paused) this.setQueue(threadId, { ...queue, paused: true })
        return
      }
      if (turn.planned) {
        if (!queue.waitingForPlan || queue.paused) this.setQueue(threadId, { ...queue, paused: undefined, waitingForPlan: true })
        return
      }
      if (queue.waitingForPlan && !turn.agent) return
    }
    this.dispatchQueued(threadId)
  }

  private dispatchQueued(threadId: string): void {
    const queue = this.queues.get(threadId)
    const head = queue?.items[0]
    if (!queue || !head) return
    this.setQueue(threadId, { items: queue.items.slice(1) })
    const req: SendRequest = {
      threadId, prompt: head.prompt, model: head.model, mode: head.mode, force: head.force,
      ...(head.attachments.length ? { attachmentIds: head.attachments.map((a) => a.id) } : {}),
      ...(head.cli ? { cli: head.cli } : {})
    }
    void this.send(req).catch((err) => {
      if (!this.store.thread(threadId)) return
      const current = this.queues.get(threadId) ?? { items: [] }
      this.setQueue(threadId, {
        items: [{ ...head, immediate: undefined }, ...current.items],
        paused: true,
        error: err instanceof Error ? err.message : String(err)
      })
    })
  }

  /**
   * Loads an existing CLI session without sending a prompt, so slash commands can be listed.
   * A thread with no `chatId` is left alone. A list already received is returned immediately.
   */
  prepare(threadId: string, opts: PrepareRequest): Promise<SlashCommand[]> {
    return this.withStartup(threadId, (cancelled) => this.enqueue(threadId, () => this.prepareBody(threadId, opts, cancelled)))
  }

  /** Copies the persisted CLI session immediately, without prompting or loading the source. */
  forkSession(threadId: string): Promise<{ chatId: string; cwd: string }> {
    return this.enqueue(threadId, async () => {
      if (this.isRunning(threadId)) throw new Error(translate('对话正在运行，请稍后再分叉'))
      const thread = this.store.thread(threadId)
      if (!thread) throw new Error(translate('对话不存在'))
      if (!thread.chatId) throw new Error(translate('对话没有可复制的 CLI 会话'))
      const sourceChatId = thread.chatId
      const provider = threadCli(thread)
      if (provider !== 'codex' && provider !== 'claude') throw new Error(translate('此 CLI 不支持通过 ACP 分叉'))
      const project = this.store.project(thread.projectId)
      if (!project) throw new Error(translate('项目不存在'))
      const settings = this.store.settings
      const launch = resolveLaunch(provider, settings.agentPath, settings.codexPath, settings.claudePath)
      if (!launch) throw new Error(translate('未找到 {label}。请先安装，或在设置中指定路径。', { label: cliLabel(provider) }))
      const cwd = thread.cwd && (thread.worktree || fs.existsSync(thread.cwd)) ? thread.cwd : project.path
      if (!fs.existsSync(cwd)) throw new Error(translate('项目目录不存在：{path}', { path: cwd }))
      const apiKey = providerApiKey(provider, settings)
      const mcpServers = toAcpMcpServers(settings.mcpServers)
      syncAllManagedSkills(settings.skills)
      // A separate id keeps this short-lived process from touching the source's live state.
      const transientId = newId()
      const proc = this.openProc(transientId, provider, launch, [], cwd, apiKey, '', false)
      let timer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([
          (async () => {
            const initialized = await initializeSession(proc.acp, provider, apiKey)
            if (initialized?.agentCapabilities?.sessionCapabilities?.fork == null) {
              throw new Error(translate('{label} 不支持会话分叉', { label: cliLabel(provider) }))
            }
            const forked = await proc.acp.request('session/fork', { sessionId: sourceChatId, cwd, mcpServers })
            const chatId = typeof forked?.sessionId === 'string' ? forked.sessionId.trim() : ''
            if (!chatId || chatId === sourceChatId) throw new Error(translate('{label} 没有返回独立的分叉会话 id', { label: cliLabel(provider) }))
            return { chatId, cwd }
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(translate('{label} 会话分叉超时', { label: cliLabel(provider) }))), FORK_TIMEOUT_MS)
          })
        ])
      } finally {
        if (timer) clearTimeout(timer)
        this.killProc(proc)
      }
    })
  }

  private enqueue<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(threadId) ?? Promise.resolve()
    const start = () => {
      if (this.shuttingDown) throw new Error(translate('应用正在关闭'))
      return fn()
    }
    const result = prev.then(start, start)
    const settled = result.then(
      () => undefined,
      () => undefined
    )
    this.tails.set(threadId, settled)
    void settled.finally(() => {
      if (this.tails.get(threadId) === settled) this.tails.delete(threadId)
    })
    return result
  }

  private async withStartup<T>(threadId: string, body: (cancelled: () => boolean) => Promise<T>): Promise<T> {
    const token = { cancelled: false }
    const tokens = this.startups.get(threadId) ?? new Set<{ cancelled: boolean }>()
    tokens.add(token)
    this.startups.set(threadId, tokens)
    try {
      return await body(() => {
        if (this.shuttingDown) throw new Error(translate('应用正在关闭'))
        if (!this.store.thread(threadId)) throw new Error(translate('对话不存在'))
        return token.cancelled
      })
    } finally {
      tokens.delete(token)
      if (!tokens.size && this.startups.get(threadId) === tokens) this.startups.delete(threadId)
    }
  }

  private beginSend(req: SendRequest, internal?: { autoContinue?: boolean }, cancelled?: () => boolean): Promise<void> {
    const start = async (isCancelled: () => boolean) => {
      const started = await this.beginSendBody(req, isCancelled, internal)
      if (!started) {
        // A cancelled startup has no endRun to pause the queue or dispatch a "now" message.
        setImmediate(() => {
          if (!this.active().includes(req.threadId)) {
            this.drainQueue(req.threadId, { interrupted: true, planned: false, agent: false })
          }
        })
      }
    }
    return cancelled ? start(cancelled) : this.withStartup(req.threadId, start)
  }

  private async beginSendBody(req: SendRequest, cancelled: () => boolean, internal?: { autoContinue?: boolean }): Promise<boolean> {
    if (cancelled()) return false
    if (this.shuttingDown) throw new Error(translate('应用正在关闭'))
    if (this.runs.has(req.threadId)) throw new Error(translate('该对话正在运行中'))
    const thread = this.store.thread(req.threadId)
    if (!thread) throw new Error(translate('对话不存在'))
    if (req.attachmentIds !== undefined && !Array.isArray(req.attachmentIds)) throw new Error(translate('附件参数无效'))
    const attachments = req.attachmentIds?.length ? attachmentsFor(this.store).resolveMany(req.attachmentIds) : []
    if (typeof req.prompt !== 'string' || (!req.prompt.trim() && !attachments.length)) throw new Error(translate('请输入消息或添加附件'))
    if (isCliProvider(req.cli) && req.cli !== threadCli(thread)) {
      this.store.updateThread(thread.id, { cli: req.cli })
      this.discard(thread.id)
    }
    const project = this.store.project(thread.projectId)
    if (!project) throw new Error(translate('项目不存在'))
    const settings = this.store.settings
    const provider = threadCli(thread)
    const launch = resolveLaunch(provider, settings.agentPath, settings.codexPath, settings.claudePath)
    if (!launch) throw new Error(translate('未找到 {label}。请先安装，或在设置中指定路径。', { label: cliLabel(provider) }))
    const apiKey = providerApiKey(provider, settings)

    let cwd = thread.cwd && (thread.worktree || fs.existsSync(thread.cwd)) ? thread.cwd : project.path
    if (!fs.existsSync(cwd)) throw new Error(translate('项目目录不存在：{path}', { path: cwd }))
    // Cursor creates its own worktree from `--worktree`; the Codex and Claude adapters have no such flag.
    if (provider !== 'cursor' && req.worktree && !thread.chatId && !thread.cwd) {
      cwd = await createWorktree(cwd, worktreeRoot(this.store))
      if (cancelled()) return false
      this.store.updateThread(thread.id, { cwd, worktree: true })
    }
    this.usage.cancel(thread.id)

    const mcpServers = toAcpMcpServers(settings.mcpServers)
    const skills = enabledSkillFingerprint(settings.skills)
    // Automatic「继续」must register its run before this function yields. A refresh here
    // lets the deferred queue drain, and idle observers, see the thread as already finished.
    const fingerprint = internal?.autoContinue
      ? this.cachedFingerprint(provider, launch, cwd, settings.sandbox, req.force, apiKey, mcpServers, skills)
      : await this.launchFingerprint(provider, launch, cwd, settings.sandbox, req.force, apiKey, mcpServers, skills)
    if (cancelled()) return false
    let proc = this.agents.get(thread.id)
    const reusable = !!proc && this.canReuse(proc, fingerprint)
    if (proc && !reusable) {
      this.discard(thread.id)
      proc = undefined
    }
    if (!proc) syncAllManagedSkills(settings.skills)

    const items = this.store.items(thread.id)
    const userId = newId()
    const managedMessageId = attachments.length ? userId : undefined
    const userItem: Item = {
      id: userId, kind: 'user', text: req.prompt, createdAt: Date.now(),
      ...(attachments.length ? { attachments, managedMessageId } : {})
    }
    items.push(userItem)
    if (attachments.length) attachmentsFor(this.store).retain(attachments.map((attachment) => attachment.id))

    this.store.updateThread(thread.id, {
      ...(thread.titleKind ? { title: titleFrom(req.prompt.trim() || attachments[0]?.name || ''), titleKind: undefined } : {}),
      model: req.model,
      mode: req.mode,
      force: req.force,
      worktree: thread.chatId || thread.cwd ? thread.worktree : !!req.worktree,
      updatedAt: Date.now(),
      archived: false
    })

    if (!proc) {
      const args = provider === 'cursor' ? cursorArgs(req, settings.sandbox, cwd, !!thread.chatId) : []
      proc = this.openProc(thread.id, provider, launch, args, cwd, apiKey, fingerprint)
    }
    proc.force = req.force

    const run: Run = {
      proc,
      reducer: new StreamReducer(items, imageCapture(this.store, cwd, items)),
      stopped: false,
      pending: new Map(),
      announcedQuestions: new Set(),
      acceptUpdates: false,
      force: req.force,
      mode: req.mode,
      model: req.model,
      ...(internal?.autoContinue ? { autoContinue: true } : {}),
      onPlanApproved: () => {
        this.store.updateThread(thread.id, { mode: 'agent' })
        this.onStateChange()
      },
      switchCalls: new Set(),
      settled: false,
      starting: !reusable,
      attachments,
      managedMessageId,
      userItemId: userId,
      isAttachmentReadAllowed: (filePath, expectedPath) => {
        const refs = this.store.items(thread.id).flatMap((item) => item.kind === 'user' ? item.attachments ?? [] : [])
        return refs.length > 0 && attachmentsFor(this.store).scopedRead(filePath, proc!.cwd, refs, expectedPath)
      }
    }
    this.runs.set(thread.id, run)
    this.queue(thread.id, run, [userItem])
    this.emit({ type: 'running', threadId: thread.id, running: true })
    this.onStateChange()

    if (provider === 'codex' && !apiKey) run.codexAccountPath = settings.codexPath
    const turn = reusable
      ? this.continueSession(thread.id, run, req)
      : this.drive(thread.id, run, req, cwd, thread.chatId, provider, apiKey, mcpServers)
    void turn.catch((err) => {
      if (run.settled) return
      if (!run.stopped) run.failText = err instanceof Error ? err.message : String(err)
      // A live process can take the follow-up. Killing it here would drop the session
      // that the automatic「继续」needs to reuse.
      if (this.canAutoContinue(thread.id, run)) {
        void this.endRun(thread.id, run, null)
        return
      }
      this.killProc(run.proc)
    })
    return true
  }

  answerQuestion(threadId: string, questionId: string, answers: QuestionAnswer[] | null): void {
    answerPendingQuestion(this.runs.get(threadId), questionId, answers)
  }

  /** Cancel the current turn and keep the CLI process for the next message. */
  stop(threadId: string): void {
    for (const startup of this.startups.get(threadId) ?? []) startup.cancelled = true
    const run = this.runs.get(threadId)
    if (!run) return
    run.stopped = true
    settleQuestion(run, 'cancel')
    if (run.proc.ready && run.proc.sessionId) {
      run.proc.acp.notify('session/cancel', { sessionId: run.proc.sessionId })
      if (!run.killTimer) {
        run.killTimer = setTimeout(() => {
          run.killTimer = undefined
          if (this.runs.get(threadId) !== run || run.settled) return
          this.killProc(run.proc)
        }, CANCEL_KILL_MS)
      }
      return
    }
    this.killProc(run.proc)
  }

  /** Kill the CLI process for this thread. Used when the thread or app is going away. */
  dispose(threadId: string): void {
    for (const startup of this.startups.get(threadId) ?? []) startup.cancelled = true
    this.usage.cancel(threadId)
    this.commandLists.delete(threadId)
    this.commandWaiters.delete(threadId)
    const run = this.runs.get(threadId)
    if (run) {
      run.stopped = true
      if (run.killTimer) {
        clearTimeout(run.killTimer)
        run.killTimer = undefined
      }
      settleQuestion(run, 'cancel')
      this.killProc(run.proc)
      return
    }
    this.discard(threadId)
  }

  stopAll(): void {
    this.shuttingDown = true
    this.queues.clear()
    this.usage.stop()
    for (const id of [...this.runs.keys()]) this.dispose(id)
    for (const id of [...this.agents.keys()]) this.discard(id)
  }

  /** Drop idle processes after CLI path, API key, sandbox, MCP, or skill changes. */
  dropIdle(): void {
    for (const id of [...this.agents.keys()]) {
      if (!this.runs.has(id)) this.discard(id)
    }
  }

  /** Refresh Codex's system proxy before the fingerprint, so a newly detected proxy starts a new process. */
  private async launchFingerprint(
    provider: CliProvider,
    launch: AgentLaunch,
    cwd: string,
    sandbox: string,
    force: boolean,
    apiKey: string,
    mcpServers: unknown,
    skills: unknown
  ): Promise<string> {
    if (provider === 'codex') await refreshCodexProxyEnv()
    return this.cachedFingerprint(provider, launch, cwd, sandbox, force, apiKey, mcpServers, skills)
  }

  private cachedFingerprint(
    provider: CliProvider,
    launch: AgentLaunch,
    cwd: string,
    sandbox: string,
    force: boolean,
    apiKey: string,
    mcpServers: unknown,
    skills: unknown
  ): string {
    return procFingerprint(
      launch.cli, provider, cwd, sandbox, force, apiKey, mcpServers, skills,
      provider === 'codex' ? codexProxyOverlay() : {}
    )
  }

  private canReuse(proc: AgentProc, fingerprint: string): boolean {
    return proc.ready && !proc.dying && proc.child.exitCode === null && proc.fingerprint === fingerprint
  }

  private openProc(
    threadId: string,
    provider: CliProvider,
    launch: AgentLaunch,
    args: string[],
    cwd: string,
    apiKey: string,
    fingerprint: string,
    trackCommands = true
  ): AgentProc {
    const child = spawnProvider(provider, launch, args, cwd, apiKey)
    const proc: AgentProc = {
      child,
      acp: undefined as unknown as AcpConnection,
      provider,
      sessionId: '',
      cwd,
      fingerprint,
      stderr: '',
      ready: false,
      dying: false,
      force: false
    }
    const acp = new AcpConnection(child)
    proc.acp = acp
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      proc.stderr = (proc.stderr + chunk).slice(-8000)
    })
    acp.start({
      onText: (line) => {
        const worktree = worktreePathFrom(stripAnsi(line))
        if (worktree) proc.worktree = worktree
      },
      onNotification: (method, params, receivedAt) => {
        if (proc.dying) return
        if (method === 'session/update' && params?.update?.sessionUpdate === 'available_commands_update') {
          const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
          if (trackCommands && (!sessionId || !proc.sessionId || sessionId === proc.sessionId)) {
            this.rememberCommands(threadId, params.update.availableCommands)
          }
          return
        }
        const run = this.runs.get(threadId)
        if (!run || run.proc !== proc || method !== 'session/update' || !run.acceptUpdates) return
        if (
          params.sessionId &&
          proc.sessionId &&
          params.sessionId !== proc.sessionId
        ) {
          return
        }
        if ((proc.provider === 'cursor' || proc.provider === 'claude') && run.mode === 'plan' && leftPlanMode(params?.update, run.switchCalls)) {
          proc.acp.request('session/set_mode', { sessionId: proc.sessionId, modeId: 'plan' }).catch(() => undefined)
        }
        run.timing?.observe(params?.update, receivedAt)
        const changed = run.reducer.handleAcp(params?.update)
        if (changed.length) this.queue(threadId, run, changed)
      },
      onRequest: (method, params) => {
        const run = this.runs.get(threadId)
        if (run?.proc === proc) run.timing?.interrupt()
        if (run && run.proc === proc) return onAcpRequest(run, method, params, (items) => this.queue(threadId, run, items))
        return onIdleAcpRequest(proc, method, params)
      }
    })
    child.on('error', (err) => {
      const run = this.runs.get(threadId)
      if (run?.proc === proc) this.endRun(threadId, run, null, err)
    })
    child.on('close', (code) => {
      if (this.agents.get(threadId) === proc) this.agents.delete(threadId)
      const run = this.runs.get(threadId)
      if (run?.proc !== proc) return
      // Prompt rejection records failText in a microtask. Ending the turn on this
      // close event would run first and miss an automatic「继续」from that rejection.
      setImmediate(() => {
        if (run.settled || this.runs.get(threadId) !== run) return
        void this.endRun(threadId, run, code)
      })
    })
    return proc
  }

  private killProc(proc: AgentProc): void {
    proc.dying = true
    for (const [id, kept] of this.agents) {
      if (kept === proc) this.agents.delete(id)
    }
    killTree(proc.child)
  }

  private discard(threadId: string): void {
    const proc = this.agents.get(threadId)
    if (!proc) return
    this.killProc(proc)
  }

  private async continueSession(threadId: string, run: Run, req: SendRequest): Promise<void> {
    run.reducer.init = { sessionId: run.proc.sessionId, cwd: run.proc.cwd, model: req.model }
    await applySessionOptions(run.proc, req, this.store.settings.sandbox)
    if (!this.runs.has(threadId) || run.settled) return
    run.acceptUpdates = true
    await this.runPrompt(threadId, run, req)
  }

  private async prepareBody(threadId: string, opts: PrepareRequest, cancelled: () => boolean): Promise<SlashCommand[]> {
    if (cancelled()) return []
    const known = this.commandLists.get(threadId)
    if (known) return known
    if (this.runs.has(threadId)) return []
    const thread = this.store.thread(threadId)
    if (!thread) throw new Error(translate('对话不存在'))
    if (!thread.chatId) return []
    const project = this.store.project(thread.projectId)
    if (!project) throw new Error(translate('项目不存在'))
    const settings = this.store.settings
    const provider = threadCli(thread)
    const launch = resolveLaunch(provider, settings.agentPath, settings.codexPath, settings.claudePath)
    if (!launch) throw new Error(translate('未找到 {label}。请先安装，或在设置中指定路径。', { label: cliLabel(provider) }))
    const apiKey = providerApiKey(provider, settings)
    const cwd = thread.cwd && (thread.worktree || fs.existsSync(thread.cwd)) ? thread.cwd : project.path
    if (!fs.existsSync(cwd)) throw new Error(translate('项目目录不存在：{path}', { path: cwd }))

    const mcpServers = toAcpMcpServers(settings.mcpServers)
    const fingerprint = await this.launchFingerprint(
      provider,
      launch,
      cwd,
      settings.sandbox,
      opts.force,
      apiKey,
      mcpServers,
      enabledSkillFingerprint(settings.skills)
    )
    if (cancelled()) return []
    const req: SendRequest = { threadId, prompt: '', model: opts.model, mode: opts.mode, force: opts.force }
    let proc = this.agents.get(threadId)
    const reusable = !!proc && this.canReuse(proc, fingerprint)
    if (proc && !reusable) {
      this.discard(threadId)
      proc = undefined
    }
    if (reusable && proc) return this.finishCommandWait(threadId)

    if (!proc) {
      syncAllManagedSkills(settings.skills)
      const args = provider === 'cursor' ? cursorArgs(req, settings.sandbox, cwd, true) : []
      proc = this.openProc(threadId, provider, launch, args, cwd, apiKey, fingerprint)
    }
    proc.force = opts.force
    // Track startup too: deletion, settings changes, and shutdown must be able
    // to cancel initialize/session/load before the process becomes ready.
    this.agents.set(threadId, proc)
    try {
      const sessionId = await this.connectSession(proc, cwd, thread.chatId, provider, apiKey, mcpServers)
      await applySessionOptions(proc, req, this.store.settings.sandbox)
      if (proc.dying || proc.child.exitCode !== null) throw new Error(translate('CLI 进程已退出'))
      this.store.updateThread(threadId, { chatId: sessionId, cwd })
      this.onStateChange()
      this.agents.set(threadId, proc)
    } catch (err) {
      this.killProc(proc)
      throw err
    }
    return this.finishCommandWait(threadId)
  }

  private rememberCommands(threadId: string, raw: unknown): void {
    const commands = parseAvailableCommands(raw)
    this.commandLists.set(threadId, commands)
    this.emit({ type: 'commands', threadId, commands })
    const waiters = this.commandWaiters.get(threadId)
    if (!waiters) return
    this.commandWaiters.delete(threadId)
    for (const wake of waiters) wake()
  }

  private finishCommandWait(threadId: string): Promise<SlashCommand[]> {
    const known = this.commandLists.get(threadId)
    if (known) return Promise.resolve(known)
    return new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        const left = (this.commandWaiters.get(threadId) ?? []).filter((waiter) => waiter !== wake)
        if (left.length) this.commandWaiters.set(threadId, left)
        else this.commandWaiters.delete(threadId)
        if (!this.commandLists.has(threadId)) this.commandLists.set(threadId, [])
        resolve(this.commandLists.get(threadId) ?? [])
      }
      const wake = () => finish()
      timer = setTimeout(finish, COMMAND_WAIT_MS)
      const waiting = this.commandWaiters.get(threadId) ?? []
      waiting.push(wake)
      this.commandWaiters.set(threadId, waiting)
    })
  }

  private async drive(
    threadId: string,
    run: Run,
    req: SendRequest,
    cwd: string,
    chatId: string | undefined,
    provider: CliProvider,
    apiKey: string,
    mcpServers: Record<string, unknown>[] = []
  ): Promise<void> {
    const { proc } = run
    const sessionId = await this.connectSession(proc, cwd, chatId, provider, apiKey, mcpServers)
    run.reducer.init = { sessionId, cwd: proc.cwd, model: req.model }
    this.store.updateThread(threadId, { chatId: sessionId, cwd: proc.cwd })
    this.onStateChange()
    await applySessionOptions(proc, req, this.store.settings.sandbox)
    if (!this.runs.has(threadId) || run.settled) return
    run.acceptUpdates = true
    await this.runPrompt(threadId, run, req)
  }

  /** Initializes the ACP session. Does not send a prompt. */
  private async connectSession(
    proc: AgentProc,
    cwd: string,
    chatId: string | undefined,
    provider: CliProvider,
    apiKey: string,
    mcpServers: Record<string, unknown>[]
  ): Promise<string> {
    const acp = proc.acp
    const initialized = await initializeSession(proc.acp, provider, apiKey)
    proc.promptCapabilities = { image: initialized?.agentCapabilities?.promptCapabilities?.image === true }

    let sessionId = chatId
    if (sessionId) {
      await acp.request('session/load', { sessionId, cwd, mcpServers })
    } else {
      const sessionCwd = proc.worktree ?? cwd
      const created = await acp.request('session/new', { cwd: sessionCwd, mcpServers })
      sessionId = created?.sessionId
      if (!sessionId) throw new Error(translate('{label} 没有返回会话 id', { label: cliLabel(provider) }))
      if (sessionCwd !== proc.cwd) {
        proc.cwd = sessionCwd
        proc.fingerprint = fingerprintWithCwd(proc.fingerprint, sessionCwd)
      }
    }
    proc.sessionId = sessionId
    proc.ready = true
    return sessionId
  }

  private async runPrompt(threadId: string, run: Run, req: SendRequest): Promise<void> {
    if (this.runs.get(threadId) !== run || run.settled) return
    if (run.stopped) {
      this.endRun(threadId, run, null)
      return
    }
    const contextThroughId = this.store.thread(threadId)?.forkContextThroughItemId
    let prompt = req.prompt
    let copied: Item[] = []
    const currentAttachments = run.attachments ?? []
    if (contextThroughId) {
      const items = this.store.items(threadId)
      const cut = items.findIndex((item) => item.id === contextThroughId)
      if (cut < 0) throw new Error(translate('分叉历史缺失，无法恢复上下文'))
      copied = items.slice(0, cut + 1)
    }
    // Native forks already retain their image inputs. Only our fallback replay
    // needs to restore bytes from the trusted, persisted prefix of the fork.
    const historicalMessages = copied.filter((item) => item.kind === 'user')
      .map((item) => item.attachments?.length
        ? attachmentsFor(this.store).resolveMany(item.attachments.map((attachment) => attachment.id)) : [])
    const historicalAttachments = historicalMessages.flat()
    if (currentAttachments.length) prompt = this.withAttachmentPaths(prompt, currentAttachments)
    if (historicalAttachments.length) prompt = this.withAttachmentPaths(prompt, historicalAttachments, true)
    if (historicalAttachments.length && !run.managedMessageId && run.userItemId) {
      const item = this.store.items(threadId).find((item) => item.kind === 'user' && item.id === run.userItemId)
      if (item?.kind === 'user') {
        item.managedMessageId = run.managedMessageId = item.id
        this.queue(threadId, run, [item])
      }
    }
    if (run.managedMessageId) prompt = attachmentPrompt(prompt, run.managedMessageId)
    if (contextThroughId) prompt = forkPrompt(copied, prompt)
    const imageRefs = [...new Map([...historicalAttachments, ...currentAttachments]
      .filter(isImageAttachment).map((attachment) => [attachment.id, attachment])).values()]
    if (imageRefs.length > MAX_ATTACHMENTS || imageRefs.reduce((size, attachment) => size + attachment.size, 0) > MAX_MESSAGE_ATTACHMENT_BYTES) {
      throw new Error(translate('分叉历史与本条消息的图片合计超出附件限制，请减少图片或从更早的消息分叉后重试'))
    }
    if (imageRefs.length && !run.proc.promptCapabilities?.image) {
      throw new Error(translate('{label} 未声明支持图片输入，请更新 CLI 或移除图片后重试', { label: cliLabel(run.proc.provider) }))
    }
    const text = planPrompt(run.proc.provider, req.mode, prompt)
    const images = imageRefs.flatMap<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>((attachment) => [
      { type: 'text', text: `Attached image: ${JSON.stringify({
        id: attachment.id, name: attachment.name,
        copiedUserMessages: historicalMessages.flatMap((refs, index) => refs.some((ref) => ref.id === attachment.id) ? [index + 1] : []),
        currentMessage: currentAttachments.some((ref) => ref.id === attachment.id)
      })}. Copied user message numbers are one-based within the replayed conversation history.` },
      { type: 'image', ...attachmentsFor(this.store).read(attachment.id) }
    ])
    if (run.codexAccountPath !== undefined) {
      const start = await this.usage.sampleQuota()
      if (this.runs.get(threadId) !== run || run.settled) return
      if (run.stopped) {
        this.endRun(threadId, run, null)
        return
      }
      run.weeklyQuotaEstimate = start ? { start } : {}
    }
    run.fileSnapshot = await snapshotTurnFiles(run.proc.cwd).catch(() => [])
    if (this.runs.get(threadId) !== run || run.settled) return
    if (run.stopped) {
      await this.endRun(threadId, run, null)
      return
    }
    if (run.proc.provider === 'codex') run.codexUsage = new CodexTurnUsageReader(run.proc.sessionId)
    run.timing = new TurnTiming()
    const result = await run.proc.acp.request('session/prompt', {
      sessionId: run.proc.sessionId,
      prompt: [{ type: 'text', text }, ...images]
    })
    const stop = String(result?.stopReason ?? 'end_turn')
    const failedReply = isAutomaticContinueFailure(run.proc.provider, run.reducer.lastAssistantText)
      || isAutomaticContinueFailure(run.proc.provider, run.failText)
    const timing = run.timing.finish(run.stopped || stop === 'cancelled'
      ? 'cancelled' : stop === 'end_turn' && !failedReply ? 'completed' : 'failed')
    if (!this.runs.has(threadId) || run.settled) return
    const codexUsage = run.codexUsage?.read()
    if (contextThroughId && stop === 'end_turn') {
      this.store.updateThread(threadId, { forkContextThroughItemId: undefined })
      this.onStateChange()
    }
    run.reducer.gotResult = true
    const usage = run.proc.provider === 'codex'
      ? codexUsage?.usage
      : preferTurnUsage(normalizeTurnUsage(result?.usage), run.reducer.lastUsage)
    const changed = run.reducer.closeSegments()
    const resultId = newId()
    run.resultId = resultId
    changed.push(
      run.reducer.push({
        id: resultId,
        kind: 'result',
        isError: stop !== 'end_turn' && stop !== 'cancelled',
        durationMs: Math.round(timing.elapsedMs),
        timing,
        createdAt: Date.now(),
        model: req.model,
        ...(run.proc.provider === 'claude' && run.reducer.lastModel ? { apiModel: run.reducer.lastModel } : {}),
        cli: run.proc.provider,
        usageId: codexUsage?.usageId ?? newId(),
        usage,
        ...(codexUsage?.quotaSnapshot ? { quotaSnapshot: codexUsage.quotaSnapshot } : {}),
        ...(run.codexUsage ? { usageComplete: codexUsage?.completed ?? false } : {})
      })
    )
    this.queue(threadId, run, changed)
    const planFeedback = stop === 'end_turn' && !run.stopped && !run.proc.dying && run.proc.child.exitCode === null
      ? run.planFeedback : undefined
    run.planFeedback = undefined
    // The CLI stays up after a turn. Parking it avoids the next message paying
    // for process startup and session/load. A later close still ends the turn.
    await this.endRun(threadId, run, null)
    if (run.codexUsage && !codexUsage?.completed) void this.usage.saveTurnUsage(threadId, resultId, run.codexUsage)
    const thread = this.store.thread(threadId)
    if (planFeedback && !this.shuttingDown && thread?.chatId === run.proc.sessionId
      && threadCli(thread) === 'codex' && !this.runs.has(threadId)) {
      // The adapter consumes only the permission option id. After declining,
      // deliver the feedback in a new Plan turn on the same session. send() marks the
      // thread active at once, so a user send or queue drain cannot start a second turn.
      try {
        await this.send({ ...req, delivery: undefined, attachmentIds: undefined, prompt: planFeedback, mode: 'plan', cli: 'codex', worktree: false })
      } catch (error) {
        if (!this.store.thread(threadId)) return
        const notice: Item = {
          id: newId(), kind: 'notice', level: 'error',
          text: error instanceof Error ? error.message : String(error)
        }
        this.store.items(threadId).push(notice)
        this.store.markItemsDirty(threadId)
        this.emit({ type: 'items', threadId, items: [notice] })
      }
    }
  }

  /** Original files remain outside the project and are read through normal CLI tools. */
  private withAttachmentPaths(prompt: string, refs: AttachmentRef[], historical = false): string {
    const files = [...new Map(refs.map((attachment) => [attachment.id, attachment])).values()]
      .map((attachment) => JSON.stringify({ name: attachment.name, path: attachmentsFor(this.store).pathFor(attachment.id), mimeType: attachment.mimeType, size: attachment.size }))
    const label = historical ? 'Files attached in the copied conversation history:' : 'Files attached to this user message:'
    return `${prompt}\n\n${label}\nRead the original files at these exact local paths when needed.\n${files.join('\n')}`
  }

  private async endRun(threadId: string, run: Run, code: number | null, spawnError?: Error): Promise<void> {
    if (run.settled) return
    run.settled = true
    run.acceptUpdates = false
    // Freeze before filesystem/account cleanup. A killed/rejected turn must not look completed.
    const timing = run.timing?.finish(run.stopped ? 'cancelled' : 'failed')
    if (run.killTimer) {
      clearTimeout(run.killTimer)
      run.killTimer = undefined
    }
    settleQuestion(run, 'cancel')
    if (!this.store.thread(threadId)) {
      this.runs.delete(threadId)
      this.killProc(run.proc)
      return
    }

    const fileChanges = run.fileSnapshot?.length
      ? await changedTurnFiles(run.fileSnapshot).catch(() => undefined) : undefined
    run.fileSnapshot = undefined
    // A conversation may have been deleted while reading its final files.
    if (!this.store.thread(threadId)) {
      this.runs.delete(threadId)
      this.killProc(run.proc)
      return
    }
    const r = run.reducer
    const items = this.store.items(threadId)
    const changed: Item[] = [...r.closeSegments(), ...r.abortRunningTools(), ...abandonQuestions(items)]
    if (!r.gotResult) {
      const recorded = run.codexUsage?.read()
      if (recorded) {
        run.resultId = newId()
        changed.push(r.push({
          id: run.resultId, kind: 'result', isError: !run.stopped,
          cli: 'codex', model: r.init.model || recorded.model,
          createdAt: Date.now(), usageId: recorded.usageId, usage: recorded.usage, usageComplete: recorded.completed,
          ...(recorded.quotaSnapshot ? { quotaSnapshot: recorded.quotaSnapshot } : {})
        }))
      }
    }
    if (fileChanges !== undefined) {
      let result = items.find((item) => item.kind === 'result' && item.id === run.resultId)
      if (!result) {
        run.resultId = newId()
        result = r.push({ id: run.resultId, kind: 'result', isError: !r.gotResult && !run.stopped,
          cli: run.proc.provider, model: r.init.model, createdAt: Date.now() })
      }
      if (result?.kind === 'result') {
        result.fileChanges = fileChanges
        changed.push(result)
      }
    }
    if (timing) {
      let result = items.find((item) => item.kind === 'result' && item.id === run.resultId)
      if (!result) {
        run.resultId = newId()
        result = r.push({ id: run.resultId, kind: 'result', isError: !run.stopped,
          cli: run.proc.provider, model: run.model, createdAt: Date.now() })
      }
      if (result.kind === 'result') {
        result.timing = timing
        result.durationMs = Math.round(timing.elapsedMs)
        changed.push(result)
      }
    }
    const recover = this.canAutoContinue(threadId, run)
    const continuePrompt = recover ? automaticContinuePrompt() : undefined
    const recoverNotice = continuePrompt ? automaticContinueNotice(run.proc.provider) : undefined
    if (run.stopped) {
      changed.push(r.push({ id: newId(), kind: 'notice', level: 'info', ...localizedMessage('已停止') }))
    } else if (spawnError) {
      changed.push(r.push({ id: newId(), kind: 'notice', level: 'error', ...localizedMessage('无法启动 {label}：{error}', { label: cliLabel(run.proc.provider), error: spawnError.message }) }))
    } else if (continuePrompt && recoverNotice) {
      const existing = [...items].reverse().find((item) => item.kind === 'result')
      if (existing?.kind === 'result' && existing.isError) {
        existing.isError = false
        changed.push(existing)
      }
      changed.push(r.push({ id: newId(), kind: 'notice', level: 'info', ...localizedMessage(recoverNotice, { word: continuePrompt }) }))
    } else if (run.autoContinue && r.gotResult && isAutomaticContinueFailure(run.proc.provider, r.lastAssistantText)) {
      const existing = [...items].reverse().find((item) => item.kind === 'result')
      if (existing?.kind === 'result') {
        existing.isError = true
        changed.push(existing)
      }
      changed.push(r.push({ id: newId(), kind: 'notice', level: 'error', text: r.lastAssistantText.trim() }))
    } else if (!r.gotResult) {
      const detail = exitFailureDetail(run.failText, run.proc.stderr)
      changed.push(
        r.push({
          id: newId(),
          kind: 'notice',
          level: 'error',
          ...(isCodexRoutingTimeout(detail)
            ? localizedMessage('Codex 工作区路由超时，请确认代理或 VPN 已启动后重试。')
            : detail
              ? { text: detail }
              : localizedMessage('{label} 意外退出（退出码 {code}）', { label: cliLabel(run.proc.provider), code: code ?? 'unknown' }))
        })
      )
    }
    if (run.resultId && run.weeklyQuotaEstimate) {
      const result = items.find((item) => item.kind === 'result' && item.id === run.resultId)
      if (result?.kind === 'result') {
        result.weeklyQuotaEstimate = run.weeklyQuotaEstimate
        changed.push(result)
      }
    }
    this.queue(threadId, run, changed)
    this.flushPending(threadId, run)
    this.runs.delete(threadId)

    if (run.resultId && run.weeklyQuotaEstimate) {
      void this.usage.saveQuotaEstimate(threadId, run.resultId, run.proc.sessionId)
    }

    const keep = !run.proc.dying && !spawnError && run.proc.child.exitCode === null && (r.gotResult || recover)
    if (keep) this.agents.set(threadId, run.proc)
    else this.killProc(run.proc)

    const preview = (recoverNotice && continuePrompt ? translate(recoverNotice, { word: continuePrompt }) : r.lastAssistantText).replace(/\s+/g, ' ').trim().slice(0, 120)
    const updated = this.store.updateThread(threadId, {
      updatedAt: Date.now(),
      syncedAt: Date.now(),
      unread: true,
      ...(preview ? { preview } : {})
    })
    this.store.markItemsDirty(threadId)
    this.emit({ type: 'running', threadId, running: false })
    this.onStateChange()
    const result = [...items].reverse().find((it) => it.kind === 'result')
    const failed = !recover && (!!spawnError || !r.gotResult || (result?.kind === 'result' && result.isError))
    let summary = preview
    if (failed && !summary) {
      const notice = [...items].reverse().find((it) => it.kind === 'notice' && it.level === 'error')
      if (notice?.kind === 'notice') summary = notice.text.replace(/\s+/g, ' ').trim().slice(0, 120)
    }
    this.onFinished({
      threadId,
      title: updated ? displayThreadTitle(updated) : translate(DEFAULT_TITLE),
      stopped: run.stopped,
      failed,
      preview: summary
    })
    // Deferred so a follow-up turn that drive() starts right after endRun (Codex plan feedback) goes first.
    if (this.queues.has(threadId)) {
      const userIndex = items.findIndex((it) => it.id === run.userItemId)
      const turn = {
        interrupted: run.stopped || failed,
        planned: run.mode === 'plan' && userIndex >= 0 && items.slice(userIndex + 1).some((it) => it.kind === 'tool' && it.tool === 'createPlan'),
        agent: run.mode === 'agent'
      }
      setImmediate(() => this.drainQueue(threadId, turn))
    }
    if (run.resultId && run.codexAccountPath !== undefined) {
      void this.usage.saveAccountUsage(threadId, run.resultId, run.proc.sessionId, run.codexAccountPath)
    }
    if (recover && continuePrompt) void this.sendAutoContinue(threadId, run, continuePrompt)
  }

  /** Cursor disconnects and Codex model-capacity failures get one automatic continue. A repeat shows the error. */
  private canAutoContinue(threadId: string, run: Run): boolean {
    if (run.autoContinue || run.stopped || this.shuttingDown) return false
    if (!this.store.thread(threadId)) return false
    return isAutomaticContinueFailure(run.proc.provider, run.failText)
      || isAutomaticContinueFailure(run.proc.provider, run.reducer.lastAssistantText)
  }

  private async sendAutoContinue(threadId: string, run: Run, prompt: string): Promise<void> {
    if (this.shuttingDown || run.stopped || this.runs.has(threadId) || !this.store.thread(threadId)) return
    try {
      await this.beginSend({
        threadId,
        prompt,
        model: run.model,
        mode: run.mode,
        force: run.force,
        cli: run.proc.provider,
        worktree: false
      }, { autoContinue: true })
    } catch (error) {
      if (!this.store.thread(threadId)) return
      const notice: Item = {
        id: newId(), kind: 'notice', level: 'error',
        text: error instanceof Error ? error.message : String(error)
      }
      this.store.items(threadId).push(notice)
      this.store.markItemsDirty(threadId)
      this.emit({ type: 'items', threadId, items: [notice] })
    }
  }

  private queue(threadId: string, run: Run, items: Item[]): void {
    for (const it of items) run.pending.set(it.id, it)
    const questions = items.filter((item) => item.kind === 'question')
    const freshQuestions = questions.filter((item) => item.status === 'pending' && !run.announcedQuestions.has(item.id))
    for (const item of freshQuestions) run.announcedQuestions.add(item.id)
    if (freshQuestions.length && this.store.thread(threadId)) {
      this.store.updateThread(threadId, { unread: true, updatedAt: Date.now() })
    }
    this.store.markItemsDirty(threadId)
    if (questions.length) {
      // Publish cards before the state that allows a focused renderer to mark them read.
      this.flushPending(threadId, run)
      this.onStateChange()
      return
    }
    if (!run.flushTimer) run.flushTimer = setTimeout(() => this.flushPending(threadId, run), 40)
  }

  private flushPending(threadId: string, run: Run): void {
    if (run.flushTimer) clearTimeout(run.flushTimer)
    run.flushTimer = undefined
    if (!run.pending.size) return
    this.emit({ type: 'items', threadId, items: [...run.pending.values()] })
    run.pending.clear()
  }
}
