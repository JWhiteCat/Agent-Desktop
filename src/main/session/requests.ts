import type { AgentMode, CliProvider, Item, QuestionAnswer, QuestionItem } from '@shared/types'
import { normalizeQuestions } from '@shared/questions'
import { MethodNotFound, permissionResult } from '../acp'
import { newId } from '../id'
import type { StreamReducer } from '../reducer'

interface PendingQuestion {
  itemId: string
  resolve: (decision: QuestionAnswer[] | 'skip' | 'cancel') => void
}

type QueueItems = (items: Item[]) => void

/** Only the turn state needed for ACP questions and permission decisions. */
export interface InteractionRun {
  proc: { provider: CliProvider }
  reducer: Pick<StreamReducer, 'push'>
  /** Ignore session/update events while session/load replays history. */
  acceptUpdates: boolean
  pendingQuestion?: PendingQuestion
  force: boolean
  mode: AgentMode
}

export function answerPendingQuestion(run: InteractionRun | undefined, questionId: string, answers: QuestionAnswer[] | null): void {
  const pending = run?.pendingQuestion
  if (!run || !pending || pending.itemId !== questionId) throw new Error('这个问题已经不能回答了')
  run.pendingQuestion = undefined
  pending.resolve(answers ?? 'skip')
}

export function onIdleAcpRequest(proc: { force: boolean }, method: string, params: any): Promise<unknown> {
  if (method === 'cursor/ask_question' || isQuestionParams(params)) return Promise.resolve({ outcome: { outcome: 'skipped', reason: 'idle' } })
  if (method === 'cursor/create_plan') return Promise.resolve({ outcome: { outcome: 'accepted' } })
  if (method === 'session/request_permission') {
    const options: { optionId?: string; kind?: string }[] = Array.isArray(params?.options) ? params.options : []
    return Promise.resolve(permissionResult(options, proc.force))
  }
  return Promise.reject(new MethodNotFound(method))
}

export function onAcpRequest(run: InteractionRun, method: string, params: any, queue: QueueItems): Promise<unknown> {
  if (method === 'cursor/ask_question' || isQuestionParams(params)) return answerAskQuestion(run, params, queue)
  if (method === 'cursor/create_plan') return Promise.resolve({ outcome: { outcome: 'accepted' } })
  if (method === 'session/request_permission') return answerPermission(run, params, queue)
  return Promise.reject(new MethodNotFound(method))
}

async function answerAskQuestion(run: InteractionRun, params: any, queue: QueueItems): Promise<unknown> {
  if (!run.acceptUpdates) return { outcome: { outcome: 'skipped', reason: 'replay' } }
  const questions = normalizeQuestions(params?.questions)
  const decision = await waitForAnswers(run, {
    toolCallId: String(params?.toolCallId ?? ''),
    title: typeof params?.title === 'string' ? params.title : undefined,
    questions
  }, queue)
  if (decision === 'cancel') return { outcome: { outcome: 'cancelled' } }
  if (decision === 'skip') return { outcome: { outcome: 'skipped', reason: '用户跳过了提问' } }
  return { outcome: { outcome: 'answered', answers: decision } }
}

async function answerPermission(run: InteractionRun, params: any, queue: QueueItems): Promise<unknown> {
  const options: { optionId?: string; kind?: string; name?: string }[] = Array.isArray(params?.options) ? params.options : []
  const askFallback = options.some((o) => o.optionId === '__ask_question_skip__')
  if (run.proc.provider === 'claude' && run.mode === 'ask' && !askFallback) return permissionResult(options, false, true)
  if (!askFallback || !run.acceptUpdates) return permissionResult(options, run.force)
  const decision = await waitForAnswers(run, {
    toolCallId: String(params?.toolCall?.toolCallId ?? ''),
    title: typeof params?.toolCall?.title === 'string' ? params.toolCall.title : undefined,
    questions: [
      {
        id: 'q',
        prompt: String(params?.toolCall?.title || params?.toolCall?.content?.[0]?.content?.text || '请选择'),
        allowMultiple: false,
        options: options
          .filter((o) => o.optionId && o.optionId !== '__ask_question_skip__')
          .map((o) => ({ id: String(o.optionId), label: String(o.name || o.optionId) }))
      }
    ]
  }, queue)
  if (decision === 'cancel' || decision === 'skip') {
    return { outcome: { outcome: 'selected', optionId: '__ask_question_skip__' } }
  }
  const optionId = decision[0]?.selectedOptionIds[0]
  return { outcome: { outcome: 'selected', optionId: optionId || '__ask_question_skip__' } }
}

function waitForAnswers(
  run: InteractionRun,
  spec: Pick<QuestionItem, 'toolCallId' | 'title' | 'questions'>,
  queue: QueueItems
): Promise<QuestionAnswer[] | 'skip' | 'cancel'> {
  if (spec.questions.length === 0) return Promise.resolve('skip')
  const item: QuestionItem = { id: newId(), kind: 'question', status: 'pending', ...spec }
  run.reducer.push(item)
  queue([item])
  return new Promise((resolve) => {
    run.pendingQuestion = {
      itemId: item.id,
      resolve: (decision) => {
        if (decision === 'cancel' || decision === 'skip') item.status = 'skipped'
        else {
          item.status = 'answered'
          item.answers = decision
        }
        queue([item])
        resolve(decision)
      }
    }
  })
}

export function settleQuestion(run: InteractionRun, decision: 'skip' | 'cancel'): void {
  const pending = run.pendingQuestion
  if (!pending) return
  run.pendingQuestion = undefined
  pending.resolve(decision)
}

function isQuestionParams(params: any): boolean {
  return Array.isArray(params?.questions) && params.questions.some((q: any) => q && typeof q === 'object' && ('prompt' in q || 'options' in q))
}

export function abandonQuestions(items: Item[]): Item[] {
  const changed: Item[] = []
  for (const it of items) {
    if (it.kind === 'question' && it.status === 'pending') {
      it.status = 'skipped'
      changed.push(it)
    }
  }
  return changed
}
