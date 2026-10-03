import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACP_TURN_USAGE_ANCHOR,
  ACP_TURN_USAGE_ASYNC_ANCHOR,
  acpUsagePreloadSource,
  patchAcpPresenterSource
} from '../src/main/acp-usage'
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

const TURN_USAGE = {
  sessionUpdate: 'usage_update',
  usage: {
    inputIncludesCache: true,
    inputTokens: 100,
    outputTokens: 7,
    cacheReadTokens: 30,
    cacheWriteTokens: 10
  }
}

function loadPatchedChunk(chunkName: string, moduleSource: string, runSource: string) {
  // Keep a space in the fixture path so preload argument handling stays covered.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad usage-'))
  try {
    const preload = path.join(dir, 'preload.cjs')
    fs.writeFileSync(preload, acpUsagePreloadSource())
    fs.writeFileSync(path.join(dir, chunkName), moduleSource)
    fs.writeFileSync(path.join(dir, 'run.cjs'), runSource)
    return spawnSync(process.execPath, ['--require', preload, path.join(dir, 'run.cjs')], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '' }
    })
  } finally {
    const resolved = path.resolve(dir)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('ad usage-')) {
      throw new Error(`Unexpected test directory: ${resolved}`)
    }
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}

describe('ACP usage preload', () => {
  it('inserts a yielded turnEnded case ahead of the generator thought handler', () => {
    const source = `function*(){switch(e.message.case){${ACP_TURN_USAGE_ANCHOR}}}`
    const patched = patchAcpPresenterSource(source)
    expect(patched.indexOf('case"turnEnded":')).toBeLessThan(patched.indexOf('case"thinkingDelta":'))
    expect(patched).toContain('yield this.sendSessionUpdate({sessionUpdate:"usage_update"')
    expect(patched).not.toContain('await ')
    expect(patchAcpPresenterSource(patched)).toBe(patched)
  })

  it('inserts an awaited turnEnded case ahead of the async thought handler', () => {
    const source = `async function present(e){switch(e.message.case){${ACP_TURN_USAGE_ASYNC_ANCHOR}}}`
    const patched = patchAcpPresenterSource(source)
    expect(patched.indexOf('case"turnEnded":')).toBeLessThan(patched.indexOf('case"thinkingDelta":'))
    expect(patched).toContain('await this.sendSessionUpdate({sessionUpdate:"usage_update"')
    expect(patched).not.toContain('yield ')
    expect(patchAcpPresenterSource(patched)).toBe(patched)
  })

  it('forwards turnEnded token counts when the old generator chunk loads', () => {
    const r = loadPatchedChunk(
      '6589.index.js',
      `exports.gen=function*(e){switch(e.message.case){${ACP_TURN_USAGE_ANCHOR}}}`,
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
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual([TURN_USAGE])
  })

  it('forwards turnEnded token counts when the current async chunk loads', () => {
    const r = loadPatchedChunk(
      '8210.index.js',
      `exports.present=async function(e){switch(e.message.case){${ACP_TURN_USAGE_ASYNC_ANCHOR}}}`,
      `const m = require('./8210.index.js')
const updates = []
;(async () => {
  await m.present.call({
    sendSessionUpdate(update) { updates.push(update); return Promise.resolve() }
  }, { message: { case: 'turnEnded', value: { inputTokens: 100n, outputTokens: 7n, cacheReadTokens: 30n, cacheWriteTokens: 10n } } })
  process.stdout.write(JSON.stringify(updates))
})().catch((err) => { console.error(err); process.exit(1) })
`
    )
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual([TURN_USAGE])
  })
})
