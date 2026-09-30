/**
 * A TOML reader for the parts of Codex's config.toml this app edits, plus a writer
 * that replaces one server's tables as text so the rest of the file keeps its comments.
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable
export interface TomlTable {
  [key: string]: TomlValue
}

export interface TomlSection {
  /** Header key path. The implicit root table has an empty path. */
  path: string[]
  array: boolean
  /** Offset of the header line start. */
  start: number
  /** Offset of the next header line start, or the end of the file. */
  end: number
  values: TomlTable
  error?: string
}

class TomlError extends Error {}

const BARE_KEY = /[A-Za-z0-9_-]/

export function parseTomlSections(text: string): TomlSection[] {
  const p = new Parser(text)
  const sections: TomlSection[] = []
  let current: TomlSection = { path: [], array: false, start: 0, end: text.length, values: {} }
  sections.push(current)
  while (true) {
    p.skipBlank()
    if (p.eof()) break
    const lineStart = p.lineStart()
    if (p.peek() === '[') {
      current.end = lineStart
      try {
        const array = p.text.startsWith('[[', p.pos)
        p.pos += array ? 2 : 1
        const path = p.keyPath()
        p.ws()
        p.expect(array ? ']]' : ']')
        p.endOfLine()
        current = { path, array, start: lineStart, end: text.length, values: {} }
      } catch (err) {
        current = { path: [], array: false, start: lineStart, end: text.length, values: {}, error: message(err) }
        p.skipLine()
      }
      sections.push(current)
      continue
    }
    try {
      const key = p.keyPath()
      p.ws()
      p.expect('=')
      p.ws()
      const value = p.value()
      p.endOfLine()
      setPath(current.values, key, value)
    } catch (err) {
      current.error ??= message(err)
      p.skipLine()
    }
  }
  return sections
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function setPath(table: TomlTable, path: string[], value: TomlValue): void {
  let node = table
  for (const key of path.slice(0, -1)) {
    const next = node[key]
    if (next && typeof next === 'object' && !Array.isArray(next)) node = next
    else node = node[key] = {}
  }
  node[path[path.length - 1]] = value
}

class Parser {
  pos = 0
  constructor(readonly text: string) {}

  eof(): boolean {
    return this.pos >= this.text.length
  }

  peek(): string {
    return this.text[this.pos] ?? ''
  }

  lineStart(): number {
    const nl = this.text.lastIndexOf('\n', this.pos - 1)
    return nl + 1
  }

  fail(what: string): never {
    const line = this.text.slice(0, this.pos).split('\n').length
    throw new TomlError(`TOML line ${line}: ${what}`)
  }

  expect(token: string): void {
    if (!this.text.startsWith(token, this.pos)) this.fail(`expected ${token}`)
    this.pos += token.length
  }

  ws(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos++
  }

  /** Whitespace, newlines, and comments. */
  skipBlank(): void {
    while (!this.eof()) {
      const c = this.peek()
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') this.pos++
      else if (c === '#') this.skipLine()
      else break
    }
  }

  skipLine(): void {
    const nl = this.text.indexOf('\n', this.pos)
    this.pos = nl < 0 ? this.text.length : nl + 1
  }

  endOfLine(): void {
    this.ws()
    if (this.peek() === '#') return this.skipLine()
    if (this.peek() === '\r') this.pos++
    if (this.eof()) return
    if (this.peek() !== '\n') this.fail('expected end of line')
    this.pos++
  }

  keyPath(): string[] {
    const out: string[] = []
    while (true) {
      this.ws()
      out.push(this.key())
      this.ws()
      if (this.peek() !== '.') return out
      this.pos++
    }
  }

  key(): string {
    const c = this.peek()
    if (c === '"') return this.basicString()
    if (c === "'") return this.literalString()
    const start = this.pos
    while (BARE_KEY.test(this.peek())) this.pos++
    if (start === this.pos) this.fail('expected a key')
    return this.text.slice(start, this.pos)
  }

  value(): TomlValue {
    const c = this.peek()
    if (this.text.startsWith('"""', this.pos)) return this.multilineBasic()
    if (this.text.startsWith("'''", this.pos)) return this.multilineLiteral()
    if (c === '"') return this.basicString()
    if (c === "'") return this.literalString()
    if (c === '[') return this.array()
    if (c === '{') return this.inlineTable()
    const start = this.pos
    while (!this.eof() && !/[,\]}\s#]/.test(this.peek())) this.pos++
    const token = this.text.slice(start, this.pos)
    if (!token) this.fail('expected a value')
    if (token === 'true') return true
    if (token === 'false') return false
    const num = Number(token.replace(/_/g, ''))
    if (/^[+-]?(\d|inf|nan|0x|0o|0b)/.test(token) && !Number.isNaN(num)) return num
    // Dates and times are kept as their source text.
    return token
  }

  array(): TomlValue[] {
    this.expect('[')
    const out: TomlValue[] = []
    while (true) {
      this.skipBlank()
      if (this.peek() === ']') {
        this.pos++
        return out
      }
      out.push(this.value())
      this.skipBlank()
      if (this.peek() === ',') {
        this.pos++
        continue
      }
      this.skipBlank()
      this.expect(']')
      return out
    }
  }

  inlineTable(): TomlTable {
    this.expect('{')
    const out: TomlTable = {}
    this.skipBlank()
    if (this.peek() === '}') {
      this.pos++
      return out
    }
    while (true) {
      this.skipBlank()
      const key = this.keyPath()
      this.ws()
      this.expect('=')
      this.ws()
      setPath(out, key, this.value())
      this.skipBlank()
      if (this.peek() === ',') {
        this.pos++
        this.skipBlank()
        if (this.peek() === '}') {
          this.pos++
          return out
        }
        continue
      }
      this.expect('}')
      return out
    }
  }

  basicString(): string {
    this.expect('"')
    let out = ''
    while (true) {
      if (this.eof() || this.peek() === '\n') this.fail('unterminated string')
      const c = this.text[this.pos++]
      if (c === '"') return out
      if (c === '\\') out += this.escape()
      else out += c
    }
  }

  escape(): string {
    const c = this.text[this.pos++]
    switch (c) {
      case 'b': return '\b'
      case 't': return '\t'
      case 'n': return '\n'
      case 'f': return '\f'
      case 'r': return '\r'
      case 'e': return '\x1b'
      case '"': return '"'
      case '\\': return '\\'
      case 'u':
      case 'U': {
        const len = c === 'u' ? 4 : 8
        const hex = this.text.slice(this.pos, this.pos + len)
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) this.fail('invalid unicode escape')
        this.pos += len
        return String.fromCodePoint(parseInt(hex, 16))
      }
      default:
        return this.fail('invalid escape')
    }
  }

  literalString(): string {
    this.expect("'")
    const end = this.text.indexOf("'", this.pos)
    const nl = this.text.indexOf('\n', this.pos)
    if (end < 0 || (nl >= 0 && nl < end)) this.fail('unterminated string')
    const out = this.text.slice(this.pos, end)
    this.pos = end + 1
    return out
  }

  multilineBasic(): string {
    this.expect('"""')
    if (this.peek() === '\r') this.pos++
    if (this.peek() === '\n') this.pos++
    let out = ''
    while (true) {
      if (this.eof()) this.fail('unterminated string')
      if (this.text.startsWith('"""', this.pos)) {
        this.pos += 3
        while (this.peek() === '"') {
          out += '"'
          this.pos++
        }
        return out
      }
      const c = this.text[this.pos++]
      if (c !== '\\') {
        out += c
        continue
      }
      if (/[ \t\r\n]/.test(this.peek())) {
        while (/[ \t\r\n]/.test(this.peek())) this.pos++
        continue
      }
      out += this.escape()
    }
  }

  multilineLiteral(): string {
    this.expect("'''")
    if (this.peek() === '\r') this.pos++
    if (this.peek() === '\n') this.pos++
    const end = this.text.indexOf("'''", this.pos)
    if (end < 0) this.fail('unterminated string')
    let close = end + 3
    while (this.text[close] === "'") close++
    const out = this.text.slice(this.pos, close - 3)
    this.pos = close
    return out
  }
}

export function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}

export function tomlValue(value: TomlValue): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : value > 0 ? 'inf' : value < 0 ? '-inf' : 'nan'
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`
  const pairs = Object.entries(value).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`)
  return pairs.length ? `{ ${pairs.join(', ')} }` : '{}'
}

function isTable(value: TomlValue): value is TomlTable {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** `[prefix]` with scalar keys, followed by one `[prefix.key]` table per nested table. */
export function renderTomlTable(prefix: string[], table: TomlTable): string {
  const header = prefix.map(tomlKey).join('.')
  const lines = [`[${header}]`]
  const nested: [string, TomlTable][] = []
  for (const [key, value] of Object.entries(table)) {
    if (isTable(value)) nested.push([key, value])
    else lines.push(`${tomlKey(key)} = ${tomlValue(value)}`)
  }
  let out = `${lines.join('\n')}\n`
  for (const [key, value] of nested) out += `\n${renderTomlTable([...prefix, key], value)}`
  return out
}

/** Sections whose header is `[root.name]` or below it. */
export function tableSections(sections: TomlSection[], root: string, name: string): TomlSection[] {
  return sections.filter((s) => !s.array && s.path.length >= 2 && s.path[0] === root && s.path[1] === name)
}

/**
 * Removes every `[root.name…]` table and puts `block` where the first one was, or at the end.
 * `block` may be empty to delete the server.
 */
export function replaceTomlTables(text: string, root: string, name: string, block: string, insertAfter?: string): string {
  const out = replaceLf(text.replace(/\r\n/g, '\n'), root, name, block.replace(/\r\n/g, '\n'), insertAfter)
  return text.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out
}

function replaceLf(src: string, root: string, name: string, block: string, insertAfter?: string): string {
  const ranges = tableSections(parseTomlSections(src), root, name)
    .map((s) => ({ start: s.start, end: contentEnd(src, s.start, s.end) }))
    .sort((a, b) => b.start - a.start)
  let out = src
  ranges.forEach((range, i) => {
    const before = out.slice(0, range.start)
    const after = out.slice(range.end)
    out = i === ranges.length - 1 && block ? join(join(before, block), after) : join(before, after)
  })
  if (ranges.length || !block) return out
  const anchor = insertAfter === undefined ? undefined : tableSections(parseTomlSections(out), root, insertAfter).sort((a, b) => b.start - a.start)[0]
  if (!anchor) return join(out, block)
  const end = contentEnd(out, anchor.start, anchor.end)
  return join(join(out.slice(0, end), block), out.slice(end))
}

/** End of a table without the blank and comment lines that lead into the next header. */
function contentEnd(text: string, start: number, end: number): number {
  const lines = text.slice(start, end).split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  let keep = lines.length
  while (keep > 1 && (lines[keep - 1].trim() === '' || lines[keep - 1].trim().startsWith('#'))) keep--
  return Math.min(end, start + lines.slice(0, keep).join('\n').length + 1)
}

/** Joins two pieces of a file with exactly one blank line between them. */
function join(before: string, after: string): string {
  const head = before.replace(/\n+$/, '')
  const tail = after.replace(/^\n+/, '')
  if (!head) return tail
  if (!tail) return `${head}\n`
  return `${head}\n\n${tail}`
}
