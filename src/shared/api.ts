import type {
  AgentEvent,
  AgentMode,
  AppState,
  CliSession,
  GitDiff,
  Item,
  ModelInfo,
  Project,
  SendRequest,
  Settings,
  ThreadMeta
} from './types'

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
  getItems(threadId: string): Promise<Item[]>
  syncFromCli(threadId: string): Promise<Item[]>
  send(req: SendRequest): Promise<void>
  stop(threadId: string): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  listModels(refresh?: boolean): Promise<ModelInfo[]>
  cliInfo(): Promise<{ found: boolean; path?: string; version?: string; status?: string }>
  login(): Promise<string>
  scanCliSessions(): Promise<CliSession[]>
  importCliSessions(chatIds: string[]): Promise<number>
  gitDiff(cwd: string): Promise<GitDiff>
  openPath(path: string): Promise<void>
  openInEditor(path: string): Promise<boolean>
  openExternal(url: string): Promise<void>
  onEvent(cb: (ev: AgentEvent) => void): () => void
  onState(cb: (state: AppState) => void): () => void
}
