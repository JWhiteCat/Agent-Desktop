import type {
  AgentEvent,
  AgentMode,
  AppState,
  CliSession,
  GitDiff,
  Item,
  ModelInfo,
  Project,
  QuestionAnswer,
  SendRequest,
  Settings,
  ThreadMeta
} from './types'

export interface ForkResult {
  thread: ThreadMeta
  items: Item[]
}

export interface DesktopApi {
  platform: NodeJS.Platform
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
  listModels(refresh?: boolean): Promise<ModelInfo[]>
  cliInfo(): Promise<{ found: boolean; path?: string; version?: string; status?: string; hasApiKey?: boolean }>
  scanCliSessions(): Promise<CliSession[]>
  importCliSessions(chatIds: string[]): Promise<number>
  gitDiff(cwd: string): Promise<GitDiff>
  openPath(path: string): Promise<void>
  openInEditor(path: string): Promise<boolean>
  openExternal(url: string): Promise<void>
  onEvent(cb: (ev: AgentEvent) => void): () => void
  onState(cb: (state: AppState) => void): () => void
  onFocusThread(cb: (threadId: string) => void): () => void
}
