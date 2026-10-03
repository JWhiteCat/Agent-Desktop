import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import type { QuestionPrompt } from '../src/shared/types'
import { QuestionBlock, QuestionForm } from '../src/renderer/src/components/items/Questions'
import { TurnActionsContext } from '../src/renderer/src/components/items/TurnActions'

const single: QuestionPrompt = {
  id: 'language', prompt: '用什么语言？',
  options: [{ id: 'ts', label: 'TypeScript' }, { id: 'js', label: 'JavaScript' }]
}
const multiple: QuestionPrompt = { ...single, allowMultiple: true }

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
