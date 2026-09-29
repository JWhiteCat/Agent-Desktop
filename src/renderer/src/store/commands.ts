import { sanitizeSlashCommands, type SlashCommand } from '@shared/commands'
import { threadCli, type CliProvider } from '@shared/types'
import { errorText, toast } from './feedback'
import { writeCommandCache } from './persistence'
import { getState, setState, type SendOptions, type UIState } from './state'

const NO_COMMANDS: SlashCommand[] = []

/** Stable empty list for selectors. A missing cache must not allocate on every read. */
export function cliCommands(s: UIState, cli: CliProvider): SlashCommand[] {
  return s.commandsByCli[cli] ?? NO_COMMANDS
}

/** Live announcements may clear a CLI cache; an empty prepare response only clears this thread. */
export function receiveCommands(threadId: string, commands: SlashCommand[], preserveEmptyCache = false): void {
  const state = getState()
  const thread = state.app.threads.find((t) => t.id === threadId)
  const cli = thread ? threadCli(thread) : undefined
  const list = sanitizeSlashCommands(commands)
  const cacheCli = cli && (!preserveEmptyCache || list.length) ? cli : undefined
  const commandsByCli = cacheCli ? { ...state.commandsByCli, [cacheCli]: list } : state.commandsByCli
  setState({
    commandsByThread: { ...state.commandsByThread, [threadId]: list },
    commandsByCli
  })
  if (cacheCli) writeCommandCache(commandsByCli)
}

export async function prepareCommands(threadId: string, opts: SendOptions): Promise<void> {
  try {
    const commands = await window.api.prepareCommands(threadId, { model: opts.model, mode: opts.mode, force: opts.force })
    receiveCommands(threadId, commands, true)
  } catch (err) {
    toast(errorText(err), 'error')
  }
}
