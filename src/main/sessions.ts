import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import type { AgentEvent, Item, QuestionAnswer, QuestionItem, SendRequest } from '@shared/types'
import { AcpConnection, MethodNotFound, normalizeQuestions, permissionResult } from './acp'
import { killTree, resolveApiKey, resolveCli, spawnCli, stripAnsi } from './cli'
import { newId } from './id'
import { StreamReducer } from './reducer'
import type { Store } from './store'

interface PendingQuestion {
  itemId: string
  resolve: (decision: QuestionAnswer[] | 'skip' | 'cancel') => void
}

interface Run {
  child: ChildProcess
  reducer: StreamReducer
  stopped: boolean
  pending: Map<string, Item>
  flushTimer?: NodeJS.Timeout
  acp?: AcpConnection
  sessionId?: string
  /** Ignore session/update events while session/load replays history. */
  acceptUpdates: boolean
  pendingQuestion?: PendingQuestion
  force: boolean
  failText?: string
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

export class SessionManager {
  private runs = new Map<string, Run>()

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

    const args = ['--trust']
    if (req.model && req.model !== 'auto') args.push('--model', req.model)
    if (req.mode !== 'agent') args.push('--mode', req.mode)
    if (req.force) args.push('--force')
    if (settings.sandbox !== 'default') args.push('--sandbox', settings.sandbox)
    if (!thread.chatId && req.worktree) args.push('--worktree')
    args.push('--workspace', cwd, 'acp')

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

    const child = spawnCli(cli, args, cwd, 'pipe', apiKey)
    const run: Run = {
      child,
      reducer: new StreamReducer(items),
      stopped: false,
      pending: new Map(),
      acceptUpdates: false,
      force: req.force
    }
    this.runs.set(thread.id, run)
    this.queue(thread.id, run, [userItem])
    this.emit({ type: 'running', threadId: thread.id, running: true })
    this.onStateChange()

    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000)
    })

    const acp = new AcpConnection(child)
    run.acp = acp
    acp.start({
      onNotification: (method, params) => {
        if (method !== 'session/update' || !run.acceptUpdates) return
        const changed = run.reducer.handleAcp(params?.update)
        if (changed.length) this.queue(thread.id, run, changed)
      },
      onRequest: (method, params) => this.onAcpRequest(thread.id, run, method, params)
    })

    const finish = (code: number | null, spawnError?: Error): void => {
      if (!this.runs.has(thread.id)) return
      this.settleQuestion(run, 'cancel')
      const r = run.reducer
      const changed: Item[] = [...r.closeSegments(), ...r.abortRunningTools(), ...abandonQuestions(items)]
      if (run.stopped) {
        changed.push(r.push({ id: newId(), kind: 'notice', level: 'info', text: '已停止' }))
      } else if (spawnError) {
        changed.push(r.push({ id: newId(), kind: 'notice', level: 'error', text: `无法启动 Cursor CLI：${spawnError.message}` }))
      } else if (!r.gotResult) {
        const detail = [run.failText, stripAnsi(stderr).trim()].filter(Boolean).join('\n').slice(-4000)
        changed.push(
          r.push({
            id: newId(),
            kind: 'notice',
            level: 'error',
            text: detail || `Cursor CLI 意外退出（退出码 ${code ?? '未知'}）`
          })
        )
      }
      this.queue(thread.id, run, changed)
      this.flushPending(thread.id, run)
      this.runs.delete(thread.id)

      const preview = r.lastAssistantText.replace(/\s+/g, ' ').trim().slice(0, 120)
      const updated = this.store.updateThread(thread.id, {
        updatedAt: Date.now(),
        syncedAt: Date.now(),
        unread: true,
        ...(preview ? { preview } : {})
      })
      this.store.markItemsDirty(thread.id)
      this.emit({ type: 'running', threadId: thread.id, running: false })
      this.onStateChange()
      const result = [...items].reverse().find((it) => it.kind === 'result')
      const failed = !!spawnError || !r.gotResult || (result?.kind === 'result' && result.isError)
      let summary = preview
      if (failed && !summary) {
        const notice = [...items].reverse().find((it) => it.kind === 'notice' && it.level === 'error')
        if (notice?.kind === 'notice') summary = notice.text.replace(/\s+/g, ' ').trim().slice(0, 120)
      }
      this.onFinished({
        threadId: thread.id,
        title: updated?.title || thread.title,
        stopped: run.stopped,
        failed,
        preview: summary
      })
    }

    child.on('error', (err) => finish(null, err))
    child.on('close', (code) => finish(code))

    void this.drive(thread.id, run, acp, req, cwd, thread.chatId, !apiKey).catch((err) => {
      if (!run.stopped) run.failText = err instanceof Error ? err.message : String(err)
      killTree(child)
    })
  }

  answerQuestion(threadId: string, questionId: string, answers: QuestionAnswer[] | null): void {
    const run = this.runs.get(threadId)
    const pending = run?.pendingQuestion
    if (!run || !pending || pending.itemId !== questionId) throw new Error('这个问题已经不能回答了')
    run.pendingQuestion = undefined
    pending.resolve(answers ?? 'skip')
  }

  stop(threadId: string): void {
    const run = this.runs.get(threadId)
    if (!run) return
    run.stopped = true
    this.settleQuestion(run, 'cancel')
    if (run.sessionId) run.acp?.notify('session/cancel', { sessionId: run.sessionId })
    killTree(run.child)
  }

  stopAll(): void {
    for (const id of this.runs.keys()) this.stop(id)
  }

  private async drive(
    threadId: string,
    run: Run,
    acp: AcpConnection,
    req: SendRequest,
    cwd: string,
    chatId?: string,
    useLogin = false
  ): Promise<void> {
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
      await acp.request('session/load', { sessionId, cwd, mcpServers: [] })
    } else {
      const created = await acp.request('session/new', { cwd, mcpServers: [] })
      sessionId = created?.sessionId
      if (!sessionId) throw new Error('Cursor CLI 没有返回会话 id')
    }
    run.sessionId = sessionId
    run.reducer.init = { sessionId, cwd, model: req.model }
    this.store.updateThread(threadId, { chatId: sessionId, cwd })
    this.onStateChange()

    try {
      await acp.request('session/set_mode', { sessionId, modeId: req.mode })
    } catch {
      /* --mode on the process is the fallback */
    }
    if (req.model && req.model !== 'auto') {
      try {
        await acp.request('session/set_model', { sessionId, modelId: req.model })
      } catch {
        /* --model on the process is the fallback */
      }
    }

    run.acceptUpdates = true
    const started = Date.now()
    const result = await acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: req.prompt }]
    })
    if (!this.runs.has(threadId)) return
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
        usage
      })
    )
    this.queue(threadId, run, changed)
    // `agent acp` stays up after a turn and often ignores stdin EOF, which
    // left the thread stuck on "running" after the task had already finished.
    // This app runs one prompt per process, so close the CLI now.
    try {
      run.child.stdin?.end()
    } catch {
      /* already closed */
    }
    killTree(run.child)
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
