import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { readCodexUsage, scanCodexSessions } from '../src/main/codex-history'
import { parseCodexUsage } from '../src/main/codex-usage'

const at = (second: number): string => new Date(Date.UTC(2026, 8, 29, 0, 0, second)).toISOString()
const row = (type: string, payload: object, second = 0): string => JSON.stringify({ type, payload, timestamp: at(second) })
const event = (type: string, payload: object = {}, second = 0): string => row('event_msg', { type, ...payload }, second)
const counts = (input: number, cached: number, output: number, written = 0) => ({
  input_tokens: input, cached_input_tokens: cached, output_tokens: output,
  cache_write_input_tokens: written, reasoning_output_tokens: Math.floor(output / 2), total_tokens: input + output
})
const tokens = (total: ReturnType<typeof counts>, last = total, second = 1): string =>
  event('token_count', { info: { total_token_usage: total, last_token_usage: last } }, second)

describe('Codex rollout token usage', () => {
  it('keeps the latest quota snapshot even when its token counters repeat', () => {
    const total = counts(100, 40, 20)
    const snapshot = (percent: number, second: number) => event('token_count', {
      info: { total_token_usage: total, last_token_usage: total },
      rate_limits: {
        limit_id: 'codex', plan_type: 'prolite',
        primary: { used_percent: percent, window_minutes: 10_080, resets_at: 1_800_000_000 },
        secondary: null
      }
    }, second)
    const [turn] = parseCodexUsage([
      event('task_started', { turn_id: 'weekly' }),
      snapshot(36, 1),
      snapshot(37, 2),
      event('task_complete', { turn_id: 'weekly' }, 3)
    ].join('\n'))
    expect(turn.usage.requests).toHaveLength(1)
    expect(turn.quotaSnapshot).toEqual({
      sampledAt: Date.parse(at(2)), weekly: { usedPercent: 37, resetsAt: 1_800_000_000_000 }
    })
  })

  it('updates quota from info=null events, rejects other pools, and never inherits a previous turn snapshot', () => {
    const [first, second] = parseCodexUsage([
      event('task_started', { turn_id: 'first' }),
      tokens(counts(100, 40, 20)),
      event('token_count', {
        info: null,
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 12, window_minutes: 300, resets_at: 1_800_000_000 },
          secondary: { used_percent: 37, window_minutes: 10_080, resets_at: 1_801_000_000 }
        }
      }, 2),
      event('token_count', {
        info: null,
        rate_limits: { limit_id: 'code_review', primary: { used_percent: 99, window_minutes: 300 } }
      }, 3),
      event('task_complete', { turn_id: 'first' }, 4),
      event('task_started', { turn_id: 'second' }, 5),
      tokens(counts(150, 50, 30), counts(50, 10, 10), 6),
      event('task_complete', { turn_id: 'second' }, 7)
    ].join('\n'))
    expect(first.usage.requests).toHaveLength(1)
    expect(first.quotaSnapshot).toEqual({
      sampledAt: Date.parse(at(2)),
      fiveHour: { usedPercent: 12, resetsAt: 1_800_000_000_000 },
      weekly: { usedPercent: 37, resetsAt: 1_801_000_000_000 }
    })
    expect(second.quotaSnapshot).toBeUndefined()
  })

  it('keeps simultaneous sessions token usage independent of their shared account quota', () => {
    const rollout = (session: string, input: number, output: number, percent: number) => [
      row('session_meta', { id: session }),
      event('task_started', { turn_id: `${session}-turn` }),
      event('token_count', {
        info: { total_token_usage: counts(input, 0, output), last_token_usage: counts(input, 0, output) },
        rate_limits: { limit_id: 'codex', primary: { used_percent: percent, window_minutes: 10_080 } }
      }, 1),
      event('task_complete', { turn_id: `${session}-turn` }, 2)
    ].join('\n')
    const first = parseCodexUsage(rollout('first', 100, 20, 37))[0]
    const second = parseCodexUsage(rollout('second', 900, 300, 39))[0]
    expect(first.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 })
    expect(second.usage).toMatchObject({ inputTokens: 900, outputTokens: 300 })
    expect(first.quotaSnapshot?.weekly?.usedPercent).toBe(37)
    expect(second.quotaSnapshot?.weekly?.usedPercent).toBe(39)
    expect(parseCodexUsage(rollout('first', 100, 20, 37))[0]).toEqual(first)
  })

  it('sums requests within each turn, subtracts the previous turn, and deduplicates quota snapshots', () => {
    const text = [
      row('session_meta', { id: 'thread' }),
      event('task_started', { turn_id: 'turn-1' }),
      row('turn_context', { turn_id: 'turn-1', model: 'gpt-5.4' }),
      event('user_message', { message: 'First' }),
      tokens(counts(100, 40, 20, 10)),
      tokens(counts(300, 160, 50, 20), counts(200, 120, 30, 10), 2),
      tokens(counts(300, 160, 50, 20), counts(200, 120, 30, 10), 3),
      event('task_complete', { turn_id: 'turn-1' }, 4),
      event('task_started', { turn_id: 'turn-2' }, 5),
      row('turn_context', { turn_id: 'turn-2', model: 'gpt-5.5' }, 5),
      tokens(counts(600, 360, 90, 20), counts(300, 200, 40), 6),
      event('task_complete', { turn_id: 'turn-2' }, 7)
    ].join('\n')
    const turns = parseCodexUsage(text)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({
      usageId: 'codex:turn-1', turnId: 'turn-1', model: 'gpt-5.4', completed: true, isError: false,
      startedAt: Date.parse(at(0)), createdAt: Date.parse(at(4)), endLine: 7,
      usage: { inputTokens: 120, cacheReadTokens: 160, cacheWriteTokens: 20, outputTokens: 50 }
    })
    expect(turns[0].usage.requests).toEqual([
      { inputTokens: 50, cacheReadTokens: 40, cacheWriteTokens: 10, outputTokens: 20 },
      { inputTokens: 70, cacheReadTokens: 120, cacheWriteTokens: 10, outputTokens: 30 }
    ])
    expect(turns[1]).toMatchObject({
      usageId: 'codex:turn-2', model: 'gpt-5.5',
      usage: { inputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 0, outputTokens: 40 }
    })
  })

  it('groups legacy prompts recorded as both messages and events without counting either twice', () => {
    const text = [
      row('session_meta', { id: 'legacy' }),
      event('user_message', { message: 'One' }),
      row('response_item', { type: 'message', role: 'user', content: 'One' }),
      row('turn_context', { model: 'gpt-5.4' }),
      tokens(counts(100, 20, 10)),
      tokens(counts(200, 70, 30), counts(100, 50, 20)),
      event('agent_message', { message: 'Done' }),
      event('user_message', { message: 'Two' }, 3),
      row('response_item', { type: 'message', role: 'user', content: 'Two' }, 3),
      tokens(counts(350, 120, 50), counts(150, 50, 20), 4)
    ].join('\n')
    const turns = parseCodexUsage(text)
    expect(turns).toHaveLength(2)
    expect(turns.map((turn) => turn.usageId)).toEqual(['codex:legacy:line:1', 'codex:legacy:line:7'])
    expect(turns.map((turn) => turn.usage.inputTokens)).toEqual([130, 100])
    expect(turns.map((turn) => turn.usage.requests!.length)).toEqual([2, 1])
    expect(parseCodexUsage(text)[0].usageId).toBe(turns[0].usageId)
  })

  it('uses turn_context IDs and keeps steering messages inside an explicitly started turn', () => {
    const text = [
      event('task_started'),
      event('user_message', { message: 'Begin' }),
      row('turn_context', { turn_id: 'context-id', model: 'gpt-5.4' }),
      tokens(counts(100, 0, 10)),
      event('user_message', { message: 'Also do this' }),
      row('turn_context', { turn_id: 'context-id', model: 'gpt-5.4' }),
      tokens(counts(210, 20, 30), counts(110, 20, 20)),
      event('task_complete', { turn_id: 'context-id' })
    ].join('\n')
    const turns = parseCodexUsage(text)
    expect(turns).toHaveLength(1)
    expect(turns[0].usageId).toBe('codex:context-id')
    expect(turns[0].usage.requests).toHaveLength(2)
  })

  it('keeps aborted usage and original line positions despite blank and partial lines', () => {
    const text = [
      row('session_meta', { id: 'aborted' }),
      '',
      event('task_started', { turn_id: 'interrupted', started_at: Date.parse(at(0)) / 1000 }),
      '{"type":',
      tokens(counts(100, 70, 20), undefined, 2),
      event('turn_aborted', { turn_id: 'interrupted' }, 3),
      '{"unfinished":'
    ].join('\n')
    const [turn] = parseCodexUsage(text)
    expect(turn).toMatchObject({
      usageId: 'codex:interrupted', completed: true, isError: true,
      startedAt: Date.parse(at(0)), createdAt: Date.parse(at(3)), endLine: 5,
      usage: { inputTokens: 30, cacheReadTokens: 70, outputTokens: 20 }
    })
  })

  it('reports no invented token usage for turns containing only quota snapshots', () => {
    expect(parseCodexUsage([
      event('task_started', { turn_id: 'empty' }),
      event('token_count', { info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: 10, window_minutes: 300 } } }),
      tokens(counts(0, 0, 0)),
      event('task_complete', { turn_id: 'empty' })
    ].join('\n'))).toEqual([])
  })

  it('resets the cumulative baseline after compaction without repeating the previous request', () => {
    const first = counts(500, 200, 50)
    const reset = counts(20, 0, 0)
    const second = counts(100, 40, 10)
    const third = counts(30, 10, 5)
    const [turn] = parseCodexUsage([
      event('task_started', { turn_id: 'compact' }),
      tokens(first),
      event('context_compacted'),
      tokens(reset, first),
      tokens(counts(120, 40, 10), second),
      tokens(third, third),
      event('task_complete', { turn_id: 'compact' })
    ].join('\n'))
    expect(turn.usage).toMatchObject({ inputTokens: 380, cacheReadTokens: 250, outputTokens: 65 })
    expect(turn.usage.requests).toHaveLength(3)
    for (const request of turn.usage.requests!) {
      expect(Object.values(request).every((value) => value >= 0)).toBe(true)
    }
  })

  it('excludes inherited cumulative usage when a fork omits the parent token events', () => {
    const [turn] = parseCodexUsage([
      row('session_meta', { id: 'fork', forked_from_id: 'parent' }),
      event('task_started', { turn_id: 'fork-turn' }),
      tokens(counts(1100, 850, 120), counts(100, 50, 20)),
      tokens(counts(1300, 1000, 150), counts(200, 150, 30)),
      event('task_complete', { turn_id: 'fork-turn' })
    ].join('\n'))
    expect(turn.usage).toMatchObject({ inputTokens: 100, cacheReadTokens: 200, outputTokens: 50 })
    expect(turn.usage.requests).toHaveLength(2)
  })

  it('uses the first inherited snapshot as a baseline when its last request is unavailable', () => {
    const [turn] = parseCodexUsage([
      row('session_meta', { id: 'fork', forked_from_id: 'parent' }),
      event('task_started', { turn_id: 'fork-turn' }),
      event('token_count', { info: { total_token_usage: counts(1000, 800, 100) } }),
      tokens(counts(1100, 850, 120), counts(100, 50, 20)),
      event('task_complete', { turn_id: 'fork-turn' })
    ].join('\n'))
    expect(turn.usage).toMatchObject({ inputTokens: 50, cacheReadTokens: 50, outputTokens: 20 })
    expect(turn.usage.requests).toHaveLength(1)
  })

  it('preserves the original start time when an existing turn start is replayed', () => {
    const [turn] = parseCodexUsage([
      event('task_started', { turn_id: 'replayed' }, 0),
      tokens(counts(100, 20, 10)),
      event('task_started', { turn_id: 'replayed' }, 5),
      tokens(counts(200, 70, 30), counts(100, 50, 20), 6),
      event('task_complete', { turn_id: 'replayed' }, 7)
    ].join('\n'))
    expect(turn).toMatchObject({ usageId: 'codex:replayed', startedAt: Date.parse(at(0)), createdAt: Date.parse(at(7)) })
    expect(turn.usage.requests).toHaveLength(2)
  })

  it('reads an explicitly configured CODEX_HOME and tolerates missing rollouts', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-test-'))
    vi.stubEnv('CODEX_HOME', temp)
    try {
      fs.mkdirSync(path.join(temp, 'sessions'))
      fs.writeFileSync(path.join(temp, 'sessions', 'rollout-custom.jsonl'), [
        row('session_meta', { id: 'custom' }),
        event('task_started', { turn_id: 'custom-turn' }),
        tokens(counts(20, 0, 10)),
        event('task_complete', { turn_id: 'custom-turn' })
      ].join('\n'))
      expect(readCodexUsage('custom')?.[0].usageId).toBe('codex:custom-turn')
      expect(readCodexUsage('missing')).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })

  it('reads a named session without opening unrelated rollouts, including a long custom header', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-test-'))
    const sessions = path.join(temp, 'sessions', '2026', '03', '13')
    const namedId = '019ce705-9bed-7ac0-8d1e-c5098e8a1398'
    const otherId = '019ce754-6cdb-7691-8957-d33b58971e15'
    const namedFile = path.join(sessions, `rollout-2026-03-13T19-47-10-${namedId}.jsonl`)
    const otherFile = path.join(sessions, `rollout-2026-03-13T21-13-15-${otherId}.jsonl`)
    vi.stubEnv('CODEX_HOME', temp)
    const opened = vi.spyOn(fs, 'openSync')
    try {
      fs.mkdirSync(sessions, { recursive: true })
      const rollout = (id: string, turn: string): string => [
        row('session_meta', { id, cwd: temp, note: 'x'.repeat(20_000) }),
        event('task_started', { turn_id: turn }),
        tokens(counts(20, 0, 10)),
        event('task_complete', { turn_id: turn })
      ].join('\n')
      fs.writeFileSync(namedFile, rollout(namedId, 'named-turn'))
      fs.writeFileSync(otherFile, rollout(otherId, 'other-turn'))
      fs.writeFileSync(path.join(temp, 'sessions', 'rollout-wide.jsonl'), rollout('wide', 'wide-turn'))
      opened.mockClear()

      expect(readCodexUsage(namedId)?.[0].usageId).toBe('codex:named-turn')
      expect(readCodexUsage('wide')?.[0].usageId).toBe('codex:wide-turn')
      expect(readCodexUsage('missing-session')).toBeUndefined()

      const paths = opened.mock.calls.map((call) => path.normalize(String(call[0])))
      expect(paths).toContain(path.normalize(path.join(temp, 'sessions', 'rollout-wide.jsonl')))
      expect(paths).not.toContain(path.normalize(namedFile))
      expect(paths).not.toContain(path.normalize(otherFile))
    } finally {
      opened.mockRestore()
      vi.unstubAllEnvs()
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })

  it('uses a header id that is not in the filename after sessions are listed', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-test-'))
    const sessions = path.join(temp, 'sessions')
    const fileId = '019ce767-a8e1-7513-8f54-389cf0280799'
    const headerId = '01a02a0e-035d-7e10-bf94-f91a8b85b319'
    vi.stubEnv('CODEX_HOME', temp)
    try {
      fs.mkdirSync(sessions)
      fs.writeFileSync(path.join(sessions, `rollout-2026-03-13T21-34-16-${fileId}.jsonl`), [
        row('session_meta', { id: headerId, cwd: temp }),
        event('task_started', { turn_id: 'alias-turn' }),
        tokens(counts(20, 0, 10)),
        event('task_complete', { turn_id: 'alias-turn' })
      ].join('\n'))
      expect(scanCodexSessions(new Set()).map((session) => session.chatId)).toEqual([headerId])
      expect(readCodexUsage(headerId)?.[0].usageId).toBe('codex:alias-turn')
      expect(readCodexUsage(fileId)?.[0].usageId).toBe('codex:alias-turn')
    } finally {
      vi.unstubAllEnvs()
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })

  it('finds a mismatched header id without reading every rollout before the lookup returns', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-test-'))
    const sessions = path.join(temp, 'sessions')
    const fileId = '01a098b5-986d-71c1-8f78-720729d88013'
    const headerId = '01a098b3-6924-7a12-ab79-d282dca58943'
    const decoyId = '01a02d52-2d8b-7ea3-b55c-d63fa2d6b973'
    vi.stubEnv('CODEX_HOME', temp)
    const opened = vi.spyOn(fs, 'openSync')
    try {
      fs.mkdirSync(sessions)
      const body = (id: string, turn: string): string => [
        row('session_meta', { id, cwd: temp }),
        event('task_started', { turn_id: turn }),
        tokens(counts(20, 0, 10)),
        event('task_complete', { turn_id: turn })
      ].join('\n')
      fs.writeFileSync(path.join(sessions, `rollout-2026-03-13T21-41-30-${fileId}.jsonl`), body(headerId, 'late-alias'))
      fs.writeFileSync(path.join(sessions, `rollout-2026-03-13T21-56-41-${decoyId}.jsonl`), body(decoyId, 'decoy'))
      opened.mockClear()

      expect(readCodexUsage(headerId)).toBeUndefined()
      expect(opened).not.toHaveBeenCalled()

      await vi.waitFor(() => {
        expect(readCodexUsage(headerId)?.[0].usageId).toBe('codex:late-alias')
      })
    } finally {
      opened.mockRestore()
      vi.unstubAllEnvs()
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })
})
