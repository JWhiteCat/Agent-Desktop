import { attention } from 'micromark-core-commonmark'
import type { Code, Construct, Extension, Token, Tokenizer } from 'micromark-util-types'
import type { Plugin } from 'unified'

function isHan(code: Code): boolean {
  return code !== null && code >= 0 && /\p{Script=Han}/u.test(String.fromCodePoint(code))
}

function isPunctuation(code: Code): boolean {
  return code !== null && code >= 0 && /\p{P}/u.test(String.fromCodePoint(code))
}

const tokenize: Tokenizer = function (effects, ok, nok) {
  const previous = this.previous
  let sequence: Token | undefined
  return attention.tokenize.call(this, {
    ...effects,
    exit(type) {
      const token = effects.exit(type)
      if (type === 'attentionSequence') sequence = token
      return token
    }
  }, (next) => {
    // Run after CommonMark sets the flags, retaining its resolver and all other
    // delimiter rules. Escapes, code, and link destinations never reach here.
    if (sequence && sequence.end.offset - sequence.start.offset === 2) {
      if (isHan(previous) && isPunctuation(next)) sequence._open = true
      if (isPunctuation(previous) && isHan(next)) sequence._close = true
    }
    return ok(next)
  }, nok)
}

const chineseStrong: Construct = { ...attention, tokenize }

/** Allow double-star emphasis next to Han text when its inside edge is punctuation. */
export const remarkChineseStrong: Plugin = function () {
  const data = this.data() as { micromarkExtensions?: Extension[] }
  const extensions = data.micromarkExtensions ?? (data.micromarkExtensions = [])
  extensions.push({ text: { 42: chineseStrong } })
}
