import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { killTree, resolveCli, spawnCli, stripAnsi, type ResolvedCli } from '../../src/main/cli'
import { GROK_47_500K_HIGH_FAST } from '../grok-model'

const PROMPT = 'Reply with exactly ok'

function safeErr(stderr: string): string {
  return stripAnsi(stderr)
    .split(/\r?\n/)
    .filter((line) => !/api[_-]?key|authorization|bearer|token/i.test(line))
    .join('\n')
    .trim()
    .slice(0, 240)
}

function runPrint(cli: ResolvedCli, cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnCli(cli, [
      '--trust',
      '--model', GROK_47_500K_HIGH_FAST,
      '--mode', 'ask',
      '--print',
      '--output-format', 'text',
      '--workspace', cwd,
      PROMPT
    ], cwd)
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => killTree(child), timeoutMs)
    child.stdout?.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) })
    })
  })
}

it.skipIf(!process.env.AGENT_DESKTOP_LIVE_MODEL)(
  'asks Grok 4.7 500K High Fast for a one-word reply',
  async () => {
    const cli = resolveCli('')
    if (!cli) throw new Error('未找到 Cursor CLI（agent）。请先安装，或在设置中指定路径。')
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'agent-desktop-live-'))
    try {
      const result = await runPrint(cli, cwd, 85_000)
      const text = result.stdout.trim()
      if (result.code !== 0) throw new Error(`CLI 退出 ${result.code}: ${safeErr(result.stderr) || '无 stderr'}`)
      expect(text.toLowerCase()).toContain('ok')
      expect(text.length).toBeLessThanOrEqual(80)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  },
  90_000
)
