import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { enabledSkillFingerprint, toAcpMcpServers } from '@shared/agent-config'
import type { AgentEvent, Item, QuestionAnswer, QuestionItem, SendRequest } from '@shared/types'
import { normalizeQuestions } from '@shared/questions'
import { AcpConnection, MethodNotFound, permissionResult, planModePrompt } from './acp'
import { killTree, resolveApiKey, resolveCli, spawnCli, stripAnsi, type ResolvedCli } from './cli'
import { syncManagedSkills } from './skills'
import { newId } from './id'
import { StreamReducer } from './reducer'
import type { Store } from './store'

interface PendingQuestion {
  itemId: string
  resolve: (decision: QuestionAnswer[] | 'skip' | 'cancel') => void
}

/** One `agent acp` process kept alive so the next message skips startup and session/load. */
interface AgentProc {
  child: ChildProcess
  acp: AcpConnection
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

export class SessionManager {
  private runs = new Map<string, Run>()
  /** Idle CLI processes, keyed by thread id. Not included in `running()`. */
  private agents = new Map<string, AgentProc>()

  constructor(
    private readonly store: Store,
    private readonly emit: (ev: AgentEvent) => void,
    private readonly onStateChange: () => void,
    private readonly onFinished: (info: RunFinished) => void
  ) {}

  running(): string[] {
    return [...this.runs.keys()]
  }

  isRunning(threadId: string): boolean {
    return this.runs.has(threadId)
  }

  send(req: SendRequest): void {
    if (this.runs.has(req.threadId)) throw new Error('该对话正在运行中')
    const thread = this.store.thread(req.threadId)
    if (!thread) throw new Error('对话不存在')
    const project = this.store.project(thread.projectId)
    if (!project) throw new Error('项目不存在')
    const settings = this.store.settings
    const cli = resolveCli(settings.agentPath)
    if (!cli) throw new Error('未找到 Cursor CLI（agent）。请先安装，或在设置中指定路径。')
    const apiKey = resolveApiKey(settings.apiKey)

    const cwd = thread.cwd && fs.existsSync(thread.cwd) ? thread.cwd : project.path
    if (!fs.existsSync(cwd)) throw new Error(`项目目录不存在：${cwd}`)

    const mcpServers = toAcpMcpServers(settings.mcpServers)
    const fingerprint = procFingerprint(cli, cwd, settings.sandbox, req.force, apiKey, mcpServers, enabledSkillFingerprint(settings.skills))
    let proc = this.agents.get(thread.id)
    const reusable = !!proc && this.canReuse(proc, fingerprint)
    if (proc && !reusable) {
      this.discard(thread.id)
      proc = undefined
    }
    if (!proc) syncManagedSkills(settings.skills)

    const items = this.store.items(thread.id)
    const userItem: Item = { id: newId(), kind: 'user', text: req.prompt, createdAt: Date.now() }
    items.push(userItem)

    this.store.updateThread(thread.id, {
      title: thread.title === DEFAULT_TITLE ? titleFrom(req.prompt) : thread.title,
      model: req.model,
      mode: req.mode,
      worktree: thread.chatId ? thread.worktree : !!req.worktree,
      updatedAt: Date.now(),
      archived: false
    })

    if (!proc) {
      const args = ['--trust']
      if (req.model && req.model !== 'auto') args.push('--model', req.model)
      if (req.mode !== 'agent') args.push('--mode', req.mode)
      if (req.force) args.push('--force')
      if (settings.sandbox !== 'default') args.push('--sandbox', settings.sandbox)
      if (!thread.chatId && req.worktree) args.push('--worktree')
      args.push('--workspace', cwd, 'acp')
      proc = this.openProc(thread.id, cli, args, cwd, apiKey, fingerprint)
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

    const turn = reusable
      ? this.continueSession(thread.id, run, req)
      : this.drive(thread.id, run, req, cwd, thread.chatId, !apiKey, mcpServers)
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
    cli: ResolvedCli,
    args: string[],
    cwd: string,
    apiKey: string,
    fingerprint: string
  ): AgentProc {
    const child = spawnCli(cli, args, cwd, 'pipe', apiKey)
    const proc: AgentProc = {
      child,
      acp: undefined as unknown as AcpConnection,
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
        const run = this.runs.get(threadId)
        if (!run || run.proc !== proc || method !== 'session/update' || !run.acceptUpdates) return
        if (run.mode === 'plan' && leftPlanMode(params?.update, run.switchCalls)) {
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

  private async drive(
    threadId: string,
    run: Run,
    req: SendRequest,
    cwd: string,
    chatId?: string,
    useLogin = false,
    mcpServers: Record<string, unknown>[] = []
  ): Promise<void> {
    const { proc } = run
    const acp = proc.acp
    await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agent-desktop', version: '0.1.0' }
    })
    // API key auth is `--api-key` at process start. `cursor_login` clears stored API-key
    // credentials, so it only runs when no key is configured.
    if (useLogin) await acp.request('authenticate', { methodId: 'cursor_login' })

    let sessionId = chatId
    if (sessionId) {
      await acp.request('session/load', { sessionId, cwd, mcpServers })
    } else {
      const created = await acp.request('session/new', { cwd, mcpServers })
      sessionId = created?.sessionId
      if (!sessionId) throw new Error('Cursor CLI 没有返回会话 id')
    }
    proc.sessionId = sessionId
    proc.ready = true
    run.reducer.init = { sessionId, cwd, model: req.model }
    this.store.updateThread(threadId, { chatId: sessionId, cwd })
    this.onStateChange()
    await this.applySessionOptions(proc, req)
    if (!this.runs.has(threadId) || run.settled) return
    run.acceptUpdates = true
    await this.runPrompt(threadId, run, req)
  }

  private async applySessionOptions(proc: AgentProc, req: SendRequest): Promise<void> {
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

  private async runPrompt(threadId: string, run: Run, req: SendRequest): Promise<void> {
    const started = Date.now()
    const text = req.mode === 'plan' ? planModePrompt(req.prompt) : req.prompt
    const result = await run.proc.acp.request('session/prompt', {
      sessionId: run.proc.sessionId,
      prompt: [{ type: 'text', text }]
    })
    if (!this.runs.has(threadId) || run.settled) return
    const stop = String(result?.stopReason ?? 'end_turn')
    run.reducer.gotResult = true
    const usage = result?.usage
      ? {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cachedReadTokens,
          cacheWriteTokens: result.usage.cachedWriteTokens
        }
      : run.reducer.lastUsage
    const changed = run.reducer.closeSegments()
    changed.push(
      run.reducer.push({
        id: newId(),
        kind: 'result',
        isError: stop !== 'end_turn' && stop !== 'cancelled',
        durationMs: Date.now() - started,
        createdAt: Date.now(),
        model: req.model,
        usageId: newId(),
        usage
      })
    )
    this.queue(threadId, run, changed)
    // The CLI stays up after a turn. Parking it avoids the next message paying
    // for process startup and session/load. A later close still ends the turn.
    this.endRun(threadId, run, null)
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
    if (run.stopped) {
      changed.push(r.push({ id: newId(), kind: 'notice', level: 'info', text: '已停止' }))
    } else if (spawnError) {
      changed.push(r.push({ id: newId(), kind: 'notice', level: 'error', text: `无法启动 Cursor CLI：${spawnError.message}` }))
    } else if (!r.gotResult) {
      const detail = [run.failText, stripAnsi(run.proc.stderr).trim()].filter(Boolean).join('\n').slice(-4000)
      changed.push(
        r.push({
          id: newId(),
          kind: 'notice',
          level: 'error',
          text: detail || `Cursor CLI 意外退出（退出码 ${code ?? '未知'}）`
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
  }

  private onIdleAcpRequest(proc: AgentProc, method: string, params: any): Promise<unknown> {
    if (method === 'cursor/ask_question') return Promise.resolve({ outcome: { outcome: 'skipped', reason: 'idle' } })
    if (method === 'cursor/create_plan') return Promise.resolve({ outcome: { outcome: 'accepted' } })
    if (method === 'session/request_permission') {
      const options: { optionId?: string; kind?: string }[] = Array.isArray(params?.options) ? params.options : []
      return Promise.resolve(permissionResult(options, proc.force))
    }
    return Promise.reject(new MethodNotFound(method))
  }

  private onAcpRequest(threadId: string, run: Run, method: string, params: any): Promise<unknown> {
    if (method === 'cursor/ask_question') return this.answerAskQuestion(threadId, run, params)
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
  cwd: string,
  sandbox: string,
  force: boolean,
  apiKey: string,
  mcpServers: unknown,
  skills: unknown
): string {
  return JSON.stringify([cli.command, cli.prefixArgs, cwd, sandbox, force ? 1 : 0, apiKey, mcpServers, skills])
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
