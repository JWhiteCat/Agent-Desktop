import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACP_TURN_USAGE_ANCHOR, acpUsagePreloadSource, patchAcpPresenterSource } from '../src/main/acp-usage'
import { normalizeTurnUsage } from '../src/shared/turn-usage'

describe('normalizeTurnUsage', () => {
  it('splits cache tokens out of a turnEnded input count', () => {
    expect(
      normalizeTurnUsage({
        inputTokens: 100n,
        outputTokens: 7,
        cacheReadTokens: 30,
        cacheWriteTokens: 10,
        inputIncludesCache: true
      })
    ).toEqual({ inputTokens: 60, outputTokens: 7, cacheReadTokens: 30, cacheWriteTokens: 10 })
  })

  it('keeps an already split usage payload', () => {
    expect(normalizeTurnUsage({ inputTokens: 4, output_tokens: 2, cachedReadTokens: 8 })).toEqual({
      inputTokens: 4,
      outputTokens: 2,
      cacheReadTokens: 8,
      cacheWriteTokens: 0
    })
  })

  it('ignores an empty update', () => {
    expect(normalizeTurnUsage({})).toBeUndefined()
    expect(normalizeTurnUsage(null)).toBeUndefined()
  })
})

describe('ACP usage preload', () => {
  it('inserts a turnEnded case ahead of the thought handler', () => {
    const source = `function*(){switch(e.message.case){${ACP_TURN_USAGE_ANCHOR}}}`
    const patched = patchAcpPresenterSource(source)
    expect(patched).toContain('case"turnEnded":')
    expect(patched.indexOf('case"turnEnded":')).toBeLessThan(patched.indexOf('case"thinkingDelta":'))
    expect(patchAcpPresenterSource(patched)).toBe(patched)
  })

  it('forwards turnEnded token counts when the ACP chunk loads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-usage-'))
    const preload = path.join(dir, 'preload.cjs')
    fs.writeFileSync(preload, acpUsagePreloadSource())
    fs.writeFileSync(
      path.join(dir, '6589.index.js'),
      `exports.gen=function*(e){switch(e.message.case){${ACP_TURN_USAGE_ANCHOR}}}`
    )
    fs.writeFileSync(
      path.join(dir, 'run.cjs'),
      `const m = require('./6589.index.js')
const updates = []
const g = m.gen.call({
  sendSessionUpdate(update) { updates.push(update); return Promise.resolve() }
}, { message: { case: 'turnEnded', value: { inputTokens: 100n, outputTokens: 7n, cacheReadTokens: 30n, cacheWriteTokens: 10n } } })
let step = g.next()
while (!step.done) step = g.next()
process.stdout.write(JSON.stringify(updates))
`
    )
    const requireArg = preload.replace(/\\/g, '/')
    const r = spawnSync(process.execPath, [path.join(dir, 'run.cjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: `--require ${requireArg}` }
    })
    expect(r.status, r.stderr).toBe(0)
    const updates = JSON.parse(r.stdout) as { sessionUpdate: string; usage: Record<string, number | boolean> }[]
    expect(updates).toEqual([
      {
        sessionUpdate: 'usage_update',
        usage: {
          inputIncludesCache: true,
          inputTokens: 100,
          outputTokens: 7,
          cacheReadTokens: 30,
          cacheWriteTokens: 10
        }
      }
    ])
  })
})
