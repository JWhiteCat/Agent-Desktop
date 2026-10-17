import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { AcpConnection, MethodNotFound } from '../../src/main/acp'
import { killTree, resolveApiKey, resolveCli, spawnCli } from '../../src/main/cli'
import { applySessionOptions, cursorArgs, initializeSession } from '../../src/main/session/provider'
import { StreamReducer } from '../../src/main/reducer'
import { changedTurnFiles, snapshotTurnFiles } from '../../src/main/turn-files'
import { collectEditedFiles } from '../../src/renderer/src/lib/diff'
import type { Item, SendRequest } from '../../src/shared/types'

it.skipIf(!process.env.AGENT_DESKTOP_LIVE_MODEL)('attributes a real Cursor edit while preserving concurrent external writes only in the snapshot', async () => {
  const cli = resolveCli('')
  const apiKey = resolveApiKey('')
  if (!cli || !apiKey) throw new Error('This live test requires Cursor CLI and CURSOR_API_KEY')
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-file-changes-live-'))
  const req: SendRequest = { threadId: 'live', prompt: '', model: 'composer-2.5[fast=true]', mode: 'agent', force: true }
  const child = spawnCli(cli, cursorArgs(req, 'default', cwd, false), cwd, 'pipe', apiKey)
  const acp = new AcpConnection(child)
  const items: Item[] = []
  const reducer = new StreamReducer(items)
  reducer.init.cwd = cwd
  let sessionId = ''
  let injected = false
  let timer: ReturnType<typeof setTimeout> | undefined
  acp.start({
    onNotification: (method, params) => {
      if (method !== 'session/update' || params.sessionId !== sessionId) return
      reducer.handleAcp(params.update)
      if (!injected && items.some((item) => item.kind === 'tool' && item.status === 'success'
        && item.fileChanges?.some((file) => path.basename(file.path) === 'edited.txt'))) {
        injected = true
        fs.writeFileSync(path.join(cwd, 'external.txt'), 'EXTERNAL ONLY\n')
        fs.appendFileSync(path.join(cwd, 'edited.txt'), 'EXTERNAL APPEND\n')
      }
    },
    onRequest: async (method, params) => {
      if (method !== 'session/request_permission') throw new MethodNotFound(method)
      const choice = params.options?.find((option: any) => option.kind === 'allow_once')
      return choice ? { outcome: { outcome: 'selected', optionId: choice.optionId } } : { outcome: { outcome: 'cancelled' } }
    }
  })
  try {
    fs.writeFileSync(path.join(cwd, 'edited.txt'), 'ORIGINAL\n')
    const before = await snapshotTurnFiles(cwd)
    await Promise.race([
      (async () => {
        await initializeSession(acp, 'cursor', apiKey)
        sessionId = (await acp.request('session/new', { cwd, mcpServers: [] })).sessionId
        await applySessionOptions({ acp, sessionId, provider: 'cursor' }, req, 'default')
        const result = await acp.request('session/prompt', { sessionId, prompt: [{ type: 'text',
          text: 'Use an edit tool to replace ORIGINAL with AGENT in edited.txt, preserving the newline. Do not run terminal commands. Do not modify any other files. Make this one edit, then reply done.' }] })
        expect(result.stopReason).toBe('end_turn')
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Cursor edit test timed out')), 90_000) })
    ])
    expect(injected).toBe(true)
    const files = collectEditedFiles(items, cwd)
    expect(files.map((file) => file.path)).toEqual(['edited.txt'])
    expect(files[0].lines).toContain('+AGENT')
    expect(files[0].lines.join('\n')).not.toContain('+EXTERNAL')
    const snapshot = await changedTurnFiles(before)
    expect(snapshot.map((file) => path.basename(file.path)).sort()).toEqual(['edited.txt', 'external.txt'])
    expect(snapshot.find((file) => path.basename(file.path) === 'edited.txt')?.diff).toContain('+EXTERNAL APPEND')
  } finally {
    if (timer) clearTimeout(timer)
    const closed = child.exitCode !== null ? Promise.resolve() : new Promise<void>((resolve) => child.once('close', () => resolve()))
    killTree(child)
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([closed, new Promise<void>((resolve) => { closeTimer = setTimeout(resolve, 5000) })])
    if (closeTimer) clearTimeout(closeTimer)
    const resolved = path.resolve(cwd)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agent-desktop-file-changes-live-')) throw new Error('Unexpected live test directory')
    await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  }
}, 110_000)
