import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { enabledSkillFingerprint, toAcpMcpServers } from '@shared/agent-config'
import { parseAvailableCommands, type SlashCommand } from '@shared/commands'
import type { AgentEvent, CliProvider, Item, PrepareRequest, QuestionAnswer, QuestionItem, SendRequest } from '@shared/types'
import { isCliProvider, threadCli } from '@shared/types'
import { normalizeTurnUsage } from '@shared/turn-usage'
import { quotaSnapshot } from '@shared/turn-quota'
import { normalizeQuestions } from '@shared/questions'
import { AcpConnection, claudePlanModePrompt, codexPlanModePrompt, MethodNotFound, permissionResult, planModePrompt } from './acp'
import { killTree, resolveApiKey, resolveCli, spawnCli, stripAnsi, type ResolvedCli } from './cli'
import { claudeAsCli, claudeModeId, CLAUDE_EFFORT_CONFIG_ID, CLAUDE_MODEL_CONFIG_ID, resolveClaude, resolveClaudeApiKey, spawnClaudeAcp, type ResolvedClaude } from './claude'
import { codexAsCli, codexModeId, resolveCodex, resolveCodexApiKey, spawnCodexAcp, type ResolvedCodex } from './codex'
import { syncAllManagedSkills } from './skills'
import { newId } from './id'
import { forkPrompt } from './fork-context'
import { StreamReducer } from './reducer'
import { loadCodexAccountUsage } from './codex-account'
import { CodexTurnUsageReader } from './codex-turn-usage'
import type { Store } from './store'

interface PendingQuestion {
  itemId: string
  resolve: (decision: QuestionAnswer[] | 'skip' | 'cancel') => void
}

/** One `agent acp` process kept alive so the next message skips startup and session/load. */
interface AgentProc {
  child: ChildProcess
  acp: AcpConnection
  provider: CliProvider
  sessionId: string
  cwd: string
  fingerprint: string
  stderr: string
  ready: boolean
  /** Set when this process is being torn down and must not be reused. */
  dying: boolean
  force: boolean
}

interface Run {
  proc: AgentProc
  reducer: StreamReducer
  stopped: boolean
  pending: Map<string, Item>
  flushTimer?: NodeJS.Timeout
  /** Ignore session/update events while session/load replays history. */
  acceptUpdates: boolean
  pendingQuestion?: PendingQuestion
  force: boolean
  mode: SendRequest['mode']
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
}

interface CodexUsageRefresh {
  resultId: string
  sessionId: string
  at: number
  pending: boolean
  timer?: ReturnType<typeof setTimeout>
}

export interface RunFinished {
  threadId: string
  title: string
  stopped: boolean
  failed: boolean
  preview: string
}

export const DEFAULT_TITLE = '新对话'

export function titleFrom(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/).find((l) => l.trim()) ?? DEFAULT_TITLE
  return line.length > 48 ? `${line.slice(0, 48)}…` : line
}

const CANCEL_KILL_MS = 5000
const COMMAND_WAIT_MS = 2000
const FORK_TIMEOUT_MS = 60_000
const CODEX_USAGE_RETRY_MS = [30_000, 120_000, 300_000]

export class SessionManager {
  private runs = new Map<string, Run>()
  /** Idle CLI processes, keyed by thread id. Not included in `running()`. */
  private agents = new Map<string, AgentProc>()
  /** Last slash-command list for a thread. Kept after the process exits, until the thread is deleted. */
  private commandLists = new Map<string, SlashCommand[]>()
  private commandWaiters = new Map<string, Array<() => void>>()
  /** Serializes prepare and send so one thread cannot start two CLI processes. */
  private tails = new Map<string, Promise<void>>()
  private codexUsageRefreshes = new Map<string, CodexUsageRefresh>()
  private shuttingDown = false

  constructor(
    private readonly store: Store,
    private readonly emit: (ev: AgentEvent) => void,
    private readonly onStateChange: () => void,
    private readonly onFinished: (info: RunFinished) => void,
    private readonly readCodexAccount = loadCodexAccountUsage
  ) {}

  running(): string[] {
    return [...this.runs.keys()]
  }

  isRunning(threadId: string): boolean {
    return this.runs.has(threadId)
  }

  /** Opening a saved conversation also refreshes the latest session consumption. */
  refreshCodexUsage(threadId: string): void {
    const thread = this.store.thread(threadId)
    if (!thread?.chatId || threadCli(thread) !== 'codex' || this.isRunning(threadId)) return
    if (resolveCodexApiKey(this.store.settings.codexApiKey)) return
    const item = [...this.store.items(threadId)].reverse().find((item) => item.kind === 'result')
    if (!item || (item.cli && item.cli !== 'codex')) return
    void this.saveCodexAccountUsage(threadId, item.id, thread.chatId, this.store.settings.codexPath)
  }

  send(req: SendRequest): Promise<void> {
    return this.enqueue(req.threadId, async () => {
      this.beginSend(req)
    })
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
      if (this.isRunning(threadId)) throw new Error('对话正在运行，请稍后再分叉')
      const thread = this.store.thread(threadId)
      if (!thread) throw new Error('对话不存在')
      if (!thread.chatId) throw new Error('对话没有可复制的 CLI 会话')
      const sourceChatId = thread.chatId
      const provider = threadCli(thread)
      if (provider !== 'codex' && provider !== 'claude') throw new Error('此 CLI 不支持通过 ACP 分叉')
      const project = this.store.project(thread.projectId)
      if (!project) throw new Error('项目不存在')
      const settings = this.store.settings
      const launch = resolveLaunch(provider, settings.agentPath, settings.codexPath, settings.claudePath)
      if (!launch) throw new Error(`未找到 ${cliLabel(provider)}。请先安装，或在设置中指定路径。`)
      const cwd = thread.cwd && fs.existsSync(thread.cwd) ? thread.cwd : project.path
      if (!fs.existsSync(cwd)) throw new Error(`项目目录不存在：${cwd}`)
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
            const initialized = await this.initializeSession(proc, provider, apiKey)
            if (initialized?.agentCapabilities?.sessionCapabilities?.fork == null) {
              throw new Error(`${cliLabel(provider)} 不支持会话分叉`)
            }
            const forked = await proc.acp.request('session/fork', { sessionId: sourceChatId, cwd, mcpServers })
            const chatId = typeof forked?.sessionId === 'string' ? forked.sessionId.trim() : ''
            if (!chatId || chatId === sourceChatId) throw new Error(`${cliLabel(provider)} 没有返回独立的分叉会话 id`)
            return { chatId, cwd }
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${cliLabel(provider)} 会话分叉超时`)), FORK_TIMEOUT_MS)
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
    const result = prev.then(fn, fn)
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

  private beginSend(req: SendRequest): void {
    if (this.runs.has(req.threadId)) throw new Error('该对话正在运行中')
    const thread = this.store.thread(req.threadId)
    if (!thread) throw new Error('对话不存在')
    if (isCliProvider(req.cli) && req.cli !== threadCli(thread)) {
      this.store.updateThread(thread.id, { cli: req.cli })
      this.discard(thread.id)
    }
    const project = this.store.project(thread.projectId)
    if (!project) throw new Error('项目不存在')
    const settings = this.store.settings
    const provider = threadCli(thread)
    const launch = resolveLaunch(provider, settings.agentPath, settings.codexPath, settings.claudePath)
    if (!launch) throw new Error(`未找到 ${cliLabel(provider)}。请先安装，或在设置中指定路径。`)
    const apiKey = providerApiKey(provider, settings)

    const cwd = thread.cwd && fs.existsSync(thread.cwd) ? thread.cwd : project.path
    if (!fs.existsSync(cwd)) throw new Error(`项目目录不存在：${cwd}`)
    this.clearCodexUsageRefresh(thread.id)

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
      title: thread.title === DEFAULT_TITLE ? titleFrom(req.prompt) : thread.title,
      model: req.model,
      mode: req.mode,
      force: req.force,
      worktree: thread.chatId ? thread.worktree : !!req.worktree,
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
    const run = this.runs.get(threadId)
    const pending = run?.pendingQuestion
    if (!run || !pending || pending.itemId !== questionId) throw new Error('这个问题已经不能回答了')
    run.pendingQuestion = undefined
    pending.resolve(answers ?? 'skip')
  }

  /** Cancel the current turn and keep the CLI process for the next message. */
  stop(threadId: string): void {
    const run = this.runs.get(threadId)
    if (!run) return
    run.stopped = true
    this.settleQuestion(run, 'cancel')
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
    this.clearCodexUsageRefresh(threadId)
    this.commandLists.delete(threadId)
    this.commandWaiters.delete(threadId)
    const run = this.runs.get(threadId)
    if (run) {
      run.stopped = true
      if (run.killTimer) {
        clearTimeout(run.killTimer)
        run.killTimer = undefined
      }
      this.settleQuestion(run, 'cancel')
      this.killProc(run.proc)
      return
    }
    this.discard(threadId)
  }

  stopAll(): void {
    this.shuttingDown = true
    for (const id of this.codexUsageRefreshes.keys()) this.clearCodexUsageRefresh(id)
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
    const child =
      provider === 'codex' && launch.codex
        ? spawnCodexAcp(launch.codex, cwd, apiKey)
        : provider === 'claude' && launch.claude
          ? spawnClaudeAcp(launch.claude, cwd, apiKey)
          : spawnCli(launch.cli, args, cwd, 'pipe', apiKey)
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
      onNotification: (method, params) => {
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
        if (run && run.proc === proc) return this.onAcpRequest(threadId, run, method, params)
        return this.onIdleAcpRequest(proc, method, params)
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
    await this.applySessionOptions(run.proc, req)
    if (!this.runs.has(threadId) || run.settled) return
    run.acceptUpdates = true
    await this.runPrompt(threadId, run, req)
  }

  private async prepareBody(threadId: string, opts: PrepareRequest): Promise<SlashCommand[]> {
    const known = this.commandLists.get(threadId)
    if (known) return known
    if (this.runs.has(threadId)) return []
    const thread = this.store.thread(threadId)
    if (!thread) throw new Error('对话不存在')
    if (!thread.chatId) return []
    const project = this.store.project(thread.projectId)
    if (!project) throw new Error('项目不存在')
    const settings = this.store.settings
    const provider = threadCli(thread)
    const launch = resolveLaunch(provider, settings.agentPath, settings.codexPath, settings.claudePath)
    if (!launch) throw new Error(`未找到 ${cliLabel(provider)}。请先安装，或在设置中指定路径。`)
    const apiKey = providerApiKey(provider, settings)
    const cwd = thread.cwd && fs.existsSync(thread.cwd) ? thread.cwd : project.path
    if (!fs.existsSync(cwd)) throw new Error(`项目目录不存在：${cwd}`)

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
    try {
      const sessionId = await this.connectSession(proc, cwd, thread.chatId, provider, apiKey, mcpServers)
      await this.applySessionOptions(proc, req)
      if (proc.dying || proc.child.exitCode !== null) throw new Error('CLI 进程已退出')
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
    run.reducer.init = { sessionId, cwd, model: req.model }
    this.store.updateThread(threadId, { chatId: sessionId, cwd })
    this.onStateChange()
    await this.applySessionOptions(proc, req)
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
    await this.initializeSession(proc, provider, apiKey)

    let sessionId = chatId
    if (sessionId) {
      await acp.request('session/load', { sessionId, cwd, mcpServers })
    } else {
      const created = await acp.request('session/new', { cwd, mcpServers })
      sessionId = created?.sessionId
      if (!sessionId) throw new Error(`${cliLabel(provider)} 没有返回会话 id`)
    }
    proc.sessionId = sessionId
    proc.ready = true
    return sessionId
  }

  private async initializeSession(proc: AgentProc, provider: CliProvider, apiKey: string): Promise<any> {
    const acp = proc.acp
    const initialized = await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        ...(provider === 'codex' ? { plan: {} } : {})
      },
      clientInfo: { name: 'agent-desktop', version: '0.1.0' }
    })
    // Cursor API key auth is `--api-key` at process start. `cursor_login` clears stored
    // API-key credentials, so it only runs when no key is configured.
    if (provider === 'cursor' && !apiKey) await acp.request('authenticate', { methodId: 'cursor_login' })
    if (provider === 'codex' && apiKey) await acp.request('authenticate', { methodId: 'api-key' })
    if (provider === 'codex' && !apiKey) await acp.request('authenticate', { methodId: 'chat-gpt' })
    // Claude uses ANTHROPIC_API_KEY at process start, or the login already stored in ~/.claude.
    return initialized
  }

  private async applySessionOptions(proc: AgentProc, req: SendRequest): Promise<void> {
    if (proc.provider === 'codex') {
      await this.applyCodexOptions(proc, req)
      return
    }
    if (proc.provider === 'claude') {
      await this.applyClaudeOptions(proc, req)
      return
    }
    const { acp, sessionId } = proc
    try {
      await acp.request('session/set_mode', { sessionId, modeId: req.mode })
    } catch {
      /* --mode on the process is the fallback */
    }
    if (req.model) {
      try {
        await acp.request('session/set_model', { sessionId, modelId: req.model })
      } catch {
        /* --model on the process is the fallback when it is not "auto" */
      }
    }
  }

  private async applyCodexOptions(proc: AgentProc, req: SendRequest): Promise<void> {
    const { acp, sessionId } = proc
    const modeId = codexModeId(req.mode, req.force, this.store.settings.sandbox)
    try {
      await acp.request('session/set_mode', { sessionId, modeId })
    } catch {
      /* the next prompt still runs in whatever mode the process started with */
    }
    try {
      await acp.request('session/set_config_option', {
        sessionId,
        configId: 'collaboration_mode',
        value: req.mode === 'plan' ? 'plan' : 'default'
      })
    } catch {
      /* older adapters ignore the collaboration mode option */
    }
    await this.applyCodexModel(proc, req.model)
  }

  private async applyClaudeOptions(proc: AgentProc, req: SendRequest): Promise<void> {
    try {
      await proc.acp.request('session/set_mode', { sessionId: proc.sessionId, modeId: claudeModeId(req.mode, req.force) })
    } catch {
      /* the next prompt still runs in whatever mode the process started with */
    }
    await this.applyClaudeModel(proc, req.model)
  }

  private async applyClaudeModel(proc: AgentProc, model: string): Promise<void> {
    if (!model || model === 'auto') return
    const bracket = model.match(/^([^[]+)\[([^\]]+)\]$/)
    const id = bracket?.[1] ?? model
    try {
      await proc.acp.request('session/set_config_option', { sessionId: proc.sessionId, configId: CLAUDE_MODEL_CONFIG_ID, value: id })
    } catch {
      /* keep the session's current model */
    }
    if (!bracket?.[2] || bracket[2] === 'default') return
    try {
      await proc.acp.request('session/set_config_option', { sessionId: proc.sessionId, configId: CLAUDE_EFFORT_CONFIG_ID, value: bracket[2] })
    } catch {
      /* the model keeps its default effort */
    }
  }

  private async applyCodexModel(proc: AgentProc, model: string): Promise<void> {
    if (!model || model === 'auto') return
    const bracket = model.match(/^([^[]+)\[([^\]]+)\]$/)
    const id = bracket?.[1] ?? model
    try {
      await proc.acp.request('session/set_config_option', { sessionId: proc.sessionId, configId: 'model', value: id })
    } catch {
      /* keep the session's current model */
    }
    if (!bracket?.[2]) return
    try {
      await proc.acp.request('session/set_config_option', {
        sessionId: proc.sessionId,
        configId: 'reasoning_effort',
        value: bracket[2]
      })
    } catch {
      /* the model keeps its default effort */
    }
  }

  private async runPrompt(threadId: string, run: Run, req: SendRequest): Promise<void> {
    if (this.runs.get(threadId) !== run || run.settled) return
    if (run.stopped) {
      this.endRun(threadId, run, null)
      return
    }
    const started = Date.now()
    const contextThroughId = this.store.thread(threadId)?.forkContextThroughItemId
    let prompt = req.prompt
    if (contextThroughId) {
      const items = this.store.items(threadId)
      const cut = items.findIndex((item) => item.id === contextThroughId)
      if (cut < 0) throw new Error('分叉历史缺失，无法恢复上下文')
      prompt = forkPrompt(items.slice(0, cut + 1), prompt)
    }
    const text =
      req.mode !== 'plan'
        ? prompt
        : run.proc.provider === 'codex'
          ? codexPlanModePrompt(prompt)
          : run.proc.provider === 'claude'
            ? claudePlanModePrompt(prompt)
            : planModePrompt(prompt)
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
    if (run.codexUsage && !codexUsage?.completed) void this.saveTurnUsage(threadId, resultId, run.codexUsage)
  }

  private endRun(threadId: string, run: Run, code: number | null, spawnError?: Error): void {
    if (run.settled) return
    run.settled = true
    if (run.killTimer) {
      clearTimeout(run.killTimer)
      run.killTimer = undefined
    }
    this.settleQuestion(run, 'cancel')
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
      changed.push(r.push({ id: newId(), kind: 'notice', level: 'info', text: '已停止' }))
    } else if (spawnError) {
      changed.push(r.push({ id: newId(), kind: 'notice', level: 'error', text: `无法启动 ${cliLabel(run.proc.provider)}：${spawnError.message}` }))
    } else if (!r.gotResult) {
      const detail = [run.failText, stripAnsi(run.proc.stderr).trim()].filter(Boolean).join('\n').slice(-4000)
      changed.push(
        r.push({
          id: newId(),
          kind: 'notice',
          level: 'error',
          text: detail || `${cliLabel(run.proc.provider)} 意外退出（退出码 ${code ?? '未知'}）`
        })
      )
    }
    this.queue(threadId, run, changed)
    this.flushPending(threadId, run)
    this.runs.delete(threadId)

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
      title: updated?.title || DEFAULT_TITLE,
      stopped: run.stopped,
      failed,
      preview: summary
    })
    if (run.resultId && run.codexAccountPath !== undefined) {
      void this.saveCodexAccountUsage(threadId, run.resultId, run.proc.sessionId, run.codexAccountPath)
    }
  }

  /** Late rollout writes update only their own result, without delaying task completion. */
  private async saveTurnUsage(threadId: string, resultId: string, reader: CodexTurnUsageReader): Promise<void> {
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

  private clearCodexUsageRefresh(threadId: string): void {
    clearTimeout(this.codexUsageRefreshes.get(threadId)?.timer)
    this.codexUsageRefreshes.delete(threadId)
  }

  /** Read attributed session usage after completion; accounting may arrive later. */
  private async saveCodexAccountUsage(threadId: string, resultId: string, sessionId: string, customPath: string, retry = 0): Promise<void> {
    if (this.shuttingDown) return
    const previous = this.codexUsageRefreshes.get(threadId)
    if (previous?.resultId === resultId && previous.sessionId === sessionId && (previous.pending || Date.now() - previous.at < 30_000)) return
    this.clearCodexUsageRefresh(threadId)
    const refresh: CodexUsageRefresh = { resultId, sessionId, at: Date.now(), pending: true }
    this.codexUsageRefreshes.set(threadId, refresh)
    let needsRetry = true
    try {
      const { quota, quotaSampledAt, threadUsage, sessionUsage } = await this.readCodexAccount(customPath, sessionId)
      if (this.codexUsageRefreshes.get(threadId) !== refresh) return
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
          void this.saveCodexAccountUsage(threadId, resultId, sessionId, this.store.settings.codexPath, retry + 1)
        }, CODEX_USAGE_RETRY_MS[retry])
        refresh.timer.unref?.()
      }
    }
  }

  private canRetryCodexUsage(threadId: string, refresh: CodexUsageRefresh): boolean {
    if (this.codexUsageRefreshes.get(threadId) !== refresh || this.isRunning(threadId)) return false
    const thread = this.store.thread(threadId)
    if (!thread || thread.chatId !== refresh.sessionId || threadCli(thread) !== 'codex') return false
    if (resolveCodexApiKey(this.store.settings.codexApiKey)) return false
    const latest = [...this.store.items(threadId)].reverse().find((item) => item.kind === 'result')
    return latest?.id === refresh.resultId
  }

  private onIdleAcpRequest(proc: AgentProc, method: string, params: any): Promise<unknown> {
    if (method === 'cursor/ask_question' || isQuestionParams(params)) return Promise.resolve({ outcome: { outcome: 'skipped', reason: 'idle' } })
    if (method === 'cursor/create_plan') return Promise.resolve({ outcome: { outcome: 'accepted' } })
    if (method === 'session/request_permission') {
      const options: { optionId?: string; kind?: string }[] = Array.isArray(params?.options) ? params.options : []
      return Promise.resolve(permissionResult(options, proc.force))
    }
    return Promise.reject(new MethodNotFound(method))
  }

  private onAcpRequest(threadId: string, run: Run, method: string, params: any): Promise<unknown> {
    if (method === 'cursor/ask_question' || isQuestionParams(params)) return this.answerAskQuestion(threadId, run, params)
    if (method === 'cursor/create_plan') return Promise.resolve({ outcome: { outcome: 'accepted' } })
    if (method === 'session/request_permission') return this.answerPermission(threadId, run, params)
    return Promise.reject(new MethodNotFound(method))
  }

  private async answerAskQuestion(threadId: string, run: Run, params: any): Promise<unknown> {
    if (!run.acceptUpdates) return { outcome: { outcome: 'skipped', reason: 'replay' } }
    const questions = normalizeQuestions(params?.questions)
    const decision = await this.waitForAnswers(threadId, run, {
      toolCallId: String(params?.toolCallId ?? ''),
      title: typeof params?.title === 'string' ? params.title : undefined,
      questions
    })
    if (decision === 'cancel') return { outcome: { outcome: 'cancelled' } }
    if (decision === 'skip') return { outcome: { outcome: 'skipped', reason: '用户跳过了提问' } }
    return { outcome: { outcome: 'answered', answers: decision } }
  }

  private async answerPermission(threadId: string, run: Run, params: any): Promise<unknown> {
    const options: { optionId?: string; kind?: string; name?: string }[] = Array.isArray(params?.options) ? params.options : []
    const askFallback = options.some((o) => o.optionId === '__ask_question_skip__')
    if (run.proc.provider === 'claude' && run.mode === 'ask' && !askFallback) return permissionResult(options, false, true)
    if (!askFallback || !run.acceptUpdates) return permissionResult(options, run.force)
    const decision = await this.waitForAnswers(threadId, run, {
      toolCallId: String(params?.toolCall?.toolCallId ?? ''),
      title: typeof params?.toolCall?.title === 'string' ? params.toolCall.title : undefined,
      questions: [
        {
          id: 'q',
          prompt: String(params?.toolCall?.title || params?.toolCall?.content?.[0]?.content?.text || '请选择'),
          allowMultiple: false,
          options: options
            .filter((o) => o.optionId && o.optionId !== '__ask_question_skip__')
            .map((o) => ({ id: String(o.optionId), label: String(o.name || o.optionId) }))
        }
      ]
    })
    if (decision === 'cancel' || decision === 'skip') {
      return { outcome: { outcome: 'selected', optionId: '__ask_question_skip__' } }
    }
    const optionId = decision[0]?.selectedOptionIds[0]
    return { outcome: { outcome: 'selected', optionId: optionId || '__ask_question_skip__' } }
  }

  private waitForAnswers(
    threadId: string,
    run: Run,
    spec: Pick<QuestionItem, 'toolCallId' | 'title' | 'questions'>
  ): Promise<QuestionAnswer[] | 'skip' | 'cancel'> {
    if (spec.questions.length === 0) return Promise.resolve('skip')
    const item: QuestionItem = { id: newId(), kind: 'question', status: 'pending', ...spec }
    run.reducer.push(item)
    this.queue(threadId, run, [item])
    return new Promise((resolve) => {
      run.pendingQuestion = {
        itemId: item.id,
        resolve: (decision) => {
          if (decision === 'cancel' || decision === 'skip') item.status = 'skipped'
          else {
            item.status = 'answered'
            item.answers = decision
          }
          this.queue(threadId, run, [item])
          resolve(decision)
        }
      }
    })
  }

  private settleQuestion(run: Run, decision: 'skip' | 'cancel'): void {
    const pending = run.pendingQuestion
    if (!pending) return
    run.pendingQuestion = undefined
    pending.resolve(decision)
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

function procFingerprint(
  cli: ResolvedCli,
  provider: CliProvider,
  cwd: string,
  sandbox: string,
  force: boolean,
  apiKey: string,
  mcpServers: unknown,
  skills: unknown
): string {
  return JSON.stringify([provider, cli.command, cli.prefixArgs, cwd, sandbox, force ? 1 : 0, apiKey, mcpServers, skills])
}

interface AgentLaunch {
  cli: ResolvedCli
  codex?: ResolvedCodex
  claude?: ResolvedClaude
}

function resolveLaunch(provider: CliProvider, agentPath: string, codexPath: string, claudePath: string): AgentLaunch | undefined {
  if (provider === 'codex') {
    const codex = resolveCodex(codexPath)
    return codex ? { cli: codexAsCli(codex), codex } : undefined
  }
  if (provider === 'claude') {
    const claude = resolveClaude(claudePath)
    return claude ? { cli: claudeAsCli(claude), claude } : undefined
  }
  const cli = resolveCli(agentPath)
  return cli ? { cli } : undefined
}

function providerApiKey(provider: CliProvider, settings: { apiKey: string; codexApiKey: string; claudeApiKey: string }): string {
  if (provider === 'codex') return resolveCodexApiKey(settings.codexApiKey)
  if (provider === 'claude') return resolveClaudeApiKey(settings.claudeApiKey)
  return resolveApiKey(settings.apiKey)
}

function cursorArgs(req: SendRequest, sandbox: 'default' | 'enabled' | 'disabled', cwd: string, hasChat: boolean): string[] {
  const args = ['--trust']
  if (req.model && req.model !== 'auto') args.push('--model', req.model)
  if (req.mode !== 'agent') args.push('--mode', req.mode)
  if (req.force) args.push('--force')
  if (sandbox !== 'default') args.push('--sandbox', sandbox)
  if (!hasChat && req.worktree) args.push('--worktree')
  args.push('--workspace', cwd, 'acp')
  return args
}

function cliLabel(provider: CliProvider): string {
  if (provider === 'codex') return 'Codex CLI'
  if (provider === 'claude') return 'Claude Code'
  return 'Cursor CLI'
}

function isQuestionParams(params: any): boolean {
  return Array.isArray(params?.questions) && params.questions.some((q: any) => q && typeof q === 'object' && ('prompt' in q || 'options' in q))
}

/**
 * The CLI approves SwitchMode on its own in ACP and sends no mode update, so a plan turn
 * would silently turn into an editing turn. Seeing the switch finish is the only signal.
 */
export function leftPlanMode(update: any, switchCalls: Set<string>): boolean {
  if (update?.sessionUpdate === 'current_mode_update') return update.currentModeId !== 'plan'
  if (update?.sessionUpdate !== 'tool_call' && update?.sessionUpdate !== 'tool_call_update') return false
  const id = String(update.toolCallId ?? '')
  if (update.kind === 'switch_mode') switchCalls.add(id)
  if (update.status !== 'completed' || !switchCalls.has(id)) return false
  switchCalls.delete(id)
  return true
}

function abandonQuestions(items: Item[]): Item[] {
  const changed: Item[] = []
  for (const it of items) {
    if (it.kind === 'question' && it.status === 'pending') {
      it.status = 'skipped'
      changed.push(it)
    }
  }
  return changed
}
