import { t as translate } from '@shared/i18n'
import type { ChildProcess } from 'node:child_process'
import { QUESTION_BLOCK_LANG } from '@shared/questions'

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
  /** Non-JSON stdout lines, such as the CLI's `Using worktree:` notice. */
  onText?: (line: string) => void
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
    // Writing after the CLI exits raises EPIPE on stdin; unhandled, it crashes the main process.
    const ignoreWriteError = () => undefined
    this.child.stdin?.on('error', ignoreWriteError)
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
      this.child.stdin?.removeListener('error', ignoreWriteError)
      const err = new Error(translate('CLI 进程已退出'))
      for (const waiter of this.pending.values()) waiter.reject(err)
      this.pending.clear()
    })
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error(translate('CLI 进程已退出')))
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
      handlers.onText?.(trimmed)
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
      if (msg.error) waiter.reject(new Error(acpErrorText(msg.error)))
      else waiter.resolve(msg.result)
      return
    }
    if (typeof msg.method === 'string') handlers.onNotification(msg.method, msg.params ?? {})
  }
}

/**
 * Cursor does not offer AskQuestion to ACP clients, so plan-mode questions arrive as a fenced
 * block the renderer turns into a picker. Wrapped in a tag so CLI history import drops it.
 */
const PLAN_CLIENT_HINT = `<agent_desktop_client>
You are running inside the Agent Desktop client. The AskQuestion tool is not available here; do not look for it.
When you need the user to choose between options, do not list the options as plain text. Output one fenced code block with the language "${QUESTION_BLOCK_LANG}" whose body is JSON, then end your turn and wait:
\`\`\`${QUESTION_BLOCK_LANG}
{"title":"short title","questions":[{"id":"q1","prompt":"question text","allowMultiple":false,"options":[{"id":"a","label":"option text"},{"id":"b","label":"option text"}]}]}
\`\`\`
Write the prompts and labels in the user's language. The client automatically adds an "Other (manual input)" option to every question; do not include an Other placeholder in the options. The user's selected options and any manual answer arrive together as the next message.
Ask before planning: a turn that contains a questions block must not call CreatePlan.
Once the requirements are clear, deliver the plan with the CreatePlan tool. Stay in plan mode: never call SwitchMode and never edit files. The user starts implementation from the client with an "execute plan" button.
</agent_desktop_client>`

export function planModePrompt(prompt: string): string {
  return `${PLAN_CLIENT_HINT}\n\n${prompt}`
}

/**
 * Codex Plan is a collaboration mode, not Cursor's CreatePlan tool. The same questions
 * block feeds the existing picker; the plan tool's markdown feeds the existing plan card.
 */
const CODEX_PLAN_HINT = `<agent_desktop_client>
You are running inside the Agent Desktop client, in Codex plan mode.
When you need the user to choose between options, do not list the options as plain text. Output one fenced code block with the language "${QUESTION_BLOCK_LANG}" whose body is JSON, then end your turn and wait:
\`\`\`${QUESTION_BLOCK_LANG}
{"title":"short title","questions":[{"id":"q1","prompt":"question text","allowMultiple":false,"options":[{"id":"a","label":"option text"},{"id":"b","label":"option text"}]}]}
\`\`\`
Write the prompts and labels in the user's language. The client automatically adds an "Other (manual input)" option to every question; do not include an Other placeholder in the options. The user's selected options and any manual answer arrive together as the next message.
Ask before planning: a turn that contains a questions block must not emit a plan.
Once the requirements are clear, emit one plan with a short name, a one-paragraph overview, and the full plan as Markdown. Do not change modes and do not edit files. The user starts implementation from the client.
</agent_desktop_client>`

export function codexPlanModePrompt(prompt: string): string {
  return `${CODEX_PLAN_HINT}\n\n${prompt}`
}

/**
 * Claude Plan is the adapter's `plan` permission mode. The questions block feeds the existing
 * picker; the plan text feeds the existing plan card.
 */
const CLAUDE_PLAN_HINT = `<agent_desktop_client>
You are running inside the Agent Desktop client, in Claude plan mode.
When you need the user to choose between options, do not list the options as plain text. Output one fenced code block with the language "${QUESTION_BLOCK_LANG}" whose body is JSON, then end your turn and wait:
\`\`\`${QUESTION_BLOCK_LANG}
{"title":"short title","questions":[{"id":"q1","prompt":"question text","allowMultiple":false,"options":[{"id":"a","label":"option text"},{"id":"b","label":"option text"}]}]}
\`\`\`
Write the prompts and labels in the user's language. The client automatically adds an "Other (manual input)" option to every question; do not include an Other placeholder in the options. The user's selected options and any manual answer arrive together as the next message.
Ask before planning: a turn that contains a questions block must not emit a plan.
Once the requirements are clear, emit one plan with a short name, a one-paragraph overview, and the full plan as Markdown. Do not change modes and do not edit files. The user starts implementation from the client.
</agent_desktop_client>`

export function claudePlanModePrompt(prompt: string): string {
  return `${CLAUDE_PLAN_HINT}\n\n${prompt}`
}

/** JSON-RPC internal errors often keep the useful text in `data`, not `message`. */
export function acpErrorText(error: { message?: unknown; data?: unknown } | null | undefined): string {
  const message = typeof error?.message === 'string' ? error.message.trim() : ''
  const detail = acpErrorDetail(error?.data)
  if (detail && (!message || message === 'Internal error')) return detail
  if (detail && message && !message.includes(detail)) return `${message}: ${detail}`
  return message || translate('ACP 请求失败')
}

function acpErrorDetail(data: unknown): string {
  if (typeof data === 'string') return data.trim()
  if (!data || typeof data !== 'object') return ''
  const record = data as Record<string, unknown>
  for (const key of ['details', 'message', 'stderr']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function permissionResult(
  options: { optionId?: string; kind?: string }[],
  force: boolean,
  deny = false
): { outcome: { outcome: string; optionId?: string } } {
  const usable = options.filter((o) => o.optionId)
  if (deny) {
    const reject = usable.find((o) => o.kind === 'reject_once') || usable.find((o) => o.kind === 'reject_always')
    if (!reject?.optionId) return { outcome: { outcome: 'cancelled' } }
    return { outcome: { outcome: 'selected', optionId: reject.optionId } }
  }
  const allowAlways = usable.find((o) => o.kind === 'allow_always')
  const allowOnce = usable.find((o) => o.kind === 'allow_once')
  const picked = (force && allowAlways) || allowOnce || allowAlways || usable[0]
  if (!picked?.optionId) return { outcome: { outcome: 'cancelled' } }
  return { outcome: { outcome: 'selected', optionId: picked.optionId } }
}
