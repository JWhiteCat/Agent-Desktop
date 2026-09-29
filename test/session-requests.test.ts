import { describe, expect, it } from 'vitest'
import type { Item, QuestionAnswer, QuestionItem } from '../src/shared/types'
import {
  abandonQuestions,
  answerPendingQuestion,
  onAcpRequest,
  onIdleAcpRequest,
  settleQuestion,
  type InteractionRun
} from '../src/main/session/requests'

const questionParams = {
  toolCallId: 'ask-1',
  title: 'Choose an approach',
  questions: [{ id: 'approach', prompt: 'Which approach?', options: ['Small change', 'Full rewrite'] }]
}

const fallbackParams = {
  toolCall: { toolCallId: 'ask-fallback', title: 'Which approach?' },
  options: [
    { optionId: 'small', kind: 'allow_once', name: 'Small change' },
    { optionId: 'full', kind: 'allow_once', name: 'Full rewrite' },
    { optionId: '__ask_question_skip__', kind: 'reject_once', name: 'Skip' }
  ]
}

function setup(overrides: Partial<Pick<InteractionRun, 'proc' | 'acceptUpdates' | 'force' | 'mode'>> = {}) {
  const items: Item[] = []
  const batches: Item[][] = []
  const run: InteractionRun = {
    proc: { provider: 'cursor' },
    reducer: { push: (item) => { items.push(item); return item } },
    acceptUpdates: true,
    force: false,
    mode: 'agent',
    ...overrides
  }
  // Preserve each notification as the renderer received it, before later item mutations.
  const queue = (changed: Item[]) => { batches.push(structuredClone(changed)) }
  return { run, items, batches, queue }
}

function onlyQuestion(items: Item[]): QuestionItem {
  expect(items).toHaveLength(1)
  const item = items[0]
  if (item.kind !== 'question') throw new Error('Expected a question item')
  return item
}

describe('session request interactions', () => {
  it('publishes a pending question and updates the same history item when answered', async () => {
    const ctx = setup()
    const response = onAcpRequest(ctx.run, 'cursor/ask_question', questionParams, ctx.queue)
    const item = onlyQuestion(ctx.items)
    const pending = structuredClone(item)
    expect(item).toMatchObject({
      status: 'pending', toolCallId: 'ask-1', title: 'Choose an approach',
      questions: [{ id: 'approach', options: [{ id: 'o0', label: 'Small change' }, { id: 'o1', label: 'Full rewrite' }] }]
    })
    expect(ctx.run.pendingQuestion?.itemId).toBe(item.id)
    expect(ctx.batches).toEqual([[pending]])

    const answers: QuestionAnswer[] = [{ questionId: 'approach', selectedOptionIds: ['o0'] }]
    answerPendingQuestion(ctx.run, item.id, answers)

    await expect(response).resolves.toEqual({ outcome: { outcome: 'answered', answers } })
    expect(ctx.run.pendingQuestion).toBeUndefined()
    expect(ctx.items).toEqual([{ ...pending, status: 'answered', answers }])
    expect(ctx.items[0]).toBe(item)
    expect(ctx.batches).toEqual([[pending], [{ ...pending, status: 'answered', answers }]])
    expect(() => answerPendingQuestion(ctx.run, item.id, answers)).toThrow('这个问题已经不能回答了')
    expect(ctx.batches).toHaveLength(2)
  })

  it('rejects a stale question id without consuming the currently pending question', async () => {
    const ctx = setup()
    const response = onAcpRequest(ctx.run, 'cursor/ask_question', questionParams, ctx.queue)
    const item = onlyQuestion(ctx.items)

    expect(() => answerPendingQuestion(ctx.run, 'previous-question', null)).toThrow('这个问题已经不能回答了')
    expect(ctx.run.pendingQuestion?.itemId).toBe(item.id)
    expect(item.status).toBe('pending')
    expect(ctx.batches).toHaveLength(1)

    answerPendingQuestion(ctx.run, item.id, null)
    await expect(response).resolves.toMatchObject({ outcome: { outcome: 'skipped' } })
    expect(() => answerPendingQuestion(undefined, item.id, null)).toThrow('这个问题已经不能回答了')
  })

  it.each(['user skip', 'turn skip', 'turn cancel'] as const)('settles %s exactly once and releases the blocked request', async (action) => {
    const ctx = setup()
    const response = onAcpRequest(ctx.run, 'cursor/ask_question', questionParams, ctx.queue)
    const item = onlyQuestion(ctx.items)
    const pending = structuredClone(item)

    if (action === 'user skip') answerPendingQuestion(ctx.run, item.id, null)
    else settleQuestion(ctx.run, action === 'turn cancel' ? 'cancel' : 'skip')

    await expect(response).resolves.toEqual({
      outcome: action === 'turn cancel'
        ? { outcome: 'cancelled' }
        : { outcome: 'skipped', reason: '用户跳过了提问' }
    })
    expect(ctx.run.pendingQuestion).toBeUndefined()
    expect(item).toEqual({ ...pending, status: 'skipped' })
    expect(ctx.batches).toEqual([[pending], [{ ...pending, status: 'skipped' }]])
    settleQuestion(ctx.run, 'cancel')
    expect(ctx.batches).toHaveLength(2)
  })

  it.each(['cursor/ask_question', 'provider/custom_question'])('does not open %s during replay or while idle', async (method) => {
    const ctx = setup({ acceptUpdates: false })

    await expect(onAcpRequest(ctx.run, method, questionParams, ctx.queue)).resolves.toEqual({
      outcome: { outcome: 'skipped', reason: 'replay' }
    })
    await expect(onIdleAcpRequest({ force: false }, method, questionParams)).resolves.toEqual({
      outcome: { outcome: 'skipped', reason: 'idle' }
    })
    expect(ctx.run.pendingQuestion).toBeUndefined()
    expect(ctx.items).toEqual([])
    expect(ctx.batches).toEqual([])
  })

  it('skips unusable question payloads without leaving a blocked request', async () => {
    const ctx = setup()

    await expect(onAcpRequest(ctx.run, 'cursor/ask_question', {
      questions: [{ prompt: 'No choices', options: [] }, null]
    }, ctx.queue)).resolves.toMatchObject({ outcome: { outcome: 'skipped' } })
    expect(ctx.run.pendingQuestion).toBeUndefined()
    expect(ctx.items).toEqual([])
    expect(ctx.batches).toEqual([])
  })

  it('denies normal Claude Ask permissions even with force enabled, while allowing question answers', async () => {
    const ctx = setup({ proc: { provider: 'claude' }, mode: 'ask', force: true })
    await expect(onAcpRequest(ctx.run, 'session/request_permission', {
      options: [
        { optionId: 'always', kind: 'allow_always' },
        { optionId: 'once', kind: 'allow_once' },
        { optionId: 'deny', kind: 'reject_once' }
      ]
    }, ctx.queue)).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
    await expect(onAcpRequest(ctx.run, 'session/request_permission', {
      options: [{ optionId: 'allow', kind: 'allow_once' }]
    }, ctx.queue)).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(ctx.items).toEqual([])
    expect(ctx.batches).toEqual([])

    const response = onAcpRequest(ctx.run, 'session/request_permission', fallbackParams, ctx.queue)
    const item = onlyQuestion(ctx.items)
    expect(item).toMatchObject({
      status: 'pending', toolCallId: 'ask-fallback',
      questions: [{
        id: 'q', prompt: 'Which approach?', allowMultiple: false,
        options: [{ id: 'small', label: 'Small change' }, { id: 'full', label: 'Full rewrite' }]
      }]
    })
    answerPendingQuestion(ctx.run, item.id, [{ questionId: 'q', selectedOptionIds: ['full'] }])
    await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'full' } })
    expect(item.status).toBe('answered')
    expect(ctx.run.pendingQuestion).toBeUndefined()
    expect(ctx.batches).toHaveLength(2)
  })

  it.each(['skip', 'cancel'] as const)('maps fallback %s to the adapter skip option', async (decision) => {
    const ctx = setup({ proc: { provider: 'claude' }, mode: 'ask' })
    const response = onAcpRequest(ctx.run, 'session/request_permission', fallbackParams, ctx.queue)
    const item = onlyQuestion(ctx.items)

    settleQuestion(ctx.run, decision)

    await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId: '__ask_question_skip__' } })
    expect(item.status).toBe('skipped')
    expect(ctx.run.pendingQuestion).toBeUndefined()
  })

  it('handles fallback permissions during replay and idle without opening a question', async () => {
    const ctx = setup({ proc: { provider: 'claude' }, mode: 'ask', acceptUpdates: false })
    const automatic = { outcome: { outcome: 'selected', optionId: 'small' } }

    await expect(onAcpRequest(ctx.run, 'session/request_permission', fallbackParams, ctx.queue)).resolves.toEqual(automatic)
    await expect(onIdleAcpRequest({ force: false }, 'session/request_permission', fallbackParams)).resolves.toEqual(automatic)
    expect(ctx.run.pendingQuestion).toBeUndefined()
    expect(ctx.items).toEqual([])
    expect(ctx.batches).toEqual([])
  })

  it('closes only unanswered saved questions when abandoning history interactions', () => {
    const pending: QuestionItem = { id: 'pending', kind: 'question', toolCallId: 'old', status: 'pending', questions: [] }
    const answered: QuestionItem = { ...pending, id: 'answered', status: 'answered', answers: [] }
    const skipped: QuestionItem = { ...pending, id: 'skipped', status: 'skipped' }
    const notice: Item = { id: 'notice', kind: 'notice', level: 'info', text: 'History loaded' }
    const items: Item[] = [pending, answered, skipped, notice]

    expect(abandonQuestions(items)).toEqual([pending])
    expect(pending.status).toBe('skipped')
    expect(answered.status).toBe('answered')
    expect(answered.answers).toEqual([])
    expect(items).toEqual([pending, answered, skipped, notice])
    expect(abandonQuestions(items)).toEqual([])
  })

  it('rejects unknown methods with the JSON-RPC method-not-found error', async () => {
    const ctx = setup()
    const error = { code: -32601, message: 'Method not found: provider/unsupported' }

    await expect(onAcpRequest(ctx.run, 'provider/unsupported', {}, ctx.queue)).rejects.toMatchObject(error)
    await expect(onIdleAcpRequest({ force: false }, 'provider/unsupported', {})).rejects.toMatchObject(error)
    expect(ctx.run.pendingQuestion).toBeUndefined()
    expect(ctx.items).toEqual([])
    expect(ctx.batches).toEqual([])
  })
})
