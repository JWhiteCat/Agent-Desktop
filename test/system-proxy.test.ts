import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnCodexAcp } from '../src/main/codex'
import { procFingerprint } from '../src/main/session/provider'
import { codexProxyOverlay, isCodexRoutingTimeout, proxyEnvFrom, refreshCodexProxyEnv } from '../src/main/system-proxy'

const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']

describe('proxyEnvFrom', () => {
  it('maps an HTTP proxy and bypasses localhost', () => {
    expect(proxyEnvFrom('PROXY 127.0.0.1:7890', {})).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost,127.0.0.1,::1'
    })
  })

  it('keeps an existing HTTPS proxy', () => {
    expect(proxyEnvFrom('PROXY 127.0.0.1:7890', { HTTPS_PROXY: 'http://existing:1' })).toEqual({})
    expect(proxyEnvFrom('PROXY 127.0.0.1:7890', { http_proxy: 'http://existing:1' })).toEqual({})
  })

  it('ignores a direct connection', () => {
    expect(proxyEnvFrom('DIRECT', {})).toEqual({})
    expect(proxyEnvFrom('  ', {})).toEqual({})
  })

  it('maps SOCKS5 to ALL_PROXY', () => {
    expect(proxyEnvFrom('SOCKS5 127.0.0.1:7891', {})).toEqual({
      ALL_PROXY: 'socks5://127.0.0.1:7891',
      NO_PROXY: 'localhost,127.0.0.1,::1'
    })
  })

  it('uses the first usable rule in a semicolon list', () => {
    expect(proxyEnvFrom('DIRECT; PROXY 127.0.0.1:7890', { NO_PROXY: 'example.com' })).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890'
    })
  })

  it('recognizes the Codex routing timeout', () => {
    expect(isCodexRoutingTimeout('account/read failed: workspace routing discovery timed out')).toBe(true)
    expect(isCodexRoutingTimeout('other failure')).toBe(false)
  })
})

describe('Codex launch environment', () => {
  const children: ChildProcess[] = []

  afterEach(async () => {
    for (const child of children) child.kill()
    children.length = 0
    await refreshCodexProxyEnv(async () => 'DIRECT')
    vi.unstubAllEnvs()
  })

  it('puts the refreshed proxy into the Codex process environment', async () => {
    for (const key of PROXY_KEYS) vi.stubEnv(key, '')
    await refreshCodexProxyEnv(async () => 'PROXY 127.0.0.1:7890')
    expect(codexProxyOverlay().HTTP_PROXY).toBe('http://127.0.0.1:7890')

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-proxy-'))
    const script = path.join(root, 'print-env.cjs')
    fs.writeFileSync(script, `console.log(JSON.stringify({
      HTTP_PROXY: process.env.HTTP_PROXY ?? null,
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
      NO_PROXY: process.env.NO_PROXY ?? null
    }))\n`)
    const child = spawnCodexAcp({ acpEntry: script, bundled: true, display: 'bundled' }, root, '')
    children.push(child)
    let text = ''
    child.stdout?.on('data', (chunk) => { text += chunk.toString() })
    const [code] = await once(child, 'close')
    expect(code, text).toBe(0)
    expect(JSON.parse(text)).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost,127.0.0.1,::1'
    })
  })

  it('changes the process fingerprint when the proxy appears', () => {
    const cli = { command: 'codex', prefixArgs: [] as string[], display: 'codex' }
    const without = procFingerprint(cli, 'codex', 'D:\\repo', 'default', false, '', [], [], {})
    const withProxy = procFingerprint(cli, 'codex', 'D:\\repo', 'default', false, '', [], [], {
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890'
    })
    expect(withProxy).not.toBe(without)
  })

  it('clears the overlay when resolution fails', async () => {
    for (const key of PROXY_KEYS) vi.stubEnv(key, '')
    await refreshCodexProxyEnv(async () => 'PROXY 127.0.0.1:7890')
    await refreshCodexProxyEnv(async () => { throw new Error('no session') })
    expect(codexProxyOverlay()).toEqual({})
  })
})
