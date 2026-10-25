import assert from 'node:assert/strict'

/** The smoke prompt asks for one word, not merely a response containing it. */
export function assertExactOkReply(text: string): void {
  assert.equal(text.trim().toLowerCase(), 'ok', 'Expected exactly the one-word reply ok')
}
