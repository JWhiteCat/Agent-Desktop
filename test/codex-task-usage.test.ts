import { describe, expect, it } from 'vitest'
import { parseCodexSessionUsage } from '../src/shared/codex-account'

const threadId = 'thread-a'
const dataAsOf = '2026-09-29T12:34:56.123456Z'

function response(fields: Record<string, unknown> = {}): { data_as_of: string; threads: Record<string, unknown>[] } {
  return {
    data_as_of: dataAsOf,
    threads: [{ thread_id: threadId, data_status: 'available', ...fields }]
  }
}

describe('Codex consumer session usage', () => {
  it('reads the real weekly percentage without manufacturing an absent five-hour window', () => {
    expect(parseCodexSessionUsage(response({
      weekly_limit_percent: 18.899578816199377,
      five_hour_limit_percent: null,
      balance_usage_credits: '0E-10'
    }), threadId)).toEqual({
      threadId, status: 'available', weekly: 18.899578816199377, balanceCredits: '0E-10', dataAsOf
    })
  })

  it('preserves explicit zeros and percentages above a single allowance', () => {
    expect(parseCodexSessionUsage(response({ weekly_limit_percent: 150.25, five_hour_limit_percent: 0 }), threadId))
      .toEqual({ threadId, status: 'available', weekly: 150.25, fiveHour: 0, dataAsOf })
    expect(parseCodexSessionUsage(response({ weekly_limit_percent: 0 }), threadId))
      .toEqual({ threadId, status: 'available', weekly: 0, dataAsOf })
    expect(parseCodexSessionUsage(response({ five_hour_limit_percent: 0.125 }), threadId))
      .toEqual({ threadId, status: 'available', fiveHour: 0.125, dataAsOf })
  })

  it.each(['-0.000000000000000001', '1.000000000000000002', '0E-10', '-1E+3', '1e-20', '0'])
    ('retains the exact decimal credits string %s', (credits) => {
      expect(parseCodexSessionUsage(response({ balance_usage_credits: credits }), threadId))
        .toEqual({ threadId, status: 'available', balanceCredits: credits, dataAsOf })
    })

  it.each(['NaN', 'Infinity', '-Infinity', '1..0', '', ' ', ' 1', '1 ', '1e', '+', '0x10', '1/2', 0, null, undefined, '1'.repeat(129)])
    ('does not treat invalid credits %s as a zero debit', (credits) => {
      expect(parseCodexSessionUsage(response({ balance_usage_credits: credits }), threadId))
        .toEqual({ threadId, status: 'unavailable', dataAsOf })
    })

  it.each([null, undefined, -0.1, Infinity, NaN, '0', {}, []])
    ('ignores invalid allowance values %s while retaining other amounts', (weekly) => {
      expect(parseCodexSessionUsage(response({ weekly_limit_percent: weekly, five_hour_limit_percent: 0.5 }), threadId))
        .toEqual({ threadId, status: 'available', fiveHour: 0.5, dataAsOf })
    })

  it('keeps partial readings distinguishable and ignores stale unavailable amounts', () => {
    expect(parseCodexSessionUsage(response({ data_status: 'partial', weekly_limit_percent: 2.1 }), threadId))
      .toEqual({ threadId, status: 'partial', weekly: 2.1, dataAsOf })
    expect(parseCodexSessionUsage(response({
      data_status: 'unavailable', weekly_limit_percent: 2.1, five_hour_limit_percent: 0, balance_usage_credits: '5'
    }), threadId)).toEqual({ threadId, status: 'unavailable', dataAsOf })
    for (const status of ['available', 'partial']) {
      expect(parseCodexSessionUsage(response({ data_status: status }), threadId))
        .toEqual({ threadId, status: 'unavailable', dataAsOf })
    }
  })

  it('requires one exact thread match and rejects duplicates', () => {
    const body = response({ weekly_limit_percent: 1 })
    expect(parseCodexSessionUsage(body, 'thread-b')).toBeUndefined()
    expect(parseCodexSessionUsage(body, '')).toBeUndefined()
    expect(parseCodexSessionUsage(body, ' ')).toBeUndefined()
    body.threads.push({ thread_id: 'thread-b', data_status: 'available', weekly_limit_percent: 99 })
    expect(parseCodexSessionUsage(body, threadId)).toEqual({ threadId, status: 'available', weekly: 1, dataAsOf })
    body.threads.push({ ...body.threads[0] })
    expect(parseCodexSessionUsage(body, threadId)).toBeUndefined()
  })

  it('rejects malformed response shapes and unknown statuses', () => {
    for (const body of [null, [], {}, { threads: {} }, { threads: [null, [], 'thread-a', 1] },
      response({ data_status: null }), response({ data_status: 'pending' }), response({ data_status: undefined }),
      response({ thread_id: { id: threadId } })]) {
      expect(parseCodexSessionUsage(body, threadId)).toBeUndefined()
    }
  })

  it('retains valid ISO accounting timestamps and omits malformed ones', () => {
    const body: Record<string, unknown> = response({ weekly_limit_percent: 1 })
    body.data_as_of = '2026-09-29T20:34:56+08:00'
    expect(parseCodexSessionUsage(body, threadId)?.dataAsOf).toBe(body.data_as_of)
    for (const timestamp of [null, undefined, 1790680000000, '', 'September 29, 2026', '2026-09-29',
      '2026-13-29T00:00:00Z', '2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-09-29T24:00:00Z']) {
      body.data_as_of = timestamp
      expect(parseCodexSessionUsage(body, threadId)).toEqual({ threadId, status: 'available', weekly: 1 })
    }
    body.data_as_of = '2024-02-29T00:00:00Z'
    expect(parseCodexSessionUsage(body, threadId)?.dataAsOf).toBe(body.data_as_of)
  })
})
