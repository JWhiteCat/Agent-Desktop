export interface ToolbarCommandPayload {
  program: string
  args: string[]
  cwd: string
  messages: {
    finished: string
    failed: string
    close: string
  }
}

export type ToolbarCommandStatus = { kind: 'started' } | { kind: 'error'; message: string }
