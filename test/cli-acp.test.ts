import { afterEach, describe, expect, it } from 'vitest'
import { normalizeQuestions, permissionResult } from '../src/main/acp'
import { parseModels, resolveApiKey, stripAnsi } from '../src/main/cli'

const previousKey = process.env.CURSOR_API_KEY

afterEach(() => {
  if (previousKey === undefined) delete process.env.CURSOR_API_KEY
  else process.env.CURSOR_API_KEY = previousKey
})

describe('cli parsing', () => {
  it('parses model lines and strips status markers', () => {
    const models = parseModels(
      [
        'grok-4.7-high-fast - Grok 4.7 High Fast (current)',
        'auto - Auto (default)',
        'not a model line',
        ''
      ].join('\n')
    )
    expect(models).toEqual([
      { id: 'grok-4.7-high-fast', label: 'Grok 4.7 High Fast' },
      { id: 'auto', label: 'Auto' }
    ])
  })

  it('strips ANSI color codes', () => {
    expect(stripAnsi('\u001b[31mok\u001b[0m')).toBe('ok')
  })

  it('prefers the settings API key over the environment', () => {
    process.env.CURSOR_API_KEY = 'env-key'
    expect(resolveApiKey('  settings-key  ')).toBe('settings-key')
    expect(resolveApiKey('')).toBe('env-key')
    expect(resolveApiKey(undefined)).toBe('env-key')
  })
})

describe('acp questions', () => {
  it('keeps complete questions and drops empty ones', () => {
    const questions = normalizeQuestions([
      { id: 'q1', prompt: '继续？', options: [{ id: 'yes', label: '是' }, { label: '' }] },
      { prompt: '   ', options: [{ id: 'a', label: 'A' }] },
      null
    ])
    expect(questions).toEqual([
      { id: 'q1', prompt: '继续？', options: [{ id: 'yes', label: '是' }], allowMultiple: false }
    ])
  })

  it('picks allow-always when force is on', () => {
    const options = [
      { optionId: 'once', kind: 'allow_once' },
      { optionId: 'always', kind: 'allow_always' }
    ]
    expect(permissionResult(options, true)).toEqual({ outcome: { outcome: 'selected', optionId: 'always' } })
    expect(permissionResult(options, false)).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(permissionResult([], false)).toEqual({ outcome: { outcome: 'cancelled' } })
  })
})
