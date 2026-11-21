import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAntigravityVerificationUrl } from '../src/main/antigravity-validation'

const startedAt = new Date(2026, 10, 21, 10, 32, 35, 100).getTime()
const fileName = 'acp-server-20261121_103235-123.log'
const url = 'https://accounts.google.com/v3/signin/continue?challenge=test&next=1'
const responseHeader = 'I1121 10:32:37.257557     262 http_helpers.go:938] Failed to make code assist backend request (https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary): '
function challenge(link: string) {
  return responseHeader + JSON.stringify({
    error: { code: 403, details: [{ reason: 'VALIDATION_REQUIRED', metadata: { validation_url: link } }] }
  }, null, 2)
}

describe('Antigravity account verification logs', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'agy-verification-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('reads the latest Google challenge from the active process', async () => {
    await writeFile(path.join(dir, fileName), [challenge(url + '0'), challenge(url)].join('\n'))
    await writeFile(path.join(dir, 'acp-server-20261121_103236-456.log'), challenge(url + '2'))
    expect(await readAntigravityVerificationUrl(123, startedAt, undefined, dir)).toBe(url)
  })

  it('ignores a log from an earlier process with the same PID', async () => {
    await writeFile(path.join(dir, fileName), challenge(url))
    expect(await readAntigravityVerificationUrl(123, startedAt + 5000, undefined, dir)).toBeUndefined()
    expect(await readAntigravityVerificationUrl(undefined, startedAt, undefined, dir)).toBeUndefined()
  })

  it('recovers a challenge logged during startup in a long session', async () => {
    await writeFile(path.join(dir, fileName), challenge(url) + '\nI1121 10:33:00.123000     100 server.go:1] ' + 'x'.repeat(600_000))
    expect(await readAntigravityVerificationUrl(123, startedAt, undefined, dir)).toBe(url)
  })

  it('ignores invalid destinations, unrelated log text and unrelated errors', async () => {
    for (const log of [
      challenge('https://example.org/verify'),
      challenge(url).replace(responseHeader, 'Logged user message: '),
      challenge(url).replace('VALIDATION_REQUIRED', 'PERMISSION_DENIED')
    ]) {
      await writeFile(path.join(dir, fileName), log)
      expect(await readAntigravityVerificationUrl(123, startedAt, undefined, dir)).toBeUndefined()
    }
  })

  it('follows only the worker that the active front process assigned to this session', async () => {
    const router = 'I1121 10:32:36.000000     54 router.go:1049] front: '
    await writeFile(path.join(dir, fileName.replace('server', 'front')), [
      'started worker 1 (pid 333)', 'started worker 2 (pid 444)',
      'session target served by worker 1', 'session other served by worker 2'
    ].map(line => router + line).join('\n'))
    const stream = 'I1121 10:32:36.000000     82 server.go:1283] Starting conversation update stream for '
    const workerFile = path.join(dir, 'acp-worker-20261121_103236-333.log')
    await writeFile(workerFile, challenge(url) + '\n' + stream + 'target')
    await writeFile(path.join(dir, 'acp-worker-20261121_103237-444.log'), challenge(url + '2') + '\n' + stream + 'other')
    expect(await readAntigravityVerificationUrl(123, startedAt, 'target', dir)).toBe(url)
    expect(await readAntigravityVerificationUrl(123, startedAt, 'unknown', dir)).toBeUndefined()
    expect(await readAntigravityVerificationUrl(123, startedAt, undefined, dir)).toBeUndefined()

    // A newer, unrelated process has since reused the assigned worker's PID.
    await writeFile(path.join(dir, 'acp-worker-20261121_103300-333.log'), challenge(url + '3') + '\n' + stream + 'other')
    expect(await readAntigravityVerificationUrl(123, startedAt, 'target', dir)).toBeUndefined()
  })
})
