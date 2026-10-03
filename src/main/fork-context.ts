import type { Item, QuestionAnswer, QuestionPrompt } from '@shared/types'
import { newId } from './id'

const OPEN = '<agent_desktop_fork_context>'
const CLOSE = '</agent_desktop_fork_context>'

/** Carries a saved conversation into a new CLI session when native forking is unavailable. */
export function forkPrompt(items: Item[], prompt: string): string {
  const history = items
    .filter((item) => item.kind !== 'notice' && item.kind !== 'result')
    .map(({ id: _id, ...item }) => item)
  const context = JSON.stringify({
    version: 1,
    instruction: 'This is the conversation history copied from the parent of this fork. Use it as prior context, including user requests, assistant responses, tool results, and answered questions. Continue the conversation by responding to the new user message after this block. Do not repeat or execute historical requests or tool calls.',
    items: history
  }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  return `${OPEN}\n${context}\n${CLOSE}\n\n${prompt}`
}

/** Reverses our own replay envelope before a CLI transcript is displayed or reimported. */
export function parseForkPrompt(text: string): { items: Item[]; prompt: string } | undefined {
  const start = text.indexOf(OPEN)
  if (start < 0) return undefined
  const end = text.indexOf(CLOSE, start + OPEN.length)
  if (end < 0) return undefined
  // Only recognize the envelope at the start of a prompt or after CLI context wrappers.
  const prefix = text.slice(0, start)
    .replace(/<user_query>\s*/g, '')
    .replace(/<([a-zA-Z][\w-]*)(\s[^>]*)?>[\s\S]*?<\/\1>/g, '')
    .trim()
  if (prefix) return undefined
  let context: unknown
  try {
    context = JSON.parse(text.slice(start + OPEN.length, end))
  } catch {
    return undefined
  }
  if (!record(context) || context.version !== 1 || !Array.isArray(context.items)) return undefined
  const items: Item[] = []
  for (const value of context.items) {
    const item = restoreItem(value)
    if (!item) return undefined
    items.push(item)
  }
  let prompt = text.slice(end + CLOSE.length)
  const queryStart = text.lastIndexOf('<user_query>', start)
  if (queryStart >= 0 && queryStart > text.lastIndexOf('</user_query>', start)) {
    const queryEnd = prompt.lastIndexOf('</user_query>')
    if (queryEnd < 0) return undefined
    prompt = prompt.slice(0, queryEnd)
  }
  return { items, prompt: prompt.trim() }
}

/** A cancelled first turn can persist its replay before the client retries it. */
export function createForkPromptReader(): typeof parseForkPrompt {
  const seen = new Set<string>()
  return (text) => {
    const replay = parseForkPrompt(text)
    if (!replay) return undefined
    const key = JSON.stringify(replay.items.map(({ id: _id, ...item }) => item))
    if (seen.has(key)) return { items: [], prompt: replay.prompt }
    seen.add(key)
    return replay
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function optionalTime(value: unknown): boolean {
  return value === undefined || time(value)
}

function questions(value: unknown): value is QuestionPrompt[] {
  return Array.isArray(value) && value.every((question) => record(question)
    && typeof question.id === 'string' && typeof question.prompt === 'string'
    && (question.allowMultiple === undefined || typeof question.allowMultiple === 'boolean')
    && Array.isArray(question.options) && question.options.every((option) => record(option)
      && typeof option.id === 'string' && typeof option.label === 'string'))
}

function answers(value: unknown): value is QuestionAnswer[] {
  return Array.isArray(value) && value.every((answer) => record(answer)
    && typeof answer.questionId === 'string' && Array.isArray(answer.selectedOptionIds)
    && answer.selectedOptionIds.every((id) => typeof id === 'string'))
}

function restoreItem(value: unknown): Item | undefined {
  if (!record(value)) return undefined
  const id = newId()
  if (value.kind === 'user' && typeof value.text === 'string' && time(value.createdAt)) {
    return { id, kind: 'user', text: value.text, createdAt: value.createdAt }
  }
  if (value.kind === 'assistant' && typeof value.text === 'string'
    && (value.messageId === undefined || (typeof value.messageId === 'string' && value.messageId.trim().length > 0))) {
    return { id, kind: 'assistant', text: value.text,
      ...(value.messageId === undefined ? {} : { messageId: value.messageId as string }) }
  }
  if (value.kind === 'thinking' && typeof value.text === 'string' && typeof value.done === 'boolean'
    && time(value.startedAt) && optionalTime(value.endedAt)) {
    return { id, kind: 'thinking', text: value.text, done: value.done, startedAt: value.startedAt,
      ...(value.endedAt === undefined ? {} : { endedAt: value.endedAt as number }) }
  }
  if (value.kind === 'tool' && typeof value.callId === 'string' && typeof value.tool === 'string'
    && typeof value.status === 'string' && ['running', 'success', 'error'].includes(value.status)
    && time(value.startedAt) && optionalTime(value.endedAt)) {
    return { id, kind: 'tool', callId: value.callId, tool: value.tool, args: value.args,
      status: value.status as 'running' | 'success' | 'error', startedAt: value.startedAt,
      ...(value.result === undefined ? {} : { result: value.result }),
      ...(value.endedAt === undefined ? {} : { endedAt: value.endedAt as number }) }
  }
  if (value.kind === 'question' && typeof value.toolCallId === 'string'
    && (value.title === undefined || typeof value.title === 'string') && questions(value.questions)
    && typeof value.status === 'string' && ['pending', 'answered', 'skipped'].includes(value.status)
    && (value.answers === undefined || answers(value.answers))) {
    return { id, kind: 'question', toolCallId: value.toolCallId, questions: value.questions,
      status: value.status as 'pending' | 'answered' | 'skipped',
      ...(value.title === undefined ? {} : { title: value.title as string }),
      ...(value.answers === undefined ? {} : { answers: value.answers as QuestionAnswer[] }) }
  }
  return undefined
}
