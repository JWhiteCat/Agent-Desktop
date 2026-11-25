import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { tokenizeCode } from '../src/renderer/src/lib/syntax-highlight'
import { CodeBlock } from '../src/renderer/src/components/items/primitives'

describe('syntax-highlight tokenizer', () => {
  it('returns null for plain text, unknown languages, empty input, and oversized blocks', () => {
    expect(tokenizeCode('hello world')).toBeNull()
    expect(tokenizeCode('hello world', 'text')).toBeNull()
    expect(tokenizeCode('hello world', 'unknown-lang')).toBeNull()
    expect(tokenizeCode('', 'ts')).toBeNull()
    expect(tokenizeCode('a'.repeat(50_001), 'ts')).toBeNull()
  })

  it.each([
    ['ts', 'const count: number = 42 // comment\nfunction greet(name: string) { return `hi ${name}` }', ['kw', 'type', 'num', 'com', 'fn', 'str']],
    ['python', '@cache\ndef fib(n: int) -> int:\n  # base\n  return 1 if n <= 1 else fib(n - 1)', ['attr', 'kw', 'fn', 'type', 'com', 'num']],
    ['json', '{\n  "name": "agent-desktop",\n  "count": 3,\n  "enabled": true\n}', ['prop', 'str', 'num', 'kw']],
    ['bash', '# deploy\nexport NODE_ENV="prod"\nnpm run build --silent $HOME', ['com', 'kw', 'prop', 'str', 'attr']],
    ['css', '@media (max-width: 720px) {\n  /* mobile */\n  .card { color: #ff00aa; padding: 12px !important; }\n}', ['kw', 'com', 'tag', 'prop', 'num']],
    ['html', '<!-- tip -->\n<button class="primary" disabled>Save</button>', ['com', 'tag', 'attr', 'str']],
    ['sql', '-- query\nSELECT id, count(*) FROM threads WHERE active = TRUE LIMIT 10;', ['com', 'kw', 'fn', 'num']],
    ['diff', '--- a/file.ts\n+++ b/file.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n unchanged', ['com', 'kw', 'del', 'add']]
  ] as const)('tokenizes %s losslessly with expected token kinds', (lang, code, expectedKinds) => {
    const tokens = tokenizeCode(code, lang)
    expect(tokens).not.toBeNull()
    expect(tokens!.map((t) => t.text).join('')).toBe(code)
    const kinds = new Set(tokens!.map((t) => t.kind))
    for (const kind of expectedKinds) {
      expect(kinds.has(kind)).toBe(true)
    }
  })

  it('renders plain text code blocks without extra spans and highlights supported languages', () => {
    const plainHtml = renderToStaticMarkup(createElement(CodeBlock, { lang: 'text', text: 'const x = 1' }))
    expect(plainHtml).toContain('<pre><code>const x = 1</code></pre>')
    expect(plainHtml).not.toContain('hl-kw')

    const tsHtml = renderToStaticMarkup(createElement(CodeBlock, { lang: 'ts', text: 'const x = 1' }))
    expect(tsHtml).toContain('<span class="hl-kw">const</span>')
    expect(tsHtml).toContain('<span class="hl-num">1</span>')
  })
})
