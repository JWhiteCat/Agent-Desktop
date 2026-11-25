import fs from 'node:fs'
import path from 'node:path'

export interface HeadlessLockInfo {
  version: 1
  pid: number
  startedAt: number
  command?: string
  owner?: 'cli' | 'desktop'
}

export const HEADLESS_LOCK_FILE = 'cli-headless.lock'

export function headlessLockPath(dataDir: string): string {
  return path.join(dataDir, HEADLESS_LOCK_FILE)
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    // EPERM means the process exists but is owned by another user.
    return code === 'EPERM'
  }
}

export function readHeadlessLock(dataDir: string): HeadlessLockInfo | undefined {
  try {
    const raw = fs.readFileSync(headlessLockPath(dataDir), 'utf8')
    const parsed = JSON.parse(raw) as Partial<HeadlessLockInfo>
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return undefined
    return {
      version: 1,
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      ...(typeof parsed.command === 'string' ? { command: parsed.command } : {}),
      ...(parsed.owner === 'desktop' || parsed.owner === 'cli' ? { owner: parsed.owner } : {})
    }
  } catch {
    return undefined
  }
}

export function activeHeadlessLock(dataDir: string): HeadlessLockInfo | undefined {
  const info = readHeadlessLock(dataDir)
  if (!info) return undefined
  if (!isProcessAlive(info.pid)) {
    try {
      fs.rmSync(headlessLockPath(dataDir), { force: true })
    } catch {
      // ignore cleanup errors
    }
    return undefined
  }
  return info
}

export interface AcquiredHeadlessLock {
  info: HeadlessLockInfo
  release(): void
}

/**
 * Acquires an exclusive lock file for headless CLI access to `dataDir`.
 * Uses `O_CREAT | O_EXCL` (`wx`) so concurrent headless processes cannot both acquire it.
 */
export function acquireHeadlessLock(dataDir: string, command?: string, owner?: 'cli' | 'desktop'): AcquiredHeadlessLock {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const file = headlessLockPath(dataDir)
  const info: HeadlessLockInfo = {
    version: 1,
    pid: process.pid,
    startedAt: Date.now(),
    ...(command ? { command } : {}),
    ...(owner ? { owner } : {})
  }
  const payload = JSON.stringify(info, null, 2)

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, payload, 'utf8')
      } finally {
        fs.closeSync(fd)
      }
      let released = false
      return {
        info,
        release() {
          if (released) return
          released = true
          const current = readHeadlessLock(dataDir)
          if (current && current.pid !== info.pid) return
          try {
            fs.rmSync(file, { force: true })
          } catch {
            // ignore cleanup errors
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
      const existing = readHeadlessLock(dataDir)
      if (existing && isProcessAlive(existing.pid)) {
        throw new HeadlessLockConflictError(existing)
      }
      try {
        fs.rmSync(file, { force: true })
      } catch {
        // retry once
      }
    }
  }
  const existing = readHeadlessLock(dataDir)
  throw new HeadlessLockConflictError(existing ?? { version: 1, pid: 0, startedAt: 0 })
}

export interface DesktopStartupLockOptions {
  /** Maximum time to wait for a short-lived lock holder before reporting a conflict. */
  waitMs?: number
  pollMs?: number
}

export type DesktopStartupLockResult =
  | { ok: true; lock: AcquiredHeadlessLock }
  | { ok: false; holder: HeadlessLockInfo }

/**
 * Waits briefly for any active `cli-headless.lock` to clear, then acquires a desktop
 * startup lock so headless CLI cannot open `Store` concurrently before `LocalControlServer`
 * publishes `cli-control.json`.
 */
export async function acquireDesktopStartupLock(
  dataDir: string,
  opts: DesktopStartupLockOptions = {}
): Promise<DesktopStartupLockResult> {
  const waitMs = Math.max(0, opts.waitMs ?? 1500)
  const pollMs = Math.max(10, opts.pollMs ?? 50)
  const deadline = Date.now() + waitMs
  while (true) {
    try {
      return { ok: true, lock: acquireHeadlessLock(dataDir, 'desktop-startup', 'desktop') }
    } catch (err) {
      if (!(err instanceof HeadlessLockConflictError)) throw err
      const remaining = deadline - Date.now()
      if (remaining <= 0) return { ok: false, holder: err.holder }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)))
    }
  }
}

export class HeadlessLockConflictError extends Error {
  readonly holder: HeadlessLockInfo
  constructor(holder: HeadlessLockInfo) {
    super(
      holder.owner === 'desktop'
        ? `Agent Desktop (PID ${holder.pid}) is starting up on this data directory`
        : `Another headless Agent Desktop CLI process (PID ${holder.pid}) is using this data directory`
    )
    this.name = 'HeadlessLockConflictError'
    this.holder = holder
  }
}
