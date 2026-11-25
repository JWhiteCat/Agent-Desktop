import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getRuntimeDataDir } from './runtime-paths'
import { normalizeMcpServers, normalizeSkills } from '@shared/agent-config'
import { normalizeLanguage } from '@shared/i18n'
import { normalizeGrokBotNames } from '@shared/grokbot'
import { normalizePanelWidths } from '@shared/panel-widths'
import { normalizeFontFamily, normalizeFontSize } from '@shared/appearance'
import { normalizeToolbarButtons } from '@shared/toolbar'
import { normalizeSkin, normalizeSkins } from '@shared/skins'
import { repairTurnTimings } from '@shared/turn-performance'
import { DEFAULT_SETTINGS, normalizeCliProvider, threadCli, type Item, type Project, type ResultItem, type Settings, type ThreadMeta } from '@shared/types'
import { restoreToolFileChanges } from './tool-file-changes'
import { newId } from './id'
import { pathKey, writeTextSafely } from './local-files'
import { attachmentsFor } from './attachments'
import { newRemoteClientId, validClientId } from './public-tunnel'
import { readCodexUsage, repairCodexAssistantMessages, repairCodexMcpTools } from './codex-history'
import { repairCodexUsage } from './codex-usage-repair'
import type { CodexUsageTurn } from './codex-usage'

interface PersistedState {
  version: 1
  projects: Project[]
  threads: ThreadMeta[]
  settings: Settings
}

const STATE_SAVE_MS = 400
/** Each save rewrites a whole transcript file, so streamed item changes are batched longer. */
const ITEMS_SAVE_MS = 2000
const RETRY_SAVE_MS = 5000

function writeAtomic(file: string, data: string): void {
  writeTextSafely(file, data, false)
}

type JsonReadResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'missing' }
  | { kind: 'io-error'; error: unknown }
  | { kind: 'parse-error'; error: unknown }

function readJsonFile<T>(file: string): JsonReadResult<T> {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'io-error', error }
  }
  try {
    return { kind: 'ok', value: JSON.parse(raw.replace(/^\uFEFF/, '')) as T }
  } catch (error) {
    return { kind: 'parse-error', error }
  }
}

function backupCorruptStateFile(file: string): string {
  const backup = `${file}.corrupt-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.bak`
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL)
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(backup, 0o600)
    } catch {
      // best effort permission tightening on POSIX
    }
  }
  return backup
}

function isValidThreadId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id !== '.' && id !== '..' && !/[/\\\0:]/.test(id)
}

export class Store {
  private readonly dir: string
  private readonly threadsDir: string
  private readonly stateFile: string
  private state: PersistedState
  private itemsCache = new Map<string, Item[]>()
  private saveTimer: NodeJS.Timeout | undefined
  private saveDue = 0
  private stateDirty = false
  private dirtyThreads = new Set<string>()

  constructor(options?: { dataDir?: string; userDataDir?: string }) {
    this.dir = options?.dataDir ? path.resolve(options.dataDir) : getRuntimeDataDir(options?.userDataDir)
    this.threadsDir = path.resolve(this.dir, 'threads')
    this.stateFile = path.join(this.dir, 'state.json')
    fs.mkdirSync(this.threadsDir, { recursive: true, mode: 0o700 })
    let loaded: Partial<PersistedState> | undefined
    let recoveredFromCorruptState = false
    const stateResult = readJsonFile<unknown>(this.stateFile)
    if (stateResult.kind === 'io-error') {
      throw stateResult.error
    } else if (stateResult.kind === 'parse-error') {
      const backup = backupCorruptStateFile(this.stateFile)
      console.error('[store] corrupted state.json backed up to', backup, stateResult.error)
      recoveredFromCorruptState = true
    } else if (stateResult.kind === 'ok') {
      if (stateResult.value && typeof stateResult.value === 'object' && !Array.isArray(stateResult.value)) {
        loaded = stateResult.value as Partial<PersistedState>
      } else {
        const backup = backupCorruptStateFile(this.stateFile)
        console.error('[store] invalid state.json structure backed up to', backup)
        recoveredFromCorruptState = true
      }
    }
    const loadedSettings = loaded?.settings && typeof loaded.settings === 'object' && !Array.isArray(loaded.settings)
      ? loaded.settings
      : undefined
    const rawClientId = loadedSettings?.remoteClientId
    const remoteClientId = typeof rawClientId === 'string' && validClientId(rawClientId) ? rawClientId : newRemoteClientId()
    const rawSshPort = loadedSettings?.remotePublicSshPort
    const remotePublicSshPort = typeof rawSshPort === 'number' && Number.isInteger(rawSshPort) && rawSshPort >= 1 && rawSshPort <= 65535 ? rawSshPort : 22
    const fontFamily = normalizeFontFamily(loadedSettings?.fontFamily)
    const fontSize = normalizeFontSize(loadedSettings?.fontSize)
    this.state = {
      version: 1,
      projects: Array.isArray(loaded?.projects) ? loaded.projects : [],
      threads: Array.isArray(loaded?.threads) ? loaded.threads : [],
      settings: {
        ...DEFAULT_SETTINGS,
        ...loadedSettings,
        language: normalizeLanguage(loadedSettings?.language),
        fontFamily,
        fontSize,
        skin: normalizeSkin(loadedSettings?.skin),
        skins: normalizeSkins(loadedSettings?.skins),
        cliProvider: normalizeCliProvider(loadedSettings?.cliProvider),
        codexPath: typeof loadedSettings?.codexPath === 'string' ? loadedSettings.codexPath : '',
        codexApiKey: typeof loadedSettings?.codexApiKey === 'string' ? loadedSettings.codexApiKey : '',
        claudePath: typeof loadedSettings?.claudePath === 'string' ? loadedSettings.claudePath : '',
        claudeApiKey: typeof loadedSettings?.claudeApiKey === 'string' ? loadedSettings.claudeApiKey : '',
        antigravityPath: typeof loadedSettings?.antigravityPath === 'string' ? loadedSettings.antigravityPath : '',
        antigravityApiKey: typeof loadedSettings?.antigravityApiKey === 'string' ? loadedSettings.antigravityApiKey : '',
        antigravityApiEndpoint: typeof loadedSettings?.antigravityApiEndpoint === 'string' ? loadedSettings.antigravityApiEndpoint : '',
        codexDefaultModel: typeof loadedSettings?.codexDefaultModel === 'string' ? loadedSettings.codexDefaultModel : '',
        claudeDefaultModel: typeof loadedSettings?.claudeDefaultModel === 'string' ? loadedSettings.claudeDefaultModel : '',
        antigravityDefaultModel: typeof loadedSettings?.antigravityDefaultModel === 'string' ? loadedSettings.antigravityDefaultModel : '',
        favoriteModels: Array.isArray(loadedSettings?.favoriteModels) ? loadedSettings.favoriteModels : [],
        codexFavoriteModels: Array.isArray(loadedSettings?.codexFavoriteModels)
          ? loadedSettings.codexFavoriteModels
          : Array.isArray(loadedSettings?.favoriteModels)
            ? loadedSettings.favoriteModels.slice()
            : [],
        claudeFavoriteModels: Array.isArray(loadedSettings?.claudeFavoriteModels) ? loadedSettings.claudeFavoriteModels : [],
        antigravityFavoriteModels: Array.isArray(loadedSettings?.antigravityFavoriteModels) ? loadedSettings.antigravityFavoriteModels : [],
        mcpServers: normalizeMcpServers(loadedSettings?.mcpServers),
        skills: normalizeSkills(loadedSettings?.skills),
        grokbotBots: normalizeGrokBotNames(loadedSettings?.grokbotBots),
        panelWidths: normalizePanelWidths(loadedSettings?.panelWidths),
        threadToolbarButtons: normalizeToolbarButtons(loadedSettings?.threadToolbarButtons),
        remoteClientId,
        remotePublicSshPort
      }
    }
    if (remoteClientId !== rawClientId || remotePublicSshPort !== rawSshPort
      || fontFamily !== loadedSettings?.fontFamily || fontSize !== loadedSettings?.fontSize
      || JSON.stringify(this.state.settings.skin) !== JSON.stringify(loadedSettings?.skin)
      || JSON.stringify(this.state.settings.threadToolbarButtons) !== JSON.stringify(loadedSettings?.threadToolbarButtons)) {
      this.stateDirty = true
      this.flush()
    }
    if (!recoveredFromCorruptState && fs.existsSync(path.join(this.dir, 'attachments'))) {
      try {
        attachmentsFor(this).collectGarbage()
      } catch (error) {
        console.error('[attachments] cleanup failed', error)
      }
    }
  }

  get dataDir(): string {
    return this.dir
  }

  get projects(): Project[] {
    return this.state.projects
  }

  get threads(): ThreadMeta[] {
    return this.state.threads
  }

  get settings(): Settings {
    return this.state.settings
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.state.settings = { ...this.state.settings, ...patch }
    this.scheduleSave()
    return this.state.settings
  }

  project(id: string): Project | undefined {
    return this.state.projects.find((p) => p.id === id)
  }

  projectByPath(p: string): Project | undefined {
    const norm = normalizePath(p)
    return this.state.projects.find((x) => normalizePath(x.path) === norm)
  }

  addProject(dir: string, name?: string): Project {
    const existing = this.projectByPath(dir)
    if (existing) return existing
    const project: Project = {
      id: newId(),
      name: name || path.basename(dir) || dir,
      path: dir,
      createdAt: Date.now()
    }
    this.state.projects.push(project)
    this.scheduleSave()
    return project
  }

  updateProject(id: string, patch: Partial<Project>): void {
    const p = this.project(id)
    if (!p) return
    Object.assign(p, patch, { id: p.id })
    for (const key of Object.keys(patch) as (keyof Project)[]) {
      if (patch[key] === undefined) delete p[key]
    }
    this.scheduleSave()
  }

  collapseAllProjects(): void {
    const expanded = this.state.projects.filter((project) => !project.collapsed)
    if (!expanded.length) return
    for (const project of expanded) project.collapsed = true
    this.scheduleSave()
  }

  removeProject(id: string): void {
    this.state.projects = this.state.projects.filter((p) => p.id !== id)
    for (const t of this.state.threads.filter((t) => t.projectId === id)) this.deleteThread(t.id)
    this.scheduleSave()
  }

  reorderProjects(ids: string[]): void {
    const byId = new Map(this.state.projects.map((p) => [p.id, p]))
    const ordered = ids.map((id) => byId.get(id)).filter((p): p is Project => !!p)
    const rest = this.state.projects.filter((p) => !ids.includes(p.id))
    this.state.projects = [...ordered, ...rest]
    this.scheduleSave()
  }

  thread(id: string): ThreadMeta | undefined {
    return this.state.threads.find((t) => t.id === id)
  }

  createThread(init: Omit<ThreadMeta, 'id' | 'createdAt' | 'updatedAt'> & Partial<ThreadMeta>): ThreadMeta {
    const id = init.id ?? newId()
    if (!isValidThreadId(id)) throw new Error(`Invalid thread id: ${String(id)}`)
    const now = Date.now()
    const thread: ThreadMeta = { createdAt: now, updatedAt: now, ...init, id }
    this.state.threads.push(thread)
    this.itemsCache.set(thread.id, [])
    this.scheduleSave()
    return thread
  }

  updateThread(id: string, patch: Partial<ThreadMeta>): ThreadMeta | undefined {
    const t = this.thread(id)
    if (!t) return undefined
    const nextCli = patch.cli !== undefined ? normalizeCliProvider(patch.cli) : undefined
    const cliChanged = nextCli !== undefined && nextCli !== threadCli(t)
    if (cliChanged) {
      // Stamp legacy results before changing the thread's fallback provider.
      for (const item of this.items(id)) {
        if (item.kind === 'result' && !item.cli) item.cli = threadCli(t)
      }
      this.markItemsDirty(id)
    }
    const nextPatch: Partial<ThreadMeta> = nextCli !== undefined ? { ...patch, cli: nextCli } : { ...patch }
    if (cliChanged) {
      // Each new CLI session starts empty. Refresh even a pending replay marker:
      // the previous CLI may have failed after adding new messages to the transcript.
      const items = this.items(id)
      if (items.some((item) => item.kind === 'user' || item.kind === 'assistant')) nextPatch.forkContextThroughItemId = items.at(-1)?.id
    }
    Object.assign(t, nextPatch, { id: t.id })
    // A title supplied without an explicit placeholder marker is a literal name.
    if (typeof patch.title === 'string' && !Object.hasOwn(patch, 'titleKind')) delete t.titleKind
    if (cliChanged) {
      delete t.chatId
    }
    this.scheduleSave()
    return t
  }

  deleteThread(id: string): void {
    if (!this.thread(id)) return
    const attachmentIds = this.peekItems(id).flatMap((item) => item.kind === 'user' ? (item.attachments ?? []).map((ref) => ref.id) : item.kind === 'tool' ? (item.images ?? []).map((ref) => ref.id) : [])
    this.state.threads = this.state.threads.filter((t) => t.id !== id)
    this.itemsCache.delete(id)
    this.dirtyThreads.delete(id)
    const file = this.threadFile(id)
    if (file) fs.rmSync(file, { force: true })
    if (attachmentIds.length) attachmentsFor(this).removeUnreferenced(attachmentIds)
    this.scheduleSave()
  }

  items(threadId: string): Item[] {
    const thread = this.thread(threadId)
    if (!thread) return []
    let items = this.itemsCache.get(threadId)
    if (!items) {
      items = this.readItemsFile(threadId)
      this.itemsCache.set(threadId, items)
      const cwd = thread.cwd ?? this.project(thread.projectId)?.path ?? ''
      if (restoreToolFileChanges(items, cwd)) this.markItemsDirty(threadId)
      if (repairTurnTimings(items)) this.markItemsDirty(threadId)
      if (thread.chatId && threadCli(thread) === 'codex') {
        const repairedTools = repairCodexMcpTools(thread.chatId, items)
        const repairedMessages = repairCodexAssistantMessages(thread.chatId, items)
        if (repairedTools || repairedMessages) this.markItemsDirty(threadId)
      }
      if (thread.chatId && threadCli(thread) === 'codex'
        && items.some((item) => item.kind === 'result' && (!item.usage?.requests || item.usageComplete === false || (!item.quotaSnapshot && !item.quotaUsage)))) {
        const turns = readCodexUsage(thread.chatId)
        const previous = new Map(items.filter((item): item is ResultItem => item.kind === 'result').map((item) => [item.id, item.usageId]))
        if (turns && repairCodexUsage(items, turns)) {
          this.markItemsDirty(threadId)
          const repaired = new Map<string, ResultItem>()
          for (const item of items) {
            if (item.kind !== 'result') continue
            const oldId = previous.get(item.id)
            if (oldId && item.cli === 'codex' && item.usageComplete) repaired.set(oldId, item)
          }
          this.repairUsageCopies(repaired, turns)
        }
      }
    }
    return items
  }

  /** Saved items for read-only scans: no cache fill and no history repair. */
  peekItems(threadId: string): Item[] {
    if (!this.thread(threadId)) return []
    return this.itemsCache.get(threadId) ?? this.readItemsFile(threadId)
  }

  private repairUsageCopies(repaired: Map<string, ResultItem>, turns: CodexUsageTurn[]): void {
    if (!repaired.size) return
    for (const thread of this.threads) {
      const items = this.peekItems(thread.id)
      let changed = false
      const groups = new Set<CodexUsageTurn>()
      for (const item of items) {
        if (item.kind !== 'result' || !item.usageId) continue
        const source = repaired.get(item.usageId)
        if (!source) continue
        const group = turns.find((turn) => turn.componentTurns?.some((part) => part.usageId === item.usageId))
        if (group) {
          // A copied native plan may still have a separate implementation result.
          // Match that transcript's layout before replacing either token count.
          groups.add(group)
          continue
        }
        Object.assign(item, { usageId: source.usageId, usage: source.usage, cli: source.cli, usageComplete: source.usageComplete })
        if (source.quotaSnapshot && !item.quotaSnapshot) item.quotaSnapshot = source.quotaSnapshot
        changed = true
      }
      if (groups.size && repairCodexUsage(items, [...groups])) changed = true
      if (changed) this.setItems(thread.id, items)
    }
  }

  setItems(threadId: string, items: Item[]): void {
    if (!this.thread(threadId) || !this.threadFile(threadId) || !Array.isArray(items)) return
    this.itemsCache.set(threadId, items)
    this.markItemsDirty(threadId)
  }

  markItemsDirty(threadId: string): void {
    if (!this.thread(threadId) || !this.threadFile(threadId)) return
    this.dirtyThreads.add(threadId)
    this.queueSave(ITEMS_SAVE_MS)
  }

  scheduleSave(): void {
    this.stateDirty = true
    this.queueSave(STATE_SAVE_MS)
  }

  /** Keeps the earliest pending deadline. */
  private queueSave(delay: number): void {
    const due = Date.now() + delay
    if (this.saveTimer && this.saveDue <= due) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveDue = due
    this.saveTimer = setTimeout(() => this.flush(), delay)
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    try {
      if (this.stateDirty) {
        writeAtomic(this.stateFile, JSON.stringify(this.state, null, 2))
        this.stateDirty = false
      }
      for (const id of [...this.dirtyThreads]) {
        const items = this.itemsCache.get(id)
        const file = this.threadFile(id)
        if (items && this.thread(id) && file) writeAtomic(file, JSON.stringify(items))
        this.dirtyThreads.delete(id)
      }
    } catch (err) {
      console.error('[store] save failed', err)
      // A locked file (e.g. antivirus on Windows) must not leave changes only in memory.
      this.queueSave(RETRY_SAVE_MS)
    }
  }

  private readItemsFile(threadId: string): Item[] {
    const file = this.threadFile(threadId)
    if (!file) return []
    const result = readJsonFile<unknown>(file)
    if (result.kind !== 'ok' || !Array.isArray(result.value)) return []
    return result.value.filter((item): item is Item => !!item && typeof item === 'object' && !Array.isArray(item))
  }

  private threadFile(id: string): string | undefined {
    if (!isValidThreadId(id)) return undefined
    const file = path.resolve(this.threadsDir, `${id}.json`)
    if (path.dirname(file) !== this.threadsDir || path.basename(file) !== `${id}.json`) return undefined
    return file
  }
}

export function normalizePath(p: string): string {
  return pathKey(p)
}
