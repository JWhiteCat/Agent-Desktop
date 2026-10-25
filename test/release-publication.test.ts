import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const workflow = fs.readFileSync(path.resolve('.github/workflows/release.yml'), 'utf8').replace(/\r\n/g, '\n')

function publicationShell(): string {
  const step = workflow.indexOf('      - name: Publish GitHub Release\n')
  if (step < 0) throw new Error('Missing publication step')
  const run = workflow.indexOf('        run: |\n', step)
  if (run < 0) throw new Error('Missing publication shell')
  const lines: string[] = []
  for (const line of workflow.slice(run + '        run: |\n'.length).split('\n')) {
    if (line && !line.startsWith('          ')) break
    lines.push(line.slice(10))
  }
  return lines.join('\n')
}

interface FixtureOptions {
  existing?: 'missing' | 'draft' | 'published'
  api?: 'ok' | 'failure' | 'malformed'
  publishedVersion?: string
}

function runPublication(options: FixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-publication-'))
  roots.push(root)
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.mkdirSync(path.join(root, 'artifacts'))
  for (const script of ['changelog.mjs', 'release-artifacts.mjs', 'release-latest.mjs']) {
    fs.copyFileSync(path.resolve('scripts', script), path.join(root, 'scripts', script))
  }
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## [1.2.0] - 2026-10-25\n\n- Fixture release.\n')
  for (const suffix of ['win-x64-portable.exe', 'win-x64-setup.exe', 'linux-x86_64.AppImage', 'linux-amd64.deb', 'mac-arm64.dmg', 'mac-x64.dmg']) {
    fs.writeFileSync(path.join(root, 'artifacts', `agent-desktop-1.2.0-${suffix}`), 'fixture, not executable')
  }
  // A closed PATH contains only Node and our fake gh. No real gh or network
  // command can be reached, and no user authentication environment is inherited.
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'api') {
  if (process.env.FIXTURE_API === 'failure') { console.error('fixture API unavailable'); process.exit(1); }
  if (process.env.FIXTURE_API === 'malformed') { console.log('not-json'); process.exit(0); }
  console.log(JSON.stringify([[{tag_name: 'v' + process.env.FIXTURE_VERSION, draft: false, prerelease: false}]]));
} else if (args[0] === 'release' && args[1] === 'view') {
  if (process.env.FIXTURE_EXISTING === 'missing') process.exit(1);
  if (args.includes('--json')) console.log(process.env.FIXTURE_EXISTING === 'draft' ? 'true' : 'false');
} else if (args[0] !== 'release' || !['edit', 'create', 'upload'].includes(args[1])) {
  console.error('Unexpected fake gh invocation'); process.exit(90);
}
`, { mode: 0o755 })
  const log = path.join(root, 'gh-commands.jsonl')
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', publicationShell()], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      PATH: bin,
      HOME: root,
      VERSION: '1.2.0',
      GITHUB_REPOSITORY: 'fixture/never-contact-network',
      GH_TOKEN: 'fixture-not-a-token',
      FIXTURE_LOG: log,
      FIXTURE_EXISTING: options.existing ?? 'missing',
      FIXTURE_API: options.api ?? 'ok',
      FIXTURE_VERSION: options.publishedVersion ?? '1.1.0'
    }
  })
  const commands: string[][] = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []
  return { result, commands }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

// The publish job runs on Ubuntu; macOS's system Bash lacks mapfile.
describe.skipIf(process.platform !== 'linux')('actual publication shell with an isolated fake gh', () => {
  it.each([
    { publishedVersion: '2.0.0', expected: '--latest=false' },
    { publishedVersion: '1.1.0', expected: '--latest=true' }
  ])('publishes against $publishedVersion using $expected', ({ publishedVersion, expected }) => {
    const { result, commands } = runPublication({ publishedVersion })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const final = commands.find((args) => args.includes('--draft=false'))
    expect(final).toEqual(['release', 'edit', 'v1.2.0', '--draft=false', '--prerelease=false', expected])
    expect(commands.find((args) => args[1] === 'create')).toContain('--draft')
    const upload = commands.findIndex((args) => args[1] === 'upload')
    const api = commands.findIndex((args) => args[0] === 'api')
    expect(upload).toBeGreaterThan(-1)
    expect(commands[upload].filter((arg) => arg.startsWith('artifacts/'))).toHaveLength(7)
    expect(api).toBeGreaterThan(upload)
    expect(commands[api]).toContain('--paginate')
    expect(commands[api]).toContain('--slurp')
    expect(commands.indexOf(final!)).toBeGreaterThan(api)
  })

  it.each(['failure', 'malformed'] as const)('does not publish a draft after API %s', (api) => {
    const { result, commands } = runPublication({ api })
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(commands.some((args) => args[0] === 'api')).toBe(true)
    expect(commands.some((args) => args.includes('--draft=false'))).toBe(false)
  })

  it('resumes a draft without creating a second release', () => {
    const { result, commands } = runPublication({ existing: 'draft' })
    expect(result.status, result.stderr).toBe(0)
    expect(commands.some((args) => args[1] === 'create')).toBe(false)
    expect(commands.some((args) => args[1] === 'upload')).toBe(true)
    expect(commands.some((args) => args.includes('--draft=false'))).toBe(true)
  })

  it('refuses an already public release before asset upload or metadata changes', () => {
    const { result, commands } = runPublication({ existing: 'published' })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('already published')
    expect(commands.every((args) => args[0] === 'release' && args[1] === 'view')).toBe(true)
  })
})
