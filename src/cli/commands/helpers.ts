import fs from 'node:fs'
import path from 'node:path'
import type { AttachmentRef, AttachmentUpload } from '@shared/attachments'
import { isCliProvider, normalizeCliProvider, type AgentMode, type AppState, type CliProvider, type Project, type Settings } from '@shared/types'
import { pathKey } from '../../main/local-files'
import { CliError, EXIT_USAGE, type CliIo, type CliRuntime, type OutputFormat } from '../types'

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.js': 'text/plain',
  '.jsx': 'text/plain',
  '.py': 'text/plain',
  '.sh': 'text/plain',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.css': 'text/css'
}

export function guessMimeType(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

export function defaultModelForProvider(settings: Settings, provider: CliProvider): string {
  if (provider === 'codex') return settings.codexDefaultModel || ''
  if (provider === 'claude') return settings.claudeDefaultModel || ''
  if (provider === 'antigravity') return settings.antigravityDefaultModel || ''
  return settings.defaultModel || 'auto'
}

export function parseProvider(raw: string | undefined, fallback: CliProvider): CliProvider {
  if (!raw) return normalizeCliProvider(fallback)
  if (!isCliProvider(raw)) {
    throw new CliError(`Invalid --cli value "${raw}". Expected one of: cursor, codex, claude, antigravity.`, EXIT_USAGE)
  }
  return raw
}

export function parseMode(raw: string | undefined, fallback: AgentMode): AgentMode {
  if (!raw) return fallback
  if (raw === 'agent' || raw === 'plan' || raw === 'ask') return raw
  throw new CliError(`Invalid --mode value "${raw}". Expected one of: agent, plan, ask.`, EXIT_USAGE)
}

export function findProject(projects: Project[], selector: string, cwd: string): Project | undefined {
  const byId = projects.find((p) => p.id === selector)
  if (byId) return byId
  const target = pathKey(path.resolve(cwd, selector))
  const exact = projects.find((p) => pathKey(path.resolve(p.path)) === target)
  if (exact) return exact
  // Prefix match: find deepest project containing the target directory.
  const containing = projects
    .filter((p) => {
      const root = pathKey(path.resolve(p.path))
      const sep = process.platform === 'win32' ? '\\' : '/'
      return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
    })
    .sort((a, b) => b.path.length - a.path.length)
  return containing[0]
}

export async function resolveOrCreateProject(
  runtime: CliRuntime,
  state: AppState,
  selector: string | undefined,
  cwd: string,
  allowCreate: boolean
): Promise<Project> {
  const ref = selector ?? cwd
  const existing = findProject(state.projects, ref, cwd)
  if (existing) return existing

  const candidateDir = path.resolve(cwd, ref)
  if (!fs.existsSync(candidateDir) || !fs.statSync(candidateDir).isDirectory()) {
    throw new CliError(`Project not found and path is not an existing directory: ${ref}`, EXIT_USAGE)
  }
  if (!allowCreate) {
    throw new CliError(`Project not registered: ${candidateDir}. Run "agent-desktop projects add ${candidateDir}" first.`, EXIT_USAGE)
  }
  return runtime.call<Project>('project:add', candidateDir)
}

export async function uploadLocalFiles(runtime: CliRuntime, files: string[], cwd: string): Promise<string[]> {
  const ids: string[] = []
  for (const raw of files) {
    const resolved = path.resolve(cwd, raw)
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new CliError(`Attachment file not found: ${resolved}`, EXIT_USAGE)
    }
    const bytes = fs.readFileSync(resolved)
    const upload: AttachmentUpload = {
      name: path.basename(resolved),
      mimeType: guessMimeType(resolved),
      data: bytes.toString('base64')
    }
    const ref = await runtime.call<AttachmentRef>('attachment:upload', upload)
    ids.push(ref.id)
  }
  return ids
}

export async function readStdinText(io: CliIo): Promise<string> {
  if (io.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of io.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function writeJson(io: CliIo, value: unknown, format: OutputFormat = 'json'): void {
  const serialized = format === 'jsonl' ? JSON.stringify(value) : JSON.stringify(value, null, 2)
  io.stdout.write(`${serialized}\n`)
}
