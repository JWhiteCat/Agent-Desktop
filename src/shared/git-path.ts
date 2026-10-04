const ESCAPES: Record<string, string> = {
  a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"'
}
const QUOTED = new Map(Object.entries(ESCAPES).map(([escape, char]) => [char, `\\${escape}`]))

/** Git uses C-style quoting, including octal UTF-8 bytes, rather than JSON escapes. */
export function decodeGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value
  return value.slice(1, -1).replace(/(?:\\[0-7]{1,3})+|\\([abfnrtv\\"])/g, (quoted, escape: string | undefined) => {
    if (escape) return ESCAPES[escape]
    const bytes = quoted.match(/[0-7]{1,3}/g)!.map((octal: string) => parseInt(octal, 8))
    return new TextDecoder().decode(Uint8Array.from(bytes))
  })
}

/** Quote synthetic diff paths so filename control characters cannot become header lines. */
export function quoteGitPath(value: string): string {
  if (!/[ "\\\x00-\x1f\x7f]/.test(value)) return value
  const escaped = value.replace(/["\\\x00-\x1f\x7f]/g, (char) =>
    QUOTED.get(char) ?? `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}`)
  return `"${escaped}"`
}

export function untrackedGitPaths(status: string): string[] {
  return status.split(/\r?\n/).filter((line) => line.startsWith('?? ')).map((line) => decodeGitPath(line.slice(3)))
}
