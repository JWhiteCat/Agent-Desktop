import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const script = fs.readFileSync(path.resolve('scripts/start-linux.sh'), 'utf8')
const fixtures: string[] = []
type Invocation = { args: string[]; cwd: string; nodeEnv?: string; electronNode?: string }

function fixture({ dependencies = true, runtime = true } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-linux-launcher-'))
  fixtures.push(temp)
  const project = path.join(temp, 'project with spaces')
  const bin = path.join(temp, 'mock bin')
  const electron = path.join(project, 'node_modules/electron')
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true })
  fs.mkdirSync(electron, { recursive: true })
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(project, 'scripts/start-linux.sh'), script)
  fs.writeFileSync(path.join(electron, 'package.json'), '{"name":"electron"}')
  fs.writeFileSync(path.join(electron, 'install.js'), `
    const fs = require('node:fs');
    if (process.env.TEST_INSTALL_FAIL) process.exit(17);
    fs.mkdirSync(__dirname + '/dist', { recursive: true });
    fs.writeFileSync(__dirname + '/dist/electron', '', { mode: 0o755 });
    fs.writeFileSync(__dirname + '/path.txt', 'electron');
    fs.writeFileSync('runtime-installed', 'yes');
  `)
  if (dependencies) fs.writeFileSync(path.join(project, 'deps-ready'), '')
  if (runtime) {
    fs.mkdirSync(path.join(electron, 'dist'))
    fs.writeFileSync(path.join(electron, 'path.txt'), 'electron')
    fs.writeFileSync(path.join(electron, 'dist/electron'), '', { mode: 0o755 })
  }
  fs.writeFileSync(path.join(bin, 'node'), `#!/usr/bin/env bash
if [[ "\${1:-}" == --version ]]; then
  printf '%s\\n' "\${TEST_NODE_VERSION:-v24.0.0}"
else
  exec ${JSON.stringify(process.execPath)} "$@"
fi
`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify({ args, cwd: process.cwd(), nodeEnv: process.env.NODE_ENV, electronNode: process.env.ELECTRON_RUN_AS_NODE }) + '\\n');
if (args[0] === 'ls') process.exit(fs.existsSync('deps-ready') ? 0 : 1);
if (args[0] === 'ci') {
  if (process.env.TEST_CI_FAIL) process.exit(18);
  fs.writeFileSync('deps-ready', 'yes');
}
if (args[0] === 'run' && args[1] === process.env.TEST_RUN_FAIL) process.exit(19);
`, { mode: 0o755 })
  return {
    project,
    run(args: string[] = [], env: Record<string, string> = {}) {
      return spawnSync('bash', [path.join(project, 'scripts/start-linux.sh'), ...args], {
        cwd: temp,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, DISPLAY: ':test', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: '1', ...env }
      })
    },
    calls(): Invocation[] {
      const file = path.join(project, 'calls.jsonl')
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
    }
  }
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'linux' || process.getuid?.() === 0)('Linux startup script', () => {
  it('reuses dependencies and Electron offline, from another cwd and a path with spaces', () => {
    const app = fixture()
    expect(app.run().status).toBe(0)
    expect(app.run().status).toBe(0)
    expect(app.calls().map(call => call.args[0])).toEqual(['ls', 'run', 'ls', 'run'])
    for (const call of app.calls()) expect(call.cwd).toBe(app.project)
    expect(app.calls()[1]).toMatchObject({ args: ['run', 'dev'], nodeEnv: 'development' })
    expect(app.calls()[1].electronNode).toBeUndefined()
    expect(fs.existsSync(path.join(app.project, 'runtime-installed'))).toBe(false)
  })

  it('bootstraps missing dependencies and runtime, then reuses them', () => {
    const app = fixture({ dependencies: false, runtime: false })
    expect(app.run().status).toBe(0)
    expect(app.run().status).toBe(0)
    expect(app.calls().map(call => call.args[0])).toEqual(['ls', 'ci', 'run', 'ls', 'run'])
    expect(app.calls()[1].args).toEqual(['ci', '--include=dev', '--include=optional', '--no-audit', '--no-fund'])
    expect(fs.existsSync(path.join(app.project, 'runtime-installed'))).toBe(true)
  })

  it('can explicitly refresh the lockfile dependencies', () => {
    const app = fixture()
    expect(app.run(['dev', '--install']).status).toBe(0)
    expect(app.calls().map(call => call.args[0])).toEqual(['ci', 'run'])
  })

  it('builds before production preview and clears Electron Node mode', () => {
    const app = fixture()
    expect(app.run(['preview']).status).toBe(0)
    expect(app.calls().map(call => call.args.slice(0, 2))).toEqual([['ls', '--depth=0'], ['run', 'build'], ['run', 'preview']])
    for (const call of app.calls().slice(1)) {
      expect(call.nodeEnv).toBe('production')
      expect(call.electronNode).toBeUndefined()
    }
  })

  it('works in a Wayland session without DISPLAY', () => {
    expect(fixture().run([], { DISPLAY: '', WAYLAND_DISPLAY: 'wayland-0' }).status).toBe(0)
  })

  it.each(['v20.19.0', 'v22.11.0', 'v23.0.0', 'v25.0.0', 'v26.0.0-rc.1'])(
    'rejects unsupported Node %s before dependency installation', version => {
      const app = fixture()
      expect(app.run([], { TEST_NODE_VERSION: version }).status).toBe(1)
      expect(app.calls()).toEqual([])
    }
  )

  it.each(['v22.12.0', 'v24.0.0', 'v26.0.0'])('accepts supported Node %s', version => {
    expect(fixture().run([], { TEST_NODE_VERSION: version }).status).toBe(0)
  })

  it('reports a missing desktop without installing dependencies', () => {
    const app = fixture()
    const result = app.run([], { DISPLAY: '', WAYLAND_DISPLAY: '' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('No graphical session')
    expect(app.calls()).toEqual([])
  })

  it('stops on dependency or runtime installation failures', () => {
    const deps = fixture({ dependencies: false })
    expect(deps.run([], { TEST_CI_FAIL: '1' }).stderr).toContain('Dependency installation failed')
    expect(deps.calls().some(call => call.args[0] === 'run')).toBe(false)
    const runtime = fixture({ runtime: false })
    expect(runtime.run([], { TEST_INSTALL_FAIL: '1' }).stderr).toContain('Electron download failed')
    expect(runtime.calls().some(call => call.args[0] === 'run')).toBe(false)
  })

  it('propagates failures without starting a stale production preview', () => {
    const app = fixture()
    expect(app.run(['preview'], { TEST_RUN_FAIL: 'build' }).status).toBe(19)
    expect(app.calls().some(call => call.args[1] === 'preview')).toBe(false)
    expect(fixture().run(['dev'], { TEST_RUN_FAIL: 'dev' }).status).toBe(19)
  })

  it('shows help or rejects unknown arguments without side effects', () => {
    const app = fixture()
    expect(app.run(['--help'], { DISPLAY: '' }).status).toBe(0)
    expect(app.run(['--unknown']).status).toBe(1)
    expect(app.calls()).toEqual([])
  })
})
