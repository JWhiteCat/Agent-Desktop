import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { t } from '@shared/i18n'
import {
  MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_MESSAGE_ATTACHMENT_BYTES,
  type AttachmentData, type AttachmentRef, type AttachmentUpload
} from '@shared/attachments'
import type { Store } from './store'

type AttachmentOwner = Pick<Store, 'dataDir' | 'threads' | 'items'>
interface Manifest extends AttachmentRef {
  createdAt: number
  referenced?: boolean
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000
const stores = new WeakMap<object, AttachmentStore>()

export function attachmentsFor(store: AttachmentOwner): AttachmentStore {
  let storage = stores.get(store)
  if (!storage) {
    storage = new AttachmentStore(store)
    stores.set(store, storage)
  }
  return storage
}

function safeName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? ''
  let safe = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '')
  if (!safe || safe === '.' || safe === '..') safe = 'attachment'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `file-${safe}`
  if (safe.toLowerCase() === '_metadata.json' || safe.toLowerCase() === '_metadata.json.tmp') safe = `file-${safe}`
  // Keep a conventional extension when shortening names for Unix and Windows limits.
  const extension = /\.[a-z0-9]{1,16}$/i.exec(safe)?.[0] ?? ''
  let stem = extension ? safe.slice(0, -extension.length) : safe
  while (stem.length + extension.length > 180 || Buffer.byteLength(stem + extension, 'utf8') > 240) {
    stem = Array.from(stem).slice(0, -1).join('')
  }
  safe = stem + extension
  return safe
}

/** Detect native image types from their bytes, never an untrusted MIME label. */
export function attachmentMime(bytes: Buffer, supplied: string): string {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString('ascii', 12, 16) === 'IHDR') return 'image/png'
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 13 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (supplied.toLowerCase().startsWith('image/')) return 'application/octet-stream'
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(supplied) ? supplied.toLowerCase() : 'application/octet-stream'
}

export class AttachmentStore {
  private readonly root: string

  constructor(private readonly store: AttachmentOwner) {
    this.root = path.resolve(store.dataDir, 'attachments')
    fs.mkdirSync(this.root, { recursive: true })
  }

  upload(req: AttachmentUpload): AttachmentRef {
    if (!req || typeof req.name !== 'string' || !req.name.trim() || req.name.length > 1024
      || typeof req.mimeType !== 'string' || req.mimeType.length > 255 || typeof req.data !== 'string'
      || req.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) {
      throw new Error(t('附件无效或超过 10 MiB'))
    }
    if (req.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(req.data)) {
      throw new Error(t('附件编码无效'))
    }
    const bytes = Buffer.from(req.data, 'base64')
    if (bytes.toString('base64') !== req.data) throw new Error(t('附件编码无效'))
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(t('单个附件不能超过 10 MiB'))
    const id = crypto.randomUUID()
    const manifest: Manifest = {
      id, name: safeName(req.name), mimeType: attachmentMime(bytes, req.mimeType), size: bytes.length, createdAt: Date.now()
    }
    const dir = this.directory(id)
    fs.mkdirSync(dir)
    try {
      fs.writeFileSync(path.join(dir, manifest.name), bytes, { flag: 'wx' })
      this.writeManifest(manifest)
    } catch (error) {
      this.removeDirectory(id)
      throw error
    }
    return this.ref(manifest)
  }

  resolveMany(ids: string[]): AttachmentRef[] {
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length) {
      throw new Error(t('每条消息最多添加 10 个不同附件'))
    }
    const refs = ids.map((id) => this.ref(this.manifest(id)))
    if (refs.reduce((sum, ref) => sum + ref.size, 0) > MAX_MESSAGE_ATTACHMENT_BYTES) {
      throw new Error(t('每条消息的附件合计不能超过 20 MiB'))
    }
    for (const ref of refs) this.pathFor(ref.id)
    return refs
  }

  pathFor(id: string): string {
    const manifest = this.manifest(id)
    const dir = this.directory(id)
    const file = path.join(dir, manifest.name)
    try {
      const stat = fs.lstatSync(file)
      const realRoot = fs.realpathSync(this.root)
      const realFile = fs.realpathSync(file)
      const relative = path.relative(realRoot, realFile)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== manifest.size
        || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid attachment path')
    } catch {
      throw new Error(t('附件已丢失或不可读取：{name}', { name: manifest.name }))
    }
    return file
  }

  read(id: string): AttachmentData {
    const manifest = this.manifest(id)
    const bytes = fs.readFileSync(this.pathFor(id))
    return { data: bytes.toString('base64'), mimeType: manifest.mimeType }
  }

  /** The sole Ask-mode permission exception is a proven original in this conversation. */
  scopedRead(filePath: string, cwd: string, attachments: AttachmentRef[], expectedPath?: string): boolean {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) return false
    try {
      const target = fs.realpathSync(path.resolve(cwd, filePath))
      const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
      if (expectedPath !== undefined && normalize(target) !== normalize(fs.realpathSync(path.resolve(cwd, expectedPath)))) return false
      return attachments.some((ref) => normalize(fs.realpathSync(this.pathFor(ref.id))) === normalize(target))
    } catch {
      return false
    }
  }

  retain(ids: string[]): void {
    for (const id of ids) {
      const manifest = this.manifest(id)
      if (!manifest.referenced) this.writeManifest({ ...manifest, referenced: true })
    }
  }

  removeUnreferenced(ids: string[]): void {
    const live = this.liveIds()
    for (const id of new Set(ids)) if (UUID.test(id) && !live.has(id)) this.removeDirectory(id)
  }

  collectGarbage(now = Date.now()): void {
    const live = this.liveIds()
    for (const id of fs.readdirSync(this.root)) {
      if (!UUID.test(id)) continue
      try {
        const manifest = this.manifest(id)
        if (live.has(id)) {
          if (!manifest.referenced) this.writeManifest({ ...manifest, referenced: true })
        } else if (manifest.referenced || now - manifest.createdAt >= ORPHAN_AGE_MS) {
          this.removeDirectory(id)
        }
      } catch {
        // A malformed directory is never served. Leave it for diagnosis rather than deleting arbitrary files.
      }
    }
  }

  private liveIds(): Set<string> {
    const live = new Set<string>()
    for (const thread of this.store.threads) {
      for (const item of this.store.items(thread.id)) {
        if (item.kind === 'user') for (const ref of item.attachments ?? []) live.add(ref.id)
      }
    }
    return live
  }

  private directory(id: string): string {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error(t('附件不存在'))
    const dir = path.resolve(this.root, id)
    if (path.dirname(dir) !== this.root) throw new Error(t('附件不存在'))
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error(t('附件不存在'))
    return dir
  }

  private manifest(id: string): Manifest {
    try {
      const dir = this.directory(id)
      const manifestPath = path.join(dir, '_metadata.json')
      if (fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error('Invalid manifest')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest
      if (manifest.id !== id || typeof manifest.name !== 'string' || safeName(manifest.name) !== manifest.name
        || manifest.name === '_metadata.json' || typeof manifest.mimeType !== 'string'
        || !Number.isInteger(manifest.size) || manifest.size < 0 || manifest.size > MAX_ATTACHMENT_BYTES
        || !Number.isFinite(manifest.createdAt)) throw new Error('Invalid manifest')
      return manifest
    } catch {
      throw new Error(t('附件不存在'))
    }
  }

  private writeManifest(manifest: Manifest): void {
    const target = path.join(this.directory(manifest.id), '_metadata.json')
    const temp = `${target}.tmp`
    fs.writeFileSync(temp, JSON.stringify(manifest), 'utf8')
    fs.renameSync(temp, target)
  }

  private ref({ id, name, mimeType, size }: Manifest): AttachmentRef {
    return { id, name, mimeType, size }
  }

  private removeDirectory(id: string): void {
    // directory() validates the absolute target and rejects links before recursive removal.
    const dir = this.directory(id)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
