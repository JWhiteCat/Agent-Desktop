import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { AcpConnection } from '../src/main/acp'
import { VisibleStreamRecorder, estimateVisibleTokens } from '../src/main/visible-stream'
import { TurnTiming } from '../src/main/turn-timing'

const chunk = (text: string, messageId?: string) => ({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } })

describe('visible stream BPE estimate', () => {
  it('uses real fixed BPE tokens for English, CJK and special-looking text, not characters or chunks', () => {
    expect(estimateVisibleTokens('hello world')).toBe(2)
    expect(estimateVisibleTokens('你好世界')).toBe(5)
    expect(estimateVisibleTokens('🙂 hello <|endoftext|>')).toBe(9)
  })

  it.each([undefined, 'codex-item-id', 'claude-message-id'])('measures ordinary anonymous/identified provider streams (%s)', (id) => {
    const stream = new VisibleStreamRecorder()
    stream.observe(chunk('Initial batch', id), 100)
    stream.observe(chunk('hello', id), 600)
    stream.observe(chunk(' world', id), 1100)
    expect(stream.finish()).toEqual({ tokenizer: 'cl100k_base', tokens: 2, durationMs: 1000, segments: 1, excludedSegments: 0 })
  })

  it('excludes every line in the first delivery batch and tokenizes concatenated subsequent chunks once', () => {
    const stream = new VisibleStreamRecorder()
    const count = vi.fn(estimateVisibleTokens)
    stream.observe(chunk('first'), 10)
    stream.observe(chunk(' batch'), 10)
    stream.observe(chunk('h'), 210)
    stream.observe(chunk('ell'), 410)
    stream.observe(chunk('o world'), 1010)
    expect(stream.finish(count)?.tokens).toBe(2)
    expect(count).toHaveBeenCalledExactlyOnceWith('hello world')
  })

  it('handles BPE and Unicode boundaries without subtracting retokenized prefix counts', () => {
    const stream = new VisibleStreamRecorder()
    stream.observe(chunk('hel'), 0)
    stream.observe(chunk('lo 你'), 300)
    stream.observe(chunk('好\uD83D'), 600)
    stream.observe(chunk('\uDE42'), 1000)
    expect(stream.finish()?.tokens).toBe(estimateVisibleTokens('lo 你好🙂'))
    const split = new VisibleStreamRecorder()
    split.observe(chunk('start \uD83D'), 0)
    split.observe(chunk('\uDE42 hello'), 500)
    expect(split.finish()?.tokens).toBe(estimateVisibleTokens('🙂 hello'))
  })

  it('weights qualified segments by their own intervals, excluding tool/thought gaps and first batches', () => {
    const stream = new VisibleStreamRecorder()
    stream.observe(chunk('first', 'a'), 0)
    stream.observe(chunk(' hello', 'a'), 500)
    stream.observe({ sessionUpdate: 'tool_call' }, 1000)
    stream.observe({ sessionUpdate: 'tool_call_update' }, 9000)
    stream.observe(chunk('new first', 'a'), 10000) // a reused ID after a tool is a new segment
    stream.observe(chunk(' world', 'a'), 11500)
    stream.observe({ sessionUpdate: 'agent_thought_chunk', content: { text: 'hidden' } }, 12000)
    stream.observe(chunk('commentary', 'b'), 13000)
    stream.observe(chunk('final', 'c'), 14000) // new message, not joined to the previous one
    expect(stream.finish()).toEqual({ tokenizer: 'cl100k_base', tokens: 2, durationMs: 2000, segments: 2, excludedSegments: 2 })
  })

  it('does not combine interleaved parallel identities or Claude subagent text', () => {
    const stream = new VisibleStreamRecorder()
    stream.observe(chunk('A', 'a'), 0)
    stream.observe(chunk('B', 'b'), 500)
    stream.observe(chunk('A2', 'a'), 1000)
    stream.observe({ ...chunk('subagent'), _meta: { claudeCode: { parentToolUseId: 'tool' } } }, 1500)
    stream.observe(chunk('A3', 'a'), 2000)
    expect(stream.finish()).toBeUndefined()
  })

  it.each([0, 1, 99])('suppresses single/burst batches with only %s ms of evidence', (elapsed) => {
    const stream = new VisibleStreamRecorder()
    stream.observe(chunk('hello'), 0)
    stream.observe(chunk(' world'), elapsed)
    expect(stream.finish()).toBeUndefined()
  })

  it('suppresses oversized or failed-tokenizer samples rather than breaking a turn', () => {
    const large = new VisibleStreamRecorder()
    large.observe(chunk('start'), 0)
    large.observe(chunk('x'.repeat(200001)), 200)
    expect(large.finish()).toBeUndefined()
    expect(() => estimateVisibleTokens('x'.repeat(1024))).toThrow('tokenizer budget')
    const failed = new VisibleStreamRecorder()
    failed.observe(chunk('start'), 0)
    failed.observe(chunk('hello'), 500)
    expect(failed.finish(() => { throw Error('unavailable') })).toBeUndefined()
  })

  it('interrupts at permission/user waits and suppresses cancelled turns', () => {
    let now = 0
    const timer = new TurnTiming(() => now)
    timer.observe(chunk('first'))
    now = 500; timer.observe(chunk(' hello'))
    timer.interrupt()
    now = 9000; timer.observe(chunk('after wait'))
    now = 10000
    expect(timer.finish('completed').visibleStream).toMatchObject({ tokens: 1, durationMs: 500, segments: 1 })
    const cancelled = new TurnTiming(() => now)
    cancelled.observe(chunk('first'))
    now += 500; cancelled.observe(chunk(' hello'))
    expect(cancelled.finish('cancelled').visibleStream).toBeUndefined()
  })

  it('does not count subagent text as first visible main-agent output', () => {
    let now = 0
    const timer = new TurnTiming(() => now)
    now = 500
    timer.observe({ ...chunk('subagent'), _meta: { claudeCode: { parentToolUseId: 'tool' } } })
    now = 1000
    expect(timer.finish('completed').firstVisibleOutputMs).toBeUndefined()
  })
})

describe('ACP delivery batching', () => {
  it('assigns one arrival time to every JSON line in the same stdout delivery', () => {
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdout, stdin: new PassThrough() }) as unknown as ChildProcess
    const connection = new AcpConnection(child)
    const notify = vi.fn()
    connection.start({ onNotification: notify, onRequest: async () => ({}) })
    const line = (text: string) => JSON.stringify({ method: 'session/update', params: { update: chunk(text) } }) + '\n'
    stdout.write(line('first') + line('second'))
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[0][2]).toBe(notify.mock.calls[1][2])
    const stream = new VisibleStreamRecorder()
    for (const [, params, at] of notify.mock.calls) stream.observe(params.update, at)
    expect(stream.finish()).toBeUndefined()
  })
})
