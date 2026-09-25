import type { QuestionAnswer, QuestionPrompt } from './types'

export interface QuestionSet {
  title?: string
  questions: QuestionPrompt[]
}

/** Fenced block language the model uses for client-rendered multiple-choice questions. */
export const QUESTION_BLOCK_LANG = 'questions'

export function normalizeQuestions(raw: unknown): QuestionPrompt[] {
  if (!Array.isArray(raw)) return []
  const questions: QuestionPrompt[] = []
  raw.forEach((q, i) => {
    if (!q || typeof q !== 'object') return
    const prompt = String((q as { prompt?: unknown }).prompt ?? (q as { question?: unknown }).question ?? '').trim()
    const options = Array.isArray((q as { options?: unknown }).options)
      ? (q as { options: any[] }).options
          .map((o, j) =>
            typeof o === 'string'
              ? { id: `o${j}`, label: o.trim() }
              : {
                  id: String(o?.id ?? `o${j}`),
                  label: String(o?.label ?? o?.name ?? o?.id ?? '').trim()
                }
          )
          .filter((o) => o.id && o.label)
      : []
    if (!prompt || options.length === 0) return
    questions.push({
      id: String((q as { id?: unknown }).id ?? `q${i}`),
      prompt,
      options,
      allowMultiple: !!((q as { allowMultiple?: unknown }).allowMultiple || (q as { allow_multiple?: unknown }).allow_multiple)
    })
  })
  return questions
}

/** Body of a ```questions block. Undefined while the JSON is incomplete or has no usable question. */
export function parseQuestionBlock(body: string): QuestionSet | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return undefined
  }
  const obj = Array.isArray(raw) ? { questions: raw } : raw
  if (!obj || typeof obj !== 'object') return undefined
  const questions = normalizeQuestions((obj as { questions?: unknown }).questions)
  if (!questions.length) return undefined
  const title = (obj as { title?: unknown }).title
  return { title: typeof title === 'string' && title.trim() ? title.trim() : undefined, questions }
}

/** The reply sent as the next user message after picking options in a question block. */
export function formatAnswers(set: QuestionSet, answers: QuestionAnswer[]): string {
  const lines = set.questions.map((q) => {
    const ids = answers.find((a) => a.questionId === q.id)?.selectedOptionIds ?? []
    const labels = q.options.filter((o) => ids.includes(o.id)).map((o) => o.label)
    return `- ${q.prompt}：${labels.length ? labels.join('、') : '（未选择）'}`
  })
  return `我的选择：\n${lines.join('\n')}`
}
