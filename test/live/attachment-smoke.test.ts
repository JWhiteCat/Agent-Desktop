import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { AcpConnection, MethodNotFound } from '../../src/main/acp'
import { AttachmentStore } from '../../src/main/attachments'
import { killTree, resolveApiKey, resolveCli, spawnCli, stripAnsi } from '../../src/main/cli'
import { initializeSession } from '../../src/main/session/provider'

const MODEL = 'composer-2.5[fast=true]'
// Static 128 x 128 opaque red PNG; its filename does not disclose the expected color.
const IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAABWklEQVR4nO3OQQ0AMBAEofVv+iqDxzRBALvtg/wgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwg7gEgaMOyrMtNTwAAAABJRU5ErkJggg=='

function safeErr(text: string): string {
  return stripAnsi(text).split(/\r?\n/)
    .filter((line) => !/api[_-]?key|authorization|bearer|token/i.test(line))
    .join('\n').trim().slice(0, 400)
}

it.skipIf(!process.env.AGENT_DESKTOP_LIVE_MODEL)(
  'reads a native image and an original managed file outside the Cursor workspace',
  async () => {
    const cli = resolveCli('')
    if (!cli) throw new Error('未找到 Cursor CLI（agent）')
    const apiKey = resolveApiKey('')
    if (!apiKey) throw new Error('Live attachment smoke requires CURSOR_API_KEY')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desktop-attachment-live-'))
    const cwd = path.join(root, 'workspace')
    await fs.mkdir(cwd)
    const storage = new AttachmentStore({ dataDir: path.join(root, 'data'), threads: [], items: () => [] })
    const token = `ATTACHMENT_ORIGINAL_${randomBytes(8).toString('hex')}`
    const original = storage.upload({ name: 'original.txt', mimeType: 'text/plain', data: Buffer.from(token).toString('base64') })
    const image = storage.upload({ name: 'sample.png', mimeType: 'image/png', data: IMAGE })
    const originalPath = storage.pathFor(original.id)
    expect(path.relative(cwd, originalPath).startsWith('..')).toBe(true)
    const child = spawnCli(cli, ['--trust', '--model', MODEL, '--mode', 'ask', '--workspace', cwd, 'acp'], cwd, 'pipe', apiKey)
    const acp = new AcpConnection(child)
    let stderr = ''
    let output = ''
    let stage = 'initialize'
    let timer: ReturnType<typeof setTimeout> | undefined
    child.stderr?.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-8000) })
    acp.start({
      onNotification: (method, params) => {
        if (method !== 'session/update') return
        const update = params?.update
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') output += update.content.text
      },
      onRequest: async (method, params) => {
        if (method !== 'session/request_permission') throw new MethodNotFound(method)
        const call = params?.toolCall
        const candidate = typeof call?.rawInput?.file_path === 'string' ? call.rawInput.file_path
          : /^Read `([^`]+)`$/.exec(String(call?.title ?? ''))?.[1]
        const allowed = call?.kind === 'read' && typeof candidate === 'string' && storage.scopedRead(candidate, cwd, [original])
        const choice = (Array.isArray(params?.options) ? params.options : [])
          .find((option: any) => option.kind === (allowed ? 'allow_once' : 'reject_once'))
        return choice ? { outcome: { outcome: 'selected', optionId: choice.optionId } } : { outcome: { outcome: 'cancelled' } }
      }
    })
    try {
      const result = await Promise.race([
        (async () => {
          const initialized = await initializeSession(acp, 'cursor', apiKey)
          expect(initialized?.agentCapabilities?.promptCapabilities?.image).toBe(true)
          stage = 'new-session'
          const session = await acp.request('session/new', { cwd, mcpServers: [] })
          stage = 'prompt'
          return acp.request('session/prompt', {
            sessionId: session.sessionId,
            prompt: [
              { type: 'text', text: `Inspect the attached image, and use the Read tool to read the original text file at this exact local path: ${JSON.stringify(originalPath)}. Reply with a JSON object containing "color" (the image's dominant color, one English word) and "token" (the exact file contents). Do not modify files or run commands.` },
              { type: 'image', ...storage.read(image.id) }
            ]
          })
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Live attachment request timed out')), 85_000) })
      ])
      stage = 'verify'
      expect(result?.stopReason).toBe('end_turn')
      const answers = [...output.matchAll(/\{[^{}]*\}/g)].flatMap(([text]) => {
        try { return [JSON.parse(text) as { color?: unknown; token?: unknown }] } catch { return [] }
      })
      if (!answers.some((answer) => answer.color === 'red' && answer.token === token)) {
        throw new Error('Image color or original-file content verification failed')
      }
    } catch (error) {
      const detail = safeErr(`${error instanceof Error ? error.message : String(error)}\n${stderr}`)
      throw new Error(`Live attachment request failed during ${stage}: ${detail || 'no diagnostic details'}`)
    } finally {
      if (timer) clearTimeout(timer)
      const closed = child.exitCode !== null ? Promise.resolve() : new Promise<void>((resolve) => child.once('close', () => resolve()))
      killTree(child)
      let closeTimer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([closed, new Promise<void>((resolve) => { closeTimer = setTimeout(resolve, 5000) })])
      if (closeTimer) clearTimeout(closeTimer)
      const resolved = path.resolve(root)
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agent-desktop-attachment-live-')) {
        throw new Error(`Unexpected test directory: ${resolved}`)
      }
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
    }
  },
  120_000
)
