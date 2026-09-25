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
  SendRequest,
  Settings,
  ThreadMeta
} from './types'
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
  createThread(projectId: string, mode: AgentMode, model: string): Promise<ThreadMeta>
  updateThread(id: string, patch: Partial<ThreadMeta>): Promise<void>
  deleteThread(id: string): Promise<void>
  /** Copies the conversation. `throughItemId` keeps messages only through that item. */
  forkThread(id: string, throughItemId?: string): Promise<ForkResult>
  getItems(threadId: string): Promise<Item[]>
  syncFromCli(threadId: string): Promise<Item[]>
  send(req: SendRequest): Promise<void>
  stop(threadId: string): Promise<void>
  /** `null` skips the question. */
  answerQuestion(threadId: string, questionId: string, answers: QuestionAnswer[] | null): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  usageSummary(period: UsageWindow): Promise<UsageReport>
  listModels(refresh?: boolean, provider?: CliProvider): Promise<ModelInfo[]>
  cliInfo(provider?: CliProvider): Promise<CliInfo>
  login(provider?: CliProvider): Promise<string>
  scanCliSessions(): Promise<CliSession[]>
  importCliSessions(chatIds: string[]): Promise<number>
  gitDiff(cwd: string): Promise<GitDiff>
  openPath(path: string): Promise<void>
  openSkillsDir(): Promise<void>
  openInEditor(path: string): Promise<boolean>
  openExternal(url: string): Promise<void>
  remoteInfo(): Promise<RemoteInfo>
  /** Issues a new token; links handed out earlier stop working. */
  resetRemoteToken(): Promise<RemoteInfo>
  onEvent(cb: (ev: AgentEvent) => void): () => void
  onState(cb: (state: AppState) => void): () => void
  onFocusThread(cb: (threadId: string) => void): () => void
}
