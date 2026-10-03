import { createElement, type ComponentProps } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import type { QuestionItem, QuestionPrompt } from '../src/shared/types'
import { QuestionCard } from '../src/renderer/src/components/Items'
import { QuestionBlock, QuestionForm } from '../src/renderer/src/components/items/Questions'
import { TurnActionsContext } from '../src/renderer/src/components/items/TurnActions'

vi.mock('react/jsx-runtime', { spy: true })

const single: QuestionPrompt = {
  id: 'language', prompt: '用什么语言？',
  options: [{ id: 'ts', label: 'TypeScript' }, { id: 'js', label: 'JavaScript' }]
}
const multiple: QuestionPrompt = { ...single, allowMultiple: true }
const planQuestion: QuestionPrompt = {
  id: 'plan_review', prompt: 'Implement this plan?',
  options: [
    { id: 'implement_plan', label: 'Yes' },
    { id: 'revise_plan', label: 'No', requiresText: true }
  ]
}

function renderPlanCard(patch: Partial<QuestionItem> = {}): string {
  return renderToStaticMarkup(createElement(QuestionCard, {
    threadId: 'thread',
    item: {
      id: 'review', kind: 'question', toolCallId: 'plan-review:call',
      purpose: 'codex-plan-review', title: 'Implement this plan?',
      questions: [planQuestion], status: 'pending', ...patch
    }
  }))
}

function renderForm(props: Partial<ComponentProps<typeof QuestionForm>> = {}): string {
  return renderToStaticMarkup(createElement(QuestionForm, {
    questions: [single], onSubmit: vi.fn(), ...props
  }))
}

function submitButton(html: string): string {
  const button = html.match(/<button\b[^>]*class="question-submit"[^>]*>/)?.[0]
  expect(button).toBeDefined()
  return button!
}

function renderBlock(value: ComponentProps<typeof TurnActionsContext.Provider>['value']): string {
  return renderToStaticMarkup(createElement(TurnActionsContext.Provider, { value },
    createElement(QuestionBlock, { body: JSON.stringify({ questions: [single] }) })))
}

beforeEach(() => setLanguage('zh-CN'))
afterEach(() => setLanguage('zh-CN'))

describe('manual answers in question cards', () => {
  it('keeps native fixed-option forms unchanged unless Other is enabled', () => {
    const html = renderForm()
    expect(html).not.toContain('其他（手动输入）')
    expect(html).not.toContain('<textarea')
    expect(html.match(/role="radio"/g)).toHaveLength(2)
    expect(submitButton(html)).toContain('disabled=""')

    const answered = renderForm({ answers: [{ questionId: single.id, selectedOptionIds: ['ts'] }] })
    expect(submitButton(answered)).not.toContain('disabled')
  })

  it.each([
    { question: single, role: 'radio', group: 'radiogroup' },
    { question: multiple, role: 'checkbox', group: 'group' }
  ])('renders Other with the same $role semantics as the question options', ({ question, role, group }) => {
    const html = renderForm({ questions: [question], allowOther: true })
    expect(html).toContain('其他（手动输入）')
    expect(html).toContain(`role="${group}"`)
    expect(html.match(new RegExp(`role="${role}"`, 'g'))).toHaveLength(3)
    expect(html.match(/aria-checked="false"/g)).toHaveLength(3)
    expect(html).not.toContain('<textarea')
  })

  it('accepts a nonblank manual answer without a predefined selection', () => {
    const html = renderForm({
      allowOther: true, answers: [{ questionId: single.id, selectedOptionIds: [], otherText: ' Rust\n中文注释 ' }]
    })
    expect(submitButton(html)).not.toContain('disabled')
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1)
    expect(html).toContain(' Rust\n中文注释 </textarea>')
    const textarea = html.match(/<textarea\b[^>]*>/)?.[0]
    expect(textarea).toContain('required=""')
    expect(textarea).toContain('autofocus=""')
    expect(textarea).toContain('placeholder="请输入你的回答"')
    expect(textarea).not.toContain('disabled')
    const labels = textarea?.match(/aria-labelledby="([^"]+)"/)?.[1].split(' ')
    expect(labels).toHaveLength(2)
    for (const id of labels ?? []) expect(html).toContain(`id="${id}"`)
  })

  it('accepts a predefined selection and a manual answer together for multiple choice', () => {
    const html = renderForm({
      questions: [multiple], allowOther: true,
      answers: [{ questionId: single.id, selectedOptionIds: ['ts'], otherText: 'Rust' }]
    })
    expect(submitButton(html)).not.toContain('disabled')
    expect(html.match(/aria-checked="true"/g)).toHaveLength(2)
    expect(html).toContain('Rust</textarea>')
  })

  it.each(['', ' \n\t '])('blocks an explicitly selected blank Other answer (%j)', (otherText) => {
    const html = renderForm({
      questions: [multiple], allowOther: true,
      answers: [{ questionId: single.id, selectedOptionIds: ['ts'], otherText }]
    })
    expect(html).toContain('<textarea')
    expect(submitButton(html)).toContain('disabled=""')
  })

  it('requires a valid answer for every question independently', () => {
    const questions = [single, { ...single, id: 'second', prompt: '第二个问题' }]
    const first = { questionId: single.id, selectedOptionIds: [], otherText: 'Rust' }
    const partial = renderForm({ questions, allowOther: true, answers: [first] })
    expect(submitButton(partial)).toContain('disabled=""')
    expect(partial.match(/<textarea\b/g)).toHaveLength(1)

    const complete = renderForm({
      questions, allowOther: true,
      answers: [first, { questionId: 'second', selectedOptionIds: [], otherText: 'Python' }]
    })
    expect(submitButton(complete)).not.toContain('disabled')
    expect(complete.match(/<textarea\b/g)).toHaveLength(2)
  })

  it('disables all saved answer controls and does not autofocus a historical answer', () => {
    const html = renderForm({
      allowOther: true, onSubmit: undefined, status: '已回答',
      answers: [{ questionId: single.id, selectedOptionIds: [], otherText: 'Rust' }]
    })
    expect(html).toContain('已回答')
    expect(html).not.toContain('question-submit')
    expect(html).not.toContain('autofocus')
    const controls = html.match(/<(?:button|textarea)\b[^>]*>/g) ?? []
    expect(controls).toHaveLength(4)
    for (const control of controls) expect(control).toContain('disabled=""')
  })

  it('localizes the manual-answer option and renders user text as plain text', () => {
    setLanguage('en')
    const html = renderForm({
      allowOther: true,
      answers: [{ questionId: single.id, selectedOptionIds: [], otherText: '</textarea><script>alert("x")</script> & 中文' }]
    })
    expect(html).toContain('Other (type your answer)')
    expect(html).not.toContain('其他（手动输入）')
    expect(html).not.toContain('placeholder="请输入你的回答"')
    expect(html).toContain('&lt;/textarea&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; 中文')
    expect(html).not.toContain('<script>')
  })
})

describe('fenced plan questions', () => {
  it('enables Other automatically without changing the model question format', () => {
    const html = renderBlock({ reply: vi.fn() })
    expect(html).toContain('其他（手动输入）')
    expect(html).toContain('question-submit')
    expect(html).toContain('question-skip')
  })

  it('locks a complete JSON question while streaming even when a reply callback exists', () => {
    const html = renderBlock({ reply: vi.fn(), streaming: true })
    expect(html).toContain('其他（手动输入）')
    expect(html).not.toContain('question-submit')
    expect(html).not.toContain('question-skip')
    expect(html).not.toContain('已回答')
    for (const button of html.match(/<button\b[^>]*>/g) ?? []) expect(button).toContain('disabled=""')
  })

  it('keeps historical question blocks read-only', () => {
    const html = renderBlock({})
    expect(html).toContain('其他（手动输入）')
    expect(html).toContain('已回答')
    expect(html).not.toContain('question-submit')
    expect(html).not.toContain('question-skip')
  })
})

describe('Codex plan review questions', () => {
  it.each([
    { language: 'zh-CN' as const, title: '是否执行此计划？', yes: '是，执行此计划', no: '否，先修改计划' },
    { language: 'en' as const, title: 'Implement this plan?', yes: 'Yes, implement this plan', no: 'No, revise the plan first' }
  ])('localizes the app-authored plan review in $language', ({ language, title, yes, no }) => {
    setLanguage(language)
    const html = renderPlanCard()
    expect(html).toContain(`<div class="question-title">${title}</div>`)
    expect(html).toContain(title)
    expect(html).toContain(yes)
    expect(html).toContain(no)
    expect(html).not.toContain('其他（手动输入）')
    expect(html).not.toContain('<textarea')
  })

  it.each(['', ' \n\t '])('requires nonblank feedback for No (%j)', (otherText) => {
    const html = renderForm({
      questions: [planQuestion],
      feedbackPlaceholder: '请输入希望 Codex 如何修改计划',
      answers: [{ questionId: planQuestion.id, selectedOptionIds: ['revise_plan'], otherText }]
    })
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1)
    expect(submitButton(html)).toContain('disabled=""')
    const textarea = html.match(/<textarea\b[^>]*>/)?.[0]
    expect(textarea).toContain('required=""')
    expect(textarea).toContain('placeholder="请输入希望 Codex 如何修改计划"')
    const labels = textarea?.match(/aria-labelledby="([^"]+)"/)?.[1].split(' ')
    expect(labels).toHaveLength(2)
    for (const id of labels ?? []) expect(html).toContain(`id="${id}"`)
  })

  it('accepts No with multiline feedback alongside its option selection', () => {
    const html = renderForm({
      questions: [planQuestion],
      answers: [{ questionId: planQuestion.id, selectedOptionIds: ['revise_plan'], otherText: '先补测试\n再调整实现' }]
    })
    expect(submitButton(html)).not.toContain('disabled')
    expect(html).toContain('先补测试\n再调整实现</textarea>')
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1)
  })

  it('allows Yes without feedback and hides an existing revision draft', () => {
    const html = renderForm({
      questions: [planQuestion],
      answers: [{ questionId: planQuestion.id, selectedOptionIds: ['implement_plan'], otherText: '旧的修改意见' }]
    })
    expect(submitButton(html)).not.toContain('disabled')
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('旧的修改意见')
  })

  it.each([
    { option: 'revise_plan', feedback: ' 先补测试\n再实施 ', expectedText: '先补测试\n再实施' },
    { option: 'implement_plan', feedback: '保留的修改草稿', expectedText: undefined }
  ])('submits $option with feedback only when required', async ({ option, feedback, expectedText }) => {
    const onSubmit = vi.fn()
    let click: (() => void) | undefined
    const originalJsx = (await vi.importActual<typeof jsxRuntime>('react/jsx-runtime')).jsx
    const spy = vi.mocked(jsxRuntime.jsx).mockImplementation((type, props, key) => {
      const button = props as { className?: string; onClick?: () => void }
      if (type === 'button' && button.className === 'question-submit') click = button.onClick
      return originalJsx(type, props, key)
    })
    try {
      renderForm({
        questions: [planQuestion], onSubmit,
        answers: [{ questionId: planQuestion.id, selectedOptionIds: [option], otherText: feedback }]
      })
      expect(click).toBeDefined()
      click!()
      expect(onSubmit).toHaveBeenCalledWith([{
        questionId: planQuestion.id, selectedOptionIds: [option],
        ...(expectedText === undefined ? {} : { otherText: expectedText })
      }])
    } finally {
      spy.mockRestore()
    }
  })

  it.each([
    { language: 'zh-CN' as const, placeholder: '请输入希望 Codex 如何修改计划', status: '已提交' },
    { language: 'en' as const, placeholder: 'Tell Codex what to change in the plan', status: 'Submitted' }
  ])('shows locked historical feedback in $language', ({ language, placeholder, status }) => {
    setLanguage(language)
    const html = renderPlanCard({
      status: 'answered',
      answers: [{ questionId: planQuestion.id, selectedOptionIds: ['revise_plan'], otherText: '缩小改动范围\n保留现有接口' }]
    })
    expect(html).toContain(status)
    expect(html).toContain(`placeholder="${placeholder}"`)
    expect(html).toContain('缩小改动范围\n保留现有接口</textarea>')
    expect(html).not.toContain('question-submit')
    expect(html).not.toContain('autofocus')
    for (const control of html.match(/<(?:button|textarea)\b[^>]*>/g) ?? []) expect(control).toContain('disabled=""')
  })

  it('upgrades legacy plan reviews that have the exact known options', () => {
    const html = renderPlanCard({
      purpose: undefined,
      questions: [{ ...planQuestion, options: planQuestion.options.map(({ requiresText, ...option }) => option) }],
      status: 'answered',
      answers: [{ questionId: planQuestion.id, selectedOptionIds: ['revise_plan'], otherText: '补充回滚方案' }]
    })
    expect(html).toContain('是否执行此计划？')
    expect(html).toContain('否，先修改计划')
    expect(html).toContain('补充回滚方案</textarea>')
  })

  it('keeps unrelated provider questions verbatim', () => {
    const html = renderPlanCard({
      purpose: undefined, questions: [single], title: 'Provider question'
    })
    expect(html).toContain('Provider question')
    expect(html).toContain('用什么语言？')
    expect(html).not.toContain('是否执行此计划？')
  })
})
