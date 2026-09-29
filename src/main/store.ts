import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeMcpServers, normalizeSkills } from '@shared/agent-config'
import { DEFAULT_SETTINGS, normalizeCliProvider, threadCli, type Item, type Project, type ResultItem, type Settings, type ThreadMeta } from '@shared/types'
import { newId } from './id'
import { newRemoteClientId, validClientId } from './public-tunnel'
import { readCodexUsage } from './codex-history'
import { repairCodexUsage } from './codex-usage-repair'

interface PersistedState {
  version: 1
  projects: Project[]
  threads: ThreadMeta[]
  settings: Settings
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data, 'utf8')
  fs.renameSync(tmp, file)
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

export class Store {
  private readonly dir: string
  private readonly threadsDir: string
  private readonly stateFile: string
  private state: PersistedState
  private itemsCache = new Map<string, Item[]>()
  private saveTimer: NodeJS.Timeout | undefined
  private dirtyThreads = new Set<string>()

  constructor() {
    this.dir = path.join(app.getPath('userData'), 'data')
    this.threadsDir = path.join(this.dir, 'threads')
    this.stateFile = path.join(this.dir, 'state.json')
    fs.mkdirSync(this.threadsDir, { recursive: true })
    const loaded = readJson<PersistedState>(this.stateFile)
    const rawClientId = loaded?.settings?.remoteClientId
    const remoteClientId = typeof rawClientId === 'string' && validClientId(rawClientId) ? rawClientId : newRemoteClientId()
    this.state = {
      version: 1,
      projects: loaded?.projects ?? [],
      threads: loaded?.threads ?? [],
      settings: {
        ...DEFAULT_SETTINGS,
        ...loaded?.settings,
        cliProvider: normalizeCliProvider(loaded?.settings?.cliProvider),
        codexPath: typeof loaded?.settings?.codexPath === 'string' ? loaded.settings.codexPath : '',
        codexApiKey: typeof loaded?.settings?.codexApiKey === 'string' ? loaded.settings.codexApiKey : '',
        claudePath: typeof loaded?.settings?.claudePath === 'string' ? loaded.settings.claudePath : '',
        claudeApiKey: typeof loaded?.settings?.claudeApiKey === 'string' ? loaded.settings.claudeApiKey : '',
        codexDefaultModel: typeof loaded?.settings?.codexDefaultModel === 'string' ? loaded.settings.codexDefaultModel : '',
        claudeDefaultModel: typeof loaded?.settings?.claudeDefaultModel === 'string' ? loaded.settings.claudeDefaultModel : '',
        favoriteModels: Array.isArray(loaded?.settings?.favoriteModels) ? loaded.settings.favoriteModels : [],
        codexFavoriteModels: Array.isArray(loaded?.settings?.codexFavoriteModels)
          ? loaded.settings.codexFavoriteModels
          : Array.isArray(loaded?.settings?.favoriteModels)
            ? loaded.settings.favoriteModels.slice()
            : [],
        claudeFavoriteModels: Array.isArray(loaded?.settings?.claudeFavoriteModels) ? loaded.settings.claudeFavoriteModels : [],
        mcpServers: normalizeMcpServers(loaded?.settings?.mcpServers),
        skills: normalizeSkills(loaded?.settings?.skills),
        remoteClientId
      }
    }
    if (remoteClientId !== rawClientId) this.flush()
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
    const now = Date.now()
    const thread: ThreadMeta = { createdAt: now, updatedAt: now, ...init, id: init.id ?? newId() }
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
    const nextPatch = nextCli !== undefined ? { ...patch, cli: nextCli } : patch
    Object.assign(t, nextPatch, { id: t.id })
    if (cliChanged) delete t.chatId
    this.scheduleSave()
    return t
  }

  deleteThread(id: string): void {
    this.state.threads = this.state.threads.filter((t) => t.id !== id)
    this.itemsCache.delete(id)
    this.dirtyThreads.delete(id)
    fs.rmSync(this.threadFile(id), { force: true })
    this.scheduleSave()
  }

  items(threadId: string): Item[] {
    let items = this.itemsCache.get(threadId)
    if (!items) {
      items = readJson<Item[]>(this.threadFile(threadId)) ?? []
      this.itemsCache.set(threadId, items)
      const thread = this.thread(threadId)
      if (thread?.chatId && threadCli(thread) === 'codex'
        && items.some((item) => item.kind === 'result' && (!item.usage?.requests || item.usageComplete === false))) {
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
          this.repairUsageCopies(repaired)
        }
      }
    }
    return items
  }

  private repairUsageCopies(repaired: Map<string, ResultItem>): void {
    if (!repaired.size) return
    for (const thread of this.threads) {
      const items = this.itemsCache.get(thread.id) ?? readJson<Item[]>(this.threadFile(thread.id)) ?? []
      let changed = false
      for (const item of items) {
        if (item.kind !== 'result' || !item.usageId) continue
        const source = repaired.get(item.usageId)
        if (!source) continue
        Object.assign(item, { usageId: source.usageId, usage: source.usage, cli: source.cli, usageComplete: source.usageComplete })
        changed = true
      }
      if (changed) this.setItems(thread.id, items)
    }
  }

  setItems(threadId: string, items: Item[]): void {
    this.itemsCache.set(threadId, items)
    this.markItemsDirty(threadId)
  }

  markItemsDirty(threadId: string): void {
    this.dirtyThreads.add(threadId)
    this.scheduleSave()
  }

  scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => this.flush(), 400)
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    try {
      writeAtomic(this.stateFile, JSON.stringify(this.state, null, 2))
      for (const id of this.dirtyThreads) {
        const items = this.itemsCache.get(id)
        if (items && this.thread(id)) writeAtomic(this.threadFile(id), JSON.stringify(items))
      }
      this.dirtyThreads.clear()
    } catch (err) {
      console.error('[store] save failed', err)
    }
  }

  private threadFile(id: string): string {
    return path.join(this.threadsDir, `${id}.json`)
  }
}

export function normalizePath(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
