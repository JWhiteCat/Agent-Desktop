import { afterEach, describe, expect, it } from 'vitest'
import { formatAnswers, normalizeQuestions, parseQuestionBlock } from '@shared/questions'
import { setLanguage } from '@shared/i18n'
import { acpErrorText, claudePlanModePrompt, codexPlanModePrompt, permissionResult, planModePrompt } from '../src/main/acp'
import { parseModels, resolveApiKey, stripAnsi } from '../src/main/cli'
import { leftPlanMode } from '../src/main/sessions'

const previousKey = process.env.CURSOR_API_KEY

afterEach(() => {
  setLanguage('system', 'zh-CN')
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

  it('parses a questions block and formats the picks as a reply', () => {
    const set = parseQuestionBlock(
      JSON.stringify({
        title: '语言',
        questions: [{ id: 'lang', prompt: '用什么语言？', options: [{ id: 'py', label: 'Python' }, 'Node'] }]
      })
    )
    expect(set?.questions[0].options).toEqual([
      { id: 'py', label: 'Python' },
      { id: 'o1', label: 'Node' }
    ])
    expect(formatAnswers(set!, [{ questionId: 'lang', selectedOptionIds: ['o1'] }])).toBe('我的选择：\n- 用什么语言？：Node')
    expect(parseQuestionBlock('{"questions":[{"prompt":"半截')).toBeUndefined()
  })

  it('formats a custom answer without a fixed choice and preserves its internal text', () => {
    const set = { questions: normalizeQuestions([{ id: 'lang', prompt: '用什么语言？', options: ['Python'] }]) }
    const text = '  Rust\n保留 {answers} 和 <tag>。  '

    expect(formatAnswers(set, [{ questionId: 'lang', selectedOptionIds: [], otherText: text }]))
      .toBe('我的选择：\n- 用什么语言？：其他：Rust\n保留 {answers} 和 <tag>。')
  })

  it('combines fixed choices and custom answers per question in question order', () => {
    const set = { questions: normalizeQuestions([
      { id: 'lang', prompt: '用什么语言？', options: ['Python', 'Node'], allowMultiple: true },
      { id: 'storage', prompt: '如何存储？', options: ['SQLite'] }
    ]) }

    expect(formatAnswers(set, [
      { questionId: 'storage', selectedOptionIds: [], otherText: '  本地文件  ' },
      { questionId: 'lang', selectedOptionIds: ['o1', 'o0'], otherText: '  Rust  ' }
    ])).toBe('我的选择：\n- 用什么语言？：Python、Node、其他：Rust\n- 如何存储？：其他：本地文件')
  })

  it('ignores whitespace-only custom answers without changing existing choice formatting', () => {
    const set = { questions: normalizeQuestions([{ id: 'lang', prompt: '用什么语言？', options: ['Python'] }]) }

    expect(formatAnswers(set, [{ questionId: 'lang', selectedOptionIds: ['o0'], otherText: ' \n\t ' }]))
      .toBe('我的选择：\n- 用什么语言？：Python')
    expect(formatAnswers(set, [{ questionId: 'lang', selectedOptionIds: [], otherText: ' \n\t ' }]))
      .toBe('我的选择：\n- 用什么语言？：（未选择）')
  })

  it('localizes the custom answer label without translating user content', () => {
    setLanguage('en')
    const set = { questions: normalizeQuestions([{ id: 'lang', prompt: '用什么语言？', options: ['Python'] }]) }

    expect(formatAnswers(set, [{ questionId: 'lang', selectedOptionIds: ['o0'], otherText: 'Rust 和中文注释' }]))
      .toBe('My choices:\n- 用什么语言？: Python, Other: Rust 和中文注释')
  })

  it('adds the client hint to plan prompts inside a tag', () => {
    const text = planModePrompt('做个待办工具')
    expect(text.endsWith('做个待办工具')).toBe(true)
    expect(text).toMatch(/^<agent_desktop_client>[\s\S]*```questions[\s\S]*<\/agent_desktop_client>/)
  })

  it.each([planModePrompt, codexPlanModePrompt, claudePlanModePrompt])('tells Plan providers that the client supplies the manual answer option', (wrap) => {
    const text = wrap('Choose an approach')
    expect(text).toContain('The client automatically adds an "Other (manual input)" option to every question')
    expect(text).toContain('do not include an Other placeholder in the options')
    expect(text).toContain('selected options and any manual answer arrive together as the next message')
  })

  it('notices when a plan turn switches mode on its own', () => {
    const calls = new Set<string>()
    const id = 'tool_switch'
    expect(leftPlanMode({ sessionUpdate: 'tool_call', toolCallId: id, kind: 'switch_mode', status: 'pending' }, calls)).toBe(false)
    expect(leftPlanMode({ sessionUpdate: 'tool_call_update', toolCallId: id, rawInput: { targetModeId: 'agent' } }, calls)).toBe(false)
    expect(leftPlanMode({ sessionUpdate: 'tool_call_update', toolCallId: 'other', status: 'completed' }, calls)).toBe(false)
    expect(leftPlanMode({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' }, calls)).toBe(true)
    expect(leftPlanMode({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' }, calls)).toBe(false)
    expect(leftPlanMode({ sessionUpdate: 'current_mode_update', currentModeId: 'agent' }, calls)).toBe(true)
  })

  it('surfaces the detail hidden inside an ACP internal error', () => {
    expect(acpErrorText({ message: 'Internal error', data: { details: 'spawn EINVAL' } })).toBe('spawn EINVAL')
    expect(acpErrorText({ message: 'Authentication required', data: { message: 'sign in' } })).toBe('Authentication required: sign in')
    expect(acpErrorText({ message: 'CLI 进程已退出' })).toBe('CLI 进程已退出')
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

  it('picks a reject option when ask mode must deny a tool', () => {
    const options = [
      { optionId: 'once', kind: 'allow_once' },
      { optionId: 'no', kind: 'reject_once' }
    ]
    expect(permissionResult(options, true, true)).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
    expect(permissionResult([{ optionId: 'once', kind: 'allow_once' }], false, true)).toEqual({ outcome: { outcome: 'cancelled' } })
  })
})
