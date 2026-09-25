import type { ToolItem } from '@shared/types'
import { basename } from './format'

export type ToolKind = 'read' | 'edit' | 'shell' | 'search' | 'list' | 'delete' | 'todo' | 'web' | 'mcp' | 'task' | 'other'

export interface ToolSummary {
  kind: ToolKind
  verb: string
  target?: string
  meta?: string
  added?: number
  removed?: number
}

const pick = (o: any, ...keys: string[]): any => {
  for (const k of keys) if (o?.[k] !== undefined && o[k] !== '') return o[k]
  return undefined
}

export function successOf(item: ToolItem): any {
  return item.result?.success
}

export function errorOf(item: ToolItem): string | undefined {
  const r = item.result
  if (!r || r.success !== undefined) return undefined
  const e = r.error ?? r.failure ?? r.rejected
  if (!e) return undefined
  if (typeof e === 'string') return e
  return pick(e, 'message', 'error', 'reason', 'errorMessage') ?? JSON.stringify(e)
}

/** ApplyPatch receives the raw patch text instead of an args object. */
function patchPath(args: unknown): string | undefined {
  return typeof args === 'string' ? args.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)?.[1]?.trim() : undefined
}

export function summarizeTool(item: ToolItem): ToolSummary {
  const a = typeof item.args === 'object' && item.args ? item.args : {}
  const s = successOf(item) ?? {}
  const running = item.status === 'running'
  const path = pick(a, 'path', 'targetFile', 'filePath', 'file', 'targetDirectory', 'target_directory', 'directory') ?? patchPath(item.args)
  const name = item.tool.toLowerCase().replace(/[^a-z]/g, '')

  if (name === 'read' || name === 'readfile') {
    const range = s.readRange ? `L${s.readRange.startLine}-${s.readRange.endLine}` : undefined
    return { kind: 'read', verb: running ? '正在读取' : '已读取', target: path && basename(path), meta: range }
  }
  if (['edit', 'write', 'searchreplace', 'strreplace', 'multiedit', 'applypatch'].includes(name)) {
    return {
      kind: 'edit',
      verb: running ? '正在编辑' : s.linesRemoved === 0 && s.diffString?.startsWith('--- /dev/null') ? '已创建' : '已编辑',
      target: path && basename(path),
      added: s.linesAdded,
      removed: s.linesRemoved
    }
  }
  if (name === 'shell' || name === 'terminal' || name === 'runterminalcommand') {
    const exit = s.exitCode
    return {
      kind: 'shell',
      verb: running ? '正在运行' : '已运行',
      target: pick(a, 'command', 'cmd'),
      meta: exit !== undefined && exit !== 0 ? `退出码 ${exit}` : undefined
    }
  }
  if (name === 'glob') {
    return { kind: 'search', verb: running ? '正在查找文件' : '已查找文件', target: pick(a, 'globPattern', 'glob_pattern', 'pattern'), meta: s.totalFiles !== undefined ? `${s.totalFiles} 个结果` : undefined }
  }
  if (['grep', 'rg', 'search', 'codebasesearch', 'semanticsearch'].includes(name)) {
    return { kind: 'search', verb: running ? '正在搜索' : '已搜索', target: pick(a, 'pattern', 'query', 'regex') }
  }
  if (name === 'ls' || name === 'listdir') {
    return { kind: 'list', verb: running ? '正在列出' : '已列出', target: path && basename(path) }
  }
  if (name === 'delete') {
    return { kind: 'delete', verb: running ? '正在删除' : '已删除', target: path && basename(path) }
  }
  if (name.includes('todo')) {
    const todos = pick(a, 'todos', 'items')
    return { kind: 'todo', verb: '更新待办', meta: Array.isArray(todos) ? `${todos.length} 项` : undefined }
  }
  if (name.includes('web') || name.includes('fetch')) {
    return { kind: 'web', verb: name.includes('fetch') ? '获取网页' : '搜索网页', target: pick(a, 'url', 'query', 'searchTerm', 'search_term') }
  }
  if (name.includes('mcp') || name === 'calldynamictool' || name === 'getdynamictools' || name.startsWith('plugin')) {
    const target = [pick(a, 'providerIdentifier', 'server', 'serverName', 'namespace'), pick(a, 'toolName', 'name')].filter(Boolean).join(' · ')
    return { kind: 'mcp', verb: name === 'getdynamictools' ? '查询工具' : '调用工具', target: target || item.tool }
  }
  if (name === 'await' || name === 'awaitshell') {
    return { kind: 'shell', verb: running ? '等待命令' : '已等待命令', target: pick(a, 'shell_id', 'shellId', 'task_id') }
  }
  if (name === 'askquestion') {
    return { kind: 'other', verb: '提问', target: pick(a, 'title') ?? (Array.isArray(a.questions) ? a.questions[0]?.prompt : undefined) }
  }
  if (name === 'createplan') {
    return { kind: 'todo', verb: '制定计划', target: pick(a, 'name', 'overview') }
  }
  if (name.includes('task') || name.includes('agent')) {
    return { kind: 'task', verb: running ? '子代理运行中' : '子代理完成', target: pick(a, 'description', 'prompt') }
  }
  return { kind: 'other', verb: item.tool, target: path ? basename(path) : undefined }
}

export function toolDiff(item: ToolItem): string | undefined {
  const s = successOf(item)
  return typeof s?.diffString === 'string' ? s.diffString : undefined
}

/** CreatePlan reports the saved file as progress text: `Plan saved to file:///…plan.md`. */
export function planUriOf(item: ToolItem): string | undefined {
  const r = item.result
  const text = [successOf(item)?.stdout, typeof r === 'string' ? r : undefined, item.args?.planUri].filter((s) => typeof s === 'string').join('\n')
  return text.match(/(file:\/\/\S+?\.plan\.md|[A-Za-z]:[\\/]\S+?\.plan\.md|\/\S+?\.plan\.md)/)?.[1]
}

export function planPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri
  const p = decodeURIComponent(uri.replace(/^file:\/\//, ''))
  return /^\/[A-Za-z]:/.test(p) ? p.slice(1).replace(/\//g, '\\') : p
}

export function toolPath(item: ToolItem): string | undefined {
  return pick(item.args ?? {}, 'path', 'targetFile', 'filePath', 'file') ?? patchPath(item.args) ?? successOf(item)?.path
}
