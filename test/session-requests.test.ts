import { describe, expect, it } from 'vitest'
import type { Item, QuestionAnswer, QuestionItem, ToolItem } from '../src/shared/types'
import { StreamReducer } from '../src/main/reducer'
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

const permissionParams = {
  toolCall: { toolCallId: 'shell-command', title: 'npm install', kind: 'execute' },
  options: [
    { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
    { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
    { optionId: 'deny', kind: 'reject_once', name: 'Reject' }
  ]
}

const planReviewParams = {
  toolCall: {
    toolCallId: 'plan-review:plan-1', title: 'Implement this plan?', kind: 'switch_mode',
    rawInput: { plan: '# Plan\n\nUpdate the settings.' }
  },
  options: [
    { optionId: 'implement_plan', name: 'Yes, implement this plan', kind: 'allow_once' },
    { optionId: 'revise_plan', name: 'No, and tell Codex what to do differently', kind: 'reject_once' }
  ],
  _meta: { codex: { kind: 'plan_review', planItemId: 'plan-1' } }
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
  it.each(['cursor', 'codex', 'claude'] as const)('waits for an explicit %s permission decision without full access', async (provider) => {
    const ctx = setup({ proc: { provider } })
    let resolved = false
    const response = onAcpRequest(ctx.run, 'session/request_permission', permissionParams, ctx.queue).then((result) => {
      resolved = true
      return result
    })
    await Promise.resolve()
    const item = onlyQuestion(ctx.items)
    expect(resolved).toBe(false)
    expect(item).toMatchObject({
      toolCallId: 'shell-command', title: 'npm install', status: 'pending',
      questions: [{ id: 'q', prompt: 'npm install', options: [
        { id: 'once', label: 'Allow once' }, { id: 'always', label: 'Always allow' }, { id: 'deny', label: 'Reject' }
      ] }]
    })
    answerPendingQuestion(ctx.run, item.id, [{ questionId: 'q', selectedOptionIds: ['once'] }])
    await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(item.status).toBe('answered')
    expect(ctx.run.pendingQuestions?.size).toBe(0)
  })

  it.each(['always', 'deny'])('returns the explicit %s choice unchanged', async (optionId) => {
    const ctx = setup()
    const response = onAcpRequest(ctx.run, 'session/request_permission', permissionParams, ctx.queue)
    answerPendingQuestion(ctx.run, onlyQuestion(ctx.items).id, [{ questionId: 'q', selectedOptionIds: [optionId] }])
    await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId } })
  })

  it.each(['cursor', 'codex'] as const)('automatically approves %s Agent permissions with full access', async (provider) => {
    const ctx = setup({ proc: { provider }, force: true })
    await expect(onAcpRequest(ctx.run, 'session/request_permission', permissionParams, ctx.queue))
      .resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'always' } })
    expect(ctx.items).toEqual([])
  })

  it('still confirms a Claude request that reached the client in bypass mode', async () => {
    const ctx = setup({ proc: { provider: 'claude' }, force: true })
    const response = onAcpRequest(ctx.run, 'session/request_permission', permissionParams, ctx.queue)
    answerPendingQuestion(ctx.run, onlyQuestion(ctx.items).id, [{ questionId: 'q', selectedOptionIds: ['deny'] }])
    await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
  })

  it.each(['ask', 'plan'] as const)('does not auto-approve a %s request just because full access is selected', async (mode) => {
    const ctx = setup({ proc: { provider: 'codex' }, force: true, mode })
    const response = onAcpRequest(ctx.run, 'session/request_permission', permissionParams, ctx.queue)
    answerPendingQuestion(ctx.run, onlyQuestion(ctx.items).id, null)
    await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it.each(['cursor', 'codex', 'claude'] as const)('keeps explicit write requests out of %s read-only modes', async (provider) => {
    for (const mode of ['ask', 'plan'] as const) {
      for (const kind of ['edit', 'delete', 'move']) {
        const ctx = setup({ proc: { provider }, force: true, mode })
        await expect(onAcpRequest(ctx.run, 'session/request_permission', {
          ...permissionParams, toolCall: { ...permissionParams.toolCall, kind }
        }, ctx.queue)).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
        expect(ctx.items).toEqual([])
      }
    }
  })

  it.each(['cursor', 'codex', 'claude'] as const)('rejects %s mode switches in Ask mode', async (provider) => {
    const ctx = setup({ proc: { provider }, mode: 'ask', force: true })
    await expect(onAcpRequest(ctx.run, 'session/request_permission', {
      ...permissionParams, toolCall: { ...permissionParams.toolCall, kind: 'switch_mode' }
    }, ctx.queue)).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
    expect(ctx.items).toEqual([])
  })

  it.each([false, true])('waits for approval before completing a Claude plan with force=%s', async (force) => {
    const ctx = setup({ proc: { provider: 'claude' }, mode: 'plan', force })
    const reducer = new StreamReducer(ctx.items)
    ctx.run.reducer = reducer
    const toolCall = {
      toolCallId: 'exit-plan', title: 'ExitPlanMode', kind: 'switch_mode',
      rawInput: { plan: '# Implementation plan\n\nUpdate the settings.' }
    }
    reducer.handleAcp({ sessionUpdate: 'tool_call', ...toolCall, status: 'pending' })
    const plan = ctx.items.find((item): item is ToolItem => item.kind === 'tool')!
    let resolved = false
    const response = onAcpRequest(ctx.run, 'session/request_permission', {
      toolCall,
      options: [
        { optionId: 'exit-plan-default', kind: 'allow_once', name: 'Yes, manually approve edits' },
        { optionId: 'reject', kind: 'reject_once', name: 'No, keep planning' }
      ]
    }, ctx.queue).then((result) => { resolved = true; return result })
    await Promise.resolve()
    const question = ctx.items.find((item): item is QuestionItem => item.kind === 'question')!
    expect(resolved).toBe(false)
    expect(question.status).toBe('pending')
    expect(plan).toMatchObject({ tool: 'createPlan', status: 'running' })

    answerPendingQuestion(ctx.run, question.id, [{ questionId: 'q', selectedOptionIds: ['exit-plan-default'] }])
    await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'exit-plan-default' } })
    reducer.handleAcp({ sessionUpdate: 'tool_call_update', toolCallId: toolCall.toolCallId, status: 'completed' })
    expect(plan).toMatchObject({ tool: 'createPlan', status: 'success', args: toolCall.rawInput })
    expect(question.status).toBe('answered')
  })

  it.each(['user skip', 'turn skip', 'turn cancel'] as const)('does not approve an ordinary permission on %s', async (action) => {
    const ctx = setup()
    const response = onAcpRequest(ctx.run, 'session/request_permission', permissionParams, ctx.queue)
    const item = onlyQuestion(ctx.items)
    if (action === 'user skip') answerPendingQuestion(ctx.run, item.id, null)
    else settleQuestion(ctx.run, action === 'turn cancel' ? 'cancel' : 'skip')
    await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(item.status).toBe('skipped')
  })

  it.each([false, true])('does not approve replay or idle permissions with force=%s', async (force) => {
    const ctx = setup({ force, acceptUpdates: false })
    await expect(onAcpRequest(ctx.run, 'session/request_permission', permissionParams, ctx.queue))
      .resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    await expect(onIdleAcpRequest({ force }, 'session/request_permission', permissionParams))
      .resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(ctx.items).toEqual([])
  })

  it('keeps an invalid answer from consuming or approving a permission', async () => {
    const ctx = setup()
    const response = onAcpRequest(ctx.run, 'session/request_permission', permissionParams, ctx.queue)
    const item = onlyQuestion(ctx.items)
    for (const answers of [
      [], [{ questionId: 'wrong-question', selectedOptionIds: ['once'] }],
      [{ questionId: 'q', selectedOptionIds: ['forged-option'] }],
      [{ questionId: 'q', selectedOptionIds: ['once', 'always'] }],
      [{ questionId: 'q', selectedOptionIds: [] }],
      [{ questionId: 'q', selectedOptionIds: ['once'], otherText: 'Allow everything' }],
      [{ questionId: 'q', selectedOptionIds: 'once' }], [null], undefined
    ]) {
      expect(() => answerPendingQuestion(ctx.run, item.id, answers as QuestionAnswer[])).toThrow('请选择')
      expect(ctx.run.pendingQuestions?.has(item.id)).toBe(true)
      expect(item.status).toBe('pending')
    }
    answerPendingQuestion(ctx.run, item.id, [{ questionId: 'q', selectedOptionIds: ['deny'] }])
    await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
  })

  it('cancels a permission with no usable choices instead of opening an unanswerable card', async () => {
    const ctx = setup()
    await expect(onAcpRequest(ctx.run, 'session/request_permission', {
      options: [null, { optionId: 'unknown', kind: 'other' }, { optionId: 3, kind: 'allow_once' }, { optionId: '', kind: 'allow_once' }]
    }, ctx.queue)).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(ctx.items).toEqual([])
  })

  it('answers concurrent questions independently without overwriting either waiter', async () => {
    const ctx = setup()
    const question = onAcpRequest(ctx.run, 'cursor/ask_question', questionParams, ctx.queue)
    const permission = onAcpRequest(ctx.run, 'session/request_permission', permissionParams, ctx.queue)
    const [first, second] = ctx.items as QuestionItem[]
    expect(ctx.run.pendingQuestions?.size).toBe(2)
    answerPendingQuestion(ctx.run, second.id, [{ questionId: 'q', selectedOptionIds: ['deny'] }])
    await expect(permission).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
    expect(ctx.run.pendingQuestions?.has(first.id)).toBe(true)
    answerPendingQuestion(ctx.run, first.id, [{ questionId: 'approach', selectedOptionIds: ['o1'] }])
    await expect(question).resolves.toMatchObject({ outcome: { outcome: 'answered' } })
    expect(ctx.run.pendingQuestions?.size).toBe(0)
  })

  it('cancels every outstanding request and declines late requests after turn completion or stop', async () => {
    const ctx = setup()
    const question = onAcpRequest(ctx.run, 'cursor/ask_question', questionParams, ctx.queue)
    const permission = onAcpRequest(ctx.run, 'session/request_permission', permissionParams, ctx.queue)
    settleQuestion(ctx.run, 'cancel')
    await expect(question).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    await expect(permission).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(ctx.run.pendingQuestions?.size).toBe(0)
    expect(ctx.items.map((item) => (item as QuestionItem).status)).toEqual(['skipped', 'skipped'])
    ctx.run.force = true
    await expect(onAcpRequest(ctx.run, 'session/request_permission', permissionParams, ctx.queue))
      .resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    await expect(onAcpRequest(ctx.run, 'cursor/ask_question', questionParams, ctx.queue))
      .resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(ctx.items).toHaveLength(2)
    settleQuestion(ctx.run, 'cancel')
    expect(ctx.batches).toHaveLength(4)
  })

  it('publishes a pending question and updates the same history item when answered', async () => {
    const ctx = setup()
    const response = onAcpRequest(ctx.run, 'cursor/ask_question', questionParams, ctx.queue)
    const item = onlyQuestion(ctx.items)
    const pending = structuredClone(item)
    expect(item).toMatchObject({
      status: 'pending', toolCallId: 'ask-1', title: 'Choose an approach',
      questions: [{ id: 'approach', options: [{ id: 'o0', label: 'Small change' }, { id: 'o1', label: 'Full rewrite' }] }]
    })
    expect(ctx.run.pendingQuestions?.has(item.id)).toBe(true)
    expect(ctx.batches).toEqual([[pending]])

    const answers: QuestionAnswer[] = [{ questionId: 'approach', selectedOptionIds: ['o0'] }]
    answerPendingQuestion(ctx.run, item.id, answers)

    await expect(response).resolves.toEqual({ outcome: { outcome: 'answered', answers } })
    expect(ctx.run.pendingQuestions?.size ?? 0).toBe(0)
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
    expect(ctx.run.pendingQuestions?.has(item.id)).toBe(true)
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
    expect(ctx.run.pendingQuestions?.size ?? 0).toBe(0)
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
    expect(ctx.run.pendingQuestions?.size ?? 0).toBe(0)
    expect(ctx.items).toEqual([])
    expect(ctx.batches).toEqual([])
  })

  it('skips unusable question payloads without leaving a blocked request', async () => {
    const ctx = setup()

    await expect(onAcpRequest(ctx.run, 'cursor/ask_question', {
      questions: [{ prompt: 'No choices', options: [] }, null]
    }, ctx.queue)).resolves.toMatchObject({ outcome: { outcome: 'skipped' } })
    expect(ctx.run.pendingQuestions?.size ?? 0).toBe(0)
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
    expect(ctx.run.pendingQuestions?.size ?? 0).toBe(0)
    expect(ctx.batches).toHaveLength(2)
  })

  it.each(['skip', 'cancel'] as const)('maps fallback %s to the adapter skip option', async (decision) => {
    const ctx = setup({ proc: { provider: 'claude' }, mode: 'ask' })
    const response = onAcpRequest(ctx.run, 'session/request_permission', fallbackParams, ctx.queue)
    const item = onlyQuestion(ctx.items)

    settleQuestion(ctx.run, decision)

    await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId: '__ask_question_skip__' } })
    expect(item.status).toBe('skipped')
    expect(ctx.run.pendingQuestions?.size ?? 0).toBe(0)
  })

  it('handles fallback permissions during replay and idle without opening a question', async () => {
    const ctx = setup({ proc: { provider: 'claude' }, mode: 'ask', acceptUpdates: false })
    const cancelled = { outcome: { outcome: 'cancelled' } }

    await expect(onAcpRequest(ctx.run, 'session/request_permission', fallbackParams, ctx.queue)).resolves.toEqual(cancelled)
    await expect(onIdleAcpRequest({ force: false }, 'session/request_permission', fallbackParams)).resolves.toEqual(cancelled)
    expect(ctx.run.pendingQuestions?.size ?? 0).toBe(0)
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
    expect(ctx.run.pendingQuestions?.size ?? 0).toBe(0)
    expect(ctx.items).toEqual([])
    expect(ctx.batches).toEqual([])
  })
})

describe('Codex plan review feedback', () => {
  it('marks the No option for input and preserves the adapter text for renderer localization', async () => {
    const ctx = setup({ proc: { provider: 'codex' }, mode: 'plan' })
    const response = onAcpRequest(ctx.run, 'session/request_permission', planReviewParams, ctx.queue)
    const item = onlyQuestion(ctx.items)
    expect(item).toMatchObject({
      toolCallId: 'plan-review:plan-1', title: 'Implement this plan?', purpose: 'codex-plan-review', status: 'pending',
      questions: [{
        id: 'q', prompt: 'Implement this plan?', allowMultiple: false,
        options: [
          { id: 'implement_plan', label: 'Yes, implement this plan' },
          { id: 'revise_plan', label: 'No, and tell Codex what to do differently', requiresText: true }
        ]
      }]
    })
    expect(item.questions[0].options[0].requiresText).toBeUndefined()
    answerPendingQuestion(ctx.run, item.id, null)
    await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('requires nonblank feedback only with No, without consuming invalid answers', async () => {
    const ctx = setup({ proc: { provider: 'codex' }, mode: 'plan' })
    const response = onAcpRequest(ctx.run, 'session/request_permission', planReviewParams, ctx.queue)
    const item = onlyQuestion(ctx.items)
    const invalidAnswers = [
      { questionId: 'q', selectedOptionIds: ['revise_plan'] },
      { questionId: 'q', selectedOptionIds: ['revise_plan'], otherText: '' },
      { questionId: 'q', selectedOptionIds: ['revise_plan'], otherText: ' \n\t ' },
      { questionId: 'q', selectedOptionIds: ['revise_plan'], otherText: null },
      { questionId: 'q', selectedOptionIds: ['revise_plan'], otherText: 42 },
      { questionId: 'q', selectedOptionIds: ['implement_plan'], otherText: 'Change the plan' },
      { questionId: 'q', selectedOptionIds: ['implement_plan'], otherText: '' },
      { questionId: 'q', selectedOptionIds: ['revise_plan', 'implement_plan'], otherText: 'Change the plan' }
    ]
    for (const answer of invalidAnswers) {
      expect(() => answerPendingQuestion(ctx.run, item.id, [answer] as QuestionAnswer[])).toThrow('请选择')
      expect(ctx.run.pendingQuestions?.has(item.id)).toBe(true)
      expect(item.status).toBe('pending')
      expect(ctx.run.planFeedback).toBeUndefined()
    }
    expect(ctx.batches).toHaveLength(1)
    answerPendingQuestion(ctx.run, item.id, [{ questionId: 'q', selectedOptionIds: ['revise_plan'], otherText: 'Use a smaller change' }])
    await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'revise_plan' } })
  })

  it('stores trimmed No feedback and returns the exact rejection option to ACP', async () => {
    const ctx = setup({ proc: { provider: 'codex' }, mode: 'plan' })
    const response = onAcpRequest(ctx.run, 'session/request_permission', planReviewParams, ctx.queue)
    const item = onlyQuestion(ctx.items)
    answerPendingQuestion(ctx.run, item.id, [{
      questionId: 'q', selectedOptionIds: ['revise_plan'], otherText: ' \n先保留现有配置。\n再补充迁移步骤。\t '
    }])
    await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'revise_plan' } })
    expect(ctx.run.planFeedback).toBe('先保留现有配置。\n再补充迁移步骤。')
    expect(item).toMatchObject({
      status: 'answered',
      answers: [{ questionId: 'q', selectedOptionIds: ['revise_plan'], otherText: '先保留现有配置。\n再补充迁移步骤。' }]
    })
    expect(ctx.run.pendingQuestions?.size).toBe(0)
    expect(ctx.batches).toHaveLength(2)
  })

  it('allows Yes without feedback and leaves implementation to the adapter', async () => {
    const ctx = setup({ proc: { provider: 'codex' }, mode: 'plan' })
    const response = onAcpRequest(ctx.run, 'session/request_permission', planReviewParams, ctx.queue)
    const item = onlyQuestion(ctx.items)
    answerPendingQuestion(ctx.run, item.id, [{ questionId: 'q', selectedOptionIds: ['implement_plan'] }])
    await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'implement_plan' } })
    expect(ctx.run.planFeedback).toBeUndefined()
    expect(item.answers).toEqual([{ questionId: 'q', selectedOptionIds: ['implement_plan'] }])
  })

  it.each([
    ['metadata without the legacy tool id', {
      ...planReviewParams, toolCall: { ...planReviewParams.toolCall, toolCallId: 'permission-1' }
    }],
    ['legacy tool id without metadata', { ...planReviewParams, _meta: undefined }]
  ])('recognizes %s with the exact option pair', async (_name, params) => {
    const ctx = setup({ proc: { provider: 'codex' }, mode: 'plan' })
    const response = onAcpRequest(ctx.run, 'session/request_permission', params, ctx.queue)
    const item = onlyQuestion(ctx.items)
    expect(item.purpose).toBe('codex-plan-review')
    expect(item.questions[0].options.find((option) => option.id === 'revise_plan')?.requiresText).toBe(true)
    answerPendingQuestion(ctx.run, item.id, [{ questionId: 'q', selectedOptionIds: ['revise_plan'], otherText: 'Revise the tests' }])
    await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'revise_plan' } })
    expect(ctx.run.planFeedback).toBe('Revise the tests')
  })

  it.each([
    { name: 'Cursor with matching markers', provider: 'cursor' as const, params: planReviewParams },
    { name: 'Claude with matching markers', provider: 'claude' as const, params: planReviewParams },
    { name: 'an ordinary tool with plan review markers', provider: 'codex' as const, params: {
      ...planReviewParams, toolCall: { ...planReviewParams.toolCall, kind: 'execute' }
    } },
    { name: 'matching English text without either marker', provider: 'codex' as const, params: {
      ...planReviewParams, _meta: undefined, toolCall: { ...planReviewParams.toolCall, toolCallId: 'permission-1' }
    } },
    { name: 'a review marker with the wrong option kind', provider: 'codex' as const, params: {
      ...planReviewParams, options: [planReviewParams.options[0], { ...planReviewParams.options[1], kind: 'allow_once' }]
    } },
    { name: 'a review marker with additional choices', provider: 'codex' as const, params: {
      ...planReviewParams, options: [...planReviewParams.options, { optionId: 'later', name: 'Later', kind: 'reject_once' }]
    } }
  ])('keeps $name as a fixed permission choice', async ({ provider, params }) => {
    const ctx = setup({ proc: { provider }, mode: 'plan' })
    const response = onAcpRequest(ctx.run, 'session/request_permission', params, ctx.queue)
    const item = onlyQuestion(ctx.items)
    expect(item.purpose).toBeUndefined()
    expect(item.questions[0].options.every((option) => option.requiresText === undefined)).toBe(true)
    expect(() => answerPendingQuestion(ctx.run, item.id, [{
      questionId: 'q', selectedOptionIds: ['revise_plan'], otherText: 'Do not forward this'
    }])).toThrow('请选择')
    expect(ctx.run.pendingQuestions?.has(item.id)).toBe(true)
    answerPendingQuestion(ctx.run, item.id, [{ questionId: 'q', selectedOptionIds: ['revise_plan'] }])
    await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'revise_plan' } })
    expect(ctx.run.planFeedback).toBeUndefined()
  })

  it.each(['user skip', 'turn skip', 'turn cancel'] as const)('leaves no feedback after %s', async (action) => {
    const ctx = setup({ proc: { provider: 'codex' }, mode: 'plan' })
    const response = onAcpRequest(ctx.run, 'session/request_permission', planReviewParams, ctx.queue)
    const item = onlyQuestion(ctx.items)
    if (action === 'user skip') answerPendingQuestion(ctx.run, item.id, null)
    else settleQuestion(ctx.run, action === 'turn cancel' ? 'cancel' : 'skip')
    await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(item.status).toBe('skipped')
    expect(ctx.run.planFeedback).toBeUndefined()
    expect(ctx.run.pendingQuestions?.size).toBe(0)
  })

  it.each(['skip', 'cancel'] as const)('clears captured feedback when the turn is settled with %s', async (decision) => {
    const ctx = setup({ proc: { provider: 'codex' }, mode: 'plan' })
    const response = onAcpRequest(ctx.run, 'session/request_permission', planReviewParams, ctx.queue)
    const item = onlyQuestion(ctx.items)
    answerPendingQuestion(ctx.run, item.id, [{
      questionId: 'q', selectedOptionIds: ['revise_plan'], otherText: 'Do not start this after stopping'
    }])
    await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'revise_plan' } })
    expect(ctx.run.planFeedback).toBeDefined()
    settleQuestion(ctx.run, decision)
    expect(ctx.run.planFeedback).toBeUndefined()
    expect(item.status).toBe('answered')
  })

  it('does not restore feedback when cancellation wins the answer continuation', async () => {
    const ctx = setup({ proc: { provider: 'codex' }, mode: 'plan' })
    const response = onAcpRequest(ctx.run, 'session/request_permission', planReviewParams, ctx.queue)
    const item = onlyQuestion(ctx.items)
    answerPendingQuestion(ctx.run, item.id, [{
      questionId: 'q', selectedOptionIds: ['revise_plan'], otherText: 'Do not start after cancellation'
    }])
    settleQuestion(ctx.run, 'cancel')
    await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(ctx.run.planFeedback).toBeUndefined()
    expect(ctx.run.questionsClosed).toBe(true)
  })

  it('still waits for a plan review in Agent mode with full access', async () => {
    const ctx = setup({ proc: { provider: 'codex' }, mode: 'agent', force: true })
    let resolved = false
    const response = onAcpRequest(ctx.run, 'session/request_permission', planReviewParams, ctx.queue).then((result) => {
      resolved = true
      return result
    })
    await Promise.resolve()
    const item = onlyQuestion(ctx.items)
    expect(resolved).toBe(false)
    expect(item.purpose).toBe('codex-plan-review')
    answerPendingQuestion(ctx.run, item.id, [{ questionId: 'q', selectedOptionIds: ['implement_plan'] }])
    await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'implement_plan' } })
  })

  it('denies a plan mode switch in Ask mode without opening a feedback card', async () => {
    const ctx = setup({ proc: { provider: 'codex' }, mode: 'ask', force: true })
    await expect(onAcpRequest(ctx.run, 'session/request_permission', planReviewParams, ctx.queue))
      .resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'revise_plan' } })
    expect(ctx.items).toEqual([])
    expect(ctx.run.planFeedback).toBeUndefined()
  })
})
