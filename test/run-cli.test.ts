import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { resolveExitCode } from '../scripts/run-cli.mjs'

describe('run-cli exit code handling', () => {
  it('propagates normal numeric child exit statuses', () => {
    expect(resolveExitCode({ status: 0, signal: null })).toBe(0)
    expect(resolveExitCode({ status: 2, signal: null })).toBe(2)
  })

  it('returns non-zero 128 + signal when child is terminated by a signal', () => {
    expect(resolveExitCode({ status: null, signal: 'SIGINT' })).toBe(128 + os.constants.signals.SIGINT)
    expect(resolveExitCode({ status: null, signal: 'SIGTERM' })).toBe(128 + os.constants.signals.SIGTERM)
    expect(resolveExitCode({ status: null, signal: 'SIGKILL' })).toBe(128 + os.constants.signals.SIGKILL)
  })

  it('falls back to exit code 1 on spawn errors, unknown signals, or missing status', () => {
    expect(resolveExitCode({ status: null, signal: 'SIGUNKNOWN' })).toBe(1)
    expect(resolveExitCode({ status: null, signal: null })).toBe(1)
    expect(resolveExitCode({ status: 0, signal: null, error: new Error('ENOENT') })).toBe(1)
  })
})
