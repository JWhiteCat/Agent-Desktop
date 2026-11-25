import readline from 'node:readline/promises'
import type { QuestionAnswer, QuestionItem } from '@shared/types'
import type { CliIo } from './types'

/**
 * Interactive TTY question responder for blocking Agent/Plan questions.
 * Returns `null` if the user skips/cancels.
 */
export async function promptQuestionInteractively(
  item: QuestionItem,
  io: CliIo
): Promise<QuestionAnswer[] | null> {
  const rl = readline.createInterface({
    input: io.stdin as NodeJS.ReadableStream,
    output: io.stderr as unknown as NodeJS.WritableStream
  })
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
      const raw = (await rl.question(hint)).trim()
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
        otherText = (await rl.question('Enter details: ')).trim()
      }

      answers.push({
        questionId: q.id,
        selectedOptionIds,
        ...(otherText ? { otherText } : {})
      })
    }

    return answers
  } finally {
    rl.close()
  }
}
