import path from 'node:path'
import type { AppState, Project } from '@shared/types'
import { CliError, EXIT_USAGE, type CliIo, type CliRuntime, type OutputFormat } from '../types'
import { writeJson } from './helpers'

export async function runProjectsCommand(
  runtime: CliRuntime,
  io: CliIo,
  sub: string | undefined,
  positionals: string[],
  opts: { format: OutputFormat }
): Promise<number> {
  if (!sub || sub === 'list') {
    const state = await runtime.call<AppState>('state:get')
    const counts = new Map<string, number>()
    for (const t of state.threads) {
      if (!t.archived) counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1)
    }
    const list = state.projects.map((p) => ({
      ...p,
      threadCount: counts.get(p.id) ?? 0
    }))
    if (opts.format === 'json' || opts.format === 'jsonl') {
      writeJson(io, list)
      return 0
    }
    if (!list.length) {
      io.stdout.write('No projects registered. Run "agent-desktop projects add ." to add the current folder.\n')
      return 0
    }
    for (const p of list) {
      io.stdout.write(`${p.id}  ${p.name}  (${p.threadCount} threads)  ${p.path}\n`)
    }
    return 0
  }

  if (sub === 'add') {
    const target = path.resolve(io.cwd(), positionals[0] ?? '.')
    const project = await runtime.call<Project>('project:add', target)
    if (opts.format === 'json' || opts.format === 'jsonl') {
      writeJson(io, project)
      return 0
    }
    io.stdout.write(`${project.id}  ${project.name}  ${project.path}\n`)
    return 0
  }

  throw new CliError(`Unknown "projects" subcommand: ${sub}. Expected "list" or "add".`, EXIT_USAGE)
}
