import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { t as translate } from '@shared/i18n'
import type { GrokBotAttachment } from '@shared/types'

/**
 * Files a Grok Bot delivered. The public API drops them, so they are read from the Grok Bot
 * desktop app's local `attachment-image-cache`, which is undocumented and may change when the
 * app updates. Only hashes seen in a transcript are served, and bytes are re-hashed on every read.
 */

const SHA256 = /^[0-9a-f]{64}$/
/** Larger cache files are never hashed or served. */
const MAX_FILE_BYTES = 64 * 1024 * 1024

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.zip': 'application/zip'
}

/** `<img>` never runs scripts in SVG, so SVG is safe to preview there. */
const PREVIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value)
}

export function mimeTypeFor(name: string): string {
  return MIME_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream'
}

export function isPreviewType(mimeType: string): boolean {
  return PREVIEW_TYPES.has(mimeType)
}

/** File name without any directory part, safe as a save-dialog default. */
export function safeFileName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop()?.replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim() ?? ''
  return base && base !== '.' && base !== '..' ? base : fallback
}

export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

interface IndexedFile {
  size: number
  mtimeMs: number
  sha256: string
}

export interface CachedFile {
  file: string
  bytes: Buffer
  name: string
  mimeType: string
}

export class GrokBotFiles {
  /** Hash results by path, valid while size and mtime are unchanged. */
  private readonly index = new Map<string, IndexedFile>()
  private readonly bySha = new Map<string, string>()
  /** Hashes that appeared in a transcript, with their display metadata. */
  private readonly known = new Map<string, { name: string; mimeType: string }>()

  constructor(private readonly cacheDir: () => string) {}

  remember(attachment: Pick<GrokBotAttachment, 'sha256' | 'name' | 'mimeType'>): void {
    if (isSha256(attachment.sha256)) this.known.set(attachment.sha256, { name: attachment.name, mimeType: attachment.mimeType })
  }

  isKnown(sha256: unknown): boolean {
    return isSha256(sha256) && this.known.has(sha256)
  }

  /** Re-scans the cache folder, hashing only new or changed files. */
  async refresh(): Promise<void> {
    const dir = this.cacheDir()
    let names: string[]
    try {
      names = await fs.promises.readdir(dir)
    } catch {
      this.index.clear()
      this.bySha.clear()
      return
    }
    const seen = new Set<string>()
    for (const name of names) {
      const file = path.join(dir, name)
      seen.add(file)
      try {
        const stat = await fs.promises.stat(file)
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
          this.index.delete(file)
          continue
        }
        const old = this.index.get(file)
        if (old && old.size === stat.size && old.mtimeMs === stat.mtimeMs) continue
        this.index.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, sha256: sha256Of(await fs.promises.readFile(file)) })
      } catch {
        this.index.delete(file)
      }
    }
    for (const file of [...this.index.keys()]) if (!seen.has(file)) this.index.delete(file)
    this.bySha.clear()
    for (const [file, entry] of this.index) this.bySha.set(entry.sha256, file)
  }

  /** Size of a cached file with this hash, from the last refresh. */
  lookup(sha256: string): { file: string; size: number } | undefined {
    const file = this.bySha.get(sha256)
    const entry = file ? this.index.get(file) : undefined
    return file && entry ? { file, size: entry.size } : undefined
  }

  /** Bytes for a hash seen in a transcript. Unknown hashes and changed files are refused. */
  async read(sha256: unknown): Promise<CachedFile> {
    if (!isSha256(sha256)) throw new Error(translate('无效的文件标识'))
    const meta = this.known.get(sha256)
    if (!meta) throw new Error(translate('未知的 Grok Bot 文件'))
    let found = this.lookup(sha256)
    if (!found) {
      await this.refresh()
      found = this.lookup(sha256)
    }
    if (!found) throw new Error(translate('Grok Bot 桌面端缓存里没有这个文件，请在 Grok Bot 应用中下载'))
    const bytes = await fs.promises.readFile(found.file)
    if (sha256Of(bytes) !== sha256) {
      this.index.delete(found.file)
      this.bySha.delete(sha256)
      throw new Error(translate('Grok Bot 缓存文件已变化，请重试'))
    }
    return { file: found.file, bytes, name: meta.name, mimeType: meta.mimeType }
  }
}

/** Response for `grokbot-file://<sha256>/`: known, verified bytes with a locked-down CSP. */
export async function grokBotFileResponse(files: GrokBotFiles, url: string): Promise<Response> {
  let sha = ''
  try {
    sha = new URL(url).hostname.toLowerCase()
  } catch {
    // Invalid URL.
  }
  if (!files.isKnown(sha)) return new Response('Not found', { status: 404 })
  try {
    const cached = await files.read(sha)
    return new Response(new Uint8Array(cached.bytes), {
      status: 200,
      headers: {
        'content-type': cached.mimeType,
        'content-length': String(cached.bytes.length),
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
        'cache-control': 'no-store'
      }
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}
