import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type Item, type Project, type Settings, type ThreadMeta } from '@shared/types'
import { newId } from './id'

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
    this.state = {
      version: 1,
      projects: loaded?.projects ?? [],
      threads: loaded?.threads ?? [],
      settings: { ...DEFAULT_SETTINGS, ...loaded?.settings }
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
    Object.assign(t, patch, { id: t.id })
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
    }
    return items
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
