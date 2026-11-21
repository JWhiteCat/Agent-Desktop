import { open, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isAntigravityVerificationUrl } from '@shared/antigravity-validation'

const logName = /^acp-(?:server|front|worker)-(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})-\d+\.log$/
const maxLogBytes = 256 * 1024

function verificationUrlInLog(text: string): string | undefined {
  const records = text.split(/\r?\n(?=[IWEF]\d{4} \d{2}:)/)
  for (const record of records.reverse()) {
    const response = record.match(/^[IWEF]\d{4} [^\r\n]+?\] Failed to make code assist backend request \(https:\/\/[\w.-]+\.googleapis\.com\/[^\s)]+\): (\{[\s\S]*)$/)
    if (!response) continue
    try {
      const details = JSON.parse(response[1]).error?.details
      if (!Array.isArray(details)) continue
      const challenge = details.find(detail => detail?.reason === 'VALIDATION_REQUIRED')
      if (challenge) {
        const url = challenge.metadata?.validation_url
        return isAntigravityVerificationUrl(url) ? url : undefined
      }
    } catch { /* The last record can still be in the CLI's write buffer. */ }
  }
  return undefined
}

async function readLogSections(filePath: string): Promise<string[]> {
  const file = await open(filePath, 'r')
  try {
    const size = (await file.stat()).size
    const chunk = Buffer.alloc(Math.min(size, maxLogBytes))
    const readAt = async (offset: number) => {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, offset)
      return chunk.toString('utf8', 0, bytesRead)
    }
    const tail = await readAt(size - chunk.length)
    // A long-lived session can write its only challenge while initializing, before the first prompt.
    return size <= chunk.length ? [tail] : [await readAt(0), tail]
  } finally {
    await file.close()
  }
}

function routedWorkerPid(sections: string[], sessionId: string): number | undefined {
  const workers = new Map<string, number>()
  let pid: number | undefined
  for (const section of sections) {
    for (const line of section.split(/\r?\n/)) {
      const start = line.match(/^I\d{4} [^\]]+ router\.go:\d+\] front: started worker (\d+) \(pid (\d+)\)$/)
      if (start) workers.set(start[1], Number(start[2]))
      const route = line.match(/^I\d{4} [^\]]+ router\.go:\d+\] front: session (\S+) served by worker (\d+)$/)
      if (route?.[1] === sessionId) pid = workers.get(route[2])
    }
  }
  return pid
}

/** agy emits only a short verification notice over ACP. Its own log contains the Google challenge. */
export async function readAntigravityVerificationUrl(
  pid: number | undefined, processStartedAt: number, sessionId?: string,
  logDirectory = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log')
): Promise<string | undefined> {
  if (!pid || !Number.isFinite(processStartedAt)) return undefined
  try {
    const logs = await readdir(logDirectory, { withFileTypes: true })
    // agy timestamps filenames in local time, to the second. A previous run may have reused this PID.
    const earliest = Math.floor(processStartedAt / 1000) * 1000
    const names = logs.filter(entry => entry.isFile() && logName.test(entry.name))
      .map(entry => entry.name).filter(name => Date.parse(name.replace(logName, '$1-$2-$3T$4:$5:$6')) >= earliest)
    const findLog = (role: string, processId: number) =>
      names.filter(name => name.startsWith(`acp-${role}-`) && name.endsWith(`-${processId}.log`)).sort().at(-1)
    let name = findLog('server', pid)
    let sections: string[]
    if (name) {
      sections = await readLogSections(path.join(logDirectory, name))
    } else {
      // With --process-per-session the parent routes ACP messages and the assigned worker logs Google's error.
      const front = findLog('front', pid)
      if (!sessionId || !front) return undefined
      const worker = routedWorkerPid(await readLogSections(path.join(logDirectory, front)), sessionId)
      if (!worker) return undefined
      name = findLog('worker', worker)
      if (!name) return undefined
      sections = await readLogSections(path.join(logDirectory, name))
      // Confirm the worker log still belongs to this session if the OS has since recycled the worker PID.
      const conversation = /^I\d{4} [^\]\r\n]+ server\.go:\d+\] (?:Sending user message to conversation|Starting conversation update stream for) (\S+)/gm
      if (!sections.some(section => Array.from(section.matchAll(conversation)).some(match => match[1] === sessionId))) return undefined
    }
    for (const section of sections.reverse()) {
      const url = verificationUrlInLog(section)
      if (url) return url
    }
  } catch {
    return undefined
  }
}
