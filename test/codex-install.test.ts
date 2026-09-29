import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexLogin, codexStatus, codexVersion, resolveCodex } from '../src/main/codex'

function removeFixtureDirectory(root: string): void {
  const resolved = path.resolve(root)
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('agent-desktop-codex-install-')) {
    throw new Error(`Refusing to remove unexpected fixture directory: ${resolved}`)
  }
  fs.rmSync(resolved, { recursive: true, force: true })
}

describe.skipIf(process.platform !== 'win32')('Windows Codex installation discovery', () => {
  let root: string
  let home: string
  let appData: string
  const bundledBin = path.resolve('node_modules', '.bin')
  const systemBin = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const platformPackage = `codex-win32-${process.arch}`

  function write(file: string, content = ''): string {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    return file
  }

  function npmInstall(prefix: string, placement: 'nested' | 'hoisted' | 'legacy' = 'nested', executableDir = 'bin') {
    const packageRoot = path.join(prefix, 'node_modules', '@openai', 'codex')
    const script = write(path.join(packageRoot, 'bin', 'codex.js'), '// Codex CLI fixture\n')
    write(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '1.0.0', type: 'module' }))
    const nativePackage = placement === 'nested'
      ? path.join(packageRoot, 'node_modules', '@openai', platformPackage)
      : placement === 'hoisted'
        ? path.join(prefix, 'node_modules', '@openai', platformPackage)
        : packageRoot
    if (placement !== 'legacy') write(path.join(nativePackage, 'package.json'), JSON.stringify({ name: `@openai/${platformPackage}` }))
    const executable = write(path.join(nativePackage, 'vendor', target, executableDir, 'codex.exe'))
    const shim = write(path.join(prefix, 'codex.cmd'), '@echo off\r\nnode "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n')
    const powershellShim = write(path.join(prefix, 'codex.ps1'), '& node "$PSScriptRoot/node_modules/@openai/codex/bin/codex.js" $args\n')
    return { executable, shim, powershellShim, script }
  }

  function expectInstalled(executable: string, custom = ''): void {
    expect(resolveCodex(custom)).toMatchObject({ codexPath: executable, bundled: false })
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-codex-install-'))
    home = path.join(root, 'home')
    appData = path.join(home, 'AppData', 'Roaming')
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    vi.stubEnv('PATH', systemBin)
    vi.stubEnv('APPDATA', appData)
    vi.stubEnv('LOCALAPPDATA', path.join(home, 'AppData', 'Local'))
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('CODEX_PATH', undefined)
    vi.stubEnv('PNPM_HOME', undefined)
    vi.stubEnv('NPM_CONFIG_PREFIX', undefined)
    vi.stubEnv('npm_config_prefix', undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    removeFixtureDirectory(root)
  })

  it('skips the app bundled PATH shim and finds the external installation after it', () => {
    const prefix = path.join(root, 'external npm')
    const installed = npmInstall(prefix)
    vi.stubEnv('PATH', [bundledBin, prefix, systemBin].join(path.delimiter))
    expectInstalled(installed.executable)
  })

  it('prefers an external PATH installation over the default npm directory', () => {
    const prefix = path.join(root, 'selected-cli')
    const executable = write(path.join(prefix, 'codex.exe'))
    npmInstall(path.join(appData, 'npm'))
    vi.stubEnv('PATH', [prefix, systemBin].join(path.delimiter))
    expectInstalled(executable)
  })

  it('finds a global npm installation even when its directory is absent from PATH', () => {
    const installed = npmInstall(path.join(appData, 'npm'))
    expectInstalled(installed.executable)
  })

  it('finds a standalone CLI under the user local bin directory', () => {
    const executable = write(path.join(home, '.local', 'bin', 'codex.exe'))
    expectInstalled(executable)
  })

  it('resolves quoted npm shim and directory paths with spaces to the hoisted executable', () => {
    const prefix = path.join(root, 'custom npm install')
    const installed = npmInstall(prefix, 'hoisted')
    expectInstalled(installed.executable, `  "${installed.shim}"  `)
    expectInstalled(installed.executable, `"${prefix}"`)
    expectInstalled(installed.executable, installed.powershellShim)
  })

  it('accepts codex.js and resolves an older platform package executable layout', () => {
    const installed = npmInstall(path.join(root, 'older npm'), 'nested', 'codex')
    expectInstalled(installed.executable, installed.script)
  })

  it('supports legacy packages with a vendor directory inside the CLI package', () => {
    const installed = npmInstall(path.join(root, 'legacy npm'), 'legacy', 'codex')
    expectInstalled(installed.executable, installed.shim)
  })

  it('keeps an invalid explicit path unresolved even when an automatic installation exists', () => {
    npmInstall(path.join(appData, 'npm'))
    expect(resolveCodex(path.join(root, 'missing', 'codex.exe'))).toBeUndefined()
  })

  it('preserves a custom wrapper next to an npm installation', () => {
    const prefix = path.join(root, 'custom npm install')
    npmInstall(prefix)
    const wrapper = write(path.join(prefix, 'codex-work.cmd'), '@echo off\r\necho custom wrapper\r\n')
    expectInstalled(wrapper, wrapper)
  })

  it('reports bundled Codex when only the app bundled shim is on PATH', () => {
    vi.stubEnv('PATH', [bundledBin, systemBin].join(path.delimiter))
    expect(resolveCodex('')).toMatchObject({ bundled: true, display: '内置 Codex' })
    expect(resolveCodex('')?.codexPath).toBeUndefined()
  })

  it('runs version, status and login arguments through a custom cmd path containing spaces', async () => {
    const shim = write(path.join(root, 'custom scripts', 'codex.cmd'), '@echo off\r\necho fixture %*\r\n')
    const codex = resolveCodex(shim)
    expect(codex).toMatchObject({ codexPath: shim, bundled: false })
    if (!codex || codex.codexPath !== shim) throw new Error('The fixture script must be selected before launching it')
    expect(await codexVersion(codex)).toBe('fixture --version')
    expect(await codexStatus(codex)).toBe('fixture login status')
    expect(await codexLogin(codex)).toBe('fixture login')
  })
})

describe.skipIf(process.platform === 'win32')('POSIX Codex installation discovery', () => {
  it('skips a non-executable file and finds the executable in the next PATH directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-codex-install-'))
    try {
      const first = path.join(root, 'first', 'codex')
      const second = path.join(root, 'second', 'codex')
      for (const file of [first, second]) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, '#!/bin/sh\nexit 0\n')
      }
      fs.chmodSync(first, 0o644)
      fs.chmodSync(second, 0o755)
      vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'))
      vi.stubEnv('PATH', [path.dirname(first), path.dirname(second)].join(path.delimiter))
      expect(resolveCodex('')).toMatchObject({ codexPath: second, bundled: false })
    } finally {
      vi.restoreAllMocks()
      vi.unstubAllEnvs()
      removeFixtureDirectory(root)
    }
  })
})
