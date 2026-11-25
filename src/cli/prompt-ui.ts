import readline from 'node:readline/promises'
import type { QuestionAnswer, QuestionItem } from '@shared/types'
import type { CliIo } from './types'

export function isPromptAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || (err as NodeJS.ErrnoException).code === 'ABORT_ERR'
}

/**
 * Interactive TTY question responder for blocking Agent/Plan questions.
 * Returns `null` if the user skips/cancels.
 */
export async function promptQuestionInteractively(
  item: QuestionItem,
  io: CliIo,
  signal?: AbortSignal
): Promise<QuestionAnswer[] | null> {
  if (signal?.aborted) {
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    ;(err as NodeJS.ErrnoException).code = 'ABORT_ERR'
    throw err
  }
  const rl = readline.createInterface({
    input: io.stdin as NodeJS.ReadableStream,
    output: io.stderr as unknown as NodeJS.WritableStream
  })
  const ac = new AbortController()
  const onAbort = (): void => {
    ac.abort()
    rl.close()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  rl.on('SIGINT', onAbort)
  try {
    if (item.title) io.stderr.write(`\n[question] ${item.title}\n`)
    const answers: QuestionAnswer[] = []

    for (const q of item.questions) {
      io.stderr.write(`\n${q.prompt}\n`)
      q.options.forEach((opt, index) => {
        const suffix = opt.requiresText ? ' (requires text)' : ''
        io.stderr.write(`  ${index + 1}. ${opt.label}${suffix}\n`)
      })
      const hint = q.allowMultiple
        ? 'Select numbers (comma-separated), type custom text, or leave empty to skip: '
        : 'Select a number, type custom text, or leave empty to skip: '
      const raw = (await rl.question(hint, { signal: ac.signal })).trim()
      if (!raw) return null

      const tokens = q.allowMultiple ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [raw]
      const selectedOptionIds: string[] = []
      const customParts: string[] = []
      let needsText = false

      for (const token of tokens) {
        const num = Number(token)
        if (Number.isInteger(num) && num >= 1 && num <= q.options.length) {
          const opt = q.options[num - 1]
          selectedOptionIds.push(opt.id)
          if (opt.requiresText) needsText = true
        } else {
          customParts.push(token)
        }
      }

      let otherText = customParts.length > 0 ? customParts.join(', ') : undefined
      if (needsText && !otherText) {
        otherText = (await rl.question('Enter details: ', { signal: ac.signal })).trim()
      }

      answers.push({
        questionId: q.id,
        selectedOptionIds,
        ...(otherText ? { otherText } : {})
      })
    }

    return answers
  } finally {
    signal?.removeEventListener('abort', onAbort)
    rl.off('SIGINT', onAbort)
    rl.close()
  }
}
