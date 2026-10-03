import { useContext, useId, useMemo, useState } from 'react'
import { formatAnswers, parseQuestionBlock, QUESTION_BLOCK_LANG } from '@shared/questions'
import type { QuestionAnswer, QuestionPrompt } from '@shared/types'
import { useT } from '../../lib/i18n'
import { CodeBlock } from './primitives'
import { TurnActionsContext } from './TurnActions'

interface QuestionFormProps {
  title?: string
  questions: QuestionPrompt[]
  answers?: QuestionAnswer[]
  /** Only text-reply question blocks support custom answers, not ACP permission choices. */
  allowOther?: boolean
  /** Placeholder for feedback required by a predefined option. */
  feedbackPlaceholder?: string
  /** Shown instead of the buttons once the form can no longer be submitted. */
  status?: string
  onSubmit?: (answers: QuestionAnswer[]) => Promise<void> | void
  onSkip?: () => Promise<void> | void
}

export function QuestionForm({ title, questions, answers, allowOther = false, feedbackPlaceholder, status, onSubmit, onSkip }: QuestionFormProps) {
  const t = useT()
  const formId = useId()
  const [selected, setSelected] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {}
    for (const answer of answers ?? []) init[answer.questionId] = answer.selectedOptionIds
    return init
  })
  const [other, setOther] = useState<Record<string, { selected: boolean; text: string }>>({})
  const [sending, setSending] = useState(false)
  const locked = !onSubmit || sending

  const picked = (questionId: string): string[] => {
    if (answers) return answers.find((a) => a.questionId === questionId)?.selectedOptionIds ?? []
    return selected[questionId] ?? []
  }

  const needsFeedback = (q: QuestionPrompt): boolean =>
    q.options.some((option) => option.requiresText && picked(q.id).includes(option.id))

  const custom = (questionId: string) => {
    if (answers) {
      const text = answers.find((a) => a.questionId === questionId)?.otherText
      const question = questions.find((q) => q.id === questionId)
      return { selected: text !== undefined && !(question && needsFeedback(question)), text: text ?? '' }
    }
    return other[questionId] ?? { selected: false, text: '' }
  }

  const choose = (q: QuestionPrompt, optionId: string) => {
    if (locked) return
    setSelected((prev) => {
      const cur = prev[q.id] ?? []
      const next = q.allowMultiple ? (cur.includes(optionId) ? cur.filter((id) => id !== optionId) : [...cur, optionId]) : [optionId]
      return { ...prev, [q.id]: next }
    })
    if (!q.allowMultiple) {
      setOther((prev) => ({ ...prev, [q.id]: { selected: false, text: prev[q.id]?.text ?? '' } }))
    }
  }

  const chooseOther = (q: QuestionPrompt) => {
    if (locked) return
    setOther((prev) => ({
      ...prev,
      [q.id]: { selected: q.allowMultiple ? !prev[q.id]?.selected : true, text: prev[q.id]?.text ?? '' }
    }))
    if (!q.allowMultiple) setSelected((prev) => ({ ...prev, [q.id]: [] }))
  }

  const complete = questions.every((q) => {
    if (allowOther && custom(q.id).selected) return !!custom(q.id).text.trim()
    return picked(q.id).length > 0 && (!needsFeedback(q) || !!custom(q.id).text.trim())
  })

  const run = async (action: () => Promise<void> | void) => {
    setSending(true)
    try {
      await action()
    } catch {
      setSending(false)
    }
  }

  const submit = () => {
    if (locked || !complete || !onSubmit) return
    void run(() => onSubmit(questions.map((q) => ({
      questionId: q.id,
      selectedOptionIds: picked(q.id),
      ...((allowOther && custom(q.id).selected) || needsFeedback(q) ? { otherText: custom(q.id).text.trim() } : {})
    }))))
  }

  const skip = () => {
    if (locked || !onSkip) return
    void run(onSkip)
  }

  return (
    <div className={`question-card ${locked ? 'locked' : ''}`}>
      <div className="question-title">{title || t('需要你的选择')}</div>
      {questions.map((q, index) => (
        <div key={q.id} className="question-block">
          <div className="question-prompt" id={`${formId}-prompt-${index}`}>
            {q.prompt}
            {q.allowMultiple && <span className="question-hint">{t('可多选')}</span>}
          </div>
          <div className="question-options" role={q.allowMultiple ? 'group' : 'radiogroup'} aria-labelledby={`${formId}-prompt-${index}`}>
            {q.options.map((o, optionIndex) => {
              const on = picked(q.id).includes(o.id)
              return (
                <button
                  key={o.id}
                  id={`${formId}-option-${index}-${optionIndex}`}
                  type="button"
                  role={q.allowMultiple ? 'checkbox' : 'radio'}
                  aria-checked={on}
                  disabled={locked}
                  className={`question-opt ${on ? 'selected' : ''}`}
                  onClick={() => choose(q, o.id)}
                >
                  <span className="question-mark">{on ? '✓' : ''}</span>
                  <span className="question-label">{o.label}</span>
                </button>
              )
            })}
            {allowOther && (
              <button
                id={`${formId}-other-${index}`}
                type="button"
                role={q.allowMultiple ? 'checkbox' : 'radio'}
                aria-checked={custom(q.id).selected}
                disabled={locked}
                className={`question-opt ${custom(q.id).selected ? 'selected' : ''}`}
                onClick={() => chooseOther(q)}
              >
                <span className="question-mark">{custom(q.id).selected ? '✓' : ''}</span>
                <span className="question-label">{t('其他（手动输入）')}</span>
              </button>
            )}
          </div>
          {(needsFeedback(q) || (allowOther && custom(q.id).selected)) && (
            <textarea
              className="question-other-input"
              aria-labelledby={needsFeedback(q)
                ? `${formId}-prompt-${index} ${q.options.flatMap((option, optionIndex) => option.requiresText && picked(q.id).includes(option.id) ? [`${formId}-option-${index}-${optionIndex}`] : []).join(' ')}`
                : `${formId}-prompt-${index} ${formId}-other-${index}`}
              placeholder={needsFeedback(q) ? feedbackPlaceholder || t('请输入你的回答') : t('请输入你的回答')}
              value={custom(q.id).text}
              onChange={(event) => setOther((prev) => ({
                ...prev, [q.id]: { selected: prev[q.id]?.selected ?? false, text: event.target.value }
              }))}
              rows={3}
              required
              disabled={locked}
              autoFocus={!locked}
            />
          )}
        </div>
      ))}
      {onSubmit ? (
        <div className="question-actions">
          <button type="button" className="question-submit" disabled={!complete || sending} onClick={submit}>
            {sending ? t('提交中') : t('继续')}
          </button>
          {onSkip && (
            <button type="button" className="question-skip" disabled={sending} onClick={skip}>
              {t('跳过')}
            </button>
          )}
        </div>
      ) : (
        status && <div className="question-status">{status}</div>
      )}
    </div>
  )
}

/** A ```questions block from the model, answered by sending the picks as the next message. */
export function QuestionBlock({ body }: { body: string }) {
  const t = useT()
  const { reply, streaming } = useContext(TurnActionsContext)
  const set = useMemo(() => parseQuestionBlock(body), [body])
  if (!set) {
    if (streaming) return <div className="question-card locked question-loading">{t('正在准备问题…')}</div>
    return <CodeBlock lang={QUESTION_BLOCK_LANG} text={body} />
  }
  return (
    <QuestionForm
      title={set.title}
      questions={set.questions}
      allowOther
      status={reply || streaming ? undefined : t('已回答')}
      onSubmit={reply && !streaming ? (answers) => reply(formatAnswers(set, answers)) : undefined}
      onSkip={reply && !streaming ? () => reply(t('这些问题先跳过，按你的判断继续。')) : undefined}
    />
  )
}
