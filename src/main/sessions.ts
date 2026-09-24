import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import type { AgentEvent, Item, SendRequest } from '@shared/types'
import { killTree, resolveCli, spawnCli, stripAnsi } from './cli'
import { newId } from './id'
import { StreamReducer } from './reducer'
import type { Store } from './store'

interface Run {
  child: ChildProcess
  reducer: StreamReducer
  stopped: boolean
  pending: Map<string, Item>
  flushTimer?: NodeJS.Timeout
}

export const DEFAULT_TITLE = '新对话'

function titleFrom(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/).find((l) => l.trim()) ?? DEFAULT_TITLE
  return line.length > 48 ? `${line.slice(0, 48)}…` : line
}

export class SessionManager {
  private runs = new Map<string, Run>()

  constructor(
    private readonly store: Store,
    private readonly emit: (ev: AgentEvent) => void,
    private readonly onStateChange: () => void
  ) {}

  running(): string[] {
    return [...this.runs.keys()]
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

    let cwd = thread.cwd && fs.existsSync(thread.cwd) ? thread.cwd : project.path
    if (!fs.existsSync(cwd)) throw new Error(`项目目录不存在：${cwd}`)

    const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--trust']
    if (thread.chatId) args.push('--resume', thread.chatId)
    else if (req.worktree) args.push('--worktree')
    if (req.model && req.model !== 'auto') args.push('--model', req.model)
    if (req.mode !== 'agent') args.push('--mode', req.mode)
    if (req.force) args.push('--force')
    if (settings.sandbox !== 'default') args.push('--sandbox', settings.sandbox)
    args.push('--workspace', cwd, '--', req.prompt)

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

    const child = spawnCli(cli, args, cwd)
    const run: Run = { child, reducer: new StreamReducer(items), stopped: false, pending: new Map() }
    this.runs.set(thread.id, run)
    this.queue(thread.id, run, [userItem])
    this.emit({ type: 'running', threadId: thread.id, running: true })
    this.onStateChange()

    let buffer = ''
    let stderr = ''
    const nonJson: string[] = []

    const handleLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed) return
      let ev: any
      try {
        ev = JSON.parse(trimmed)
      } catch {
        nonJson.push(stripAnsi(trimmed))
        return
      }
      const before = run.reducer.init.sessionId
      const changed = run.reducer.handle(ev)
      if (!before && run.reducer.init.sessionId) {
        const init = run.reducer.init
        this.store.updateThread(thread.id, {
          chatId: init.sessionId,
          cwd: init.cwd ?? cwd,
          modelLabel: init.model
        })
        this.onStateChange()
      }
      if (changed.length) this.queue(thread.id, run, changed)
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, idx))
        buffer = buffer.slice(idx + 1)
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000)
    })

    const finish = (code: number | null, spawnError?: Error): void => {
      if (!this.runs.has(thread.id)) return
      if (buffer) handleLine(buffer)
      buffer = ''
      const r = run.reducer
      const changed: Item[] = [...r.closeSegments(), ...r.abortRunningTools()]
      if (run.stopped) {
        changed.push(r.push({ id: newId(), kind: 'notice', level: 'info', text: '已停止' }))
      } else if (spawnError) {
        changed.push(r.push({ id: newId(), kind: 'notice', level: 'error', text: `无法启动 Cursor CLI：${spawnError.message}` }))
      } else if (!r.gotResult) {
        const detail = [stripAnsi(stderr).trim(), ...nonJson].filter(Boolean).join('\n').slice(-4000)
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
      this.store.updateThread(thread.id, {
        updatedAt: Date.now(),
        unread: true,
        ...(preview ? { preview } : {})
      })
      this.store.markItemsDirty(thread.id)
      this.emit({ type: 'running', threadId: thread.id, running: false })
      this.onStateChange()
    }

    child.on('error', (err) => finish(null, err))
    child.on('close', (code) => finish(code))
  }

  stop(threadId: string): void {
    const run = this.runs.get(threadId)
    if (!run) return
    run.stopped = true
    killTree(run.child)
  }

  stopAll(): void {
    for (const id of this.runs.keys()) this.stop(id)
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
