export type TokenKind =
  | 'plain'
  | 'kw'
  | 'str'
  | 'com'
  | 'num'
  | 'fn'
  | 'type'
  | 'prop'
  | 'tag'
  | 'attr'
  | 'add'
  | 'del'

export interface CodeToken {
  kind: TokenKind
  text: string
}

const MAX_HIGHLIGHT_CHARS = 50_000

type LangGroup = 'js' | 'py' | 'rust' | 'go' | 'c' | 'json' | 'yaml' | 'shell' | 'html' | 'css' | 'sql' | 'diff'

const LANG_ALIASES: Record<string, LangGroup> = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', javascript: 'js',
  ts: 'js', tsx: 'js', mts: 'js', cts: 'js', typescript: 'js',
  py: 'py', python: 'py', pyw: 'py',
  rs: 'rust', rust: 'rust',
  go: 'go', golang: 'go',
  c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', cxx: 'c', hpp: 'c',
  java: 'c', kt: 'c', kotlin: 'c', cs: 'c', csharp: 'c', swift: 'c', dart: 'c',
  json: 'json', jsonc: 'json', json5: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml', conf: 'yaml', env: 'yaml',
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', fish: 'shell',
  ps1: 'shell', pwsh: 'shell', powershell: 'shell', bat: 'shell', cmd: 'shell',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  sql: 'sql', sqlite: 'sql', postgres: 'sql', postgresql: 'sql', mysql: 'sql',
  diff: 'diff', patch: 'diff'
}

const KEYWORDS: Record<'js' | 'py' | 'rust' | 'go' | 'c', Set<string>> = {
  js: new Set([
    'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally',
    'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof',
    'interface', 'let', 'new', 'null', 'of', 'package', 'private', 'protected', 'public',
    'readonly', 'return', 'satisfies', 'set', 'static', 'super', 'switch', 'this', 'throw',
    'true', 'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield',
    'as', 'is', 'keyof', 'infer', 'declare', 'namespace', 'abstract', 'override'
  ]),
  py: new Set([
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
    'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
    'if', 'import', 'in', 'is', 'lambda', 'match', 'case', 'nonlocal', 'not', 'or', 'pass',
    'raise', 'return', 'try', 'while', 'with', 'yield', 'self', 'cls'
  ]),
  rust: new Set([
    'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum',
    'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod',
    'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super',
    'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while'
  ]),
  go: new Set([
    'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough',
    'false', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'iota', 'map', 'nil',
    'package', 'range', 'return', 'select', 'struct', 'switch', 'true', 'type', 'var'
  ]),
  c: new Set([
    'abstract', 'as', 'async', 'auto', 'await', 'bool', 'break', 'case', 'catch', 'class',
    'const', 'constexpr', 'continue', 'default', 'defer', 'delete', 'do', 'else', 'enum',
    'explicit', 'export', 'extends', 'extern', 'false', 'final', 'finally', 'for', 'foreach',
    'friend', 'func', 'get', 'goto', 'guard', 'if', 'implements', 'import', 'in', 'include',
    'inline', 'interface', 'internal', 'is', 'let', 'mutating', 'namespace', 'new', 'nil',
    'noexcept', 'null', 'nullptr', 'object', 'operator', 'out', 'override', 'package',
    'private', 'protected', 'protocol', 'public', 'readonly', 'record', 'ref', 'register',
    'return', 'sealed', 'self', 'set', 'sizeof', 'static', 'struct', 'super', 'switch',
    'template', 'this', 'throw', 'throws', 'true', 'try', 'typedef', 'typename', 'typeof',
    'union', 'using', 'val', 'var', 'virtual', 'volatile', 'when', 'where', 'while', 'yield'
  ])
}

const PRIMITIVE_TYPES = new Set([
  'any', 'boolean', 'bigint', 'never', 'number', 'object', 'string', 'symbol', 'unknown', 'void',
  'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'f32', 'f64',
  'str', 'char', 'float', 'float32', 'float64', 'double', 'long', 'short', 'byte', 'rune', 'size_t',
  'bool', 'dict', 'list', 'tuple', 'bytes', 'error', 'Option', 'Result', 'Vec', 'String', 'Promise', 'Record', 'Array', 'Map', 'Set'
])

const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE',
  'TABLE', 'INDEX', 'VIEW', 'DROP', 'ALTER', 'ADD', 'COLUMN', 'PRIMARY', 'KEY', 'FOREIGN',
  'REFERENCES', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'ON', 'AS',
  'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'TRUE', 'FALSE', 'LIKE', 'ILIKE', 'BETWEEN',
  'EXISTS', 'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT', 'UNION', 'ALL',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'WITH', 'RECURSIVE', 'ASC', 'DESC', 'DEFAULT',
  'CONSTRAINT', 'UNIQUE', 'CHECK', 'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION', 'EXPLAIN'
])

const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case',
  'esac', 'function', 'return', 'exit', 'export', 'local', 'readonly', 'declare', 'set',
  'unset', 'shift', 'source', 'true', 'false', 'param', 'foreach', 'try', 'catch', 'finally',
  'throw', 'switch', 'break', 'continue', 'echo', 'cd', 'pwd', 'sudo', 'npm', 'npx', 'pnpm',
  'yarn', 'git', 'node', 'python', 'python3', 'cargo', 'go', 'docker', 'curl', 'rg', 'grep'
])

function push(tokens: CodeToken[], kind: TokenKind, text: string): void {
  if (!text) return
  const last = tokens[tokens.length - 1]
  if (last && last.kind === kind) last.text += text
  else tokens.push({ kind, text })
}

function readQuoted(code: string, start: number, quote: string, multiline = false): number {
  let i = start + 1
  while (i < code.length) {
    const ch = code[i]
    if (ch === '\\' && i + 1 < code.length) {
      i += 2
      continue
    }
    if (ch === quote) return i + 1
    if (!multiline && ch === '\n') return i
    i++
  }
  return i
}

function readNumber(code: string, start: number): number {
  let i = start
  if (code[i] === '0' && (code[i + 1] === 'x' || code[i + 1] === 'X' || code[i + 1] === 'b' || code[i + 1] === 'B' || code[i + 1] === 'o' || code[i + 1] === 'O')) {
    i += 2
    while (i < code.length && /[0-9a-fA-F_]/.test(code[i])) i++
    if (code[i] === 'n') i++
    return i
  }
  while (i < code.length && /[0-9_]/.test(code[i])) i++
  if (code[i] === '.' && /[0-9]/.test(code[i + 1] ?? '')) {
    i++
    while (i < code.length && /[0-9_]/.test(code[i])) i++
  }
  if ((code[i] === 'e' || code[i] === 'E') && /[0-9+-]/.test(code[i + 1] ?? '')) {
    i++
    if (code[i] === '+' || code[i] === '-') i++
    while (i < code.length && /[0-9_]/.test(code[i])) i++
  }
  if (code[i] === 'n' || code[i] === 'f' || code[i] === 'u' || code[i] === 'i') {
    while (i < code.length && /[0-9a-zA-Z]/.test(code[i])) i++
  }
  return i
}

function tokenizeDiff(code: string): CodeToken[] {
  const tokens: CodeToken[] = []
  const lines = code.split(/(?<=\n)/)
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      push(tokens, 'com', line)
    } else if (line.startsWith('@@')) {
      push(tokens, 'kw', line)
    } else if (line.startsWith('+')) {
      push(tokens, 'add', line)
    } else if (line.startsWith('-')) {
      push(tokens, 'del', line)
    } else {
      push(tokens, 'plain', line)
    }
  }
  return tokens
}

function tokenizeJson(code: string): CodeToken[] {
  const tokens: CodeToken[] = []
  let i = 0
  while (i < code.length) {
    const ch = code[i]
    if (ch === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i)
      const next = end === -1 ? code.length : end
      push(tokens, 'com', code.slice(i, next))
      i = next
      continue
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      const next = end === -1 ? code.length : end + 2
      push(tokens, 'com', code.slice(i, next))
      i = next
      continue
    }
    if (ch === '"') {
      const next = readQuoted(code, i, '"')
      let look = next
      while (look < code.length && (code[look] === ' ' || code[look] === '\t')) look++
      push(tokens, code[look] === ':' ? 'prop' : 'str', code.slice(i, next))
      i = next
      continue
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(code[i + 1] ?? ''))) {
      const next = readNumber(code, ch === '-' ? i + 1 : i)
      push(tokens, 'num', code.slice(i, next))
      i = next
      continue
    }
    if (/[a-zA-Z]/.test(ch)) {
      let next = i + 1
      while (next < code.length && /[a-zA-Z0-9_]/.test(code[next])) next++
      const word = code.slice(i, next)
      push(tokens, word === 'true' || word === 'false' || word === 'null' ? 'kw' : 'plain', word)
      i = next
      continue
    }
    push(tokens, 'plain', ch)
    i++
  }
  return tokens
}

function tokenizeYaml(code: string): CodeToken[] {
  const tokens: CodeToken[] = []
  const lines = code.split(/(?<=\n)/)
  for (const line of lines) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('#')) {
      push(tokens, 'com', line)
      continue
    }
    if (trimmed.startsWith('[') && trimmed.trimEnd().endsWith(']')) {
      push(tokens, 'type', line)
      continue
    }
    const keyMatch = /^(\s*(?:-\s+)?)([A-Za-z0-9_.-]+)(\s*[:=])(.*)$/s.exec(line)
    if (keyMatch) {
      push(tokens, 'plain', keyMatch[1])
      push(tokens, 'prop', keyMatch[2])
      push(tokens, 'plain', keyMatch[3])
      tokenizeYamlValue(keyMatch[4], tokens)
    } else {
      tokenizeYamlValue(line, tokens)
    }
  }
  return tokens
}

function tokenizeYamlValue(rest: string, tokens: CodeToken[]): void {
  let i = 0
  while (i < rest.length) {
    const ch = rest[i]
    if (ch === '#' && (i === 0 || /\s/.test(rest[i - 1]))) {
      push(tokens, 'com', rest.slice(i))
      return
    }
    if (ch === '"' || ch === "'") {
      const next = readQuoted(rest, i, ch)
      push(tokens, 'str', rest.slice(i, next))
      i = next
      continue
    }
    if (/[0-9]/.test(ch) && (i === 0 || /[\s,[\]=:]/.test(rest[i - 1]))) {
      const next = readNumber(rest, i)
      push(tokens, 'num', rest.slice(i, next))
      i = next
      continue
    }
    if (/[a-zA-Z]/.test(ch)) {
      let next = i + 1
      while (next < rest.length && /[a-zA-Z0-9_-]/.test(rest[next])) next++
      const word = rest.slice(i, next)
      const lower = word.toLowerCase()
      push(tokens, lower === 'true' || lower === 'false' || lower === 'null' || lower === 'yes' || lower === 'no' ? 'kw' : 'plain', word)
      i = next
      continue
    }
    push(tokens, 'plain', ch)
    i++
  }
}

function tokenizeHtml(code: string): CodeToken[] {
  const tokens: CodeToken[] = []
  let i = 0
  while (i < code.length) {
    if (code.startsWith('<!--', i)) {
      const end = code.indexOf('-->', i + 4)
      const next = end === -1 ? code.length : end + 3
      push(tokens, 'com', code.slice(i, next))
      i = next
      continue
    }
    if (code[i] === '<' && (code[i + 1] === '/' || code[i + 1] === '!' || /[a-zA-Z]/.test(code[i + 1] ?? ''))) {
      push(tokens, 'plain', code[i] === '<' && code[i + 1] === '/' ? '</' : '<')
      i += code[i + 1] === '/' ? 2 : 1
      let nameEnd = i
      while (nameEnd < code.length && /[a-zA-Z0-9:_-]/.test(code[nameEnd])) nameEnd++
      if (nameEnd > i) {
        push(tokens, 'tag', code.slice(i, nameEnd))
        i = nameEnd
      }
      while (i < code.length && code[i] !== '>') {
        const ch = code[i]
        if (ch === '"' || ch === "'") {
          const next = readQuoted(code, i, ch, true)
          push(tokens, 'str', code.slice(i, next))
          i = next
          continue
        }
        if (/[a-zA-Z:@_-]/.test(ch)) {
          let attrEnd = i + 1
          while (attrEnd < code.length && /[a-zA-Z0-9:@_.-]/.test(code[attrEnd])) attrEnd++
          push(tokens, 'attr', code.slice(i, attrEnd))
          i = attrEnd
          continue
        }
        push(tokens, 'plain', ch)
        i++
      }
      if (code[i] === '>') {
        push(tokens, 'plain', '>')
        i++
      }
      continue
    }
    push(tokens, 'plain', code[i])
    i++
  }
  return tokens
}

function tokenizeCss(code: string): CodeToken[] {
  const tokens: CodeToken[] = []
  let i = 0
  let inBlock = 0
  while (i < code.length) {
    const ch = code[i]
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      const next = end === -1 ? code.length : end + 2
      push(tokens, 'com', code.slice(i, next))
      i = next
      continue
    }
    if (ch === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i)
      const next = end === -1 ? code.length : end
      push(tokens, 'com', code.slice(i, next))
      i = next
      continue
    }
    if (ch === '"' || ch === "'") {
      const next = readQuoted(code, i, ch)
      push(tokens, 'str', code.slice(i, next))
      i = next
      continue
    }
    if (ch === '{') {
      inBlock++
      push(tokens, 'plain', ch)
      i++
      continue
    }
    if (ch === '}') {
      inBlock = Math.max(0, inBlock - 1)
      push(tokens, 'plain', ch)
      i++
      continue
    }
    if (ch === '@') {
      let next = i + 1
      while (next < code.length && /[a-zA-Z0-9_-]/.test(code[next])) next++
      push(tokens, 'kw', code.slice(i, next))
      i = next
      continue
    }
    if (ch === '#' && /[0-9a-fA-F]/.test(code[i + 1] ?? '') && inBlock > 0) {
      let next = i + 1
      while (next < code.length && /[0-9a-fA-F]/.test(code[next])) next++
      push(tokens, 'num', code.slice(i, next))
      i = next
      continue
    }
    if (/[0-9]/.test(ch)) {
      let next = readNumber(code, i)
      while (next < code.length && /[a-zA-Z%]/.test(code[next])) next++
      push(tokens, 'num', code.slice(i, next))
      i = next
      continue
    }
    if (ch === '!' && code.startsWith('!important', i)) {
      push(tokens, 'kw', '!important')
      i += 10
      continue
    }
    if (/[a-zA-Z_-]/.test(ch)) {
      let next = i + 1
      while (next < code.length && /[a-zA-Z0-9_-]/.test(code[next])) next++
      const word = code.slice(i, next)
      let look = next
      while (look < code.length && (code[look] === ' ' || code[look] === '\t')) look++
      if (inBlock > 0 && code[look] === ':') push(tokens, 'prop', word)
      else if (code[next] === '(') push(tokens, 'fn', word)
      else if (inBlock === 0) push(tokens, 'tag', word)
      else push(tokens, 'plain', word)
      i = next
      continue
    }
    push(tokens, 'plain', ch)
    i++
  }
  return tokens
}

function tokenizeShell(code: string): CodeToken[] {
  const tokens: CodeToken[] = []
  let i = 0
  while (i < code.length) {
    const ch = code[i]
    if (ch === '#' && (i === 0 || /[\s;(]/.test(code[i - 1]))) {
      const end = code.indexOf('\n', i)
      const next = end === -1 ? code.length : end
      push(tokens, 'com', code.slice(i, next))
      i = next
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const next = readQuoted(code, i, ch, ch === '`')
      push(tokens, 'str', code.slice(i, next))
      i = next
      continue
    }
    if (ch === '$') {
      if (code[i + 1] === '{') {
        const end = code.indexOf('}', i + 2)
        const next = end === -1 ? i + 2 : end + 1
        push(tokens, 'prop', code.slice(i, next))
        i = next
        continue
      }
      if (/[a-zA-Z0-9_?@*#!-]/.test(code[i + 1] ?? '')) {
        let next = i + 2
        while (next < code.length && /[a-zA-Z0-9_]/.test(code[next])) next++
        push(tokens, 'prop', code.slice(i, next))
        i = next
        continue
      }
    }
    if (ch === '-' && (i === 0 || /\s/.test(code[i - 1])) && /[a-zA-Z-]/.test(code[i + 1] ?? '')) {
      let next = i + 1
      while (next < code.length && /[a-zA-Z0-9_-]/.test(code[next])) next++
      push(tokens, 'attr', code.slice(i, next))
      i = next
      continue
    }
    if (/[0-9]/.test(ch) && (i === 0 || /[\s=:(,]/.test(code[i - 1]))) {
      const next = readNumber(code, i)
      push(tokens, 'num', code.slice(i, next))
      i = next
      continue
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let next = i + 1
      while (next < code.length && /[a-zA-Z0-9_-]/.test(code[next])) next++
      const word = code.slice(i, next)
      if (code[next] === '=') push(tokens, 'prop', word)
      else if (SHELL_KEYWORDS.has(word)) push(tokens, 'kw', word)
      else push(tokens, 'plain', word)
      i = next
      continue
    }
    push(tokens, 'plain', ch)
    i++
  }
  return tokens
}

function tokenizeSql(code: string): CodeToken[] {
  const tokens: CodeToken[] = []
  let i = 0
  while (i < code.length) {
    const ch = code[i]
    if (ch === '-' && code[i + 1] === '-') {
      const end = code.indexOf('\n', i)
      const next = end === -1 ? code.length : end
      push(tokens, 'com', code.slice(i, next))
      i = next
      continue
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      const next = end === -1 ? code.length : end + 2
      push(tokens, 'com', code.slice(i, next))
      i = next
      continue
    }
    if (ch === "'" || ch === '"') {
      const next = readQuoted(code, i, ch)
      push(tokens, 'str', code.slice(i, next))
      i = next
      continue
    }
    if (/[0-9]/.test(ch)) {
      const next = readNumber(code, i)
      push(tokens, 'num', code.slice(i, next))
      i = next
      continue
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let next = i + 1
      while (next < code.length && /[a-zA-Z0-9_]/.test(code[next])) next++
      const word = code.slice(i, next)
      if (SQL_KEYWORDS.has(word.toUpperCase())) push(tokens, 'kw', word)
      else if (code[next] === '(') push(tokens, 'fn', word)
      else push(tokens, 'plain', word)
      i = next
      continue
    }
    push(tokens, 'plain', ch)
    i++
  }
  return tokens
}

function tokenizeGeneral(code: string, group: 'js' | 'py' | 'rust' | 'go' | 'c'): CodeToken[] {
  const tokens: CodeToken[] = []
  const kw = KEYWORDS[group]
  let i = 0
  let prevNonSpace = ''
  while (i < code.length) {
    const ch = code[i]
    if (group === 'py' && ch === '#') {
      const end = code.indexOf('\n', i)
      const next = end === -1 ? code.length : end
      push(tokens, 'com', code.slice(i, next))
      i = next
      continue
    }
    if (group !== 'py' && ch === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i)
      const next = end === -1 ? code.length : end
      push(tokens, 'com', code.slice(i, next))
      i = next
      continue
    }
    if (group !== 'py' && ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      const next = end === -1 ? code.length : end + 2
      push(tokens, 'com', code.slice(i, next))
      i = next
      continue
    }
    if (group === 'py' && (code.startsWith('"""', i) || code.startsWith("'''", i))) {
      const delim = code.slice(i, i + 3)
      const end = code.indexOf(delim, i + 3)
      const next = end === -1 ? code.length : end + 3
      push(tokens, 'str', code.slice(i, next))
      i = next
      prevNonSpace = '"'
      continue
    }
    if (ch === '"' || (ch === "'" && group !== 'rust') || (ch === '`' && (group === 'js' || group === 'go'))) {
      const next = readQuoted(code, i, ch, ch === '`')
      push(tokens, 'str', code.slice(i, next))
      i = next
      prevNonSpace = '"'
      continue
    }
    if (group === 'rust' && ch === "'" && code[i + 1] && code[i + 1] !== '\n') {
      if (code[i + 2] === "'" || (code[i + 1] === '\\' && code[i + 3] === "'")) {
        const next = readQuoted(code, i, "'")
        push(tokens, 'str', code.slice(i, next))
        i = next
        prevNonSpace = "'"
        continue
      }
      if (/[a-zA-Z_]/.test(code[i + 1])) {
        let next = i + 2
        while (next < code.length && /[a-zA-Z0-9_]/.test(code[next])) next++
        push(tokens, 'attr', code.slice(i, next))
        i = next
        continue
      }
    }
    if ((ch === '@' || (group === 'c' && ch === '#')) && /[a-zA-Z_]/.test(code[i + 1] ?? '')) {
      let next = i + 2
      while (next < code.length && /[a-zA-Z0-9_.]/.test(code[next])) next++
      push(tokens, 'attr', code.slice(i, next))
      i = next
      prevNonSpace = '@'
      continue
    }
    if (/[0-9]/.test(ch)) {
      const next = readNumber(code, i)
      push(tokens, 'num', code.slice(i, next))
      i = next
      prevNonSpace = '0'
      continue
    }
    if (/[a-zA-Z_$]/.test(ch)) {
      let next = i + 1
      while (next < code.length && /[a-zA-Z0-9_$]/.test(code[next])) next++
      const word = code.slice(i, next)
      let kind: TokenKind = 'plain'
      if (kw.has(word)) kind = 'kw'
      else if (code[next] === '(' || (group === 'rust' && code[next] === '!')) kind = 'fn'
      else if (PRIMITIVE_TYPES.has(word) || (/^[A-Z][a-zA-Z0-9]*$/.test(word) && /[a-z]/.test(word))) kind = 'type'
      else if (prevNonSpace === '.') kind = 'prop'
      push(tokens, kind, word)
      i = next
      prevNonSpace = 'a'
      continue
    }
    if (!/\s/.test(ch)) prevNonSpace = ch
    push(tokens, 'plain', ch)
    i++
  }
  return tokens
}

/**
 * Tokenizes source code into lightweight syntax spans.
 * Returns null for plain text, unknown languages, or oversized blocks so callers can render raw text directly.
 */
export function tokenizeCode(code: string, lang?: string): CodeToken[] | null {
  if (!code || !lang || code.length > MAX_HIGHLIGHT_CHARS) return null
  const normalized = lang.trim().toLowerCase()
  const group = LANG_ALIASES[normalized]
  if (!group) return null
  switch (group) {
    case 'diff': return tokenizeDiff(code)
    case 'json': return tokenizeJson(code)
    case 'yaml': return tokenizeYaml(code)
    case 'html': return tokenizeHtml(code)
    case 'css': return tokenizeCss(code)
    case 'shell': return tokenizeShell(code)
    case 'sql': return tokenizeSql(code)
    default: return tokenizeGeneral(code, group)
  }
}
