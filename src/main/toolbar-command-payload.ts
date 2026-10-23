export interface ToolbarCommandPayload {
  program: string
  args: string[]
  cwd: string
  /** POSIX GUI terminals may start with a different PATH from the desktop app. */
  path?: string
  messages: {
    finished: string
    failed: string
    close: string
  }
}

export type ToolbarCommandStatus = { kind: 'started' } | { kind: 'error'; message: string }
