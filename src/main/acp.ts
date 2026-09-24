import type { ChildProcess } from 'node:child_process'
import type { QuestionPrompt } from '@shared/types'

export class MethodNotFound extends Error {
  readonly code = -32601
  constructor(method: string) {
    super(`Method not found: ${method}`)
  }
}

interface Pending {
  resolve: (value: any) => void
  reject: (err: Error) => void
}

interface Handlers {
  onRequest: (method: string, params: any) => Promise<unknown>
  onNotification: (method: string, params: any) => void
}

/**
 * Newline-delimited JSON-RPC client for `agent acp`.
 * Reads stdout while requests are in flight so blocking calls such as
 * `cursor/ask_question` can be answered without stalling the stream.
 */
export class AcpConnection {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private buffer = ''
  private writeChain: Promise<void> = Promise.resolve()
  private closed = false

  constructor(private readonly child: ChildProcess) {}

  start(handlers: Handlers): void {
    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => {
      this.buffer += chunk
      let idx: number
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx)
        this.buffer = this.buffer.slice(idx + 1)
        this.onLine(line, handlers)
      }
    })
    this.child.on('close', () => {
      this.closed = true
      const err = new Error('Cursor CLI 已退出')
      for (const waiter of this.pending.values()) waiter.reject(err)
      this.pending.clear()
    })
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Cursor CLI 已退出'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private send(message: unknown): void {
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) return
    const line = `${JSON.stringify(message)}\n`
    this.writeChain = this.writeChain
      .then(
        () =>
          new Promise<void>((resolve) => {
            this.child.stdin?.write(line, () => resolve())
          })
      )
      .catch(() => undefined)
  }

  private onLine(line: string, handlers: Handlers): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: any
    try {
      msg = JSON.parse(trimmed)
    } catch {
      return
    }
    if (msg.id !== undefined && typeof msg.method === 'string') {
      void handlers
        .onRequest(msg.method, msg.params ?? {})
        .then(
          (result) => this.send({ jsonrpc: '2.0', id: msg.id, result }),
          (err: any) =>
            this.send({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: typeof err?.code === 'number' ? err.code : -32603, message: err?.message || String(err) }
            })
        )
      return
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
      const waiter = this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(msg.error.message || 'ACP 请求失败'))
      else waiter.resolve(msg.result)
      return
    }
    if (typeof msg.method === 'string') handlers.onNotification(msg.method, msg.params ?? {})
  }
}

export function normalizeQuestions(raw: unknown): QuestionPrompt[] {
  if (!Array.isArray(raw)) return []
  const questions: QuestionPrompt[] = []
  raw.forEach((q, i) => {
    if (!q || typeof q !== 'object') return
    const prompt = String((q as { prompt?: unknown }).prompt ?? '').trim()
    const options = Array.isArray((q as { options?: unknown }).options)
      ? (q as { options: any[] }).options
          .map((o, j) => ({
            id: String(o?.id ?? `o${j}`),
            label: String(o?.label ?? o?.name ?? o?.id ?? '').trim()
          }))
          .filter((o) => o.id && o.label)
      : []
    if (!prompt || options.length === 0) return
    questions.push({
      id: String((q as { id?: unknown }).id ?? `q${i}`),
      prompt,
      options,
      allowMultiple: !!((q as { allowMultiple?: unknown }).allowMultiple || (q as { allow_multiple?: unknown }).allow_multiple)
    })
  })
  return questions
}

export function permissionResult(options: { optionId?: string; kind?: string }[], force: boolean): { outcome: { outcome: string; optionId?: string } } {
  const usable = options.filter((o) => o.optionId)
  const allowAlways = usable.find((o) => o.kind === 'allow_always')
  const allowOnce = usable.find((o) => o.kind === 'allow_once')
  const picked = (force && allowAlways) || allowOnce || allowAlways || usable[0]
  if (!picked?.optionId) return { outcome: { outcome: 'cancelled' } }
  return { outcome: { outcome: 'selected', optionId: picked.optionId } }
}
