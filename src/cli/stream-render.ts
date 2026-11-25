import type { Item, QuestionItem, ResultItem, ToolItem } from '@shared/types'
import type { CliIo, OutputFormat } from './types'

export interface StreamRendererOptions {
  format: OutputFormat
  quiet?: boolean
  showThinking?: boolean
  io: CliIo
  /** Item IDs that existed before this turn started, so we only stream new/updated items. */
  baselineIds?: Iterable<string>
  onQuestion?: (item: QuestionItem) => void
}

interface ToolState {
  status: ToolItem['status']
}

function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>
  for (const key of ['command', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url']) {
    const val = record[key]
    if (typeof val === 'string' && val.trim()) {
      const compact = val.replace(/\s+/g, ' ').trim()
      return compact.length > 72 ? `${compact.slice(0, 72)}…` : compact
    }
  }
  return ''
}

export class StreamRenderer {
  private readonly format: OutputFormat
  private readonly quiet: boolean
  private readonly showThinking: boolean
  private readonly io: CliIo
  private readonly onQuestion?: (item: QuestionItem) => void

  private readonly baselineIds: Set<string>
  private readonly assistantLen = new Map<string, number>()
  private readonly thinkingLen = new Map<string, number>()
  private readonly thinkingDone = new Set<string>()
  private readonly tools = new Map<string, ToolState>()
  private readonly seenNotices = new Set<string>()
  private readonly seenResults = new Set<string>()
  private readonly seenQuestions = new Set<string>()
  private inInlineLine = false
  private lastResult: ResultItem | undefined
  private lastAssistantText = ''
  private allItems: Item[] = []

  constructor(opts: StreamRendererOptions) {
    this.format = opts.format
    this.quiet = !!opts.quiet
    this.showThinking = !!opts.showThinking
    this.io = opts.io
    this.onQuestion = opts.onQuestion
    this.baselineIds = new Set(opts.baselineIds ?? [])
  }

  get result(): ResultItem | undefined {
    return this.lastResult
  }

  get assistantText(): string {
    return this.lastAssistantText
  }

  get items(): Item[] {
    return this.allItems
  }

  emitJsonl(event: Record<string, unknown>): void {
    if (this.format !== 'jsonl') return
    this.io.stdout.write(`${JSON.stringify(event)}\n`)
  }

  private breakInlineLine(): void {
    if (this.inInlineLine) {
      this.io.stdout.write('\n')
      this.inInlineLine = false
    }
  }

  onItems(items: Item[]): void {
    this.allItems = items
    for (const item of items) {
      if (this.baselineIds.has(item.id)) continue

      if (item.kind === 'thinking') {
        const prevLen = this.thinkingLen.get(item.id) ?? 0
        if (item.text.length > prevLen) {
          const delta = item.text.slice(prevLen)
          this.thinkingLen.set(item.id, item.text.length)
          if (this.format === 'jsonl') {
            this.emitJsonl({ type: 'thinking.delta', itemId: item.id, delta })
          } else if (this.format === 'text' && this.showThinking && !this.quiet) {
            if (prevLen === 0) {
              this.breakInlineLine()
              this.io.stderr.write('[thinking] ')
            }
            this.io.stderr.write(delta)
          }
        }
        if (item.done && !this.thinkingDone.has(item.id)) {
          this.thinkingDone.add(item.id)
          if (this.format === 'jsonl') {
            this.emitJsonl({ type: 'thinking.done', itemId: item.id })
          } else if (this.format === 'text' && this.showThinking && !this.quiet) {
            this.io.stderr.write('\n')
          }
        }
        continue
      }

      if (item.kind === 'assistant') {
        this.lastAssistantText = item.text
        const prevLen = this.assistantLen.get(item.id) ?? 0
        if (item.text.length > prevLen) {
          const delta = item.text.slice(prevLen)
          this.assistantLen.set(item.id, item.text.length)
          if (this.format === 'jsonl') {
            this.emitJsonl({ type: 'assistant.delta', itemId: item.id, delta })
          } else if (this.format === 'text') {
            this.io.stdout.write(delta)
            this.inInlineLine = !delta.endsWith('\n')
          }
        }
        continue
      }

      if (item.kind === 'tool') {
        const prev = this.tools.get(item.id)
        if (!prev || prev.status !== item.status) {
          this.tools.set(item.id, { status: item.status })
          if (this.format === 'jsonl') {
            this.emitJsonl({
              type: prev ? 'tool.update' : 'tool.start',
              itemId: item.id,
              tool: item.tool,
              status: item.status,
              args: item.args
            })
          } else if (this.format === 'text' && !this.quiet) {
            this.breakInlineLine()
            const summary = summarizeToolArgs(item.args)
            const suffix = summary ? ` ${summary}` : ''
            this.io.stderr.write(`[tool:${item.status}] ${item.tool}${suffix}\n`)
          }
        }
        continue
      }

      if (item.kind === 'notice') {
        if (!this.seenNotices.has(item.id)) {
          this.seenNotices.add(item.id)
          if (this.format === 'jsonl') {
            this.emitJsonl({ type: 'notice', itemId: item.id, level: item.level, text: item.text })
          } else if (this.format === 'text' && (!this.quiet || item.level === 'error')) {
            this.breakInlineLine()
            this.io.stderr.write(`[${item.level}] ${item.text}\n`)
          }
        }
        continue
      }

      if (item.kind === 'question') {
        if (item.status === 'pending' && !this.seenQuestions.has(item.id)) {
          this.seenQuestions.add(item.id)
          if (this.format === 'jsonl') {
            this.emitJsonl({
              type: 'question',
              itemId: item.id,
              title: item.title,
              questions: item.questions
            })
          }
          this.onQuestion?.(item)
        }
        continue
      }

      if (item.kind === 'result') {
        this.lastResult = item
        if (!this.seenResults.has(item.id)) {
          this.seenResults.add(item.id)
          if (this.format === 'jsonl') {
            this.emitJsonl({
              type: 'result',
              itemId: item.id,
              isError: item.isError,
              durationMs: item.durationMs,
              fileChanges: item.fileChanges?.map((f) => f.path) ?? [],
              usage: item.usage
            })
          }
        }
      }
    }
  }

  finishTextSummary(): void {
    if (this.format !== 'text') return
    this.breakInlineLine()
    if (this.quiet || !this.lastResult) return
    const parts: string[] = []
    if (this.lastResult.durationMs !== undefined) {
      parts.push(`${(this.lastResult.durationMs / 1000).toFixed(1)}s`)
    }
    const files = this.lastResult.fileChanges?.length ?? 0
    if (files > 0) parts.push(`${files} file${files === 1 ? '' : 's'} changed`)
    if (this.lastResult.isError) parts.push('failed')
    if (parts.length > 0) {
      this.io.stderr.write(`[done] ${parts.join(' · ')}\n`)
    }
  }
}
