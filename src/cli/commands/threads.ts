import { threadCli, type AppState, type Item, type ThreadMeta } from '@shared/types'
import type { ForkResult } from '@shared/api'
import { CliError, EXIT_USAGE, type CliIo, type CliRuntime, type OutputFormat } from '../types'
import { defaultModelForProvider, findProject, parseMode, parseProvider, resolveOrCreateProject, writeJson } from './helpers'

function formatItemText(item: Item): string {
  switch (item.kind) {
    case 'user':
      return `[user] ${item.text}`
    case 'assistant':
      return `[assistant] ${item.text}`
    case 'thinking':
      return `[thinking] ${item.text.slice(0, 120)}${item.text.length > 120 ? '…' : ''}`
    case 'tool':
      return `[tool:${item.status}] ${item.tool}`
    case 'notice':
      return `[notice:${item.level}] ${item.text}`
    case 'question':
      return `[question:${item.status}] ${item.title ?? item.questions.map((q) => q.prompt).join(' / ')}`
    case 'result': {
      const files = item.fileChanges?.length ?? 0
      const secs = item.durationMs !== undefined ? `${(item.durationMs / 1000).toFixed(1)}s` : ''
      return `[result] ${item.isError ? 'error' : 'ok'}${secs ? ` ${secs}` : ''}${files ? ` (${files} files)` : ''}`
    }
  }
}

export async function runThreadsCommand(
  runtime: CliRuntime,
  io: CliIo,
  sub: string | undefined,
  positionals: string[],
  opts: {
    format: OutputFormat
    project?: string
    all?: boolean
    running?: boolean
    tail?: number
    cli?: string
    model?: string
    mode?: string
    force?: boolean
    at?: string
  }
): Promise<number> {
  if (!sub || sub === 'list') {
    const state = await runtime.call<AppState>('state:get')
    const runningSet = new Set(state.running)
    const waitingSet = new Set(state.waitingForInput)
    const projectMap = new Map(state.projects.map((p) => [p.id, p]))
    let filterProjectId: string | undefined
    if (opts.project) {
      const found = findProject(state.projects, opts.project, io.cwd())
      if (!found) throw new CliError(`Project not found: ${opts.project}`, EXIT_USAGE)
      filterProjectId = found.id
    }
    let threads = state.threads.filter((t) => {
      if (filterProjectId && t.projectId !== filterProjectId) return false
      if (!opts.all && t.archived) return false
      if (opts.running && !runningSet.has(t.id)) return false
      return true
    })
    threads = threads.sort((a, b) => b.updatedAt - a.updatedAt)

    const enriched = threads.map((t) => ({
      ...t,
      cli: threadCli(t),
      projectName: projectMap.get(t.projectId)?.name ?? t.projectId,
      status: waitingSet.has(t.id) ? 'waiting' : runningSet.has(t.id) ? 'running' : 'idle'
    }))

    if (opts.format === 'json' || opts.format === 'jsonl') {
      writeJson(io, enriched)
      return 0
    }
    if (!enriched.length) {
      io.stdout.write('No matching threads.\n')
      return 0
    }
    for (const t of enriched) {
      const updated = new Date(t.updatedAt).toISOString().replace('T', ' ').slice(0, 19)
      io.stdout.write(`${t.id}  [${t.status.padEnd(7)}]  ${t.cli.padEnd(11)}  ${t.projectName}  ${updated}  ${t.title}\n`)
    }
    return 0
  }

  if (sub === 'show') {
    const threadId = positionals[0]
    if (!threadId) throw new CliError('Usage: agent-desktop threads show <threadId>', EXIT_USAGE)
    const state = await runtime.call<AppState>('state:get')
    const thread = state.threads.find((t) => t.id === threadId)
    if (!thread) throw new CliError(`Thread not found: ${threadId}`, EXIT_USAGE)
    const items = await runtime.call<Item[]>('thread:items', threadId)
    const sliced = opts.tail && opts.tail > 0 ? items.slice(-opts.tail) : items
    if (opts.format === 'json' || opts.format === 'jsonl') {
      writeJson(io, { thread, items: sliced })
      return 0
    }
    io.stdout.write(`Thread: ${thread.id} (${thread.title})\n`)
    io.stdout.write(`CLI:    ${threadCli(thread)}  Mode: ${thread.mode}${thread.model ? `  Model: ${thread.model}` : ''}\n\n`)
    for (const item of sliced) {
      io.stdout.write(`${formatItemText(item)}\n`)
    }
    return 0
  }

  if (sub === 'create') {
    const state = await runtime.call<AppState>('state:get')
    const project = await resolveOrCreateProject(runtime, state, opts.project, io.cwd(), true)
    const provider = parseProvider(opts.cli, state.settings.cliProvider)
    const mode = parseMode(opts.mode, state.settings.defaultMode)
    const model = opts.model ?? defaultModelForProvider(state.settings, provider)
    const force = opts.force ?? state.settings.force
    const thread = await runtime.call<ThreadMeta>('thread:create', project.id, mode, model, force, provider)
    if (opts.format === 'json' || opts.format === 'jsonl') {
      writeJson(io, thread)
      return 0
    }
    io.stdout.write(`${thread.id}\n`)
    return 0
  }

  if (sub === 'fork') {
    const threadId = positionals[0]
    if (!threadId) throw new CliError('Usage: agent-desktop threads fork <threadId> [--at <itemId>]', EXIT_USAGE)
    const forked = await runtime.call<ForkResult>('thread:fork', threadId, opts.at)
    if (opts.format === 'json' || opts.format === 'jsonl') {
      writeJson(io, forked)
      return 0
    }
    io.stdout.write(`${forked.thread.id}\n`)
    return 0
  }

  if (sub === 'sync') {
    const threadId = positionals[0]
    if (!threadId) throw new CliError('Usage: agent-desktop threads sync <threadId>', EXIT_USAGE)
    const items = await runtime.call<Item[]>('thread:syncFromCli', threadId)
    if (opts.format === 'json' || opts.format === 'jsonl') {
      writeJson(io, { threadId, count: items.length, items })
      return 0
    }
    io.stdout.write(`Synced ${items.length} items for thread ${threadId}.\n`)
    return 0
  }

  if (sub === 'delete') {
    const threadId = positionals[0]
    if (!threadId) throw new CliError('Usage: agent-desktop threads delete <threadId>', EXIT_USAGE)
    await runtime.call('thread:delete', threadId)
    if (opts.format === 'json' || opts.format === 'jsonl') {
      writeJson(io, { deleted: true, threadId })
      return 0
    }
    io.stdout.write(`Deleted thread ${threadId}.\n`)
    return 0
  }

  throw new CliError(`Unknown "threads" subcommand: ${sub}. Expected list, show, create, fork, sync, or delete.`, EXIT_USAGE)
}
