import { t as translate } from '@shared/i18n'
import type { AgentMode, CliProvider, Item, QuestionAnswer, QuestionItem, QuestionPrompt } from '@shared/types'
import { normalizeQuestions } from '@shared/questions'
import { MethodNotFound, permissionResult } from '../acp'
import { newId } from '../id'
import type { StreamReducer } from '../reducer'

interface PendingQuestion {
  questions: QuestionPrompt[]
  resolve: (decision: QuestionAnswer[] | 'skip' | 'cancel') => void
}

type QueueItems = (items: Item[]) => void

/** Only the turn state needed for ACP questions and permission decisions. */
export interface InteractionRun {
  proc: { provider: CliProvider }
  reducer: Pick<StreamReducer, 'push'>
  /** Ignore session/update events while session/load replays history. */
  acceptUpdates: boolean
  pendingQuestions?: Map<string, PendingQuestion>
  /** Turn cancellation also prevents a late CLI request from reopening a card. */
  questionsClosed?: boolean
  force: boolean
  mode: AgentMode
}

export function answerPendingQuestion(run: InteractionRun | undefined, questionId: string, answers: QuestionAnswer[] | null): void {
  const pending = run?.pendingQuestions?.get(questionId)
  if (!run || !pending) throw new Error(translate('这个问题已经不能回答了'))
  if (answers !== null && !validAnswers(pending.questions, answers)) throw new Error(translate('请选择'))
  run.pendingQuestions!.delete(questionId)
  pending.resolve(answers ?? 'skip')
}

export function onIdleAcpRequest(_proc: { force: boolean }, method: string, params: any): Promise<unknown> {
  if (method === 'session/request_permission') return Promise.resolve(cancelledPermission())
  if (method === 'cursor/ask_question' || isQuestionParams(params)) return Promise.resolve({ outcome: { outcome: 'skipped', reason: 'idle' } })
  if (method === 'cursor/create_plan') return Promise.resolve({ outcome: { outcome: 'accepted' } })
  return Promise.reject(new MethodNotFound(method))
}

export function onAcpRequest(run: InteractionRun, method: string, params: any, queue: QueueItems): Promise<unknown> {
  if (method === 'session/request_permission') return answerPermission(run, params, queue)
  if (method === 'cursor/ask_question' || isQuestionParams(params)) return answerAskQuestion(run, params, queue)
  if (method === 'cursor/create_plan') return Promise.resolve({ outcome: { outcome: 'accepted' } })
  return Promise.reject(new MethodNotFound(method))
}

async function answerAskQuestion(run: InteractionRun, params: any, queue: QueueItems): Promise<unknown> {
  if (run.questionsClosed) return { outcome: { outcome: 'cancelled' } }
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
  if (!run.acceptUpdates || run.questionsClosed) return cancelledPermission()
  const seen = new Set<string>()
  const options: { optionId: string; kind: string; name?: string }[] = (Array.isArray(params?.options) ? params.options : [])
    .filter((option: any) => {
      if (!option || typeof option.optionId !== 'string' || !option.optionId.trim() || seen.has(option.optionId)) return false
      if (!['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(option.kind)) return false
      seen.add(option.optionId)
      return true
    })
  const askFallback = options.some((o) => o.optionId === '__ask_question_skip__')
  if (run.proc.provider === 'claude' && run.mode === 'ask' && !askFallback) return permissionResult(options, false, true)
  const kind = params?.toolCall?.kind
  const readOnlyViolation = (run.mode !== 'agent' && ['edit', 'delete', 'move'].includes(kind))
    || (run.mode === 'ask' && kind === 'switch_mode')
  if (!askFallback && readOnlyViolation) {
    return permissionResult(options, false, true)
  }
  // A Plan switch can complete the plan tool (Claude's ExitPlanMode). Ask the
  // user; session notifications restore Plan mode after an approved switch.
  // Claude applies bypassPermissions before sending requests. Those that still
  // reach the client explicitly require user input, even with full access on.
  if (!askFallback && run.force && run.mode === 'agent' && run.proc.provider !== 'claude') return permissionResult(options, true)
  const choices = options.filter((o) => o.optionId !== '__ask_question_skip__')
  if (!choices.length) return cancelledPermission()
  const decision = await waitForAnswers(run, {
    toolCallId: String(params?.toolCall?.toolCallId ?? ''),
    title: typeof params?.toolCall?.title === 'string' ? params.toolCall.title : undefined,
    questions: [
      {
        id: 'q',
        prompt: String(params?.toolCall?.title || params?.toolCall?.content?.[0]?.content?.text || translate('请选择')),
        allowMultiple: false,
        options: choices
          .map((o) => ({ id: String(o.optionId), label: String(o.name || o.optionId) }))
      }
    ]
  }, queue)
  if (decision === 'cancel' || decision === 'skip') {
    return askFallback ? { outcome: { outcome: 'selected', optionId: '__ask_question_skip__' } } : cancelledPermission()
  }
  return { outcome: { outcome: 'selected', optionId: decision[0].selectedOptionIds[0] } }
}

function cancelledPermission(): { outcome: { outcome: 'cancelled' } } {
  return { outcome: { outcome: 'cancelled' } }
}

/** Native ACP cards contain fixed choices; reject malformed or forged answers without consuming the request. */
function validAnswers(questions: QuestionPrompt[], answers: unknown): answers is QuestionAnswer[] {
  if (!Array.isArray(answers) || answers.length !== questions.length) return false
  const seen = new Set<string>()
  return answers.every((answer) => {
    const question = questions.find((q) => q.id === answer?.questionId)
    if (!question || seen.has(question.id) || answer.otherText !== undefined) return false
    seen.add(question.id)
    const ids: unknown = answer.selectedOptionIds
    return Array.isArray(ids) && ids.length > 0 && (question.allowMultiple || ids.length === 1)
      && new Set(ids).size === ids.length && ids.every((id) => question.options.some((option) => option.id === id))
  })
}

function waitForAnswers(
  run: InteractionRun,
  spec: Pick<QuestionItem, 'toolCallId' | 'title' | 'questions'>,
  queue: QueueItems
): Promise<QuestionAnswer[] | 'skip' | 'cancel'> {
  if (run.questionsClosed) return Promise.resolve('cancel')
  if (spec.questions.length === 0) return Promise.resolve('skip')
  const item: QuestionItem = { id: newId(), kind: 'question', status: 'pending', ...spec }
  run.reducer.push(item)
  return new Promise((resolve) => {
    run.pendingQuestions ??= new Map()
    run.pendingQuestions.set(item.id, {
      questions: item.questions,
      resolve: (decision) => {
        if (decision === 'cancel' || decision === 'skip') item.status = 'skipped'
        else {
          item.status = 'answered'
          item.answers = decision
        }
        queue([item])
        resolve(decision)
      }
    })
    queue([item])
  })
}

export function settleQuestion(run: InteractionRun, decision: 'skip' | 'cancel'): void {
  run.questionsClosed = true
  const pending = [...(run.pendingQuestions?.values() ?? [])]
  run.pendingQuestions?.clear()
  for (const question of pending) question.resolve(decision)
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
