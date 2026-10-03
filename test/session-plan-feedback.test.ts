import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type AgentEvent, type Item, type QuestionItem, type ThreadMeta } from '../src/shared/types'
import type { Store } from '../src/main/store'
import type { CodexUsageTurn } from '../src/main/codex-usage'
import { codexPlanModePrompt } from '../src/main/acp'
import { spawnCodexAcp } from '../src/main/codex'
import { readCodexUsage } from '../src/main/codex-history'
import { SessionManager } from '../src/main/sessions'

vi.mock('../src/main/skills', () => ({ syncAllManagedSkills: vi.fn() }))
vi.mock('../src/main/cli', async (original) => ({
  ...await original<typeof import('../src/main/cli')>(),
  killTree: vi.fn((child: ChildProcess) => {
    Object.assign(child, { exitCode: 0 })
    child.emit('close', 0)
  })
}))
vi.mock('../src/main/codex', async (original) => ({
  ...await original<typeof import('../src/main/codex')>(),
  resolveCodex: vi.fn(() => ({ bundled: true, display: 'Codex', acpEntry: '/mock/codex.js' })),
  resolveCodexApiKey: vi.fn((key: string) => key),
  spawnCodexAcp: vi.fn()
}))
vi.mock('../src/main/codex-history', () => ({ readCodexUsage: vi.fn() }))

interface RpcMessage {
  id?: number | string
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string }
}

const SESSION_ID = 'codex-plan-session'
const REVIEW_ID = 'plan-review-permission'
const ORIGINAL = '请设计一个可执行的改动计划'
const FEEDBACK = '保留现有接口。\n先增加中文提示，再补充修改说明输入。'
let root: string
let managers: SessionManager[]

beforeEach(() => {
  vi.clearAllMocks()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-plan-feedback-'))
  managers = []
})
afterEach(() => {
  for (const manager of managers) manager.stopAll()
  const resolved = path.resolve(root)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agent-desktop-plan-feedback-')) {
    throw new Error(`Unexpected test directory: ${resolved}`)
  }
  fs.rmSync(resolved, { recursive: true, force: true })
})

function fakeAgent() {
  const stdout = new PassThrough()
  const calls: RpcMessage[] = []
  const turns: CodexUsageTurn[] = []
  let firstPromptId: number | string | undefined
  let onFollowup: () => void = () => undefined
  const reply = (message: RpcMessage) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const complete = (id: number | string, stopReason: string) => {
    const now = Date.now()
    turns.push({
      usageId: `codex:turn-${turns.length + 1}`, startedAt: now, createdAt: now,
      usage: { inputTokens: 10, outputTokens: 5 }, isError: stopReason !== 'end_turn', completed: true,
      endLine: turns.length
    })
    reply({ id, result: { stopReason } })
  }
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    exitCode: null,
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        const message: RpcMessage = JSON.parse(chunk.toString())
        calls.push(message)
        if (message.method === 'session/prompt') {
          if (firstPromptId === undefined) {
            firstPromptId = message.id
            reply({
              id: REVIEW_ID,
              method: 'session/request_permission',
              params: {
                sessionId: SESSION_ID,
                _meta: { codex: { kind: 'plan_review' } },
                toolCall: { toolCallId: 'plan-review:turn-1', kind: 'switch_mode', title: 'Implement this plan?' },
                options: [
                  { optionId: 'implement_plan', kind: 'allow_once', name: 'Yes, implement this plan' },
                  { optionId: 'revise_plan', kind: 'reject_once', name: 'No, stay in Plan mode' }
                ]
              }
            })
          } else {
            onFollowup()
            complete(message.id!, 'end_turn')
          }
        } else if (message.method && message.id !== undefined) {
          reply({ id: message.id, result: message.method === 'session/new' ? { sessionId: SESSION_ID } : {} })
        }
        callback()
      }
    })
  }) as unknown as ChildProcess
  return {
    child,
    calls,
    turns,
    onFollowup: (inspect: () => void) => { onFollowup = inspect },
    completeFirst: (stopReason = 'end_turn') => complete(firstPromptId!, stopReason),
    failFirst: () => reply({ id: firstPromptId, error: { code: -32603, message: 'Prompt failed' } }),
    permissionReply: () => calls.find((message) => message.id === REVIEW_ID),
    prompts: () => calls.filter((message) => message.method === 'session/prompt')
  }
}

function setup() {
  const project = path.join(root, 'project')
  fs.mkdirSync(project)
  const agent = fakeAgent()
  vi.mocked(spawnCodexAcp).mockReturnValue(agent.child)
  vi.mocked(readCodexUsage).mockImplementation(() => agent.turns)
  const thread: ThreadMeta = {
    id: 'thread', projectId: 'project', title: 'Plan review', cli: 'codex', mode: 'plan',
    createdAt: Date.now(), updatedAt: Date.now(), source: 'app'
  }
  const items: Item[] = []
  const events: AgentEvent[] = []
  const store = {
    settings: { ...DEFAULT_SETTINGS, codexApiKey: 'mock-key' },
    dataDir: path.join(root, 'data'),
    thread: (id: string) => id === thread.id ? thread : undefined,
    project: () => ({ id: 'project', path: project }),
    items: () => items,
    markItemsDirty: vi.fn(),
    updateThread: (_id: string, patch: Partial<ThreadMeta>) => Object.assign(thread, patch)
  }
  const finished = vi.fn()
  const manager = new SessionManager(
    store as unknown as Store, (event) => events.push(event), vi.fn(), finished,
    vi.fn(async () => ({ threadUsage: undefined })) as any, vi.fn(async () => undefined) as any
  )
  managers.push(manager)
  const start = async () => {
    await manager.send({ threadId: thread.id, cli: 'codex', prompt: ORIGINAL, model: 'auto', mode: 'plan', force: false, worktree: false })
    await vi.waitFor(() => expect(items.some((item) => item.kind === 'question' && item.status === 'pending')).toBe(true))
    return items.find((item): item is QuestionItem => item.kind === 'question')!
  }
  const answer = async (question: QuestionItem, optionId: 'implement_plan' | 'revise_plan', feedback?: string) => {
    manager.answerQuestion(thread.id, question.id, [{
      questionId: 'q', selectedOptionIds: [optionId], ...(feedback !== undefined ? { otherText: feedback } : {})
    }])
    await vi.waitFor(() => expect(agent.permissionReply()).toBeDefined())
  }
  const finish = async (stopReason = 'end_turn') => {
    agent.completeFirst(stopReason)
    await vi.waitFor(() => expect(finished).toHaveBeenCalled())
    await vi.waitFor(() => expect(manager.isRunning(thread.id)).toBe(false))
  }
  return { manager, agent, thread, items, events, finished, start, answer, finish }
}

describe('Codex plan revision lifecycle', () => {
  it('sends No feedback once in the same Plan session after saving the original result', async () => {
    const ctx = setup()
    const question = await ctx.start()
    expect(question).toMatchObject({
      purpose: 'codex-plan-review',
      questions: [{ options: [{ id: 'implement_plan' }, { id: 'revise_plan', requiresText: true }] }]
    })
    let originalSavedBeforeFollowup = false
    ctx.agent.onFollowup(() => {
      originalSavedBeforeFollowup = ctx.finished.mock.calls.length === 1
        && ctx.items.filter((item) => item.kind === 'result').length === 1
    })
    await ctx.answer(question, 'revise_plan', `  ${FEEDBACK}  `)
    expect(ctx.agent.permissionReply()?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'revise_plan' } })
    expect(ctx.agent.prompts()).toHaveLength(1)
    expect(ctx.items.filter((item) => item.kind === 'user')).toHaveLength(1)

    await ctx.finish()
    expect(originalSavedBeforeFollowup).toBe(true)
    expect(ctx.finished).toHaveBeenCalledTimes(2)
    expect(spawnCodexAcp).toHaveBeenCalledTimes(1)
    expect(ctx.agent.calls.filter((message) => message.method === 'session/new')).toHaveLength(1)
    expect(ctx.agent.calls.some((message) => message.method === 'session/load')).toBe(false)
    expect(ctx.agent.prompts().map((message) => message.params)).toEqual([
      { sessionId: SESSION_ID, prompt: [{ type: 'text', text: codexPlanModePrompt(ORIGINAL) }] },
      { sessionId: SESSION_ID, prompt: [{ type: 'text', text: codexPlanModePrompt(FEEDBACK) }] }
    ])
    expect(ctx.items.filter((item) => item.kind === 'user').map((item) => item.text)).toEqual([ORIGINAL, FEEDBACK])
    expect(ctx.items.filter((item) => item.kind === 'user' || item.kind === 'result').map((item) => item.kind))
      .toEqual(['user', 'result', 'user', 'result'])
    expect(ctx.items.filter((item) => item.kind === 'result')).toEqual([
      expect.objectContaining({ cli: 'codex', model: 'auto', isError: false, usageId: 'codex:turn-1' }),
      expect.objectContaining({ cli: 'codex', model: 'auto', isError: false, usageId: 'codex:turn-2' })
    ])
    expect(ctx.agent.calls.filter((message) => message.method === 'session/set_mode').map((message) => message.params.modeId))
      .toEqual(['read-only', 'read-only'])
    expect(ctx.agent.calls.filter((message) => message.method === 'session/set_config_option').map((message) => message.params))
      .toEqual(Array.from({ length: 2 }, () => ({ sessionId: SESSION_ID, configId: 'collaboration_mode', value: 'plan' })))
    expect(ctx.thread).toMatchObject({ cli: 'codex', chatId: SESSION_ID, mode: 'plan', model: 'auto', worktree: false, force: false })
    expect(ctx.events.filter((event) => event.type === 'running').map((event) => event.running)).toEqual([true, false, true, false])
  })

  it('returns Yes without automatically starting another prompt', async () => {
    const ctx = setup()
    const question = await ctx.start()
    await ctx.answer(question, 'implement_plan')
    expect(ctx.agent.permissionReply()?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'implement_plan' } })
    await ctx.finish()
    expect(ctx.agent.prompts()).toHaveLength(1)
    expect(ctx.finished).toHaveBeenCalledTimes(1)
    expect(ctx.thread.mode).toBe('plan')
  })

  it('cancels a skipped review without creating a feedback prompt', async () => {
    const ctx = setup()
    const question = await ctx.start()
    ctx.manager.answerQuestion(ctx.thread.id, question.id, null)
    await vi.waitFor(() => expect(ctx.agent.permissionReply()?.result).toEqual({ outcome: { outcome: 'cancelled' } }))
    await ctx.finish()
    expect(question.status).toBe('skipped')
    expect(ctx.agent.prompts()).toHaveLength(1)
  })

  it.each(['end_turn', 'cancelled'])('does not resend feedback after stop even when the CLI returns %s', async (stopReason) => {
    const ctx = setup()
    const question = await ctx.start()
    await ctx.answer(question, 'revise_plan', FEEDBACK)
    ctx.manager.stop(ctx.thread.id)
    await vi.waitFor(() => expect(ctx.agent.calls.some((message) => message.method === 'session/cancel')).toBe(true))
    await ctx.finish(stopReason)
    expect(ctx.finished).toHaveBeenCalledTimes(1)
    expect(ctx.finished.mock.calls[0][0].stopped).toBe(true)
    expect(ctx.agent.prompts()).toHaveLength(1)
    expect(ctx.items.filter((item) => item.kind === 'user')).toHaveLength(1)
  })

  it.each(['cancelled', 'max_tokens'])('does not resend feedback after a %s result', async (stopReason) => {
    const ctx = setup()
    await ctx.answer(await ctx.start(), 'revise_plan', FEEDBACK)
    await ctx.finish(stopReason)
    expect(ctx.agent.prompts()).toHaveLength(1)
    expect(ctx.finished).toHaveBeenCalledTimes(1)
  })

  it('does not resend feedback when the original prompt fails', async () => {
    const ctx = setup()
    await ctx.answer(await ctx.start(), 'revise_plan', FEEDBACK)
    ctx.agent.failFirst()
    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledTimes(1))
    expect(ctx.finished.mock.calls[0][0].failed).toBe(true)
    expect(ctx.agent.prompts()).toHaveLength(1)
    expect(spawnCodexAcp).toHaveBeenCalledTimes(1)
  })

  it('does not launch another process for feedback after the original process exits', async () => {
    const ctx = setup()
    await ctx.answer(await ctx.start(), 'revise_plan', FEEDBACK)
    Object.assign(ctx.agent.child, { exitCode: 0 })
    await ctx.finish()
    expect(ctx.agent.prompts()).toHaveLength(1)
    expect(spawnCodexAcp).toHaveBeenCalledTimes(1)
  })

  it('does not resend feedback after disposing the process during the original turn', async () => {
    const ctx = setup()
    await ctx.answer(await ctx.start(), 'revise_plan', FEEDBACK)
    ctx.manager.dispose(ctx.thread.id)
    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledTimes(1))
    expect(ctx.finished.mock.calls[0][0].stopped).toBe(true)
    expect(ctx.agent.prompts()).toHaveLength(1)
    expect(spawnCodexAcp).toHaveBeenCalledTimes(1)
  })

  it.each(['session', 'provider'])('does not send feedback when the saved %s changes during the original turn', async (changed) => {
    const ctx = setup()
    await ctx.answer(await ctx.start(), 'revise_plan', FEEDBACK)
    if (changed === 'session') ctx.thread.chatId = 'another-session'
    else ctx.thread.cli = 'cursor'
    await ctx.finish()
    expect(ctx.agent.prompts()).toHaveLength(1)
    expect(spawnCodexAcp).toHaveBeenCalledTimes(1)
    expect(ctx.items.filter((item) => item.kind === 'user')).toHaveLength(1)
  })
})
