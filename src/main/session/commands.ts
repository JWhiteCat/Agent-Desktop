import { parseAvailableCommands, type SlashCommand } from '@shared/commands'
import type { AgentEvent } from '@shared/types'

const COMMAND_WAIT_MS = 2000

/**
 * Caches per-thread slash commands reported by ACP `available_commands_update`
 * and resolves waiters when `prepare()` asks for the initial list.
 */
export class SlashCommandRegistry {
  readonly lists = new Map<string, SlashCommand[]>()
  private waiters = new Map<string, Array<(cancelled: boolean) => void>>()

  constructor(private readonly emit: (ev: AgentEvent) => void) {}

  get(threadId: string): SlashCommand[] | undefined {
    return this.lists.get(threadId)
  }

  delete(threadId: string): void {
    this.lists.delete(threadId)
    const waiting = this.waiters.get(threadId)
    if (!waiting) return
    this.waiters.delete(threadId)
    for (const wake of waiting) wake(true)
  }

  remember(threadId: string, raw: unknown): void {
    const commands = parseAvailableCommands(raw)
    this.lists.set(threadId, commands)
    this.emit({ type: 'commands', threadId, commands })
    const waiting = this.waiters.get(threadId)
    if (!waiting) return
    this.waiters.delete(threadId)
    for (const wake of waiting) wake(false)
  }

  wait(threadId: string): Promise<SlashCommand[]> {
    const known = this.lists.get(threadId)
    if (known) return Promise.resolve(known)
    return new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (cancelled: boolean) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        const left = (this.waiters.get(threadId) ?? []).filter((waiter) => waiter !== wake)
        if (left.length) this.waiters.set(threadId, left)
        else this.waiters.delete(threadId)
        if (cancelled) {
          resolve([])
          return
        }
        if (!this.lists.has(threadId)) this.lists.set(threadId, [])
        resolve(this.lists.get(threadId) ?? [])
      }
      const wake = (cancelled: boolean) => finish(cancelled)
      timer = setTimeout(() => finish(false), COMMAND_WAIT_MS)
      const waiting = this.waiters.get(threadId) ?? []
      waiting.push(wake)
      this.waiters.set(threadId, waiting)
    })
  }
}
