export type AgentMode = 'agent' | 'plan' | 'ask'

export interface Project {
  id: string
  name: string
  path: string
  createdAt: number
  collapsed?: boolean
  /** Last model chosen in this project. Unset projects use settings.defaultModel. */
  model?: string
}

export interface ThreadMeta {
  id: string
  projectId: string
  title: string
  /** Cursor CLI chat/session id, used with `--resume`. */
  chatId?: string
  /** Actual working directory reported by the CLI (differs from project path for worktrees). */
  cwd?: string
  model?: string
  modelLabel?: string
  mode: AgentMode
  worktree?: boolean
  createdAt: number
  updatedAt: number
  pinned?: boolean
  archived?: boolean
  unread?: boolean
  preview?: string
  source: 'app' | 'cli'
  /** Last time local items were rebuilt from (or written alongside) the CLI chat store. */
  syncedAt?: number
}

export interface UserItem {
  id: string
  kind: 'user'
  text: string
  createdAt: number
}

export interface AssistantItem {
  id: string
  kind: 'assistant'
  text: string
}

export interface ThinkingItem {
  id: string
  kind: 'thinking'
  text: string
  done: boolean
  startedAt: number
  endedAt?: number
}

export interface ToolItem {
  id: string
  kind: 'tool'
  callId: string
  tool: string
  args: any
  result?: any
  status: 'running' | 'success' | 'error'
  startedAt: number
  endedAt?: number
}

export interface ResultItem {
  id: string
  kind: 'result'
  isError: boolean
  durationMs?: number
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
}

export interface NoticeItem {
  id: string
  kind: 'notice'
  level: 'info' | 'error'
  text: string
}

export interface QuestionOption {
  id: string
  label: string
}

export interface QuestionPrompt {
  id: string
  prompt: string
  options: QuestionOption[]
  allowMultiple?: boolean
}

export interface QuestionAnswer {
  questionId: string
  selectedOptionIds: string[]
}

/** A blocking plan/agent question. The run waits until the user answers or skips. */
export interface QuestionItem {
  id: string
  kind: 'question'
  toolCallId: string
  title?: string
  questions: QuestionPrompt[]
  status: 'pending' | 'answered' | 'skipped'
  answers?: QuestionAnswer[]
}

export type Item = UserItem | AssistantItem | ThinkingItem | ToolItem | ResultItem | NoticeItem | QuestionItem

export interface Settings {
  agentPath: string
  /** Cursor user API key. Empty uses the CURSOR_API_KEY environment variable. */
  apiKey: string
  defaultModel: string
  /** Model group bases shown in the chat picker. Empty means show every model. */
  favoriteModels: string[]
  defaultMode: AgentMode
  force: boolean
  theme: 'system' | 'dark' | 'light'
  sandbox: 'default' | 'enabled' | 'disabled'
  showArchived: boolean
  /** Send an OS notification when an agent run finishes. */
  notifyOnComplete: boolean
}

export interface AppState {
  projects: Project[]
  threads: ThreadMeta[]
  settings: Settings
  running: string[]
}

export interface SendRequest {
  threadId: string
  prompt: string
  model: string
  mode: AgentMode
  force: boolean
  worktree?: boolean
}

export interface ModelInfo {
  id: string
  label: string
  /** Flat CLI slug when `id` is a parameterized variant such as `name[context=1m,effort=high]`. */
  legacySlug?: string
}

export interface CliSession {
  chatId: string
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
  imported: boolean
}

export interface GitDiff {
  isRepo: boolean
  branch?: string
  status: string
  diff: string
  error?: string
}

export type AgentEvent =
  | { type: 'items'; threadId: string; items: Item[] }
  | { type: 'running'; threadId: string; running: boolean }

export const DEFAULT_SETTINGS: Settings = {
  agentPath: '',
  apiKey: '',
  defaultModel: 'auto',
  favoriteModels: [],
  defaultMode: 'agent',
  force: false,
  theme: 'system',
  sandbox: 'default',
  showArchived: false,
  notifyOnComplete: true
}
