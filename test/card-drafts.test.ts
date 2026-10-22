import { createElement, type ReactElement } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as jsxDevRuntime from 'react/jsx-dev-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import type { QuestionItem, ToolItem } from '../src/shared/types'
import { QuestionCard, StepItem } from '../src/renderer/src/components/Items'
import { TurnActionsContext, type TurnActions } from '../src/renderer/src/components/items/TurnActions'

vi.mock('react/jsx-runtime', { spy: true })
vi.mock('react/jsx-dev-runtime', { spy: true })

interface Control {
  className?: string
  role?: string
  disabled?: boolean
  'aria-checked'?: boolean
  onClick?: () => void
  onChange?: (event: { target: { value: string } }) => void
  value?: string
}

/** Rendering again creates a fresh component tree, like returning to an unmounted conversation. */
async function renderCard(element: ReactElement) {
  const controls: Control[] = []
  const capture = (type: unknown, props: unknown) => {
    if (type === 'button' || type === 'textarea') controls.push(props as Control)
  }
  const actual = await vi.importActual<typeof jsxRuntime>('react/jsx-runtime')
  const actualDev = await vi.importActual<typeof jsxDevRuntime>('react/jsx-dev-runtime')
  const jsx = vi.mocked(jsxRuntime.jsx).mockImplementation((type, props, key) => {
    capture(type, props)
    return actual.jsx(type, props, key)
  })
  const jsxs = vi.mocked(jsxRuntime.jsxs).mockImplementation((type, props, key) => {
    capture(type, props)
    return actual.jsxs(type, props, key)
  })
  const jsxDev = vi.mocked(jsxDevRuntime.jsxDEV).mockImplementation((type, props, key, ...args) => {
    capture(type, props)
    return actualDev.jsxDEV(type, props, key, ...args)
  })
  try {
    const html = renderToStaticMarkup(element)
    return {
      html,
      choices: controls.filter((control) => control.role === 'radio' || control.role === 'checkbox'),
      inputs: controls.filter((control) => control.className === 'question-other-input'),
      button: (className: string) => {
        const control = controls.find((control) => control.className === className)
        expect(control, className).toBeDefined()
        return control!
      }
    }
  } finally {
    jsx.mockRestore()
    jsxs.mockRestore()
    jsxDev.mockRestore()
  }
}

const review: QuestionItem = {
  id: 'same-question', kind: 'question', toolCallId: 'plan-review:call',
  purpose: 'codex-plan-review', status: 'pending',
  questions: [{
    id: 'plan_review', prompt: 'Implement this plan?',
    options: [{ id: 'implement_plan', label: 'Yes' }, { id: 'revise_plan', label: 'No', requiresText: true }]
  }]
}
const block = '```questions\n' + JSON.stringify({
  questions: [{ id: 'language', prompt: 'Language?', options: [{ id: 'ts', label: 'TypeScript' }, { id: 'js', label: 'JavaScript' }] }]
}) + '\n```'

let sequence = 0
let threadId: string

function markdownCard(text = block, itemId = 'same-message', actions: TurnActions = { reply: vi.fn() }, thread = threadId) {
  return createElement(TurnActionsContext.Provider, { value: actions },
    createElement(StepItem, { threadId: thread, item: { id: itemId, kind: 'assistant', text } }))
}

beforeEach(() => {
  setLanguage('zh-CN')
  threadId = `card-drafts-${++sequence}`
})

afterEach(() => setLanguage('system', 'zh-CN'))

describe('conversation card drafts', () => {
  it('restores native question choices and revision feedback only for their conversation', async () => {
    const card = () => createElement(QuestionCard, { threadId, item: review })
    let rendered = await renderCard(card())
    rendered.choices[1].onClick!()
    rendered = await renderCard(card())
    rendered.inputs[0].onChange!({ target: { value: '先加测试\n保留现有接口' } })

    const otherThread = await renderCard(createElement(QuestionCard, { threadId: `${threadId}-other`, item: review }))
    expect(otherThread.choices.every((choice) => !choice['aria-checked'])).toBe(true)
    expect(otherThread.inputs).toHaveLength(0)

    rendered = await renderCard(card())
    expect(rendered.choices.map((choice) => choice['aria-checked'])).toEqual([false, true])
    expect(rendered.inputs[0].value).toBe('先加测试\n保留现有接口')
    expect(rendered.button('question-submit').disabled).toBe(false)

    const answered = await renderCard(createElement(QuestionCard, {
      threadId, item: { ...review, status: 'answered', answers: [{ questionId: 'plan_review', selectedOptionIds: ['implement_plan'] }] }
    }))
    expect(answered.choices.map((choice) => choice['aria-checked'])).toEqual([true, false])
    expect(answered.choices.every((choice) => choice.disabled)).toBe(true)
    expect(answered.inputs).toHaveLength(0)
    expect(answered.html).toContain('已提交')
  })

  it('keeps identical Markdown question blocks separate across blocks, messages, and conversations', async () => {
    const text = `${block}\n\n${block}`
    const card = () => markdownCard(text)
    let rendered = await renderCard(card())
    rendered.choices[2].onClick!()
    rendered = await renderCard(card())
    rendered.inputs[0].onChange!({ target: { value: 'Rust with 中文注释' } })
    rendered.choices[3].onClick!()

    for (const other of [markdownCard(text, 'other-message'), markdownCard(text, 'same-message', undefined, `${threadId}-other`)]) {
      const separate = await renderCard(other)
      expect(separate.choices.every((choice) => !choice['aria-checked'])).toBe(true)
      expect(separate.inputs).toHaveLength(0)
    }
    rendered = await renderCard(card())
    expect(rendered.choices.map((choice) => choice['aria-checked'])).toEqual([false, false, true, true, false, false])
    expect(rendered.inputs[0].value).toBe('Rust with 中文注释')

    rendered.choices[0].onClick!()
    rendered = await renderCard(card())
    expect(rendered.inputs).toHaveLength(0)
    rendered.choices[2].onClick!()
    rendered = await renderCard(card())
    expect(rendered.inputs[0].value).toBe('Rust with 中文注释')
  })

  it('keeps a submitting card locked after remount and restores its picks after failure', async () => {
    let reject!: (reason: Error) => void
    const pending = new Promise<void>((_, rejectRequest) => { reject = rejectRequest })
    const reply = vi.fn(() => pending)
    const card = () => markdownCard(block, 'submitting-message', { reply })
    let rendered = await renderCard(card())
    rendered.choices[0].onClick!()
    rendered = await renderCard(card())
    rendered.button('question-submit').onClick!()
    expect(reply).toHaveBeenCalledOnce()
    rendered = await renderCard(card())
    expect(rendered.button('question-submit').disabled).toBe(true)
    expect(rendered.choices.every((choice) => choice.disabled)).toBe(true)

    reject(new Error('Connection lost'))
    await pending.catch(() => {})
    rendered = await renderCard(card())
    expect(rendered.button('question-submit').disabled).toBe(false)
    expect(rendered.choices[0]['aria-checked']).toBe(true)
  })

  it('restores plan expansion independently for each conversation', async () => {
    const item: ToolItem = {
      id: 'same-plan', kind: 'tool', callId: 'plan', tool: 'createPlan', status: 'success',
      args: { name: 'Plan', plan: 'Detailed implementation steps' }, startedAt: 1
    }
    const card = (thread = threadId) => createElement(StepItem, { threadId: thread, item })
    let rendered = await renderCard(card())
    expect(rendered.html).not.toContain('Detailed implementation steps')
    rendered.button('plan-toggle').onClick!()
    expect((await renderCard(card(`${threadId}-other`))).html).not.toContain('Detailed implementation steps')
    rendered = await renderCard(card())
    expect(rendered.html).toContain('Detailed implementation steps')
    expect(rendered.html).toContain('收起计划')
  })
})
