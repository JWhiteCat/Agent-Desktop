import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { killTree } from '../src/main/cli'
import { readAntigravityVerificationUrl } from '../src/main/antigravity-validation'
import { spawnProvider } from '../src/main/session/provider'
import { SessionManager } from '../src/main/sessions'
import type { Store } from '../src/main/store'
import { DEFAULT_SETTINGS, type AssistantItem, type Item, type QuestionItem, type ResultItem, type SendRequest, type ThreadMeta, type ToolItem } from '../src/shared/types'

vi.mock('../src/main/system-proxy', () => ({ refreshCodexProxyEnv: vi.fn(async () => ({})), codexProxyOverlay: () => ({}), isCodexRoutingTimeout: () => false }))
vi.mock('../src/main/skills', () => ({ syncAllManagedSkills: vi.fn() }))
vi.mock('../src/main/git', () => ({ createWorktree: vi.fn() }))
vi.mock('../src/main/antigravity-validation', () => ({ readAntigravityVerificationUrl: vi.fn() }))
vi.mock('../src/main/session/provider', async (original) => ({
  ...await original<typeof import('../src/main/session/provider')>(),
  resolveLaunch: () => ({ cli: { command: 'mock-agy', prefixArgs: ['acp'] } }),
  providerApiKey: () => '',
  spawnProvider: vi.fn()
}))
vi.mock('../src/main/cli', async (original) => ({
  ...await original<typeof import('../src/main/cli')>(),
  killTree: vi.fn((child: ChildProcess) => {
    Object.assign(child, { exitCode: 0 })
    child.emit('close', 0)
  })
}))

interface RpcMessage {
  id?: number | string
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string }
}

const managers: SessionManager[] = []
let workspace: string

function setup(force = true) {
  const stdout = new PassThrough()
  const incoming: RpcMessage[] = []
  let promptId: number | string | undefined
  let nextServerRequestId = 100
  const serverPending = new Map<number | string, (result: any) => void>()

  const sendToClient = (message: RpcMessage) => {
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }
  const requestClient = (method: string, params: any): Promise<any> => {
    const id = nextServerRequestId++
    return new Promise((resolve) => {
      serverPending.set(id, resolve)
      sendToClient({ id, method, params })
    })
  }
  const update = (payload: Record<string, unknown>) => {
    sendToClient({
      method: 'session/update',
      params: { sessionId: 'agy-session', update: payload }
    })
  }

  let stdinBuf = ''
  const child = Object.assign(new EventEmitter(), {
    pid: 42001,
    stdout,
    stderr: new PassThrough(),
    exitCode: null,
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        stdinBuf += chunk.toString()
        let nl = stdinBuf.indexOf('\n')
        while (nl >= 0) {
          const line = stdinBuf.slice(0, nl).trim()
          stdinBuf = stdinBuf.slice(nl + 1)
          nl = stdinBuf.indexOf('\n')
          if (!line) continue
          const message: RpcMessage = JSON.parse(line)
          incoming.push(message)
          if (message.method === undefined && message.id !== undefined) {
            serverPending.get(message.id)?.(message.result)
            serverPending.delete(message.id)
            continue
          }
          if (message.method === 'session/prompt') {
            promptId = message.id
            continue
          }
          if (message.method && message.id !== undefined) {
            const result = message.method === 'initialize'
              ? { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } }
              : message.method === 'session/new'
                ? { sessionId: 'agy-session', configOptions: [] }
                : {}
            sendToClient({ id: message.id, result })
          }
        }
        callback()
      }
    })
  }) as unknown as ChildProcess

  vi.mocked(spawnProvider).mockReturnValue(child)
  const thread = { id: 'thread', projectId: 'project', cli: 'antigravity', mode: 'agent', force } as ThreadMeta
  const items: Item[] = []
  const store = {
    dataDir: os.tmpdir(),
    settings: { ...DEFAULT_SETTINGS },
    thread: (id: string) => id === thread.id ? thread : undefined,
    project: () => ({ id: 'project', path: workspace }),
    items: () => items,
    markItemsDirty: vi.fn(),
    updateThread: vi.fn((_id: string, patch: Partial<ThreadMeta>) => Object.assign(thread, patch))
  }
  const finished = vi.fn()
  const emit = vi.fn()
  const stateChanged = vi.fn()
  const manager = new SessionManager(
    store as unknown as Store,
    emit,
    stateChanged,
    finished,
    undefined,
    undefined,
    vi.fn(async () => ({ provider: 'antigravity' as const, windows: [] }))
  )
  managers.push(manager)
  const req: SendRequest = { threadId: thread.id, prompt: 'Run checks and report', model: 'gemini-3.8-pro-high', mode: 'agent', force }
  return {
    manager,
    req,
    thread,
    store,
    items,
    incoming,
    update,
    requestClient,
    finished,
    emit,
    waitForPrompt: () => vi.waitFor(() => expect(promptId).toBeDefined()),
    rejectPrompt: (message: string) => sendToClient({ id: promptId, error: { code: -32603, message } }),
    resolvePrompt: (usage?: Record<string, unknown>) => {
      const id = promptId
      promptId = undefined
      sendToClient({ id, result: { stopReason: 'end_turn', ...(usage ? { usage } : {}) } })
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-agy-wakeup-'))
})

afterEach(async () => {
  const current = managers.splice(0)
  for (const manager of current) manager.stopAll()
  await vi.waitFor(() => expect(current.every((manager) => !manager.active().length)).toBe(true))
  const resolved = path.resolve(workspace)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agent-desktop-agy-wakeup-')) {
    throw new Error('Unexpected test directory')
  }
  fs.rmSync(resolved, { recursive: true, force: true })
})

describe('Antigravity account verification', () => {
  it.each([true, false])('shows the verification action or a terminal fallback (link available: %s)', async (available) => {
    const url = available ? 'https://accounts.google.com/signin/continue?challenge=test' : undefined
    vi.mocked(readAntigravityVerificationUrl).mockResolvedValueOnce(url)
    const ctx = setup()
    ctx.items.push({ id: 'copied-turn', kind: 'assistant', text: 'Prior conversation.' })
    ctx.thread.forkContextThroughItemId = 'copied-turn'
    await ctx.manager.send(ctx.req)
    await ctx.waitForPrompt()
    for (const text of ['\n⚠ Verification', ' Required\n']) {
      ctx.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
    }
    ctx.resolvePrompt()

    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledOnce())
    expect(readAntigravityVerificationUrl).toHaveBeenCalledWith(42001, expect.any(Number), 'agy-session')
    const notices = ctx.items.filter((it) => it.kind === 'notice')
    expect(notices).toHaveLength(1)
    expect(notices[0].level).toBe('error')
    expect(notices[0].verificationUrl).toBe(url)
    expect(notices[0].message?.source).toBe(available
      ? '请使用当前 Antigravity 账号完成验证，然后重试。' : '请在终端打开 Antigravity CLI，按提示完成 Google 账号验证，然后重试。')
    expect(ctx.items.find((it) => it.kind === 'result')).toMatchObject({ isError: true, timing: { outcome: 'failed' } })
    expect(ctx.finished).toHaveBeenCalledWith(expect.objectContaining({ failed: true }))
    expect(ctx.thread.forkContextThroughItemId).toBe('copied-turn')
    expect(killTree).toHaveBeenCalledOnce()
  })

  it('keeps a reply discussing the verification warning as ordinary assistant text', async () => {
    const ctx = setup()
    await ctx.manager.send(ctx.req)
    await ctx.waitForPrompt()
    ctx.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The CLI may say ⚠ Verification Required.' } })
    ctx.resolvePrompt()
    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledOnce())
    expect(readAntigravityVerificationUrl).not.toHaveBeenCalled()
    expect(ctx.items.find((it) => it.kind === 'notice')).toBeUndefined()
    expect(ctx.finished).toHaveBeenCalledWith(expect.objectContaining({ failed: false }))
  })

  it.each([
    ['PERMISSION_DENIED (code 403): Verify your account to continue.', true],
    ['PERMISSION_DENIED (code 403): Model is not allowed for this API key.', false]
  ] as const)('distinguishes a rejected verification request from other 403s: %s', async (message, verification) => {
    const ctx = setup()
    await ctx.manager.send(ctx.req)
    await ctx.waitForPrompt()
    ctx.rejectPrompt(message)
    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledOnce())
    expect(readAntigravityVerificationUrl).toHaveBeenCalledTimes(verification ? 1 : 0)
    const notices = ctx.items.filter((it) => it.kind === 'notice')
    expect(notices).toHaveLength(1)
    if (verification) expect(notices[0].text).toContain('Antigravity CLI')
    else expect(notices[0].text).toBe(message)
  })
})

describe('Antigravity reactive wakeup continuation', () => {
  it('keeps the turn open across early session/prompt resolution while a backgrounded tool finishes and wakes up', async () => {
    const ctx = setup(true)
    await ctx.manager.send(ctx.req)
    await ctx.waitForPrompt()

    // Backgrounded `run_command` stays `in_progress` when `agy acp` resolves `session/prompt`.
    ctx.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'bg-test',
      kind: 'execute',
      title: 'npm run typecheck; npm test',
      status: 'in_progress',
      rawInput: { CommandLine: 'npm run typecheck; npm test', WaitMsBeforeAsync: 10000 }
    })
    ctx.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '正在运行完整的类型检查和回归测试套件，稍后为您汇报结果并提交更改。' }
    })
    ctx.resolvePrompt({ inputTokens: 11269, outputTokens: 557, cachedReadTokens: 6862 })

    // Queue a follow-up while waiting for the background task; it must NOT dispatch prematurely.
    await ctx.manager.send({ ...ctx.req, prompt: 'Queued next step', delivery: 'queue' })
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(ctx.manager.isRunning('thread')).toBe(true)
    expect(ctx.finished).not.toHaveBeenCalled()
    expect(ctx.items.find((it): it is ToolItem => it.kind === 'tool' && it.callId === 'bg-test')?.status).toBe('running')
    expect(ctx.incoming.filter((m) => m.method === 'session/prompt')).toHaveLength(1)

    // Thought and plan updates can arrive while the foreground command still owns the turn.
    vi.useFakeTimers()
    try {
      ctx.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Still waiting.' } })
      ctx.update({ sessionUpdate: 'plan', entries: [] })
      await vi.advanceTimersByTimeAsync(301_000)
      expect(ctx.items.some((item) => item.kind === 'result')).toBe(false)
    } finally {
      vi.useRealTimers()
    }

    // Background task finishes and triggers Antigravity reactive wakeup steps + permission request.
    ctx.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'bg-test',
      status: 'completed',
      rawOutput: 'Tests passed'
    })
    ctx.update({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Inspecting results and running final check.' }
    })
    ctx.update({
      sessionUpdate: 'usage_update',
      usage: { used: 9651, size: 1048576 }
    })
    ctx.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'post-wakeup-cmd',
      kind: 'execute',
      title: 'npx vitest run',
      status: 'in_progress',
      rawInput: { CommandLine: 'npx vitest run' }
    })
    const perm = await ctx.requestClient('session/request_permission', {
      sessionId: 'agy-session',
      toolCall: { toolCallId: 'post-wakeup-cmd', title: 'npx vitest run', kind: 'execute' },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'allow_always', kind: 'allow_always', name: 'Always Allow' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' }
      ]
    })
    expect(perm).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_always' } })

    ctx.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'post-wakeup-cmd',
      status: 'completed',
      rawOutput: '1 passed'
    })
    ctx.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '全部类型检查与测试均已通过，代码已提交。' }
    })
    ctx.update({
      sessionUpdate: 'usage_update',
      usage: { used: 10240, size: 1048576 }
    })

    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledOnce(), { timeout: 2000 })
    expect(ctx.finished).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread',
      stopped: false,
      failed: false,
      preview: '全部类型检查与测试均已通过，代码已提交。'
    }))

    const tools = ctx.items.filter((it): it is ToolItem => it.kind === 'tool')
    expect(tools.map((t) => ({ id: t.callId, status: t.status }))).toEqual([
      { id: 'bg-test', status: 'success' },
      { id: 'post-wakeup-cmd', status: 'success' }
    ])
    const replies = ctx.items.filter((it): it is AssistantItem => it.kind === 'assistant').map((a) => a.text)
    expect(replies).toEqual([
      '正在运行完整的类型检查和回归测试套件，稍后为您汇报结果并提交更改。',
      '全部类型检查与测试均已通过，代码已提交。'
    ])
    const result = ctx.items.find((it): it is ResultItem => it.kind === 'result')
    expect(result?.isError).toBe(false)
    expect(result?.usage).toEqual({ inputTokens: 11269, outputTokens: 557, cacheReadTokens: 6862 })

    // Only after the wakeup reply settles does the queued message dispatch!
    await vi.waitFor(() => expect(ctx.incoming.filter((m) => m.method === 'session/prompt')).toHaveLength(2))
    ctx.resolvePrompt()
    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledTimes(2))
  })

  it('cancels promptly without killing the reusable CLI process when stopped during post-prompt tool wait', async () => {
    const ctx = setup(true)
    await ctx.manager.send(ctx.req)
    await ctx.waitForPrompt()

    ctx.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'bg-sleep',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: 'sleep 30', WaitMsBeforeAsync: 500 }
    })
    ctx.resolvePrompt()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ctx.manager.isRunning('thread')).toBe(true)

    ctx.manager.stop('thread')
    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledOnce())
    expect(ctx.finished).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread',
      stopped: true,
      failed: false
    }))
    expect(ctx.incoming.some((m) => m.method === 'session/cancel')).toBe(true)
    expect(killTree).not.toHaveBeenCalled()
    expect(ctx.items.find((it): it is ToolItem => it.kind === 'tool' && it.callId === 'bg-sleep')?.status).toBe('error')

    ctx.update({ sessionUpdate: 'tool_call_update', toolCallId: 'bg-sleep', status: 'completed' })
    const latePermission = await ctx.requestClient('session/request_permission', {
      sessionId: 'agy-session', toolCall: { toolCallId: 'late', kind: 'execute' },
      options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow' }]
    })
    expect(latePermission).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(ctx.manager.isRunning('thread')).toBe(false)
    expect(ctx.items.find((it): it is ToolItem => it.kind === 'tool' && it.callId === 'bg-sleep')?.status).toBe('error')

    // Process stays alive and reusable for the next prompt.
    await ctx.manager.send({ ...ctx.req, prompt: 'Follow up' })
    await ctx.waitForPrompt()
    expect(spawnProvider).toHaveBeenCalledOnce()
    ctx.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'New reply.' } })
    ctx.resolvePrompt()
    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledTimes(2))
    expect(ctx.finished).toHaveBeenLastCalledWith(expect.objectContaining({ preview: 'New reply.' }))
  })

  it('does not block session/prompt completion on IsDaemon background commands', async () => {
    const ctx = setup(true)
    await ctx.manager.send(ctx.req)
    await ctx.waitForPrompt()

    ctx.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'dev-server',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: 'npm run dev', IsDaemon: true }
    })
    ctx.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Started dev server.' }
    })
    ctx.resolvePrompt()

    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledOnce())
    expect(ctx.items.find((it): it is ToolItem => it.kind === 'tool' && it.callId === 'dev-server')?.status).toBe('running')
  })

  it('captures unsolicited subagent wakeups and interactive permissions on an idle Antigravity session', async () => {
    const ctx = setup(false)
    await ctx.manager.send(ctx.req)
    await ctx.waitForPrompt()

    // `invoke_subagent` completes immediately upon spawning the child conversation.
    ctx.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'sub-1',
      kind: 'other',
      title: 'Researcher',
      status: 'completed',
      rawInput: { TypeName: 'research', Role: 'Researcher', Prompt: 'Check docs' },
      rawOutput: 'Created the following subagent: {"conversationId":"child-1"}'
    })
    ctx.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '已启动子代理，等待返回结果。' }
    })
    ctx.resolvePrompt({ inputTokens: 2000, outputTokens: 120 })
    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledOnce())
    expect(ctx.manager.isRunning('thread')).toBe(false)

    // Later, the subagent finishes and wakes up the idle parent `agy` process!
    ctx.update({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Subagent reported back.' }
    })
    expect(ctx.manager.isRunning('thread')).toBe(true)

    // Interactive permission card (force=false) during wakeup must wait for user approval, not auto-cancel!
    const permPromise = ctx.requestClient('session/request_permission', {
      sessionId: 'agy-session',
      toolCall: { toolCallId: 'wakeup-edit', title: 'Edit note.md', kind: 'edit' },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' }
      ]
    })
    await vi.waitFor(() => {
      const q = ctx.items.find((it): it is QuestionItem => it.kind === 'question' && it.status === 'pending')
      expect(q).toBeDefined()
    })
    const question = ctx.items.find((it): it is QuestionItem => it.kind === 'question' && it.status === 'pending')!
    ctx.manager.answerQuestion('thread', question.id, [{ questionId: 'q', selectedOptionIds: ['allow_once'] }])
    await expect(permPromise).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } })

    ctx.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '子代理调查完成，已更新笔记。' }
    })
    ctx.update({
      sessionUpdate: 'usage_update',
      usage: { used: 4200, size: 1048576 }
    })

    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledTimes(2), { timeout: 2000 })
    expect(ctx.manager.isRunning('thread')).toBe(false)
    expect(ctx.finished).toHaveBeenLastCalledWith(expect.objectContaining({
      threadId: 'thread',
      stopped: false,
      failed: false,
      preview: '子代理调查完成，已更新笔记。'
    }))

    const results = ctx.items.filter((it): it is ResultItem => it.kind === 'result')
    expect(results).toHaveLength(1)
    expect(results[0].usage).toEqual({ inputTokens: 2000, outputTokens: 120 })
    const replies = ctx.items.filter((it): it is AssistantItem => it.kind === 'assistant').map((a) => a.text)
    expect(replies).toEqual(['已启动子代理，等待返回结果。', '子代理调查完成，已更新笔记。'])
  })

  it('emits an interactive questions card for Agent-mode ask_question and skips re-emitting on the reply turn', async () => {
    const ctx = setup(true)
    const rawInput = {
      questions: [
        { question: '请选择构建目标', options: ['桌面端', '网页端'], is_multi_select: false },
        { question: '需要包含哪些检查？', options: ['类型检查', '单元测试'], is_multi_select: true }
      ]
    }

    await ctx.manager.send({ ...ctx.req, prompt: '帮我准备发布', mode: 'agent', force: true })
    await ctx.waitForPrompt()

    ctx.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'ask-1',
      name: 'ask_question',
      status: 'in_progress',
      kind: 'other',
      rawInput
    })
    ctx.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'ask-1',
      name: 'ask_question',
      status: 'pending',
      kind: 'other',
      rawInput
    })
    ctx.update({
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: '\n请选择构建目标\n- [1] 桌面端\n- [2] 网页端\n\n需要包含哪些检查？\n- [1] 类型检查\n- [2] 单元测试\n'
      }
    })
    ctx.resolvePrompt({ inputTokens: 1200, outputTokens: 80 })
    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledOnce())
    expect(ctx.manager.isRunning('thread')).toBe(false)

    const turn1Replies = ctx.items.filter((it): it is AssistantItem => it.kind === 'assistant')
    expect(turn1Replies).toHaveLength(1)
    expect(turn1Replies[0].text).toContain('```questions\n')
    expect(turn1Replies[0].text).not.toContain('- [1] 桌面端')
    expect(turn1Replies[0].text).toContain('"allowMultiple":true')

    // User submits the selection card as the next message; agy completes ask-1 and continues.
    await ctx.manager.send({
      ...ctx.req,
      prompt: '我的选择：\n- 请选择构建目标：桌面端\n- 需要包含哪些检查？：类型检查、单元测试',
      mode: 'agent',
      force: true
    })
    await ctx.waitForPrompt()

    ctx.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'ask-1',
      name: 'ask_question',
      status: 'in_progress',
      kind: 'other',
      rawInput
    })
    ctx.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'ask-1',
      name: 'ask_question',
      status: 'completed',
      kind: 'other',
      rawInput
    })
    ctx.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '收到，将按桌面端并运行类型检查与单元测试来准备发布。' }
    })
    ctx.resolvePrompt({ inputTokens: 1500, outputTokens: 50 })
    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledTimes(2))

    const allReplies = ctx.items.filter((it): it is AssistantItem => it.kind === 'assistant')
    expect(allReplies).toHaveLength(2)
    expect(allReplies[1].text).toBe('收到，将按桌面端并运行类型检查与单元测试来准备发布。')
    expect(ctx.items.filter((it) => it.kind === 'tool')).toEqual([])
  })

  it('does not finish prematurely when a backgrounded run_command completes before its in-flight interim reply streams', async () => {
    const ctx = setup(true)
    await ctx.manager.send(ctx.req)
    await ctx.waitForPrompt()

    // Initial schedule timer resolves session/prompt early so the turn enters waitForFollowup.
    ctx.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'sched-1',
      name: 'schedule',
      kind: 'other',
      title: 'Run schedule',
      status: 'in_progress',
      rawInput: { DurationSeconds: 45, Prompt: 'Check progress' }
    })
    ctx.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Waiting 45 seconds to inspect progress...' }
    })
    ctx.update({ sessionUpdate: 'usage_update', usage: { used: 3000, size: 1048576 } })
    ctx.resolvePrompt({ inputTokens: 3000, outputTokens: 120 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ctx.manager.isRunning('thread')).toBe(true)

    // Queue a user follow-up that must NOT dispatch during the mid-turn race.
    await ctx.manager.send({ ...ctx.req, prompt: 'Next task after completion', delivery: 'queue' })

    // Timer fires and wakes the model.
    ctx.update({ sessionUpdate: 'tool_call_update', toolCallId: 'sched-1', status: 'completed' })

    // Model runs a command that goes background and finishes BEFORE the interim status reply finishes streaming.
    ctx.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'bg-deploy-1',
      name: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: 'python deploy.py arktest2', WaitMsBeforeAsync: 10000 }
    })
    ctx.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'bg-deploy-1',
      status: 'completed',
      rawOutput: { output: 'Command exited with code 0.\n\nCommand output:\nDeployed arktest2\n', exit_code: 0 }
    })
    // Stale in-flight interim reply arrives AFTER tool_call_update(completed)!
    ctx.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Regenerated and deploying arktest2 to the cloud phone...' }
    })
    ctx.update({ sessionUpdate: 'usage_update', usage: { used: 4500, size: 1048576 } })

    // Wait well past FOLLOWUP_USAGE_MS (250ms) and verify the turn stays open with zero bogus notifications.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(ctx.manager.isRunning('thread')).toBe(true)
    expect(ctx.finished).not.toHaveBeenCalled()
    expect(ctx.incoming.filter((m) => m.method === 'session/prompt')).toHaveLength(1)

    // Repeat the same race a second time in the same turn (like 52faa0e8 steps 351 -> 357 -> 385).
    ctx.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Deployment finished; starting script.' } })
    ctx.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'bg-deploy-2',
      name: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: 'python start.py arktest2', WaitMsBeforeAsync: 10000 }
    })
    ctx.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'bg-deploy-2',
      status: 'completed',
      rawOutput: { output: 'Command exited with code 0.\n\nCommand output:\nSTARTED\n', exit_code: 0 }
    })
    ctx.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Loading and starting arktest2...' }
    })
    ctx.update({ sessionUpdate: 'usage_update', usage: { used: 5200, size: 1048576 } })

    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(ctx.manager.isRunning('thread')).toBe(true)
    expect(ctx.finished).not.toHaveBeenCalled()

    // Now model runs a synchronous git commit (with Created At / Completed At) and emits the real final reply.
    ctx.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Committing verified changes.' } })
    ctx.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'sync-commit',
      name: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: 'git commit -m "done"', WaitMsBeforeAsync: 10000 }
    })
    ctx.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'sync-commit',
      status: 'completed',
      rawOutput: {
        output: 'Created At: 2026-11-22T23:56:03+08:00\nCompleted At: 2026-11-22T23:56:08+08:00\nCommand exited with code 0.\n',
        exit_code: 0
      }
    })
    ctx.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Summarizing.' } })
    ctx.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '全部功能已完成验证并提交（commit 4695471）。' }
    })
    ctx.update({ sessionUpdate: 'usage_update', usage: { used: 6000, size: 1048576 } })

    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledOnce(), { timeout: 2000 })
    expect(ctx.finished).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread',
      stopped: false,
      failed: false,
      preview: '全部功能已完成验证并提交（commit 4695471）。'
    }))
    const results = ctx.items.filter((it): it is ResultItem => it.kind === 'result')
    expect(results).toHaveLength(1)
    const finalReplyIdx = ctx.items.findIndex((it) => it.kind === 'assistant' && it.text.includes('4695471'))
    const resultIdx = ctx.items.findIndex((it) => it.kind === 'result')
    expect(finalReplyIdx).toBeGreaterThan(-1)
    expect(resultIdx).toBeGreaterThan(finalReplyIdx)

    // Queued follow-up dispatches only after the real completion.
    await vi.waitFor(() => expect(ctx.incoming.filter((m) => m.method === 'session/prompt')).toHaveLength(2))
    ctx.resolvePrompt()
    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledTimes(2))
  })

  it('distinguishes truncated backgrounded run_command from truncated synchronous run_command', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const ctx = setup(true)
      await ctx.manager.send(ctx.req)
      await ctx.waitForPrompt()

      // Enter waitForFollowup via schedule.
      ctx.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'sched-trunc',
        name: 'schedule',
        kind: 'other',
        status: 'in_progress',
        rawInput: { DurationSeconds: 30, Prompt: 'Check' }
      })
      ctx.resolvePrompt()
      await vi.advanceTimersByTimeAsync(10)
      ctx.update({ sessionUpdate: 'tool_call_update', toolCallId: 'sched-trunc', status: 'completed' })

      // 1) Truncated backgrounded run_command (no Created At / Completed At, elapsed >= WaitMsBeforeAsync).
      ctx.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'bg-trunc',
        name: 'run_command',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'npm run package', WaitMsBeforeAsync: 10000 }
      })
      await vi.advanceTimersByTimeAsync(15_000)
      ctx.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'bg-trunc',
        status: 'completed',
        rawOutput: { output: "The tool's output was truncated due to being too long. Preview:\nbuild log..." }
      })
      ctx.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '正在执行打包，请稍候。' } })
      ctx.update({ sessionUpdate: 'usage_update', usage: { used: 4000, size: 1048576 } })

      await vi.advanceTimersByTimeAsync(5000)
      expect(ctx.finished).not.toHaveBeenCalled()
      expect(ctx.manager.isRunning('thread')).toBe(true)

      // 2) After wakeup, a truncated SYNCHRONOUS run_command (has Created At + Completed At) finishes right away.
      ctx.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking final status.' } })
      ctx.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'sync-trunc',
        name: 'run_command',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'npm test', WaitMsBeforeAsync: 5000 }
      })
      await vi.advanceTimersByTimeAsync(6000)
      ctx.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'sync-trunc',
        status: 'completed',
        rawOutput: {
          output: "The tool's output was truncated due to being too long.\n\nHere is a preview:\nCreated At: 2026-11-22T23:55:00+08:00\nCompleted At: 2026-11-22T23:55:05+08:00\nCommand exited with code 0."
        }
      })
      ctx.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '打包与测试全部通过。' } })
      ctx.update({ sessionUpdate: 'usage_update', usage: { used: 4500, size: 1048576 } })

      await vi.advanceTimersByTimeAsync(300)
      vi.useRealTimers()
      await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledOnce())
      expect(ctx.finished).toHaveBeenCalledWith(expect.objectContaining({ preview: '打包与测试全部通过。' }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('suppresses premature completion for short schedule timers, mid-stream yielding races, and missing usage_update', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const ctx = setup(true)
      await ctx.manager.send(ctx.req)
      await ctx.waitForPrompt()

      // Enter waitForFollowup via initial schedule.
      ctx.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'sched-init',
        name: 'schedule',
        kind: 'other',
        status: 'in_progress',
        rawInput: { DurationSeconds: 10, Prompt: 'Initial check' }
      })
      ctx.resolvePrompt()
      await vi.advanceTimersByTimeAsync(10)
      ctx.update({ sessionUpdate: 'tool_call_update', toolCallId: 'sched-init', status: 'completed' })

      // Case A: short schedule completes BEFORE interim reply starts, and interim reply omits usage_update.
      ctx.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'sched-short',
        name: 'schedule',
        kind: 'other',
        status: 'in_progress',
        rawInput: { DurationSeconds: 5, Prompt: 'Short wait' }
      })
      ctx.update({ sessionUpdate: 'tool_call_update', toolCallId: 'sched-short', status: 'completed' })
      ctx.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Waiting 5 seconds...' } })
      // Advance past FOLLOWUP_REPLY_MS (2000ms): must transition to awaiting_wakeup (NOT finish!).
      await vi.advanceTimersByTimeAsync(3000)
      expect(ctx.finished).not.toHaveBeenCalled()
      expect(ctx.manager.isRunning('thread')).toBe(true)

      // Case B: background command completes WHILE interim reply is mid-stream (yielding).
      ctx.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'bg-midstream',
        name: 'run_command',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'deploy.sh', WaitMsBeforeAsync: 5000 }
      })
      ctx.update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg-inflight', content: { type: 'text', text: 'Deploying ' } })
      ctx.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'bg-midstream',
        status: 'completed',
        rawOutput: { output: 'Command exited with code 0.\n', exit_code: 0 }
      })
      ctx.update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg-inflight', content: { type: 'text', text: 'now...' } })
      ctx.update({ sessionUpdate: 'usage_update', usage: { used: 3200, size: 1048576 } })
      await vi.advanceTimersByTimeAsync(3000)
      expect(ctx.finished).not.toHaveBeenCalled()
      expect(ctx.manager.isRunning('thread')).toBe(true)

      // Post-wakeup direct reply (without agent_thought_chunk) finishes cleanly.
      ctx.update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg-final', content: { type: 'text', text: '部署完成。' } })
      ctx.update({ sessionUpdate: 'usage_update', usage: { used: 3500, size: 1048576 } })
      await vi.advanceTimersByTimeAsync(300)
      vi.useRealTimers()
      await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledOnce())
      expect(ctx.finished).toHaveBeenCalledWith(expect.objectContaining({ preview: '部署完成。' }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears deferred wakeup when the in-flight step invokes another tool instead of replying, and excludes permission wait time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const ctx = setup(false)
      await ctx.manager.send(ctx.req)
      await ctx.waitForPrompt()

      // Enter waitForFollowup via initial schedule.
      ctx.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'sched-start',
        name: 'schedule',
        kind: 'other',
        status: 'in_progress',
        rawInput: { DurationSeconds: 15, Prompt: 'Wait' }
      })
      ctx.resolvePrompt()
      await vi.advanceTimersByTimeAsync(10)
      ctx.update({ sessionUpdate: 'tool_call_update', toolCallId: 'sched-start', status: 'completed' })

      // Background command finishes while P_inflight is running, then P_inflight calls another tool (not a reply).
      ctx.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'bg-step',
        name: 'run_command',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'python build.py', WaitMsBeforeAsync: 5000 }
      })
      ctx.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'bg-step',
        status: 'completed',
        rawOutput: { output: 'Command exited with code 0.\n', exit_code: 0 }
      })
      ctx.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Running final check tool.' } })

      // Next tool waits 15s for user permission approval, then finishes synchronously in 1s (with non-timestamped output).
      ctx.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'perm-cmd',
        name: 'run_command',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'git status', WaitMsBeforeAsync: 5000 }
      })
      const permPromise = ctx.requestClient('session/request_permission', {
        sessionId: 'agy-session',
        toolCall: { toolCallId: 'perm-cmd', title: 'git status', kind: 'execute' },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' }
        ]
      })
      await vi.advanceTimersByTimeAsync(15_000)
      const question = ctx.items.find((it): it is QuestionItem => it.kind === 'question' && it.status === 'pending')!
      expect(question).toBeDefined()
      ctx.manager.answerQuestion('thread', question.id, [{ questionId: 'q', selectedOptionIds: ['allow_once'] }])
      await expect(permPromise).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } })

      await vi.advanceTimersByTimeAsync(1000)
      ctx.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'perm-cmd',
        status: 'completed',
        rawOutput: { output: 'clean tree' }
      })
      ctx.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '检查完成，工作区干净。' } })
      ctx.update({ sessionUpdate: 'usage_update', usage: { used: 2200, size: 1048576 } })

      await vi.advanceTimersByTimeAsync(300)
      vi.useRealTimers()
      await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledOnce())
      expect(ctx.finished).toHaveBeenCalledWith(expect.objectContaining({ preview: '检查完成，工作区干净。' }))
    } finally {
      vi.useRealTimers()
    }
  })
})
