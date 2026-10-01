import { localizedMessage, t as translate } from '@shared/i18n'
import { displayThreadTitle } from '@shared/thread-title'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { enabledSkillFingerprint, toAcpMcpServers } from '@shared/agent-config'
import { parseAvailableCommands, type SlashCommand } from '@shared/commands'
import type { AgentEvent, CliProvider, Item, PrepareRequest, QuestionAnswer, SendRequest } from '@shared/types'
import { isCliProvider, threadCli } from '@shared/types'
import { normalizeTurnUsage } from '@shared/turn-usage'
import type { WeeklyQuotaEstimate } from '@shared/turn-quota'
import { AcpConnection } from './acp'
import { killTree, stripAnsi } from './cli'
import { createWorktree } from './git'
import { syncAllManagedSkills } from './skills'
import { newId } from './id'
import { forkPrompt } from './fork-context'
import { StreamReducer } from './reducer'
import { loadCodexAccountUsage } from './codex-account'
import { CodexTurnUsageReader } from './codex-turn-usage'
import { SessionUsage } from './session/usage'
import { loadCodexQuota } from './quota'
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
}

interface Run extends InteractionRun {
  proc: AgentProc
  reducer: StreamReducer
  stopped: boolean
  pending: Map<string, Item>
  flushTimer?: NodeJS.Timeout
  /** SwitchMode tool calls seen this turn; their completion carries no kind. */
  switchCalls: Set<string>
  failText?: string
  /** Terminal UI state for this turn has already been published. */
  settled: boolean
  killTimer?: NodeJS.Timeout
  /** Defined only for ChatGPT-authenticated Codex turns; an empty path selects the detected CLI. */
  codexAccountPath?: string
  resultId?: string
  codexUsage?: CodexTurnUsageReader
  weeklyQuotaEstimate?: WeeklyQuotaEstimate
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

export class SessionManager {
  private runs = new Map<string, Run>()
  /** Idle or preparing CLI processes, keyed by thread id. Not included in `running()`. */
  private agents = new Map<string, AgentProc>()
  /** Last slash-command list for a thread. Kept after the process exits, until the thread is deleted. */
  private commandLists = new Map<string, SlashCommand[]>()
  private commandWaiters = new Map<string, Array<() => void>>()
  /** Serializes prepare and send so one thread cannot start two CLI processes. */
  private tails = new Map<string, Promise<void>>()
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

  isRunning(threadId: string): boolean {
    return this.runs.has(threadId)
  }

  /** Opening a saved conversation also refreshes the latest session consumption. */
  refreshCodexUsage(threadId: string): void {
    this.usage.refreshLatest(threadId)
  }

  send(req: SendRequest): Promise<void> {
    return this.enqueue(req.threadId, () => this.beginSend(req))
  }

  /**
   * Loads an existing CLI session without sending a prompt, so slash commands can be listed.
   * A thread with no `chatId` is left alone. A list already received is returned immediately.
   */
  prepare(threadId: string, opts: PrepareRequest): Promise<SlashCommand[]> {
    return this.enqueue(threadId, () => this.prepareBody(threadId, opts))
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
      const cwd = thread.cwd && fs.existsSync(thread.cwd) ? thread.cwd : project.path
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

  private async beginSend(req: SendRequest): Promise<void> {
    if (this.runs.has(req.threadId)) throw new Error(translate('该对话正在运行中'))
    const thread = this.store.thread(req.threadId)
    if (!thread) throw new Error(translate('对话不存在'))
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

    let cwd = thread.cwd && fs.existsSync(thread.cwd) ? thread.cwd : project.path
    if (!fs.existsSync(cwd)) throw new Error(translate('项目目录不存在：{path}', { path: cwd }))
    // Cursor creates its own worktree from `--worktree`; the Codex and Claude adapters have no such flag.
    if (provider !== 'cursor' && req.worktree && !thread.chatId && !thread.cwd) {
      cwd = await createWorktree(cwd, worktreeRoot(this.store))
      if (!this.store.thread(thread.id)) throw new Error(translate('对话不存在'))
      this.store.updateThread(thread.id, { cwd, worktree: true })
    }
    this.usage.cancel(thread.id)

    const mcpServers = toAcpMcpServers(settings.mcpServers)
    const fingerprint = procFingerprint(launch.cli, provider, cwd, settings.sandbox, req.force, apiKey, mcpServers, enabledSkillFingerprint(settings.skills))
    let proc = this.agents.get(thread.id)
    const reusable = !!proc && this.canReuse(proc, fingerprint)
    if (proc && !reusable) {
      this.discard(thread.id)
      proc = undefined
    }
    if (!proc) syncAllManagedSkills(settings.skills)

    const items = this.store.items(thread.id)
    const userItem: Item = { id: newId(), kind: 'user', text: req.prompt, createdAt: Date.now() }
    items.push(userItem)

    this.store.updateThread(thread.id, {
      ...(thread.titleKind ? { title: titleFrom(req.prompt), titleKind: undefined } : {}),
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
      reducer: new StreamReducer(items),
      stopped: false,
      pending: new Map(),
      acceptUpdates: false,
      force: req.force,
      mode: req.mode,
      switchCalls: new Set(),
      settled: false
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
      this.killProc(run.proc)
    })
  }

  answerQuestion(threadId: string, questionId: string, answers: QuestionAnswer[] | null): void {
    answerPendingQuestion(this.runs.get(threadId), questionId, answers)
  }

  /** Cancel the current turn and keep the CLI process for the next message. */
  stop(threadId: string): void {
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
      onNotification: (method, params) => {
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
          params?.update?.sessionUpdate === 'usage_update' &&
          params.sessionId &&
          proc.sessionId &&
          params.sessionId !== proc.sessionId
        ) {
          return
        }
        if ((proc.provider === 'cursor' || proc.provider === 'claude') && run.mode === 'plan' && leftPlanMode(params?.update, run.switchCalls)) {
          proc.acp.request('session/set_mode', { sessionId: proc.sessionId, modeId: 'plan' }).catch(() => undefined)
        }
        const changed = run.reducer.handleAcp(params?.update)
        if (changed.length) this.queue(threadId, run, changed)
      },
      onRequest: (method, params) => {
        const run = this.runs.get(threadId)
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
      if (run?.proc === proc) this.endRun(threadId, run, code)
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

  private async prepareBody(threadId: string, opts: PrepareRequest): Promise<SlashCommand[]> {
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
    const cwd = thread.cwd && fs.existsSync(thread.cwd) ? thread.cwd : project.path
    if (!fs.existsSync(cwd)) throw new Error(translate('项目目录不存在：{path}', { path: cwd }))

    const mcpServers = toAcpMcpServers(settings.mcpServers)
    const fingerprint = procFingerprint(
      launch.cli,
      provider,
      cwd,
      settings.sandbox,
      opts.force,
      apiKey,
      mcpServers,
      enabledSkillFingerprint(settings.skills)
    )
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
    await initializeSession(proc.acp, provider, apiKey)

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
    if (contextThroughId) {
      const items = this.store.items(threadId)
      const cut = items.findIndex((item) => item.id === contextThroughId)
      if (cut < 0) throw new Error(translate('分叉历史缺失，无法恢复上下文'))
      prompt = forkPrompt(items.slice(0, cut + 1), prompt)
    }
    const text = planPrompt(run.proc.provider, req.mode, prompt)
    if (run.codexAccountPath !== undefined) {
      const start = await this.usage.sampleQuota()
      if (this.runs.get(threadId) !== run || run.settled) return
      if (run.stopped) {
        this.endRun(threadId, run, null)
        return
      }
      run.weeklyQuotaEstimate = start ? { start } : {}
    }
    const started = Date.now()
    if (run.proc.provider === 'codex') run.codexUsage = new CodexTurnUsageReader(run.proc.sessionId)
    const result = await run.proc.acp.request('session/prompt', {
      sessionId: run.proc.sessionId,
      prompt: [{ type: 'text', text }]
    })
    if (!this.runs.has(threadId) || run.settled) return
    const stop = String(result?.stopReason ?? 'end_turn')
    const codexUsage = run.codexUsage?.read()
    if (contextThroughId && stop === 'end_turn') {
      this.store.updateThread(threadId, { forkContextThroughItemId: undefined })
      this.onStateChange()
    }
    run.reducer.gotResult = true
    const usage = run.proc.provider === 'codex'
      ? codexUsage?.usage
      : normalizeTurnUsage(result?.usage) ?? run.reducer.lastUsage
    const changed = run.reducer.closeSegments()
    const resultId = newId()
    run.resultId = resultId
    changed.push(
      run.reducer.push({
        id: resultId,
        kind: 'result',
        isError: stop !== 'end_turn' && stop !== 'cancelled',
        durationMs: Date.now() - started,
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
    // The CLI stays up after a turn. Parking it avoids the next message paying
    // for process startup and session/load. A later close still ends the turn.
    this.endRun(threadId, run, null)
    if (run.codexUsage && !codexUsage?.completed) void this.usage.saveTurnUsage(threadId, resultId, run.codexUsage)
  }

  private endRun(threadId: string, run: Run, code: number | null, spawnError?: Error): void {
    if (run.settled) return
    run.settled = true
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
    if (run.stopped) {
      changed.push(r.push({ id: newId(), kind: 'notice', level: 'info', ...localizedMessage('已停止') }))
    } else if (spawnError) {
      changed.push(r.push({ id: newId(), kind: 'notice', level: 'error', ...localizedMessage('无法启动 {label}：{error}', { label: cliLabel(run.proc.provider), error: spawnError.message }) }))
    } else if (!r.gotResult) {
      const detail = [run.failText, stripAnsi(run.proc.stderr).trim()].filter(Boolean).join('\n').slice(-4000)
      changed.push(
        r.push({
          id: newId(),
          kind: 'notice',
          level: 'error',
          ...(detail ? { text: detail } : localizedMessage('{label} 意外退出（退出码 {code}）', { label: cliLabel(run.proc.provider), code: code ?? 'unknown' }))
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

    const keep = !run.proc.dying && !spawnError && r.gotResult && run.proc.child.exitCode === null
    if (keep) this.agents.set(threadId, run.proc)
    else this.killProc(run.proc)

    const preview = r.lastAssistantText.replace(/\s+/g, ' ').trim().slice(0, 120)
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
    const failed = !!spawnError || !r.gotResult || (result?.kind === 'result' && result.isError)
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
    if (run.resultId && run.codexAccountPath !== undefined) {
      void this.usage.saveAccountUsage(threadId, run.resultId, run.proc.sessionId, run.codexAccountPath)
    }
  }

  private queue(threadId: string, run: Run, items: Item[]): void {
    for (const it of items) run.pending.set(it.id, it)
    if (!run.flushTimer) run.flushTimer = setTimeout(() => this.flushPending(threadId, run), 40)
    this.store.markItemsDirty(threadId)
  }

  private flushPending(threadId: string, run: Run): void {
    if (run.flushTimer) clearTimeout(run.flushTimer)
    run.flushTimer = undefined
    if (!run.pending.size) return
    this.emit({ type: 'items', threadId, items: [...run.pending.values()] })
    run.pending.clear()
  }
}
