import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { SKIN_SCHEME, isSourceId, type SkinKind, type SkinProperty, type SkinSource, type WallpaperEntry } from '@shared/skins'
import { t } from '@shared/i18n'
import { writeTextSafely } from './local-files'

const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'])
const VIDEOS = new Set(['.mp4', '.webm'])
const WALLPAPER_CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; sandbox allow-scripts allow-same-origin"
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.wasm': 'application/wasm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
}
const inside = (root: string, file: string) => {
  const rel = path.relative(root, file)
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}
const sourceId = (root: string, entry: string) => createHash('sha256').update(`${root}\0${entry}`).digest('hex').slice(0, 32)

export function parseSkinProperties(raw: unknown): Record<string, SkinProperty> {
  const result: Record<string, SkinProperty> = {}
  if (!raw || typeof raw !== 'object') return result
  for (const [key, value] of Object.entries(raw).slice(0, 512)) {
    if (!/^[\w-]{1,100}$/.test(key) || !value || typeof value !== 'object') continue
    const p = value as Record<string, unknown>
    if (!['bool', 'slider', 'color', 'combo', 'textinput'].includes(String(p.type))) continue
    if (!['string', 'number', 'boolean'].includes(typeof p.value)) continue
    if (typeof p.value === 'number' && !Number.isFinite(p.value)) continue
    const property: SkinProperty = { type: p.type as SkinProperty['type'], text: typeof p.text === 'string' ? p.text.slice(0, 200) : key, value: p.value as SkinProperty['value'] }
    for (const attr of ['min', 'max', 'step'] as const) if (typeof p[attr] === 'number' && Number.isFinite(p[attr])) property[attr] = p[attr]
    if (property.type === 'combo' && Array.isArray(p.options)) property.options = p.options.filter(o => o && ['string', 'number', 'boolean'].includes(typeof o.value)).slice(0, 100).map(o => ({ label: String(o.label ?? o.value).slice(0, 200), value: o.value }))
    result[key] = property
  }
  return result
}

/** Source paths live in a desktop-only registry, outside the broadcast application state. */
export class SkinLibrary {
  private sources = new Map<string, SkinSource>()
  private roots: string[] = []
  constructor(private readonly file: string) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const s of saved.sources ?? []) if (isSourceId(s.id) && typeof s.root === 'string' && typeof s.entry === 'string' && ['image', 'video', 'web'].includes(s.kind)) this.sources.set(s.id, s)
      this.roots = (Array.isArray(saved.roots) ? saved.roots : []).filter((r: unknown) => typeof r === 'string')
    } catch { /* Empty registry on first launch. */ }
  }
  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    writeTextSafely(this.file, JSON.stringify({ sources: [...this.sources.values()], roots: this.roots }, null, 2), false)
  }
  async source(id: string): Promise<SkinSource> {
    const s = this.sources.get(id)
    if (!s) throw new Error(t('未找到壁纸素材，请重新选择。'))
    await this.resolve(s, s.entry)
    return s
  }
  async resolve(s: SkinSource, relative: string): Promise<string> {
    if (!relative || relative.includes('\0') || path.isAbsolute(relative)) throw new Error('Invalid asset path')
    const target = path.resolve(s.root, relative)
    if (!inside(s.root, target)) throw new Error('Asset outside source directory')
    if (s.kind !== 'web' && relative !== s.entry && relative !== s.preview) throw new Error('Asset not selected')
    const real = await fs.promises.realpath(target)
    if (!inside(s.root, real)) throw new Error('Asset link outside source directory')
    if (!(await fs.promises.stat(real)).isFile()) throw new Error('Asset is not a file')
    return real
  }
  async add(input: string, persist = true): Promise<SkinSource> {
    const real = await fs.promises.realpath(input)
    const stat = await fs.promises.stat(real)
    const manifest = stat.isDirectory() ? path.join(real, 'project.json') : path.basename(real).toLowerCase() === 'project.json' ? real : ''
    let root = stat.isDirectory() ? real : path.dirname(real)
    let entry = stat.isDirectory() ? 'index.html' : path.basename(real)
    let kind: SkinKind
    let title = path.basename(real)
    let preview: string | undefined
    let properties: Record<string, SkinProperty> = {}
    if (manifest && fs.existsSync(manifest)) {
      const project = JSON.parse(await fs.promises.readFile(manifest, 'utf8'))
      const type = String(project.type ?? '').toLowerCase()
      if (type !== 'video' && type !== 'web') throw new Error(t('暂不支持 Scene、应用壁纸或未知项目类型。'))
      kind = type
      root = path.dirname(manifest)
      if (typeof project.file !== 'string') throw new Error(t('壁纸项目缺少入口文件。'))
      entry = project.file.replace(/\\/g, '/')
      title = typeof project.title === 'string' ? project.title.slice(0, 200) : title
      preview = typeof project.preview === 'string' && IMAGES.has(path.extname(project.preview).toLowerCase()) ? project.preview.replace(/\\/g, '/') : undefined
      properties = parseSkinProperties(project.general?.properties)
    } else {
      const ext = path.extname(entry).toLowerCase()
      if (IMAGES.has(ext)) kind = 'image'
      else if (VIDEOS.has(ext)) kind = 'video'
      else if (ext === '.html' || ext === '.htm') kind = 'web'
      else throw new Error(t('不支持的壁纸文件格式。'))
    }
    if (kind === 'video' && !VIDEOS.has(path.extname(entry).toLowerCase())) throw new Error(t('视频仅支持 MP4 和 WebM，具体编码取决于播放器。'))
    if (kind === 'web' && !['.html', '.htm'].includes(path.extname(entry).toLowerCase())) throw new Error(t('Web 壁纸入口必须是 HTML 文件。'))
    entry = path.posix.normalize(entry.replace(/\\/g, '/'))
    if (preview) preview = path.posix.normalize(preview.replace(/\\/g, '/'))
    const s: SkinSource = { id: sourceId(root, entry), title, kind, root, entry, properties, preview }
    await this.resolve(s, entry)
    if (s.preview) { try { await this.resolve(s, s.preview) } catch { delete s.preview } }
    this.sources.set(s.id, s)
    if (persist) this.save()
    return s
  }
  async scan(extraRoot?: string, steamRoots?: string[]): Promise<WallpaperEntry[]> {
    if (extraRoot) {
      const root = await fs.promises.realpath(extraRoot)
      if (!this.roots.includes(root)) { this.roots.push(root); this.save() }
    }
    const roots = new Set(this.roots)
    for (const steam of steamRoots ?? discoverSteamRoots()) {
      for (const suffix of ['steamapps/workshop/content/431960', 'steamapps/common/wallpaper_engine/projects/myprojects', 'steamapps/common/wallpaper_engine/projects/defaultprojects']) roots.add(path.join(steam, suffix))
    }
    const entries: WallpaperEntry[] = []
    const seen = new Set<string>()
    const scannedRoots = new Set<string>()
    for (const candidate of roots) {
      let dirs: string[]
      try {
        const root = await fs.promises.realpath(candidate)
        const key = process.platform === 'win32' ? root.toLowerCase() : root
        if (scannedRoots.has(key)) continue
        scannedRoots.add(key)
        dirs = fs.existsSync(path.join(root, 'project.json')) ? [root] : (await fs.promises.readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => path.join(root, d.name))
      } catch { continue }
      for (const dir of dirs) {
        let title = path.basename(dir)
        let type = 'unknown'
        try {
          const manifest = JSON.parse(await fs.promises.readFile(path.join(dir, 'project.json'), 'utf8'))
          title = typeof manifest.title === 'string' ? manifest.title : title
          type = String(manifest.type ?? 'unknown').toLowerCase()
          const source = await this.add(dir, false)
          if (seen.has(source.id)) continue
          seen.add(source.id)
          entries.push({ id: source.id, title, type, available: true, source })
        } catch (e) {
          const id = sourceId(dir, 'project.json')
          if (seen.has(id)) continue
          seen.add(id)
          entries.push({ id, title, type, available: false, reason: e instanceof Error ? e.message : String(e) })
        }
      }
    }
    this.save()
    return entries.sort((a, b) => a.title.localeCompare(b.title))
  }
  async response(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (url.protocol !== `${SKIN_SCHEME}:` || !isSourceId(url.hostname) || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 403 })
      const s = await this.source(url.hostname)
      const relative = decodeURIComponent(url.pathname.slice(1))
      if (s.kind === 'web' && relative === '__agent_skin_bridge__.js') return new Response(bridgeScript(s), { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' } })
      const file = await this.resolve(s, relative)
      const size = (await fs.promises.stat(file)).size
      const mime = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
      const headers: Record<string, string> = { 'content-type': mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes', 'content-security-policy': WALLPAPER_CSP }
      if (mime.startsWith('text/html')) {
        const html = await fs.promises.readFile(file, 'utf8')
        const injection = `<script src="${SKIN_SCHEME}://${s.id}/__agent_skin_bridge__.js"></script>`
        const body = /<head(?:\s[^>]*)?>/i.test(html) ? html.replace(/<head(?:\s[^>]*)?>/i, match => match + injection) : injection + html
        return new Response(request.method === 'HEAD' ? null : body, { headers })
      }
      const range = parseSkinRange(request.headers.get('range'), size)
      if (range === false) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
      const start = range ? range.start : 0
      const end = range ? range.end : size - 1
      headers['content-length'] = String(Math.max(0, end - start + 1))
      if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`
      const stream = request.method === 'HEAD' || size === 0 ? null : Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream<Uint8Array>
      return new Response(stream, { status: range ? 206 : 200, headers })
    } catch { return new Response(null, { status: 404 }) }
  }
}

export function parseSkinRange(value: string | null, size: number): { start: number; end: number } | false | undefined {
  if (!value) return undefined
  const m = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!m || (!m[1] && !m[2]) || size === 0) return false
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
  const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size ? { start, end } : false
}

export function parseSteamLibraries(text: string): string[] {
  return [...text.matchAll(/"path"\s*"([^"\r\n]+)"/gi)].map(m => m[1].replace(/\\\\/g, '\\'))
}
export function discoverSteamRoots(): string[] {
  if (process.platform !== 'win32') return []
  const roots = new Set<string>()
  try {
    const output = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
    const installed = /SteamPath\s+REG_SZ\s+([^\r\n]+)/i.exec(output)?.[1].trim()
    if (installed) roots.add(installed)
  } catch { /* Portable Steam can be selected manually. */ }
  roots.add(path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Steam'))
  for (const root of [...roots]) {
    try { for (const library of parseSteamLibraries(fs.readFileSync(path.join(root, 'steamapps/libraryfolders.vdf'), 'utf8'))) roots.add(library) } catch { /* Missing Steam library. */ }
  }
  return [...roots]
}

export function bridgeScript(source: SkinSource): string {
  const defaults = Object.fromEntries(Object.entries(source.properties).map(([k, p]) => [k, { value: p.value }]))
  const data = JSON.stringify(defaults).replace(/</g, '\\u003c')
  return `(() => {
    let listener; let properties = ${data};
    const apply = () => { try { listener?.applyUserProperties?.(properties); listener?.applyGeneralProperties?.({fps:30}); listener?.setPaused?.(false); } catch {} };
    Object.defineProperty(window, 'wallpaperPropertyListener', { configurable:true, get:()=>listener, set:v=>{listener=v; queueMicrotask(apply);} });
    window.wallpaperRegisterAudioListener = cb => { try { cb(new Array(128).fill(0)); } catch {} };
    window.addEventListener('load', () => { apply(); parent.postMessage({type:'skin-ready'}, '*'); });
    window.addEventListener('error', e => { if (e.error) parent.postMessage({type:'skin-error'}, '*'); });
    window.addEventListener('message', e => {
      if (e.source !== parent) return;
      if (e.data?.type === 'skin-paused') { try { listener?.setPaused?.(!!e.data.paused); } catch {} return; }
      if (e.data?.type !== 'skin-properties') return;
      for (const key of Object.keys(properties)) if (Object.hasOwn(e.data.properties || {}, key)) properties[key] = {value:e.data.properties[key]};
      apply();
    });
    const mute = () => document.querySelectorAll('audio,video').forEach(m => {m.muted=true;});
    new MutationObserver(mute).observe(document, {childList:true, subtree:true}); mute();
  })();`
}

const libraries = new WeakMap<object, SkinLibrary>()
export function skinsFor(store: { dataDir: string }): SkinLibrary {
  let library = libraries.get(store)
  if (!library) { library = new SkinLibrary(path.join(store.dataDir, 'skin-sources.json')); libraries.set(store, library) }
  return library
}
