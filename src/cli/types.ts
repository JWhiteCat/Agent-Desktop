import type { AgentEvent, AppState } from '@shared/types'

export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_USAGE = 2
export const EXIT_QUESTION_REQUIRED = 3
export const EXIT_NOT_ATTACHED = 4
export const EXIT_CONFLICT = 5
export const EXIT_SIGINT = 130

export type CliMode = 'attached' | 'headless'
export type OutputFormat = 'text' | 'json' | 'jsonl'
export type QuestionPolicy = 'interactive' | 'fail' | 'cancel'

export class CliError extends Error {
  readonly exitCode: number
  readonly details?: unknown

  constructor(message: string, exitCode = EXIT_ERROR, details?: unknown) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
    this.details = details
  }
}

export interface CliIo {
  stdout: { write(chunk: string): boolean | void; isTTY?: boolean }
  stderr: { write(chunk: string): boolean | void; isTTY?: boolean }
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  cwd(): string
  env: NodeJS.ProcessEnv
}

export interface CliRuntime {
  readonly mode: CliMode
  readonly dataDir: string
  readonly desktopPid?: number
  readonly appVersion?: string
  call<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  subscribe(listeners: {
    onEvent?: (event: AgentEvent) => void
    onState?: (state: AppState) => void
    onDisconnect?: (err?: Error) => void
  }): Promise<() => void>
  close(): Promise<void>
}
