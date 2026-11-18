import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { t as translate } from '@shared/i18n'
import type { CliInstallStatus } from '@shared/types'
import { x as extractTar } from 'tar'
import { Open as zip } from 'unzipper'
import { AcpConnection, MethodNotFound } from './acp'
import { cliArtifact, type CliArtifact } from './cli-install-source'
import { cliEnvironment, isExecutableFile, killCliProcessTree, spawnCliProcess } from './cli-runtime'
import { writeTextSafely } from './local-files'
import { installPath, managedCliDirectory, managedExecutable, type CliInstallTarget } from './managed-cli-location'

type Fetch = (url: string, init?: RequestInit) => Promise<Response>
type Progress = Omit<CliInstallStatus, 'source' | 'unavailable'>
const ARCHIVE_LIMIT = 1024 * 1024 * 1024
const EXTRACT_LIMIT = 2 * ARCHIVE_LIMIT

async function request(fetchResource: Fetch, url: string, signal: AbortSignal): Promise<Response> {
  const response = await fetchResource(url, { credentials: 'omit', redirect: 'error', signal })
  if (!response.ok || !response.body) {
    void response.body?.cancel()
    throw new Error(translate('下载失败（HTTP {status}）', { status: response.status }))
  }
  return response
}

async function* bodyChunks(response: Response): AsyncGenerator<Uint8Array> {
  const reader = response.body!.getReader()
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

async function readJson(fetchResource: Fetch, url: string): Promise<unknown> {
  const response = await request(fetchResource, url, AbortSignal.timeout(20_000))
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of bodyChunks(response)) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 2 * 1024 * 1024) throw new Error(translate('CLI 下载清单过大'))
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function download(fetchResource: Fetch, artifact: CliArtifact, archive: string, change: (status: Progress) => void): Promise<void> {
  const response = await request(fetchResource, artifact.url, AbortSignal.timeout(10 * 60_000))
  const total = Number(response.headers.get('content-length')) || undefined
  if (total && total > ARCHIVE_LIMIT) {
    await response.body!.cancel()
    throw new Error(translate('CLI 安装包过大'))
  }
  let received = 0
  const hash = createHash(artifact.integrity.algorithm)
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length
      if (received > ARCHIVE_LIMIT) {
        done(new Error(translate('CLI 安装包过大')))
        return
      }
      hash.update(chunk)
      change({ phase: 'downloading', total, received })
      done(null, chunk)
    }
  })
  await pipeline(Readable.from(bodyChunks(response), { objectMode: false }), counter, fs.createWriteStream(archive, { flags: 'wx', mode: 0o600 }))
  change({ phase: 'verifying' })
  if (hash.digest(artifact.integrity.encoding) !== artifact.integrity.digest) throw new Error(translate('CLI 安装包校验失败'))
}

export async function unpackCliArchive(archive: string, directory: string, format: Exclude<CliArtifact['format'], 'binary'>): Promise<void> {
  let extracted = 0
  const validate = (name: string, size: number) => {
    const target = installPath(directory, name.replace(/\/$/, ''))
    extracted += size
    if (!target || !Number.isSafeInteger(extracted) || extracted > EXTRACT_LIMIT) throw new Error(translate('CLI 安装包包含无效的文件'))
    return target
  }
  if (format === 'tar.gz') {
    let invalid = false
    await extractTar({
      file: archive, cwd: directory, strict: true, noChmod: false,
      filter(name, entry) {
        if (invalid) return false
        try {
          validate(name, entry.size)
          invalid = !('type' in entry) || !['File', 'Directory', 'OldFile'].includes(entry.type)
        } catch {
          invalid = true
        }
        return !invalid
      }
    })
    if (invalid) throw new Error(translate('CLI 安装包包含无效的文件'))
    return
  }
  const { files } = await zip.file(archive)
  for (const entry of files) {
    const target = validate(entry.path, entry.uncompressedSize)
    const mode = entry.externalFileAttributes >>> 16
    const kind = mode & 0o170000
    if (kind && kind !== 0o100000 && kind !== 0o040000) throw new Error(translate('CLI 安装包包含无效的文件'))
    if (entry.type === 'Directory') {
      await fs.promises.mkdir(target, { recursive: true })
      continue
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await pipeline(entry.stream(), fs.createWriteStream(target, { flags: 'wx', mode: (mode & 0o777) || 0o644 }))
  }
}

async function probe(provider: CliInstallTarget, command: string, prefixArgs: string[]): Promise<void> {
  const usesAcp = provider === 'antigravity' || provider === 'antigravity-registry'
  const args = usesAcp ? provider === 'antigravity' ? ['acp'] : prefixArgs
    : [...prefixArgs, ...(provider === 'cursor' ? ['--disable-auto-update'] : []), '--version']
  const env = cliEnvironment(provider === 'antigravity' ? { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } : {}, path.dirname(command))
  const child = spawnCliProcess(command, args, {
    cwd: os.homedir(), env,
    windowsHide: true, stdio: [usesAcp ? 'pipe' : 'ignore', 'pipe', 'pipe']
  })
  child.stderr?.resume()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(translate('CLI 安装验证超时'))), 30_000)
        child.once('error', reject)
      }),
      usesAcp
        ? (async () => {
            const acp = new AcpConnection(child)
            acp.start({ onNotification() {}, onRequest: async (method) => { throw new MethodNotFound(method) } })
            const result = await acp.request('initialize', {
              protocolVersion: 1, clientCapabilities: {},
              clientInfo: { name: 'agent-desktop', version: '0.1.0' }
            })
            if (result?.protocolVersion !== 1) throw new Error(translate('CLI 安装验证失败'))
          })()
        : new Promise<void>((resolve, reject) => {
            child.stdout?.resume()
            child.once('close', (code) => code === 0 ? resolve() : reject(new Error(translate('CLI 安装验证失败'))))
          })
    ])
  } finally {
    clearTimeout(timer)
    killCliProcessTree(child)
  }
}

function payloadEntry(provider: CliInstallTarget, artifact: CliArtifact, directory: string): { command: string; prefixArgs: string[] } {
  const command = installPath(directory, artifact.command)!
  if (provider === 'cursor' && process.platform === 'win32' && !isExecutableFile(command)) {
    return { command: 'dist-package/node.exe', prefixArgs: ['dist-package/index.js'] }
  }
  return { command: artifact.command, prefixArgs: artifact.prefixArgs ?? [] }
}

export class CliInstaller {
  private tasks = new Map<CliInstallTarget, Promise<void>>()
  private progress = new Map<CliInstallTarget, Progress>()

  constructor(
    private readonly fetchResource: Fetch,
    private readonly verify = probe,
    private readonly artifactFor = cliArtifact
  ) {}

  status(provider: CliInstallTarget): Progress {
    return this.progress.get(provider) ?? {}
  }

  install(provider: CliInstallTarget): Promise<void> {
    const pending = this.tasks.get(provider)
    if (pending) return pending
    const change = (status: Progress) => this.progress.set(provider, status)
    change({ phase: 'downloading' })
    const task = this.downloadAndActivate(provider, change).catch((error: unknown) => {
      change({ error: error instanceof Error ? error.message : String(error) })
      throw error
    }).finally(() => {
      this.tasks.delete(provider)
    })
    this.tasks.set(provider, task)
    return task
  }

  private async downloadAndActivate(provider: CliInstallTarget, change: (status: Progress) => void): Promise<void> {
    const root = managedCliDirectory(provider)
    if (!root) throw new Error(translate('CLI 安装目录不可用'))
    const artifact = await this.artifactFor(provider, (url) => readJson(this.fetchResource, url))
    if (managedExecutable(provider)?.version === artifact.version) {
      change({})
      return
    }
    const generation = `${artifact.version}-${randomUUID()}`
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 })
    const staging = await fs.promises.mkdtemp(path.join(root, '.download-'))
    const archive = path.join(staging, 'artifact')
    const versions = path.join(root, 'versions')
    const versionDirectory = path.join(versions, generation)
    let activated = false
    try {
      await download(this.fetchResource, artifact, archive, change)
      change({ phase: 'installing' })
      await fs.promises.mkdir(versions, { recursive: true })
      await fs.promises.mkdir(versionDirectory, { mode: 0o700 })
      if (artifact.format === 'binary') {
        await fs.promises.rename(archive, installPath(versionDirectory, artifact.command)!)
      } else {
        await unpackCliArchive(archive, versionDirectory, artifact.format)
        if (artifact.archiveEntry) {
          await fs.promises.rename(installPath(versionDirectory, artifact.archiveEntry)!, installPath(versionDirectory, artifact.command)!)
        }
      }
      const entry = payloadEntry(provider, artifact, versionDirectory)
      // Native Windows processes can hold their executable open briefly after
      // the probe. Probe at the final path, then publish the activation record.
      const command = installPath(versionDirectory, entry.command)!
      if (process.platform !== 'win32') await fs.promises.chmod(command, 0o755)
      const args = provider === 'cursor' ? entry.prefixArgs.map((arg) => installPath(versionDirectory, arg)!) : entry.prefixArgs
      await this.verify(provider, command, args)
      writeTextSafely(path.join(root, 'current.json'), JSON.stringify({ version: artifact.version, generation, ...entry }), false)
      activated = true
      change({})
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      if (!activated) await fs.promises.rm(versionDirectory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    }
  }
}
