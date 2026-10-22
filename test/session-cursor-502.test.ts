import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type CliProvider, type Item, type SendRequest, type ThreadMeta } from '../src/shared/types'
import { spawnProvider } from '../src/main/session/provider'
import { isCodexModelCapacity, isCursorRetriableDisconnect, SessionManager } from '../src/main/sessions'
import type { Store } from '../src/main/store'

vi.mock('../src/main/turn-files', () => ({ snapshotTurnFiles: vi.fn(async () => []), changedTurnFiles: vi.fn(async () => []) }))
vi.mock('../src/main/skills', () => ({ syncAllManagedSkills: vi.fn() }))
vi.mock('../src/main/git', () => ({ createWorktree: vi.fn() }))
vi.mock('../src/main/session/provider', async (original) => ({
  ...await original<typeof import('../src/main/session/provider')>(),
  resolveLaunch: () => ({ cli: { command: 'mock-agent', prefixArgs: [] } }),
  providerApiKey: () => 'mock-key',
  spawnProvider: vi.fn()
}))
vi.mock('../src/main/cli', async (original) => ({
  ...await original<typeof import('../src/main/cli')>(),
  killTree: vi.fn((child: ChildProcess) => {
    Object.assign(child, { exitCode: 0 })
    child.emit('close', 0)
  })
}))

const HTTP_502 = 'Error: RetriableError: [unavailable] HTTP 502'
const HTTP2_CANCEL = 'Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)'
const CODEX_CAPACITY = 'Selected model is at capacity. Please try a different model.'

interface RpcMessage {
  id?: number | string
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string }
}

const managers: SessionManager[] = []

function setup(provider: CliProvider = 'cursor') {
  const prompts: Array<{ text: string }> = []
  const calls: RpcMessage[] = []
  let onPrompt: (id: number | string, child: ChildProcess) => void = (id) => {
    reply(childOf(id), { id, result: { stopReason: 'end_turn' } })
  }
  const children: ChildProcess[] = []
  const reply = (child: ChildProcess, message: RpcMessage) => {
    ;(child.stdout as PassThrough).write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }
  const childOf = (_id: number | string) => children.at(-1)!
  vi.mocked(spawnProvider).mockImplementation(() => {
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdout, stderr: new PassThrough(), exitCode: null,
      stdin: new Writable({ write(chunk, _encoding, callback) {
        for (const line of chunk.toString().split(/\n/)) {
          if (!line.trim()) continue
          const message: RpcMessage = JSON.parse(line)
          calls.push(message)
          if (message.method === 'session/prompt') {
            prompts.push({ text: message.params.prompt[0].text })
            onPrompt(message.id!, child)
          } else if (message.method && message.id !== undefined) {
            reply(child, { id: message.id, result: message.method === 'session/new' ? { sessionId: 'test-session' } : {} })
          }
        }
        callback()
      } })
    }) as unknown as ChildProcess
    children.push(child)
    return child
  })
  const thread = { id: 'thread', projectId: 'project', cli: provider, mode: 'agent', title: 'Task' } as ThreadMeta
  const items: Item[] = []
  const store = {
    dataDir: os.tmpdir(), settings: { ...DEFAULT_SETTINGS },
    thread: (id: string) => id === thread.id ? thread : undefined,
    project: () => ({ id: 'project', path: os.tmpdir() }),
    items: () => items, markItemsDirty: vi.fn(),
    updateThread: vi.fn((_id: string, patch: Partial<ThreadMeta>) => Object.assign(thread, patch))
  }
  const finished: Array<{ failed: boolean; stopped: boolean }> = []
  const manager = new SessionManager(store as unknown as Store, vi.fn(), vi.fn(), (info) => {
    finished.push({ failed: info.failed, stopped: info.stopped })
  })
  managers.push(manager)
  const send = (prompt = '修复这个报错', extra: Partial<SendRequest> = {}) =>
    manager.send({ threadId: thread.id, prompt, model: 'auto', mode: 'agent', force: false, ...extra })
  return {
    manager, send, prompts, calls, items, finished, children,
    setPrompt(handler: (id: number | string, child: ChildProcess, index: number) => void) {
      onPrompt = (id, child) => handler(id, child, prompts.length)
    },
    reply,
    notice: (level: 'info' | 'error') => items.filter((item) => item.kind === 'notice' && item.level === level),
    idle: () => vi.waitFor(() => expect(manager.isRunning('thread')).toBe(false))
  }
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.stopAll()
})

describe('isCursorRetriableDisconnect', () => {
  it('matches a short Cursor HTTP 502 or http/2 CANCEL failure', () => {
    expect(isCursorRetriableDisconnect(`  ${HTTP_502}\n`)).toBe(true)
    expect(isCursorRetriableDisconnect('RetriableError: [unavailable] HTTP502')).toBe(true)
    expect(isCursorRetriableDisconnect(HTTP2_CANCEL)).toBe(true)
    expect(isCursorRetriableDisconnect('RetriableError: [canceled] stream closed')).toBe(true)
    expect(isCursorRetriableDisconnect('RetriableError: [unavailable]')).toBe(false)
    expect(isCursorRetriableDisconnect('HTTP 502')).toBe(false)
    expect(isCursorRetriableDisconnect('RetriableError: [canceled]')).toBe(false)
    expect(isCursorRetriableDisconnect(`${'已经完成了一段很长的说明。'.repeat(40)}\n${HTTP_502}`)).toBe(false)
    expect(isCursorRetriableDisconnect(`${'已经完成了一段很长的说明。'.repeat(40)}\n${HTTP2_CANCEL}`)).toBe(false)
    expect(isCursorRetriableDisconnect(undefined)).toBe(false)
  })
})

describe('Cursor HTTP 502 continue', () => {
  it.each([HTTP_502, HTTP2_CANCEL])('sends one 继续 on the same process after %s', async (failure) => {
    const ctx = setup()
    ctx.setPrompt((id, child, index) => {
      ctx.reply(child, index === 1
        ? { id, error: { code: -32603, message: failure } }
        : { id, result: { stopReason: 'end_turn' } })
    })
    await ctx.send()
    await ctx.idle()
    expect(ctx.prompts.map((prompt) => prompt.text)).toEqual(['修复这个报错', '继续'])
    expect(spawnProvider).toHaveBeenCalledTimes(1)
    expect(ctx.notice('info').map((item) => item.kind === 'notice' ? item.text : '')).toEqual(['Cursor 连接中断，正在发送「继续」。'])
    expect(ctx.notice('error')).toEqual([])
    expect(ctx.finished.map((info) => info.failed)).toEqual([false, false])
  })

  it('shows the error when the automatic continue fails the same way', async () => {
    const ctx = setup()
    ctx.setPrompt((id, child) => {
      ctx.reply(child, { id, error: { code: -32603, message: HTTP_502 } })
    })
    await ctx.send()
    await ctx.idle()
    expect(ctx.prompts.map((prompt) => prompt.text)).toEqual(['修复这个报错', '继续'])
    expect(ctx.notice('error').at(-1)).toMatchObject({ text: HTTP_502 })
    expect(ctx.finished.map((info) => info.failed)).toEqual([false, true])
  })

  it('sends 继续 when the whole assistant reply is the error', async () => {
    const ctx = setup()
    ctx.setPrompt((id, child, index) => {
      if (index === 1) {
        ctx.reply(child, { method: 'session/update', params: { sessionId: 'test-session', update: {
          sessionUpdate: 'agent_message_chunk', content: { text: HTTP_502 }
        } } })
      }
      ctx.reply(child, { id, result: { stopReason: 'end_turn' } })
    })
    await ctx.send()
    await ctx.idle()
    expect(ctx.prompts.map((prompt) => prompt.text)).toEqual(['修复这个报错', '继续'])
    expect(ctx.notice('error')).toEqual([])
  })

  it('shows the error when the continue reply is the same short failure', async () => {
    const ctx = setup()
    ctx.setPrompt((id, child) => {
      ctx.reply(child, { method: 'session/update', params: { sessionId: 'test-session', update: {
        sessionUpdate: 'agent_message_chunk', content: { text: HTTP_502 }
      } } })
      ctx.reply(child, { id, result: { stopReason: 'end_turn' } })
    })
    await ctx.send()
    await ctx.idle()
    expect(ctx.prompts).toHaveLength(2)
    expect(ctx.notice('error').at(-1)).toMatchObject({ text: HTTP_502 })
    expect(ctx.items.filter((item) => item.kind === 'result').at(-1)).toMatchObject({ isError: true })
    expect(ctx.finished.at(-1)?.failed).toBe(true)
  })

  it('does not continue after the user stops the turn', async () => {
    const ctx = setup()
    let answer: ((id: number | string) => void) | undefined
    ctx.setPrompt((id) => {
      answer = () => ctx.reply(ctx.children.at(-1)!, { id, error: { code: -32603, message: HTTP_502 } })
    })
    const pending = ctx.send()
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'))
    ctx.manager.stop('thread')
    answer!(1)
    await pending
    await ctx.idle()
    expect(ctx.prompts).toHaveLength(1)
    expect(ctx.notice('info').map((item) => item.kind === 'notice' ? item.text : '')).toContain('已停止')
    expect(ctx.finished).toEqual([{ failed: true, stopped: true }])
  })

  it('leaves a long reply that mentions the error alone', async () => {
    const ctx = setup()
    const long = `${'已经查过日志，连接偶尔会中断。'.repeat(30)}\n${HTTP_502}`
    ctx.setPrompt((id, child) => {
      ctx.reply(child, { method: 'session/update', params: { sessionId: 'test-session', update: {
        sessionUpdate: 'agent_message_chunk', content: { text: long }
      } } })
      ctx.reply(child, { id, result: { stopReason: 'end_turn' } })
    })
    await ctx.send()
    await ctx.idle()
    expect(ctx.prompts).toHaveLength(1)
    expect(ctx.notice('info')).toEqual([])
  })

  it('reloads a saved session when the process exits on the error', async () => {
    const ctx = setup()
    ctx.setPrompt((id, child, index) => {
      if (index === 1) {
        ctx.reply(child, { id, error: { code: -32603, message: HTTP_502 } })
        Object.assign(child, { exitCode: 1 })
        child.emit('close', 1)
        return
      }
      ctx.reply(child, { id, result: { stopReason: 'end_turn' } })
    })
    await ctx.send()
    await ctx.idle()
    expect(ctx.prompts.map((prompt) => prompt.text)).toEqual(['修复这个报错', '继续'])
    expect(spawnProvider).toHaveBeenCalledTimes(2)
    expect(ctx.calls.some((call) => call.method === 'session/load')).toBe(true)
  })

  it('sends the queued message after the continue, not instead of it', async () => {
    const ctx = setup()
    let answerFirst: (() => void) | undefined
    ctx.setPrompt((id, child, index) => {
      if (index === 1) answerFirst = () => ctx.reply(child, { id, error: { code: -32603, message: HTTP_502 } })
      else ctx.reply(child, { id, result: { stopReason: 'end_turn' } })
    })
    const pending = ctx.send()
    await vi.waitFor(() => expect(answerFirst).toBeTypeOf('function'))
    await ctx.send('排队的下一条', { delivery: 'queue' })
    answerFirst!()
    await pending
    await ctx.idle()
    expect(ctx.prompts.map((prompt) => prompt.text)).toEqual(['修复这个报错', '继续', '排队的下一条'])
  })

  it.each(['codex', 'claude'] as const)('does not continue a %s turn', async (provider) => {
    const ctx = setup(provider)
    ctx.setPrompt((id, child) => {
      ctx.reply(child, { id, error: { code: -32603, message: HTTP_502 } })
    })
    await ctx.send()
    await ctx.idle()
    expect(ctx.prompts).toHaveLength(1)
    expect(ctx.notice('error').at(-1)).toMatchObject({ text: HTTP_502 })
    expect(ctx.finished).toEqual([{ failed: true, stopped: false }])
  })
})

describe('isCodexModelCapacity', () => {
  it('matches a short Codex capacity failure', () => {
    expect(isCodexModelCapacity(`  ${CODEX_CAPACITY}\n`)).toBe(true)
    expect(isCodexModelCapacity(`Error: ${CODEX_CAPACITY}`)).toBe(true)
    expect(isCodexModelCapacity('Selected model is at capacity')).toBe(true)
    expect(isCodexModelCapacity("You've hit your usage limit.")).toBe(false)
    expect(isCodexModelCapacity(`${'已经完成了一段很长的说明。'.repeat(40)}\n${CODEX_CAPACITY}`)).toBe(false)
    expect(isCodexModelCapacity(undefined)).toBe(false)
  })
})

describe('Codex model capacity continue', () => {
  const replyWithCapacity = (ctx: ReturnType<typeof setup>) => {
    ctx.setPrompt((id, child, index) => {
      if (index === 1) {
        ctx.reply(child, { method: 'session/update', params: { sessionId: 'test-session', update: {
          sessionUpdate: 'agent_message_chunk', content: { text: CODEX_CAPACITY }
        } } })
      }
      ctx.reply(child, { id, result: { stopReason: 'end_turn' } })
    })
  }

  it('sends one 继续 on the same process when the whole reply is the capacity error', async () => {
    const ctx = setup('codex')
    replyWithCapacity(ctx)
    await ctx.send()
    await ctx.idle()
    expect(ctx.prompts.map((prompt) => prompt.text)).toEqual(['修复这个报错', '继续'])
    expect(spawnProvider).toHaveBeenCalledTimes(1)
    expect(ctx.notice('info').map((item) => item.kind === 'notice' ? item.text : '')).toEqual(['Codex 所选模型已满载，正在发送「继续」。'])
    expect(ctx.notice('error')).toEqual([])
    expect(ctx.finished.map((info) => info.failed)).toEqual([false, false])
  })

  it('sends one 继续 when the prompt is rejected with the capacity error', async () => {
    const ctx = setup('codex')
    ctx.setPrompt((id, child, index) => {
      ctx.reply(child, index === 1
        ? { id, error: { code: -32603, message: CODEX_CAPACITY } }
        : { id, result: { stopReason: 'end_turn' } })
    })
    await ctx.send()
    await ctx.idle()
    expect(ctx.prompts.map((prompt) => prompt.text)).toEqual(['修复这个报错', '继续'])
    expect(spawnProvider).toHaveBeenCalledTimes(1)
    expect(ctx.notice('error')).toEqual([])
    expect(ctx.finished.map((info) => info.failed)).toEqual([false, false])
  })

  it('shows the error when the automatic continue fails the same way', async () => {
    const ctx = setup('codex')
    ctx.setPrompt((id, child) => {
      ctx.reply(child, { method: 'session/update', params: { sessionId: 'test-session', update: {
        sessionUpdate: 'agent_message_chunk', content: { text: CODEX_CAPACITY }
      } } })
      ctx.reply(child, { id, result: { stopReason: 'end_turn' } })
    })
    await ctx.send()
    await ctx.idle()
    expect(ctx.prompts).toHaveLength(2)
    expect(ctx.notice('error').at(-1)).toMatchObject({ text: CODEX_CAPACITY })
    expect(ctx.items.filter((item) => item.kind === 'result').at(-1)).toMatchObject({ isError: true })
    expect(ctx.finished.at(-1)?.failed).toBe(true)
  })

  it('shows the error when the continue prompt is rejected the same way', async () => {
    const ctx = setup('codex')
    ctx.setPrompt((id, child) => {
      ctx.reply(child, { id, error: { code: -32603, message: CODEX_CAPACITY } })
    })
    await ctx.send()
    await ctx.idle()
    expect(ctx.prompts.map((prompt) => prompt.text)).toEqual(['修复这个报错', '继续'])
    expect(ctx.notice('error').at(-1)).toMatchObject({ text: CODEX_CAPACITY })
    expect(ctx.finished.map((info) => info.failed)).toEqual([false, true])
  })

  it('does not continue after the user stops the turn', async () => {
    const ctx = setup('codex')
    let answer: ((id: number | string) => void) | undefined
    ctx.setPrompt((id) => {
      answer = () => {
        ctx.reply(ctx.children.at(-1)!, { method: 'session/update', params: { sessionId: 'test-session', update: {
          sessionUpdate: 'agent_message_chunk', content: { text: CODEX_CAPACITY }
        } } })
        ctx.reply(ctx.children.at(-1)!, { id, result: { stopReason: 'end_turn' } })
      }
    })
    const pending = ctx.send()
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'))
    ctx.manager.stop('thread')
    answer!(1)
    await pending
    await ctx.idle()
    expect(ctx.prompts).toHaveLength(1)
    expect(ctx.notice('info').map((item) => item.kind === 'notice' ? item.text : '')).toContain('已停止')
    expect(ctx.finished).toEqual([{ failed: false, stopped: true }])
  })

  it('leaves a long reply that mentions the error alone', async () => {
    const ctx = setup('codex')
    const long = `${'已经查过日志，模型偶尔会满载。'.repeat(30)}\n${CODEX_CAPACITY}`
    ctx.setPrompt((id, child) => {
      ctx.reply(child, { method: 'session/update', params: { sessionId: 'test-session', update: {
        sessionUpdate: 'agent_message_chunk', content: { text: long }
      } } })
      ctx.reply(child, { id, result: { stopReason: 'end_turn' } })
    })
    await ctx.send()
    await ctx.idle()
    expect(ctx.prompts).toHaveLength(1)
    expect(ctx.notice('info')).toEqual([])
  })

  it('reloads a saved session when the process exits on the error', async () => {
    const ctx = setup('codex')
    ctx.setPrompt((id, child, index) => {
      if (index === 1) {
        ctx.reply(child, { id, error: { code: -32603, message: CODEX_CAPACITY } })
        Object.assign(child, { exitCode: 1 })
        child.emit('close', 1)
        return
      }
      ctx.reply(child, { id, result: { stopReason: 'end_turn' } })
    })
    await ctx.send()
    await ctx.idle()
    expect(ctx.prompts.map((prompt) => prompt.text)).toEqual(['修复这个报错', '继续'])
    expect(spawnProvider).toHaveBeenCalledTimes(2)
    expect(ctx.calls.some((call) => call.method === 'session/load')).toBe(true)
  })

  it('sends the queued message after the continue, not instead of it', async () => {
    const ctx = setup('codex')
    let answerFirst: (() => void) | undefined
    ctx.setPrompt((id, child, index) => {
      if (index === 1) {
        answerFirst = () => {
          ctx.reply(child, { method: 'session/update', params: { sessionId: 'test-session', update: {
            sessionUpdate: 'agent_message_chunk', content: { text: CODEX_CAPACITY }
          } } })
          ctx.reply(child, { id, result: { stopReason: 'end_turn' } })
        }
      } else ctx.reply(child, { id, result: { stopReason: 'end_turn' } })
    })
    const pending = ctx.send()
    await vi.waitFor(() => expect(answerFirst).toBeTypeOf('function'))
    await ctx.send('排队的下一条', { delivery: 'queue' })
    answerFirst!()
    await pending
    await ctx.idle()
    expect(ctx.prompts.map((prompt) => prompt.text)).toEqual(['修复这个报错', '继续', '排队的下一条'])
  })

  it.each(['cursor', 'claude'] as const)('does not continue a %s turn', async (provider) => {
    const ctx = setup(provider)
    ctx.setPrompt((id, child) => {
      ctx.reply(child, { method: 'session/update', params: { sessionId: 'test-session', update: {
        sessionUpdate: 'agent_message_chunk', content: { text: CODEX_CAPACITY }
      } } })
      ctx.reply(child, { id, result: { stopReason: 'end_turn' } })
    })
    await ctx.send()
    await ctx.idle()
    expect(ctx.prompts).toHaveLength(1)
    expect(ctx.notice('info')).toEqual([])
    expect(ctx.finished).toEqual([{ failed: false, stopped: false }])
  })
})
