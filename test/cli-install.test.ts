import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Header } from 'tar'
import { CliInstaller, unpackCliArchive } from '../src/main/cli-install'
import { CLAUDE_SDK_VERSION, CODEX_VERSION, cliArtifact, type CliArtifact } from '../src/main/cli-install-source'
import { configureManagedCliDirectory, managedExecutable } from '../src/main/managed-cli-location'
import { resolveCli } from '../src/main/cli'

let directory: string
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-cli-install-test-'))
  configureManagedCliDirectory(directory)
})
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

function packageBytes(name: string, content = 'test-cli') {
  const data = Buffer.from(content)
  const header = new Header({ path: name, mode: 0o755, size: data.length, type: 'File' })
  const block = Buffer.alloc(512)
  header.encode(block)
  return gzipSync(Buffer.concat([block, data, Buffer.alloc(512 - data.length + 1024)]))
}

function artifact(version: string, archive: Buffer): CliArtifact {
  return {
    version, url: 'https://registry.npmjs.org/fixture', command: 'agent.exe', format: 'tar.gz',
    integrity: { algorithm: 'sha256', encoding: 'hex', digest: createHash('sha256').update(archive).digest('hex') }
  }
}

describe('managed CLI installation', () => {
  it('shares a download, verifies the staged binary and activates only after the probe', async () => {
    const bytes = packageBytes('agent.exe')
    const fetch = vi.fn(async () => new Response(new Uint8Array(bytes)))
    const probe = vi.fn(async (_provider, executable: string) => {
      expect(fs.readFileSync(executable, 'utf8')).toBe('test-cli')
      expect(managedExecutable('cursor')).toBeUndefined()
    })
    const installer = new CliInstaller(fetch, probe, async () => artifact('1.0', bytes))
    const install = installer.install('cursor')
    expect(installer.install('cursor')).toBe(install)
    await install
    expect(fetch).toHaveBeenCalledOnce()
    expect(probe).toHaveBeenCalledOnce()
    expect(installer.status('cursor')).toEqual({})
    const installed = managedExecutable('cursor')
    expect(installed?.version).toBe('1.0')
    expect(resolveCli(path.join(directory, 'missing.exe'))).toBeUndefined()
    expect(resolveCli(installed!.command)).toMatchObject({ command: installed!.command })
  })

  it('keeps the live version after integrity or probe failure and permits a retry', async () => {
    const bytes = packageBytes('agent.exe')
    const fetch = vi.fn(async () => new Response(new Uint8Array(bytes)))
    const probe = vi.fn(async () => undefined)
    const release = vi.fn(async () => artifact('1.0', bytes))
    const installer = new CliInstaller(fetch, probe, release)
    await installer.install('codex')
    const old = managedExecutable('codex')
    release.mockResolvedValueOnce(artifact('2.0', Buffer.from('incorrect checksum')))
    await expect(installer.install('codex')).rejects.toThrow()
    expect(probe).toHaveBeenCalledOnce()
    expect(managedExecutable('codex')).toEqual(old)
    release.mockResolvedValue(artifact('2.0', bytes))
    probe.mockRejectedValueOnce(new Error('probe failed'))
    await expect(installer.install('codex')).rejects.toThrow('probe failed')
    expect(managedExecutable('codex')).toEqual(old)
    await installer.install('codex')
    expect(managedExecutable('codex')?.version).toBe('2.0')
    expect(fs.existsSync(old!.command)).toBe(true)
  })

  it('rejects traversal in a release archive', async () => {
    const archive = path.join(directory, 'bad.tgz')
    const destination = path.join(directory, 'payload')
    fs.mkdirSync(destination)
    fs.writeFileSync(archive, packageBytes('../escaped'))
    await expect(unpackCliArchive(archive, destination, 'tar.gz')).rejects.toThrow()
    expect(fs.existsSync(path.join(directory, 'escaped'))).toBe(false)
  })
})

it('pins native npm releases to the exact versions paired with the packaged adapters', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8'))
  expect(CODEX_VERSION).toBe(lock.packages['node_modules/@openai/codex'].version)
  expect(CLAUDE_SDK_VERSION).toBe(lock.packages['node_modules/@anthropic-ai/claude-agent-sdk'].version)
})

it('accepts only the published Antigravity download host and launch layout', async () => {
  const release = {
    id: 'antigravity-acp', version: '1.5.0', distribution: { binary: {
      'linux-x86_64': {
        archive: 'https://dl.google.com/agy-extensions/releases/linux/agy.zip',
        cmd: './agy_acp_server.par', sha256: 'a'.repeat(64), args: ['--uid=']
      }
    } }
  }
  expect(await cliArtifact('antigravity', async () => release, 'linux', 'x64')).toMatchObject({
    command: 'agy_acp_server.par', prefixArgs: ['--uid=']
  })
  release.distribution.binary['linux-x86_64'].archive = 'https://other.example/agy.zip'
  await expect(cliArtifact('antigravity', async () => release, 'linux', 'x64')).rejects.toThrow()
})
