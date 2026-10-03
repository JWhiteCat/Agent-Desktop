import { useContext, useMemo, useState } from 'react'
import { formatAnswers, parseQuestionBlock, QUESTION_BLOCK_LANG } from '@shared/questions'
import type { QuestionAnswer, QuestionPrompt } from '@shared/types'
import { useT } from '../../lib/i18n'
import { CodeBlock } from './primitives'
import { TurnActionsContext } from './TurnActions'

interface QuestionFormProps {
  title?: string
  questions: QuestionPrompt[]
  answers?: QuestionAnswer[]
  /** Shown instead of the buttons once the form can no longer be submitted. */
  status?: string
  onSubmit?: (answers: QuestionAnswer[]) => Promise<void> | void
  onSkip?: () => Promise<void> | void
}

export function QuestionForm({ title, questions, answers, status, onSubmit, onSkip }: QuestionFormProps) {
  const t = useT()
  const [selected, setSelected] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {}
    for (const answer of answers ?? []) init[answer.questionId] = answer.selectedOptionIds
    return init
  })
  const [sending, setSending] = useState(false)
  const locked = !onSubmit || sending

  const picked = (questionId: string): string[] => {
    if (answers) return answers.find((a) => a.questionId === questionId)?.selectedOptionIds ?? []
    return selected[questionId] ?? []
  }

  const choose = (q: QuestionPrompt, optionId: string) => {
    if (locked) return
    setSelected((prev) => {
      const cur = prev[q.id] ?? []
      const next = q.allowMultiple ? (cur.includes(optionId) ? cur.filter((id) => id !== optionId) : [...cur, optionId]) : [optionId]
      return { ...prev, [q.id]: next }
    })
  }

  const complete = questions.every((q) => picked(q.id).length > 0)

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
    void run(() => onSubmit(questions.map((q) => ({ questionId: q.id, selectedOptionIds: picked(q.id) }))))
  }

  const skip = () => {
    if (locked || !onSkip) return
    void run(onSkip)
  }

  return (
    <div className={`question-card ${locked ? 'locked' : ''}`}>
      <div className="question-title">{title || t('需要你的选择')}</div>
      {questions.map((q) => (
        <div key={q.id} className="question-block">
          <div className="question-prompt">
            {q.prompt}
            {q.allowMultiple && <span className="question-hint">{t('可多选')}</span>}
          </div>
          <div className="question-options" role={q.allowMultiple ? 'group' : 'radiogroup'}>
            {q.options.map((o) => {
              const on = picked(q.id).includes(o.id)
              return (
                <button
                  key={o.id}
                  type="button"
                  role={q.allowMultiple ? 'checkbox' : 'radio'}
                  aria-checked={on}
                  className={`question-opt ${on ? 'selected' : ''}`}
                  onClick={() => choose(q, o.id)}
                >
                  <span className="question-mark">{on ? '✓' : ''}</span>
                  <span className="question-label">{o.label}</span>
                </button>
              )
            })}
          </div>
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
      status={reply || streaming ? undefined : t('已回答')}
      onSubmit={reply ? (answers) => reply(formatAnswers(set, answers)) : undefined}
      onSkip={reply ? () => reply(t('这些问题先跳过，按你的判断继续。')) : undefined}
    />
  )
}
