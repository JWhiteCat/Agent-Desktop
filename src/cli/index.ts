import pkg from '../../package.json'
import { parseArgs, type FlagSchema } from './args'
import { runCliCommand } from './commands/cli-info'
import { runProjectsCommand } from './commands/projects'
import { runAnswerCommand, runPromptCommand, runStopCommand, runWatchCommand } from './commands/run'
import { runStatus } from './commands/status'
import { runThreadsCommand } from './commands/threads'
import { openCliRuntime, type OpenRuntimeOptions } from './runtime'
import {
  CliError,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  type CliIo,
  type CliRuntime,
  type OutputFormat,
  type QuestionPolicy
} from './types'

const SCHEMA: FlagSchema = {
  help: { type: 'boolean', alias: 'h' },
  version: { type: 'boolean', alias: 'v' },
  'user-data': { type: 'string' },
  'attach-only': { type: 'boolean' },
  headless: { type: 'boolean' },
  format: { type: 'string' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean', alias: 'q' },

  // Command-specific options
  project: { type: 'string' },
  thread: { type: 'string', alias: 't' },
  cli: { type: 'string' },
  model: { type: 'string', alias: 'm' },
  mode: { type: 'string' },
  force: { type: 'boolean', negatable: true },
  worktree: { type: 'boolean' },
  file: { type: 'string[]', alias: 'f' },
  queue: { type: 'boolean' },
  now: { type: 'boolean' },
  detach: { type: 'boolean', alias: 'd' },
  'show-thinking': { type: 'boolean' },
  'on-question': { type: 'string' },
  prompt: { type: 'string', alias: 'p' },
  all: { type: 'boolean' },
  running: { type: 'boolean' },
  tail: { type: 'string' },
  refresh: { type: 'boolean' },
  at: { type: 'string' },
  answers: { type: 'string' },
  skip: { type: 'boolean' }
}

const HELP_TEXT = `Agent Desktop CLI (agent-desktop / agd) v${pkg.version}

Usage:
  agent-desktop <command> [options]
  agd <command> [options]

Commands:
  status                                    Show runtime mode (attached/headless), desktop PID, and CLI backends
  cli list [--refresh]                      List Cursor / Codex / Claude / Antigravity installation & auth status
  cli models [provider] [--refresh]         List available models for a CLI provider
  projects list                             List registered projects
  projects add [dir]                        Register a directory as a project (defaults to ".")
  threads list [options]                    List conversations (--project, --all, --running)
  threads show <threadId> [--tail N]        Show messages in a conversation
  threads create [options]                  Create an empty conversation and print its ID
  threads fork <threadId> [--at <itemId>]   Fork a conversation
  threads sync <threadId>                   Sync conversation history from the underlying CLI
  threads delete <threadId>                 Delete a conversation
  run [prompt] [options]                    Send a prompt and stream output (accepts stdin pipe)
  watch <threadId>                          Stream output from an active conversation (attached mode)
  stop <threadId>                           Stop a running conversation
  answer <threadId> <questionId> [options]  Answer or skip a pending question (--answers '<json>' | --skip)

Run Options:
  -p, --prompt <text>         Prompt text (or pass positionally / via stdin)
      --project <id|path>     Project ID or directory (defaults to current working directory)
  -t, --thread <id>           Continue an existing thread instead of creating a new one
      --cli <provider>        cursor | codex | claude | antigravity
  -m, --model <id>            Override model ID
      --mode <mode>           agent | plan | ask
      --force / --no-force    Enable or disable full-access auto-approval
      --worktree              Run in an isolated git worktree
  -f, --file <path>           Attach a file or image (repeatable)
      --queue | --now         Queue behind or interrupt an active turn
  -d, --detach                Dispatch and return immediately (requires running desktop app)
      --show-thinking         Print thinking stream to stderr in text mode
      --on-question <policy>  interactive | fail | cancel

Global Options:
      --user-data <dir>       Override Agent Desktop userData directory
      --attach-only           Fail if Agent Desktop is not running (exit 4)
      --headless              Run standalone without desktop app (fails if desktop is running, exit 5)
      --format <fmt>          text | json | jsonl
      --json                  Shorthand for --format json
  -q, --quiet                 Suppress status headers and progress lines
  -h, --help                  Show this help
  -v, --version               Show version
`

function resolveFormat(flags: Record<string, unknown>): OutputFormat {
  if (flags.json) return 'json'
  const raw = flags.format as string | undefined
  if (!raw) return 'text'
  if (raw === 'text' || raw === 'json' || raw === 'jsonl') return raw
  throw new CliError(`Invalid --format value "${raw}". Expected text, json, or jsonl.`, EXIT_USAGE)
}

function resolveQuestionPolicy(raw: unknown): QuestionPolicy | undefined {
  if (raw === undefined) return undefined
  if (raw === 'interactive' || raw === 'fail' || raw === 'cancel') return raw
  throw new CliError(`Invalid --on-question value "${String(raw)}". Expected interactive, fail, or cancel.`, EXIT_USAGE)
}

function defaultIo(): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    cwd: () => process.cwd(),
    env: process.env
  }
}

export interface RunCliDeps {
  io?: CliIo
  openRuntime?: (opts: OpenRuntimeOptions) => Promise<CliRuntime>
}

export async function runCli(argv: string[], deps: RunCliDeps = {}): Promise<number> {
  const io = deps.io ?? defaultIo()
  const openRuntime = deps.openRuntime ?? openCliRuntime

  let format: OutputFormat = 'text'
  let runtime: CliRuntime | undefined

  try {
    const parsed = parseArgs(argv, SCHEMA)
    const { flags, positionals } = parsed

    if (flags.version) {
      io.stdout.write(`${pkg.version}\n`)
      return EXIT_OK
    }

    const command = positionals[0]
    if (flags.help || !command || command === 'help') {
      io.stdout.write(HELP_TEXT)
      return EXIT_OK
    }

    format = resolveFormat(flags)
    runtime = await openRuntime({
      userData: flags['user-data'] as string | undefined,
      attachOnly: Boolean(flags['attach-only']),
      headless: Boolean(flags.headless),
      command
    })

    const sub = positionals[1]
    const rest = positionals.slice(2)

    switch (command) {
      case 'status':
        return await runStatus(runtime, io, { format })

      case 'cli':
        return await runCliCommand(runtime, io, sub, rest, {
          format,
          refresh: Boolean(flags.refresh)
        })

      case 'projects':
      case 'project':
        return await runProjectsCommand(runtime, io, sub, rest, { format })

      case 'threads':
      case 'thread': {
        const tailRaw = flags.tail as string | undefined
        const tail = tailRaw !== undefined ? Number(tailRaw) : undefined
        if (tail !== undefined && (!Number.isInteger(tail) || tail <= 0)) {
          throw new CliError(`Invalid --tail value: ${tailRaw}`, EXIT_USAGE)
        }
        return await runThreadsCommand(runtime, io, sub, rest, {
          format,
          project: flags.project as string | undefined,
          all: Boolean(flags.all),
          running: Boolean(flags.running),
          tail,
          cli: flags.cli as string | undefined,
          model: flags.model as string | undefined,
          mode: flags.mode as string | undefined,
          force: typeof flags.force === 'boolean' ? flags.force : undefined,
          at: flags.at as string | undefined
        })
      }

      case 'run':
      case 'send':
        return await runPromptCommand(runtime, io, positionals.slice(1), {
          format,
          quiet: Boolean(flags.quiet),
          project: flags.project as string | undefined,
          thread: flags.thread as string | undefined,
          cli: flags.cli as string | undefined,
          model: flags.model as string | undefined,
          mode: flags.mode as string | undefined,
          force: typeof flags.force === 'boolean' ? flags.force : undefined,
          worktree: Boolean(flags.worktree),
          files: flags.file as string[] | undefined,
          queue: Boolean(flags.queue),
          now: Boolean(flags.now),
          detach: Boolean(flags.detach),
          showThinking: Boolean(flags['show-thinking']),
          onQuestion: resolveQuestionPolicy(flags['on-question']),
          promptFlag: flags.prompt as string | undefined
        })

      case 'watch':
        return await runWatchCommand(runtime, io, positionals.slice(1), {
          format,
          quiet: Boolean(flags.quiet),
          showThinking: Boolean(flags['show-thinking'])
        })

      case 'stop':
        return await runStopCommand(runtime, io, positionals.slice(1), { format })

      case 'answer':
        return await runAnswerCommand(runtime, io, positionals.slice(1), {
          format,
          answersJson: flags.answers as string | undefined,
          skip: Boolean(flags.skip)
        })

      default:
        throw new CliError(`Unknown command: ${command}. Run "agent-desktop --help" for usage.`, EXIT_USAGE)
    }
  } catch (err) {
    const exitCode = err instanceof CliError ? err.exitCode : EXIT_ERROR
    const message = err instanceof Error ? err.message : String(err)
    if (format === 'json' || format === 'jsonl') {
      io.stdout.write(`${JSON.stringify({ ok: false, error: message, exitCode })}\n`)
    } else {
      io.stderr.write(`Error: ${message}\n`)
    }
    return exitCode
  } finally {
    if (runtime) {
      await runtime.close().catch(() => {})
    }
  }
}

// Execute automatically when invoked as the bundled CLI entrypoint (not when imported by Vitest).
const isDirectMain =
  typeof require !== 'undefined'
  && typeof module !== 'undefined'
  && require.main === module

if (isDirectMain && !process.env.VITEST) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
