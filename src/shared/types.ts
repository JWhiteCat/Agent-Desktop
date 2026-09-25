export type AgentMode = 'agent' | 'plan' | 'ask'

/** Which local CLI owns a thread. Missing values on older threads mean Cursor. */
export type CliProvider = 'cursor' | 'codex'

export function threadCli(thread: { cli?: CliProvider }): CliProvider {
  return thread.cli === 'codex' ? 'codex' : 'cursor'
}

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
  /** CLI chat/session id, used to resume. Cursor threads use `--resume`; Codex threads use ACP `session/load`. */
  chatId?: string
  /** Which CLI created this thread. Omitted on threads saved before Codex support; those stay on Cursor. */
  cli?: CliProvider
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
  /** When this turn finished. Older transcripts omit it; usage stats then use the preceding user message. */
  createdAt?: number
  /** Model id used for this turn. */
  model?: string
  /** Stable across a fork so the same turn is not counted twice. */
  usageId?: string
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

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface NamedValue {
  name: string
  value: string
}

/** One MCP server attached to agent sessions from Settings. */
export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: McpTransport
  command: string
  args: string[]
  env: NamedValue[]
  url: string
  headers: NamedValue[]
}

/** A user skill written to ~/.cursor/skills when enabled. */
export interface SkillConfig {
  id: string
  name: string
  description: string
  enabled: boolean
  /** Markdown body after the SKILL.md frontmatter. */
  body: string
}

export interface Settings {
  /** CLI used for new threads. Existing threads keep the CLI stored on them. */
  cliProvider: CliProvider
  agentPath: string
  /** Cursor user API key. Empty uses the CURSOR_API_KEY environment variable. */
  apiKey: string
  /** Codex executable. Empty auto-detects, then falls back to the adapter's bundled CLI. */
  codexPath: string
  /** Codex API key. Empty uses CODEX_API_KEY, then OPENAI_API_KEY, then ChatGPT login. */
  codexApiKey: string
  defaultModel: string
  /** Default model for new Codex threads. Empty uses the adapter's recommended model. */
  codexDefaultModel: string
  /** Model group bases shown in the chat picker. Empty means show every model. */
  favoriteModels: string[]
  defaultMode: AgentMode
  force: boolean
  theme: 'system' | 'dark' | 'light'
  sandbox: 'default' | 'enabled' | 'disabled'
  showArchived: boolean
  /** Send an OS notification when an agent run finishes. */
  notifyOnComplete: boolean
  mcpServers: McpServerConfig[]
  skills: SkillConfig[]
  /** Serve the UI on the LAN so a phone browser can control the app. */
  remoteEnabled: boolean
  remotePort: number
  /** Secret embedded in the remote link. Never sent to remote clients. */
  remoteToken: string
  /** Expose the LAN server through an SSH reverse tunnel. */
  remotePublicEnabled: boolean
  /** SSH login on the public server. */
  remotePublicUser: string
  /** Public server hostname or IPv4 address, without a scheme or port. */
  remotePublicHost: string
  /** TCP port opened on the public server. */
  remotePublicPort: number
}

export type PublicLinkStatus = 'off' | 'connecting' | 'up' | 'error'

export interface RemoteInfo {
  enabled: boolean
  running: boolean
  port: number
  /** LAN links, plus the public link once the tunnel is up. Token included. */
  urls: string[]
  error?: string
  publicStatus: PublicLinkStatus
  /** Set while the tunnel is up. Also present in `urls`. */
  publicUrl?: string
  publicError?: string
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
  cli: CliProvider
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
  imported: boolean
}

export interface CliInfo {
  found: boolean
  path?: string
  version?: string
  status?: string
  hasApiKey?: boolean
  /** Codex is running from the adapter package rather than a CLI on PATH. */
  bundled?: boolean
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
  cliProvider: 'cursor',
  agentPath: '',
  apiKey: '',
  codexPath: '',
  codexApiKey: '',
  defaultModel: 'auto',
  codexDefaultModel: '',
  favoriteModels: [],
  defaultMode: 'agent',
  force: false,
  theme: 'system',
  sandbox: 'default',
  showArchived: false,
  notifyOnComplete: true,
  mcpServers: [],
  skills: [],
  remoteEnabled: false,
  remotePort: 8765,
  remoteToken: '',
  remotePublicEnabled: false,
  remotePublicUser: 'root',
  remotePublicHost: '43.167.166.239',
  remotePublicPort: 8765
}
