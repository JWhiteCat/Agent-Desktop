import { t } from '@shared/i18n'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Item, ToolItem } from '@shared/types'
import type { ToolImageCapture, ToolImageRef, ToolImageData } from '@shared/tool-images'
import { MAX_TOOL_IMAGE_PIXELS } from '@shared/tool-images'
import { MAX_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENT_BYTES, MAX_ATTACHMENTS, isImageAttachment } from '@shared/attachments'
import { attachmentMime, attachmentsFor } from './attachments'
import type { Store } from './store'

const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex')
type ImageOwner = Pick<Store, 'dataDir' | 'threads' | 'items' | 'thread' | 'project' | 'markItemsDirty'>
const readTool = (tool: string) => ['read', 'readfile', 'viewimage', 'readimage'].includes(tool.toLowerCase().replace(/[^a-z]/g, ''))
export function imagePath(item: ToolItem): string | undefined {
  if (!readTool(item.tool) || !item.args || typeof item.args !== 'object') return
  for (const key of ['path', 'file_path', 'local_image_path', 'targetFile', 'filePath', 'file']) {
    const value = item.args[key]
    if (typeof value === 'string' && /\.(png|jpe?g|webp|gif)$/i.test(value)) return value
  }
}
/** Only recognized content envelopes are inspected; arbitrary JSON paths/URLs are not capabilities. */
export function inlineImages(raw: unknown, depth = 0): { data: string; mimeType: string }[] {
  if (!raw || typeof raw !== 'object' || depth > 7) return []
  if (Array.isArray(raw)) return raw.slice(0, 100).flatMap((x) => inlineImages(x, depth + 1)).slice(0, MAX_ATTACHMENTS + 1)
  const x = raw as any
  if (x.type === 'image') {
    if (typeof x.data === 'string') return [{ data: x.data, mimeType: String(x.mimeType ?? '') }]
    if (x.source?.type === 'base64' && typeof x.source.data === 'string') return [{ data: x.source.data, mimeType: String(x.source.media_type ?? '') }]
  }
  if (x.type === 'resource' && typeof x.resource?.blob === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(x.resource.mimeType ?? '')) return [{ data: x.resource.blob, mimeType: x.resource.mimeType }]
  if ((x.type === 'input_image' || x.type === 'image_url') && typeof (x.image_url?.url ?? x.image_url) === 'string') {
    const uri = x.image_url?.url ?? x.image_url
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(uri)
    if (m) return [{ data: m[2], mimeType: m[1] }]
  }
  return ['content', 'result', 'success', 'output', 'rawOutput'].flatMap((key) => inlineImages(x[key], depth + 1)).slice(0, MAX_ATTACHMENTS + 1)
}

/** Header checks bound decoding memory before any browser/native decoder is invoked. */
export function imageDimensions(bytes: Buffer, mime: string): [number, number] | undefined {
  if (mime === 'image/png' && bytes.length >= 24) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  if (mime === 'image/gif' && bytes.length >= 10) return [bytes.readUInt16LE(6), bytes.readUInt16LE(8)]
  if (mime === 'image/webp' && bytes.length >= 30) {
    const kind = bytes.toString('ascii', 12, 16)
    if (kind === 'VP8X') return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)]
    if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff]
    if (kind === 'VP8L' && bytes[20] === 0x2f) return [1 + (bytes.readUInt32LE(21) & 0x3fff), 1 + ((bytes.readUInt32LE(21) >>> 14) & 0x3fff)]
  }
  if (mime === 'image/jpeg') {
    let i = 2
    while (i + 4 < bytes.length) {
      if (bytes[i++] !== 0xff) return
      while (bytes[i] === 0xff) i++
      const marker = bytes[i++]
      if (marker === 0xd9 || marker === 0xda) return
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (i + 2 > bytes.length) return
      const len = bytes.readUInt16BE(i)
      if (len < 2 || i + len > bytes.length) return
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && len >= 7) return [bytes.readUInt16BE(i + 5), bytes.readUInt16BE(i + 3)]
      i += len
    }
  }
}
export function validateImage(bytes: Buffer): string {
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(t('图片为空或超过 10 MiB'))
  const mime = attachmentMime(bytes, 'application/octet-stream')
  const size = imageDimensions(bytes, mime)
  if (!isImageAttachment({ mimeType: mime }) || !size || size.some((v) => v <= 0 || v > 32768) || size[0] * size[1] > MAX_TOOL_IMAGE_PIXELS) throw new Error(t('图片格式或尺寸不支持（最大 3200 万像素）'))
  return mime
}
export function decodeImage(data: string): Buffer {
  if (data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error(t('图片编码无效或超过 10 MiB'))
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data) throw new Error(t('图片编码无效'))
  validateImage(bytes)
  return bytes
}
function safeFile(file: string, cwd: string, allowed: string[] = []): string {
  if (!cwd || file.includes('\0') || /^(https?:|data:|blob:|\\\\)/i.test(file)) throw new Error(t('图片不在允许的项目范围内'))
  const candidate = file.startsWith('file:') ? fileURLToPath(file) : file
  // file://host/share becomes a UNC path on Windows; reject before filesystem access.
  if (/^(\\\\|\/\/)/.test(candidate)) throw new Error(t('图片不在允许的项目范围内'))
  const root = fs.realpathSync(cwd)
  const target = fs.realpathSync(path.resolve(cwd, candidate))
  const rel = path.relative(root, target)
  if ((rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) && !allowed.includes(target)) throw new Error(t('图片不在允许的项目范围内'))
  return target
}
function fileBytes(target: string): Buffer {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) throw new Error(t('图片不是普通文件或超过 10 MiB'))
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!n) throw new Error(t('图片在读取期间发生变化'))
      offset += n
    }
    const end = fs.fstatSync(fd)
    const current = fs.statSync(target)
    if (fs.realpathSync(target) !== target || current.ino !== stat.ino || current.dev !== stat.dev || end.size !== stat.size || end.mtimeMs !== stat.mtimeMs) throw new Error(t('图片在读取期间发生变化'))
    return bytes
  } finally { fs.closeSync(fd) }
}
export function imageCapture(store: ImageOwner, cwd: string, previous: Item[] = []): ToolImageCapture {
  const storage = () => attachmentsFor(store)
  const allowed: string[] = []
  for (const x of previous) if (x.kind === 'user') for (const ref of x.attachments ?? []) {
    try { allowed.push(fs.realpathSync(storage().pathFor(ref.id))) } catch { /* unavailable originals do not grant access */ }
  }
  const saved = new Map<string, ToolItem | undefined>()
  for (const x of previous) if (x.kind === 'tool') saved.set(x.callId, saved.has(x.callId) ? undefined : x)
  const pending = new Map<string, { data: string; mimeType: string }[]>()
  let pendingBytes = 0
  const incomplete = new Set<string>()
  return (item, raw) => {
    const incoming = inlineImages(raw)
    if (item.status === 'running') {
      const existing = pending.get(item.callId) ?? []
      for (const blob of incoming) {
        if (existing.some((x) => x.data === blob.data)) continue
        if (existing.length >= MAX_ATTACHMENTS || blob.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || pendingBytes + blob.data.length > 2 * MAX_MESSAGE_ATTACHMENT_BYTES) {
          incomplete.add(item.callId)
          item.imageError = t('待处理图片超出缓存限制')
          break
        }
        existing.push(blob); pendingBytes += blob.data.length
      }
      if (existing.length) pending.set(item.callId, existing)
      return
    }
    const earlier = pending.get(item.callId) ?? []
    pending.delete(item.callId)
    pendingBytes -= earlier.reduce((n, x) => n + x.data.length, 0)
    if (item.status !== 'success') { incomplete.delete(item.callId); return }
    const old = saved.get(item.callId)
    if (!item.images?.length && old?.images?.length && ((old.tool === item.tool && JSON.stringify(old.args) === JSON.stringify(item.args)) || (readTool(old.tool) && readTool(item.tool) && !!imagePath(old) && imagePath(old) === imagePath(item)))) {
      item.images = structuredClone(old.images)
      if (old.imageError) item.imageError = old.imageError
      return
    }
    const blobs = [...earlier, ...incoming]
    const file = imagePath(item)
    if (!blobs.length && item.images?.length) return
    if (!blobs.length && !file) return
    let total = (item.images ?? []).reduce((sum, x) => sum + x.size, 0)
    const add = (bytes: Buffer, key: string, sourceKind: ToolImageRef['sourceKind'], sourcePath?: string) => {
      if (item.images?.some((x) => x.key === key)) return
      if ((item.images?.length ?? 0) >= MAX_ATTACHMENTS || total + bytes.length > MAX_MESSAGE_ATTACHMENT_BYTES) throw new Error(t('工具图片超过 10 张或 20 MiB'))
      const mimeType = validateImage(bytes)
      const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice(6)
      const ref = storage().upload({ name: sourcePath ? path.basename(sourcePath) : `image-${(item.images?.length ?? 0) + 1}.${ext}`, mimeType, data: bytes.toString('base64') })
      item.images = [...(item.images ?? []), { ...ref, key, sourceKind, ...(sourcePath ? { sourcePath } : {}) }]
      total += bytes.length
    }
    try {
      if (blobs.length) for (const blob of blobs) {
        const bytes = decodeImage(blob.data)
        let sourcePath: string | undefined
        if (file) { try { sourcePath = safeFile(file, cwd, allowed) } catch { /* inline data remains previewable without granting path access */ } }
        add(bytes, hash(bytes), 'result', sourcePath)
      }
      else if (file && !item.images?.length) {
        const target = safeFile(file, cwd, allowed)
        add(fileBytes(target), hash(target), 'file', target)
      }
      if (incomplete.has(item.callId)) item.imageError = t('待处理图片超出缓存限制')
      else delete item.imageError
    } catch (error) { item.imageError = error instanceof Error ? error.message : t('图片不可用') }
  }
}
export function readToolImage(store: ImageOwner, threadId: string, itemId: string, imageId: string): ToolImageData {
  if (typeof threadId !== 'string' || typeof itemId !== 'string' || typeof imageId !== 'string' || !store.thread(threadId)) throw new Error(t('图片不存在'))
  const item = store.items(threadId).find((x) => x.id === itemId)
  if (!item || item.kind !== 'tool' || item.status !== 'success') throw new Error(t('图片不存在'))
  const ref = item.images?.find((x) => x.id === imageId)
  if (!ref) throw new Error(t('图片不属于此工具消息'))
  const storage = attachmentsFor(store)
  const value = storage.read(ref.id)
  decodeImage(value.data)
  return { ...value, path: storage.pathFor(ref.id), ...(ref.sourcePath ? { sourcePath: ref.sourcePath } : {}) }
}

/** Legacy transcripts only gain previews on explicit expansion, never by scanning the host. */
export function prepareToolImages(store: ImageOwner, threadId: string, itemId: string): { images: ToolImageRef[]; error?: string; retryable?: boolean } {
  const thread = store.thread(threadId)
  if (!thread) throw new Error(t('对话不存在'))
  const item = store.items(threadId).find((x) => x.id === itemId)
  if (!item || item.kind !== 'tool') throw new Error(t('工具消息不存在'))
  if (item.status === 'success' && !item.images?.length) {
    imageCapture(store, thread.cwd ?? store.project(thread.projectId)?.path ?? '', store.items(threadId))(item, item.result)
    store.markItemsDirty(threadId)
  }
  return { images: item.images ?? [], ...(item.imageError ? { error: item.imageError, retryable: item.status === 'success' && !item.images?.length && !!imagePath(item) } : {}) }
}
