import { describe, expect, it } from 'vitest'
import { assertExactOkReply } from './helpers/live-model-contract'

// Pure offline contract checks: importing this helper never spawns a CLI.
describe('live text smoke response contract', () => {
  it.each(['ok', 'OK', '  Ok\r\n'])('accepts only the expected word with harmless case/whitespace: %j', (text) => {
    expect(() => assertExactOkReply(text)).not.toThrow()
  })
  it.each(['', 'not ok', 'token expired', 'okay', 'ok.', 'ok\nerror', 'Here is ok', '```\nok\n```'])('rejects false-positive output: %j', (text) => {
    expect(() => assertExactOkReply(text)).toThrow('Expected exactly the one-word reply ok')
  })
})
