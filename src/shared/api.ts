import type {
  AgentEvent,
  AgentMode,
  AppState,
  CliInfo,
  CliProvider,
  CliSession,
  GitDiff,
  Item,
  ModelInfo,
  Project,
  QuestionAnswer,
  RemoteInfo,
  PrepareRequest,
  SendRequest,
  Settings,
  ThreadMeta
} from './types'
import type { SlashCommand } from './commands'
import type { LocalMcpReport, LocalMcpSaveRequest, LocalSkillContent, LocalSkillReport, LocalSkillSaveRequest } from './local-config'
import type { QuotaReport } from './quota'
import type { UsageReport, UsageWindow } from './usage'

export interface ForkResult {
  thread: ThreadMeta
  items: Item[]
}

export interface DesktopApi {
  platform: NodeJS.Platform | 'web'
  /** True in a phone browser connected over the LAN. */
  isRemote: boolean
  getState(): Promise<AppState>
  pickProject(): Promise<Project | null>
  addProject(path: string): Promise<Project>
  updateProject(id: string, patch: Partial<Project>): Promise<void>
  removeProject(id: string): Promise<void>
  reorderProjects(ids: string[]): Promise<void>
  createThread(projectId: string, mode: AgentMode, model: string, force?: boolean, cli?: CliProvider): Promise<ThreadMeta>
  updateThread(id: string, patch: Partial<ThreadMeta>): Promise<void>
  deleteThread(id: string): Promise<void>
  /** Copies the conversation. `throughItemId` keeps messages only through that item. */
  forkThread(id: string, throughItemId?: string): Promise<ForkResult>
  getItems(threadId: string): Promise<Item[]>
  syncFromCli(threadId: string): Promise<Item[]>
  send(req: SendRequest): Promise<void>
  /** Loads slash commands for a thread that already has a CLI session. */
  prepareCommands(threadId: string, opts: PrepareRequest): Promise<SlashCommand[]>
  stop(threadId: string): Promise<void>
  /** `null` skips the question. */
  answerQuestion(threadId: string, questionId: string, answers: QuestionAnswer[] | null): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  usageSummary(period: UsageWindow): Promise<UsageReport>
  usageQuotas(): Promise<QuotaReport>
  /** Redeems one Codex reset card. The caller must already have confirmed. */
  consumeCodexReset(creditId: string): Promise<void>
  listModels(refresh?: boolean, provider?: CliProvider): Promise<ModelInfo[]>
  cliInfo(provider?: CliProvider): Promise<CliInfo>
  login(provider?: CliProvider): Promise<string>
  updateCli(provider: CliProvider): Promise<string>
  scanCliSessions(): Promise<CliSession[]>
  importCliSessions(chatIds: string[]): Promise<number>
  gitDiff(cwd: string): Promise<GitDiff>
  openPath(path: string): Promise<void>
  openSkillsDir(): Promise<void>
  /** MCP servers in the CLIs' own config files, including disabled ones held by this app. */
  localMcpList(): Promise<LocalMcpReport>
  localMcpSave(req: LocalMcpSaveRequest): Promise<void>
  localMcpToggle(id: string, enabled: boolean, fileHash?: string): Promise<void>
  localMcpDelete(id: string, fileHash?: string): Promise<void>
  /** Skills in user, project, built-in, and plugin directories. */
  localSkillList(): Promise<LocalSkillReport>
  localSkillRead(id: string): Promise<LocalSkillContent>
  localSkillSave(req: LocalSkillSaveRequest): Promise<void>
  localSkillToggle(id: string, enabled: boolean): Promise<void>
  /** Moves the skill directory to the trash. */
  localSkillDelete(id: string): Promise<void>
  openInEditor(path: string): Promise<boolean>
  openExternal(url: string): Promise<void>
  remoteInfo(): Promise<RemoteInfo>
  /** Issues a new token; links handed out earlier stop working. */
  resetRemoteToken(): Promise<RemoteInfo>
  onEvent(cb: (ev: AgentEvent) => void): () => void
  onState(cb: (state: AppState) => void): () => void
  onFocusThread(cb: (threadId: string) => void): () => void
}
