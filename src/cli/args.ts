import { CliError, EXIT_USAGE } from './types'

export type FlagSpec = {
  type: 'boolean' | 'string' | 'string[]'
  alias?: string
  negatable?: boolean
}

export type FlagSchema = Record<string, FlagSpec>

export interface ParsedArgs {
  positionals: string[]
  flags: Record<string, boolean | string | string[] | undefined>
}

export function parseArgs(argv: string[], schema: FlagSchema): ParsedArgs {
  const byAlias = new Map<string, string>()
  for (const [name, spec] of Object.entries(schema)) {
    if (spec.alias) byAlias.set(spec.alias, name)
  }

  const positionals: string[] = []
  const flags: Record<string, boolean | string | string[] | undefined> = {}

  const setString = (name: string, spec: FlagSpec, value: string) => {
    if (spec.type === 'string[]') {
      const current = Array.isArray(flags[name]) ? (flags[name] as string[]) : []
      current.push(value)
      flags[name] = current
    } else {
      flags[name] = value
    }
  }

  let passthrough = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (passthrough) {
      positionals.push(token)
      continue
    }
    if (token === '--') {
      passthrough = true
      continue
    }
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      const rawName = eq >= 0 ? body.slice(0, eq) : body
      const inlineValue = eq >= 0 ? body.slice(eq + 1) : undefined

      if (rawName.startsWith('no-')) {
        const base = rawName.slice(3)
        const baseSpec = schema[base]
        if (baseSpec?.type === 'boolean' && baseSpec.negatable) {
          if (inlineValue !== undefined) throw new CliError(`Option --${rawName} does not take a value`, EXIT_USAGE)
          flags[base] = false
          continue
        }
      }

      const spec = schema[rawName]
      if (!spec) throw new CliError(`Unknown option: --${rawName}`, EXIT_USAGE)

      if (spec.type === 'boolean') {
        if (inlineValue !== undefined) {
          if (inlineValue === 'true' || inlineValue === '1') flags[rawName] = true
          else if (inlineValue === 'false' || inlineValue === '0') flags[rawName] = false
          else throw new CliError(`Invalid boolean value for --${rawName}: ${inlineValue}`, EXIT_USAGE)
        } else {
          flags[rawName] = true
        }
      } else {
        const value = inlineValue !== undefined ? inlineValue : argv[++i]
        if (value === undefined) throw new CliError(`Missing value for --${rawName}`, EXIT_USAGE)
        setString(rawName, spec, value)
      }
      continue
    }

    if (token.startsWith('-') && token.length > 1) {
      const short = token.slice(1)
      const name = byAlias.get(short)
      if (!name) throw new CliError(`Unknown option: -${short}`, EXIT_USAGE)
      const spec = schema[name]
      if (spec.type === 'boolean') {
        flags[name] = true
      } else {
        const value = argv[++i]
        if (value === undefined) throw new CliError(`Missing value for -${short}`, EXIT_USAGE)
        setString(name, spec, value)
      }
      continue
    }

    positionals.push(token)
  }

  return { positionals, flags }
}
