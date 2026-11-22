import { imageCapture } from './tool-images'
import { t as translate } from '@shared/i18n'
import { displayThreadTitle } from '@shared/thread-title'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { enabledSkillFingerprint, toAcpMcpServers } from '@shared/agent-config'
import type { SlashCommand } from '@shared/commands'
import type { AttachmentRef } from '@shared/attachments'
import type { AgentEvent, CliProvider, Item, MessageQueue, PrepareRequest, QuestionAnswer, SendRequest } from '@shared/types'
import { isCliProvider, threadCli } from '@shared/types'
import { normalizeTurnUsage, preferTurnUsage } from '@shared/turn-usage'
import type { WeeklyQuotaEstimate } from '@shared/turn-quota'
import { AcpConnection } from './acp'
import { readAntigravityVerificationUrl } from './antigravity-validation'
import { killTree, stripAnsi } from './cli'
import { createWorktree } from './git'
import { changedTurnFiles, snapshotTurnFiles } from './turn-files'
import { syncAllManagedSkills } from './skills'
import { newId } from './id'
import { attachmentsFor } from './attachments'
import { StreamReducer } from './reducer'
import { TurnTiming } from './turn-timing'
import { loadCodexAccountUsage } from './codex-account'
import { CodexTurnUsageReader } from './codex-turn-usage'
import { loadCodexQuota } from './quota'
import { codexProxyOverlay, refreshCodexProxyEnv } from './system-proxy'
import {
  antigravityArgs, applySessionOptions, cliLabel, cursorArgs, fingerprintWithCwd, initializeSession, leftPlanMode,
  procFingerprint, providerApiKey, resolveLaunch, spawnProvider, worktreePathFrom, type AgentLaunch, type SessionConnection
} from './session/provider'
import { answerPendingQuestion, onAcpRequest, onIdleAcpRequest, settleQuestion, type InteractionRun } from './session/requests'
import { SessionUsage } from './session/usage'
import { isAutomaticContinueFailure } from './session/auto-continue'
import { SessionQueue } from './session/queue'
import { SlashCommandRegistry } from './session/commands'
import { buildTurnPrompt } from './session/prompt'
import {
  finishFollowup, holdFollowupForInteraction, isAntigravityWakeupUpdate, observeFollowup,
  resumeFollowupAfterInteraction, waitForFollowup, type FollowupState
} from './session/antigravity-wakeup'
import { finalizeTurnItems, mergeWakeupResult } from './session/finalize'
import type { Store } from './store'
import { openAntigravityGateway, usesAntigravityGateway, type AntigravityGateway } from './antigravity-gateway'

export { leftPlanMode } from './session/provider'
export { automaticContinuePrompt, isCodexModelCapacity, isCursorRetriableDisconnect } from './session/auto-continue'

/** One ACP process kept alive so the next message skips startup and session restoration. */
interface AgentProc extends SessionConnection {
  child: ChildProcess
  startedAt: number
  antigravityGateway?: AntigravityGateway
  acp: AcpConnection
  cwd: string
  /** Worktree the CLI created for `--worktree`. New sessions start there instead of `cwd`. */
  worktree?: string
  fingerprint: string
  stderr: string
  ready: boolean
  /** A commands preload is still holding the per-thread send queue. */
  preparing?: boolean
  /** Set when this process is being torn down and must not be reused. */
  dying: boolean
  /** Ignore late Antigravity updates from a cancelled turn until the next prompt is sent. */
  suppressWakeups?: boolean
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
  /** Antigravity reactive wakeup continuation after `session/prompt` returned early. */
  followup?: FollowupState
  /** Attached to an unsolicited post-turn wakeup on an idle Antigravity session. */
  wakeup?: boolean
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

// agy can deliver this warning as the entire assistant reply and still report end_turn.
function requiresAntigravityVerification(run: Run): boolean {
  return run.proc.provider === 'antigravity' && (
    run.reducer.lastAssistantText.trim() === '⚠ Verification Required'
    || /\bVALIDATION_REQUIRED\b|^PERMISSION_DENIED \(code 403\): Verify your account to continue\.?$/i.test(run.failText ?? '')
  )
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
const FORK_TIMEOUT_MS = 60_000

export class SessionManager {
  private runs = new Map<string, Run>()
  /** Cancellation remains observable before asynchronous startup creates a process/run. */
  private startups = new Map<string, Set<{ cancelled: boolean }>>()
  /** Sends queued or still preparing before they hand over to `runs`. */
  private pendingSends = new Map<string, number>()
  /** Idle or preparing CLI processes, keyed by thread id. Not included in `running()`. */
  private agents = new Map<string, AgentProc>()
  /** Serializes prepare and send so one thread cannot start two CLI processes. */
  private tails = new Map<string, Promise<void>>()
  private readonly commands: SlashCommandRegistry
  private readonly messageQueue: SessionQueue
  private readonly usage: SessionUsage
  private shuttingDown = false

  private get commandLists(): Map<string, SlashCommand[]> {
    return this.commands.lists
  }

  constructor(
    private readonly store: Store,
    private readonly emit: (ev: AgentEvent) => void,
    private readonly onStateChange: () => void,
    private readonly onFinished: (info: RunFinished) => void,
    readCodexAccount = loadCodexAccountUsage,
    readCodexQuota = loadCodexQuota
  ) {
    this.commands = new SlashCommandRegistry(emit)
    this.usage = new SessionUsage(store, emit, (threadId) => this.isRunning(threadId), readCodexAccount, readCodexQuota)
    this.messageQueue = new SessionQueue({
      store,
      isActive: (threadId) => this.active().includes(threadId),
      isShuttingDown: () => this.shuttingDown,
      stop: (threadId) => this.stop(threadId),
      dispatch: (req) => this.send(req),
      onStateChange
    })
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
        this.messageQueue.enqueue(req)
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
      this.messageQueue.pauseIfIdle(id)
      throw err
    })
  }

  queued(): Record<string, MessageQueue> {
    return this.messageQueue.snapshot()
  }

  removeQueued(threadId: string, messageId: string): void {
    this.messageQueue.remove(threadId, messageId)
  }

  /** Drops the queue of a conversation that is being deleted. */
  clearQueue(threadId: string): void {
    this.messageQueue.clear(threadId)
  }

  reorderQueued(threadId: string, ids: string[]): void {
    this.messageQueue.reorder(threadId, ids)
  }

  /** Moves a queued message to the front; a running turn is stopped so it goes next. */
  sendQueuedNow(threadId: string, messageId: string): void {
    this.messageQueue.sendNow(threadId, messageId)
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
      const launch = resolveLaunch(provider, settings)
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
            this.messageQueue.drain(req.threadId, { interrupted: true, planned: false, agent: false })
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
    const project = this.store.project(thread.projectId)
    if (!project) throw new Error(translate('项目不存在'))
    const settings = this.store.settings
    const currentProvider = threadCli(thread)
    const provider = isCliProvider(req.cli) ? req.cli : currentProvider
    const launch = resolveLaunch(provider, settings)
    if (!launch) throw new Error(translate('未找到 {label}。请先安装，或在设置中指定路径。', { label: cliLabel(provider) }))
    if (provider !== currentProvider) {
      this.store.updateThread(thread.id, { cli: provider })
      this.discard(thread.id)
    }
    const apiKey = providerApiKey(provider, settings)

    let cwd = thread.cwd && (thread.worktree || fs.existsSync(thread.cwd)) ? thread.cwd : project.path
    if (!fs.existsSync(cwd)) throw new Error(translate('项目目录不存在：{path}', { path: cwd }))
    // Cursor creates its own worktree from `--worktree`; the other providers use an app-managed worktree.
    if (provider !== 'cursor' && req.worktree && !thread.chatId && !thread.cwd) {
      cwd = await createWorktree(cwd, worktreeRoot(this.store))
      if (cancelled()) return false
      this.store.updateThread(thread.id, { cwd, worktree: true })
    }
    this.usage.cancel(thread.id)

    const mcpServers = this.mcpServersFor(provider)
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
      const args = this.providerArgs(provider, req, cwd, !!thread.chatId, mcpServers)
      const opening = this.openTurnProc(thread.id, provider, launch, args, cwd, apiKey, fingerprint, cancelled)
      proc = opening instanceof Promise ? await opening : opening
      if (!proc) return false
    }
    proc.force = req.force

    const run = this.createRun(thread.id, proc, items, {
      cwd,
      model: req.model,
      mode: req.mode,
      force: req.force,
      starting: !reusable,
      autoContinue: internal?.autoContinue,
      attachments,
      managedMessageId,
      userItemId: userId
    })
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
      // A rejected ACP request is terminal even if the adapter keeps its pipes
      // open. Only the automatic follow-up can reuse this process.
      if (!this.canAutoContinue(thread.id, run)) this.killProc(run.proc)
      void this.endRun(thread.id, run, run.proc.child.exitCode)
    })
    return true
  }

  private createRun(
    threadId: string,
    proc: AgentProc,
    items: Item[],
    opts: {
      cwd: string
      model: string
      mode: SendRequest['mode']
      force: boolean
      starting: boolean
      acceptUpdates?: boolean
      autoContinue?: boolean
      wakeup?: boolean
      resultId?: string
      timing?: TurnTiming
      attachments?: AttachmentRef[]
      managedMessageId?: string
      userItemId?: string
    }
  ): Run {
    return {
      proc,
      reducer: new StreamReducer(items, imageCapture(this.store, opts.cwd, items)),
      stopped: false,
      pending: new Map(),
      announcedQuestions: new Set(),
      acceptUpdates: opts.acceptUpdates ?? false,
      force: opts.force,
      mode: opts.mode,
      model: opts.model,
      ...(opts.autoContinue ? { autoContinue: true } : {}),
      ...(opts.wakeup ? { wakeup: true } : {}),
      ...(opts.resultId ? { resultId: opts.resultId } : {}),
      ...(opts.timing ? { timing: opts.timing } : {}),
      onPlanApproved: () => {
        this.store.updateThread(threadId, { mode: 'agent' })
        this.onStateChange()
      },
      switchCalls: new Set(),
      settled: false,
      starting: opts.starting,
      attachments: opts.attachments,
      managedMessageId: opts.managedMessageId,
      userItemId: opts.userItemId,
      isAttachmentReadAllowed: (filePath, expectedPath) => {
        const refs = this.store.items(threadId).flatMap((item) => (item.kind === 'user' ? item.attachments ?? [] : []))
        return refs.length > 0 && attachmentsFor(this.store).scopedRead(filePath, proc.cwd, refs, expectedPath)
      }
    }
  }

  private mcpServersFor(provider: CliProvider): Record<string, unknown>[] {
    const servers = this.store.settings.mcpServers
    return toAcpMcpServers(provider === 'antigravity' ? servers.filter((server) => server.transport !== 'sse') : servers)
  }

  private providerArgs(
    provider: CliProvider,
    req: SendRequest,
    cwd: string,
    hasChat: boolean,
    mcpServers: Record<string, unknown>[]
  ): string[] {
    const sandbox = this.store.settings.sandbox
    if (provider === 'cursor') return cursorArgs(req, sandbox, cwd, hasChat)
    if (provider === 'antigravity') return antigravityArgs(sandbox, mcpServers)
    return []
  }

  answerQuestion(threadId: string, questionId: string, answers: QuestionAnswer[] | null): void {
    answerPendingQuestion(this.runs.get(threadId), questionId, answers)
  }

  /** Cancel the current turn and keep the CLI process for the next message. */
  stop(threadId: string): void {
    for (const startup of this.startups.get(threadId) ?? []) startup.cancelled = true
    const run = this.runs.get(threadId)
    if (!run) {
      const proc = this.agents.get(threadId)
      if (proc?.preparing) this.killProc(proc)
      return
    }
    if (run.stopped) return
    run.stopped = true
    run.acceptUpdates = false
    if (run.proc.provider === 'antigravity') run.proc.suppressWakeups = true
    if (run.settled) return
    settleQuestion(run, 'cancel')
    if (run.proc.ready && run.proc.sessionId) {
      run.proc.acp.notify('session/cancel', { sessionId: run.proc.sessionId })
      if (run.followup) {
        finishFollowup(run)
        return
      }
      if (!run.killTimer) {
        run.killTimer = setTimeout(() => {
          run.killTimer = undefined
          if (this.runs.get(threadId) !== run || run.settled) return
          this.forceStop(threadId, run)
        }, CANCEL_KILL_MS)
      }
      return
    }
    this.forceStop(threadId, run)
  }

  private forceStop(threadId: string, run: Run): void {
    this.killProc(run.proc)
    // Descendants can keep pipes open after the adapter exits. Closing out the
    // interrupted turn must not depend on another ACP response or child "close".
    void this.endRun(threadId, run, null)
  }

  /** Kill the CLI process for this thread. Used when the thread or app is going away. */
  dispose(threadId: string): void {
    for (const startup of this.startups.get(threadId) ?? []) startup.cancelled = true
    this.usage.cancel(threadId)
    this.commands.delete(threadId)
    const run = this.runs.get(threadId)
    if (run) {
      run.stopped = true
      if (run.killTimer) {
        clearTimeout(run.killTimer)
        run.killTimer = undefined
      }
      finishFollowup(run)
      settleQuestion(run, 'cancel')
      this.killProc(run.proc)
      return
    }
    this.discard(threadId)
  }

  stopAll(): void {
    this.shuttingDown = true
    this.messageQueue.clearAll()
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
      provider === 'codex' ? codexProxyOverlay()
        : launch.antigravityEndpoint ? { GOOGLE_GEMINI_BASE_URL: launch.antigravityEndpoint } : {}
    )
  }

  private canReuse(proc: AgentProc, fingerprint: string): boolean {
    return proc.ready && !proc.dying && proc.child.exitCode === null && proc.fingerprint === fingerprint
  }

  private openTurnProc(
    threadId: string, provider: CliProvider, launch: AgentLaunch, args: string[], cwd: string,
    apiKey: string, fingerprint: string, cancelled: () => boolean
  ): AgentProc | Promise<AgentProc | undefined> {
    const endpoint = launch.antigravityEndpoint
    if (provider !== 'antigravity' || !usesAntigravityGateway(endpoint, apiKey)) {
      return this.openProc(threadId, provider, launch, args, cwd, apiKey, fingerprint)
    }
    return openAntigravityGateway(endpoint).then((gateway) => {
      try {
        if (!cancelled()) return this.openProc(threadId, provider, launch, args, cwd, apiKey, fingerprint, true, gateway)
      } catch (error) {
        gateway.close()
        throw error
      }
      gateway.close()
    })
  }

  private openProc(
    threadId: string,
    provider: CliProvider,
    launch: AgentLaunch,
    args: string[],
    cwd: string,
    apiKey: string,
    fingerprint: string,
    trackCommands = true,
    antigravityGateway?: AntigravityGateway
  ): AgentProc {
    const routedLaunch = antigravityGateway ? { ...launch, antigravityEndpoint: antigravityGateway.endpoint } : launch
    const startedAt = Date.now()
    const child = spawnProvider(provider, routedLaunch, args, cwd, apiKey)
    const proc: AgentProc = {
      child,
      startedAt,
      antigravityGateway,
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
      onNotification: (method, params, receivedAt) => this.handleProcNotification(threadId, proc, trackCommands, method, params, receivedAt),
      onRequest: (method, params) => this.handleProcRequest(threadId, proc, method, params)
    })
    child.on('error', (err) => {
      const run = this.runs.get(threadId)
      if (run?.proc === proc) void this.endRun(threadId, run, null, err)
    })
    child.on('close', (code) => {
      antigravityGateway?.close()
      if (this.agents.get(threadId) === proc) this.agents.delete(threadId)
      const run = this.runs.get(threadId)
      if (run?.proc !== proc) return
      finishFollowup(run)
      // Prompt rejection records failText in a microtask. Ending the turn on this
      // close event would run first and miss an automatic「继续」from that rejection.
      setImmediate(() => {
        if (run.settled || this.runs.get(threadId) !== run) return
        void this.endRun(threadId, run, code)
      })
    })
    return proc
  }

  private handleProcNotification(
    threadId: string,
    proc: AgentProc,
    trackCommands: boolean,
    method: string,
    params: any,
    receivedAt: number
  ): void {
    if (proc.dying) return
    if (proc.provider === 'antigravity' && method === 'session/update' && params?.update?.sessionUpdate === 'config_option_update'
      && params.sessionId === proc.sessionId && Array.isArray(params.update.configOptions)) {
      proc.antigravityOptions = params.update.configOptions
    }
    if (method === 'session/update' && params?.update?.sessionUpdate === 'available_commands_update') {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
      if (trackCommands && (!sessionId || !proc.sessionId || sessionId === proc.sessionId)) {
        this.commands.remember(threadId, params.update.availableCommands)
      }
      return
    }
    if (proc.suppressWakeups) return
    let run = this.runs.get(threadId)
    if (!run && method === 'session/update') run = this.resumeAntigravityWakeup(threadId, proc, params?.sessionId, params?.update)
    if (!run || run.proc !== proc || method !== 'session/update' || !run.acceptUpdates) return
    if (params.sessionId && proc.sessionId && params.sessionId !== proc.sessionId) return
    if ((proc.provider === 'cursor' || proc.provider === 'claude' || proc.provider === 'antigravity')
      && (run.mode === 'plan' || (proc.provider === 'antigravity' && run.mode === 'ask'))
      && leftPlanMode(params?.update, run.switchCalls)) {
      proc.acp.request('session/set_mode', { sessionId: proc.sessionId, modeId: 'plan' }).catch(() => undefined)
    }
    run.timing?.observe(params?.update, receivedAt)
    const changed = run.reducer.handleAcp(params?.update)
    if (changed.length) this.queue(threadId, run, changed)
    observeFollowup(run, params?.update)
  }

  private handleProcRequest(threadId: string, proc: AgentProc, method: string, params: any): Promise<unknown> {
    if (proc.suppressWakeups) return onIdleAcpRequest(proc, method, params)
    let run = this.runs.get(threadId)
    if (!run && (method === 'session/request_permission' || method === 'cursor/ask_question' || Array.isArray(params?.questions))) {
      run = this.resumeAntigravityWakeup(threadId, proc, params?.sessionId, { sessionUpdate: 'tool_call' })
    }
    if (run?.proc === proc) run.timing?.interrupt()
    if (run && run.proc === proc) {
      holdFollowupForInteraction(run)
      return onAcpRequest(run, method, params, (items) => this.queue(threadId, run!, items))
        .finally(() => resumeFollowupAfterInteraction(run!))
    }
    return onIdleAcpRequest(proc, method, params)
  }

  private killProc(proc: AgentProc): void {
    if (proc.dying) return
    proc.dying = true
    for (const [id, kept] of this.agents) {
      if (kept === proc) this.agents.delete(id)
    }
    killTree(proc.child)
    proc.acp.disconnect()
    proc.antigravityGateway?.close()
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
    const known = this.commands.get(threadId)
    if (known) return known
    if (this.runs.has(threadId)) return []
    const thread = this.store.thread(threadId)
    if (!thread) throw new Error(translate('对话不存在'))
    if (!thread.chatId) return []
    const project = this.store.project(thread.projectId)
    if (!project) throw new Error(translate('项目不存在'))
    const settings = this.store.settings
    const provider = threadCli(thread)
    const launch = resolveLaunch(provider, settings)
    if (!launch) throw new Error(translate('未找到 {label}。请先安装，或在设置中指定路径。', { label: cliLabel(provider) }))
    const apiKey = providerApiKey(provider, settings)
    const cwd = thread.cwd && (thread.worktree || fs.existsSync(thread.cwd)) ? thread.cwd : project.path
    if (!fs.existsSync(cwd)) throw new Error(translate('项目目录不存在：{path}', { path: cwd }))

    const mcpServers = this.mcpServersFor(provider)
    const fingerprint = await this.launchFingerprint(
      provider, launch, cwd, settings.sandbox, opts.force, apiKey, mcpServers, enabledSkillFingerprint(settings.skills)
    )
    if (cancelled()) return []
    const req: SendRequest = { threadId, prompt: '', model: opts.model, mode: opts.mode, force: opts.force }
    let proc = this.agents.get(threadId)
    const reusable = !!proc && this.canReuse(proc, fingerprint)
    if (proc && !reusable) {
      this.discard(threadId)
      proc = undefined
    }
    if (reusable && proc) return this.commands.wait(threadId)

    if (!proc) {
      syncAllManagedSkills(settings.skills)
      const args = this.providerArgs(provider, req, cwd, true, mcpServers)
      const opening = this.openTurnProc(threadId, provider, launch, args, cwd, apiKey, fingerprint, cancelled)
      proc = opening instanceof Promise ? await opening : opening
      if (!proc) return []
    }
    proc.force = opts.force
    // Track startup too: deletion, settings changes, and shutdown must be able
    // to cancel initialize/session/load before the process becomes ready.
    this.agents.set(threadId, proc)
    proc.preparing = true
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
    } finally {
      proc.preparing = false
    }
    return this.commands.wait(threadId)
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
    if (run.settled || this.runs.get(threadId) !== run) return
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
    let sessionState
    if (sessionId) {
      const resume = provider === 'antigravity' && initialized?.agentCapabilities?.sessionCapabilities?.resume
      sessionState = await acp.request(resume ? 'session/resume' : 'session/load', { sessionId, cwd, mcpServers })
    } else {
      const sessionCwd = proc.worktree ?? cwd
      const created = await acp.request('session/new', { cwd: sessionCwd, mcpServers })
      sessionState = created
      sessionId = created?.sessionId
      if (!sessionId) throw new Error(translate('{label} 没有返回会话 id', { label: cliLabel(provider) }))
      if (sessionCwd !== proc.cwd) {
        proc.cwd = sessionCwd
        proc.fingerprint = fingerprintWithCwd(proc.fingerprint, sessionCwd)
      }
    }
    if (provider === 'antigravity') {
      proc.antigravityOptions = sessionState?.configOptions
      proc.antigravityDefaults = proc.antigravityOptions
    }
    proc.sessionId = sessionId
    proc.ready = true
    return sessionId
  }

  private async runPrompt(threadId: string, run: Run, req: SendRequest): Promise<void> {
    if (this.runs.get(threadId) !== run || run.settled) return
    if (run.stopped) {
      await this.endRun(threadId, run, null)
      return
    }
    const built = buildTurnPrompt({
      store: this.store,
      threadId,
      req,
      provider: run.proc.provider,
      supportsImage: !!run.proc.promptCapabilities?.image,
      attachments: run.attachments ?? [],
      managedMessageId: run.managedMessageId,
      userItemId: run.userItemId
    })
    run.managedMessageId = built.managedMessageId
    if (built.updatedUserItem) this.queue(threadId, run, [built.updatedUserItem])

    if (run.codexAccountPath !== undefined) {
      const start = await this.usage.sampleQuota()
      if (this.runs.get(threadId) !== run || run.settled) return
      if (run.stopped) {
        await this.endRun(threadId, run, null)
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
    run.proc.suppressWakeups = false
    const result = await run.proc.acp.request('session/prompt', {
      sessionId: run.proc.sessionId,
      prompt: built.blocks
    })
    const stop = String(result?.stopReason ?? 'end_turn')
    if (run.proc.provider === 'antigravity' && stop === 'end_turn' && !run.stopped
      && !run.proc.dying && run.proc.child.exitCode === null && run.reducer.hasRunningForegroundTools()) {
      await waitForFollowup(run)
      if (!this.runs.has(threadId) || run.settled) return
      if (run.proc.dying || run.proc.child.exitCode !== null) return
    }
    if (stop !== 'cancelled' && !run.stopped && requiresAntigravityVerification(run)) {
      return this.endRun(threadId, run, null)
    }
    const failedReply = isAutomaticContinueFailure(run.proc.provider, run.reducer.lastAssistantText)
      || isAutomaticContinueFailure(run.proc.provider, run.failText)
    const timing = run.timing.finish(run.stopped || stop === 'cancelled'
      ? 'cancelled' : stop === 'end_turn' && !failedReply ? 'completed' : 'failed')
    if (!this.runs.has(threadId) || run.settled) return
    const codexUsage = run.codexUsage?.read()
    if (built.contextThroughId && stop === 'end_turn' && !run.stopped) {
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
        isError: stop !== 'end_turn' && stop !== 'cancelled' && !run.stopped,
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
        this.emitErrorNotice(threadId, error)
      }
    }
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
    finishFollowup(run)
    settleQuestion(run, 'cancel')
    if (!this.store.thread(threadId)) {
      this.runs.delete(threadId)
      this.killProc(run.proc)
      return
    }

    const verification = !run.reducer.gotResult && !run.stopped && requiresAntigravityVerification(run)
      ? { url: await readAntigravityVerificationUrl(run.proc.child.pid, run.proc.startedAt, run.proc.sessionId) }
      : undefined
    const fileChanges = run.fileSnapshot?.length
      ? await changedTurnFiles(run.fileSnapshot).catch(() => undefined) : undefined
    run.fileSnapshot = undefined
    // A conversation may have been deleted while reading its final files.
    if (!this.store.thread(threadId)) {
      this.runs.delete(threadId)
      this.killProc(run.proc)
      return
    }

    const items = this.store.items(threadId)
    const finalized = finalizeTurnItems({
      items,
      reducer: run.reducer,
      provider: run.proc.provider,
      model: run.model,
      stopped: run.stopped,
      autoContinue: run.autoContinue,
      wakeup: run.wakeup,
      failText: run.failText,
      verification,
      stderr: run.proc.stderr,
      code,
      spawnError,
      resultId: run.resultId,
      timing,
      fileChanges,
      codexUsage: run.codexUsage,
      weeklyQuotaEstimate: run.weeklyQuotaEstimate,
      recover: this.canAutoContinue(threadId, run)
    })
    run.resultId = finalized.resultId

    this.queue(threadId, run, finalized.changed)
    this.flushPending(threadId, run)
    this.runs.delete(threadId)

    if (run.resultId && run.weeklyQuotaEstimate) {
      void this.usage.saveQuotaEstimate(threadId, run.resultId, run.proc.sessionId)
    }

    const keep = !run.proc.dying && !spawnError && run.proc.child.exitCode === null && (run.reducer.gotResult || finalized.recover)
    if (keep) this.agents.set(threadId, run.proc)
    else this.killProc(run.proc)

    const updated = this.store.updateThread(threadId, {
      updatedAt: Date.now(),
      syncedAt: Date.now(),
      unread: true,
      ...(finalized.preview ? { preview: finalized.preview } : {})
    })
    this.store.markItemsDirty(threadId)
    this.emit({ type: 'running', threadId, running: false })
    this.onStateChange()
    this.onFinished({
      threadId,
      title: updated ? displayThreadTitle(updated) : translate(DEFAULT_TITLE),
      stopped: run.stopped,
      failed: finalized.failed,
      preview: finalized.summary
    })
    // Deferred so a follow-up turn that drive() starts right after endRun (Codex plan feedback) goes first.
    if (this.messageQueue.has(threadId)) {
      const userIndex = items.findIndex((it) => it.id === run.userItemId)
      const turn = {
        interrupted: run.stopped || finalized.failed,
        planned: run.mode === 'plan' && userIndex >= 0 && items.slice(userIndex + 1).some((it) => it.kind === 'tool' && it.tool === 'createPlan'),
        agent: run.mode === 'agent'
      }
      setImmediate(() => this.messageQueue.drain(threadId, turn))
    }
    if (run.resultId && run.codexAccountPath !== undefined) {
      void this.usage.saveAccountUsage(threadId, run.resultId, run.proc.sessionId, run.codexAccountPath)
    }
    if (finalized.recover && finalized.continuePrompt) void this.sendAutoContinue(threadId, run, finalized.continuePrompt)
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
      this.emitErrorNotice(threadId, error)
    }
  }

  private emitErrorNotice(threadId: string, error: unknown): void {
    if (!this.store.thread(threadId)) return
    const notice: Item = {
      id: newId(),
      kind: 'notice',
      level: 'error',
      text: error instanceof Error ? error.message : String(error)
    }
    this.store.items(threadId).push(notice)
    this.store.markItemsDirty(threadId)
    this.emit({ type: 'items', threadId, items: [notice] })
  }

  private resumeAntigravityWakeup(threadId: string, proc: AgentProc, sessionId: unknown, update: any): Run | undefined {
    if (proc.provider !== 'antigravity' || this.shuttingDown || !proc.ready || !proc.sessionId) return undefined
    if (this.agents.get(threadId) !== proc || this.runs.has(threadId) || this.pendingSends.has(threadId)) return undefined
    if (typeof sessionId === 'string' && sessionId && sessionId !== proc.sessionId) return undefined
    if (!isAntigravityWakeupUpdate(update)) return undefined
    const thread = this.store.thread(threadId)
    if (!thread || threadCli(thread) !== 'antigravity') return undefined
    const items = this.store.items(threadId)
    let userItemId: string | undefined
    let resultId: string | undefined
    for (let i = items.length - 1; i >= 0; i--) {
      if (!resultId && items[i].kind === 'result') resultId = items[i].id
      if (items[i].kind === 'user') { userItemId = items[i].id; break }
    }
    const run = this.createRun(threadId, proc, items, {
      cwd: proc.cwd,
      model: thread.model ?? '',
      mode: thread.mode ?? 'agent',
      force: thread.force ?? proc.force,
      starting: false,
      acceptUpdates: true,
      wakeup: true,
      resultId,
      timing: new TurnTiming(),
      userItemId
    })
    run.reducer.init = { sessionId: proc.sessionId, cwd: proc.cwd, model: run.model }
    this.runs.set(threadId, run)
    this.emit({ type: 'running', threadId, running: true })
    this.onStateChange()
    void this.driveAntigravityWakeup(threadId, run)
    return run
  }

  private async driveAntigravityWakeup(threadId: string, run: Run): Promise<void> {
    const waiting = waitForFollowup(run)
    void snapshotTurnFiles(run.proc.cwd)
      .then((files) => { if (!run.settled) run.fileSnapshot = files })
      .catch(() => undefined)
    await waiting
    if (this.runs.get(threadId) !== run || run.settled) return
    if (run.proc.dying || run.proc.child.exitCode !== null) return
    if (!run.stopped && requiresAntigravityVerification(run)) return this.endRun(threadId, run, null)
    const timing = run.timing?.finish(run.stopped ? 'cancelled' : 'completed')
    run.timing = undefined
    run.reducer.gotResult = true
    const changed = run.reducer.closeSegments()
    if (!run.stopped) {
      const merged = mergeWakeupResult({
        items: this.store.items(threadId),
        reducer: run.reducer,
        userItemId: run.userItemId,
        model: run.model,
        timing,
        preferUsage: preferTurnUsage
      })
      run.resultId = merged.resultId
      changed.push(merged.item)
    }
    this.queue(threadId, run, changed)
    await this.endRun(threadId, run, null)
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
