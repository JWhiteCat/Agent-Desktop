import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertPublicKey,
  classifySshFailure,
  installAuthorizedKeysCommand,
  parseSetupArgs,
  remoteSetupCommand,
  shellSingleQuote
} from '../scripts/setup-public-server.mjs'

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGtestkeyvalueforagentdesktoponly agent-desktop'
const SETUP_SH_PATH = path.resolve('scripts/setup-public-server.sh')

function findBash(): { cmd: string; env: NodeJS.ProcessEnv } | undefined {
  if (process.platform !== 'win32') {
    const res = spawnSync('bash', ['--version'], { encoding: 'utf8', timeout: 5000 })
    return res.status === 0 ? { cmd: 'bash', env: process.env } : undefined
  }
  const gitRes = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
  if (gitRes.status === 0) {
    const candidate = path.resolve(gitRes.stdout.trim(), '../../../usr/bin/bash.exe')
    if (fs.existsSync(candidate)) {
      const binDir = path.dirname(candidate)
      return {
        cmd: candidate,
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}` }
      }
    }
  }
  return undefined
}

function extractShellFunction(script: string, name: string): string {
  const start = script.indexOf(`${name}() {`)
  if (start < 0) throw new Error(`Function ${name} not found in setup-public-server.sh`)
  const end = script.indexOf('\n}\n', start)
  if (end < 0) throw new Error(`End of function ${name} not found`)
  return script.slice(start, end + 2)
}

describe('public server setup args', () => {
  it('defaults to the built-in server', () => {
    expect(parseSetupArgs(['node', 'setup-public-server.mjs'])).toEqual({
      help: false,
      user: 'root',
      host: '43.167.166.239',
      port: 8765,
      sshPort: 22,
      identity: undefined
    })
  })

  it('accepts a custom server', () => {
    expect(
      parseSetupArgs([
        'node',
        'setup-public-server.mjs',
        '--user',
        'ubuntu',
        '--host',
        'example.com',
        '--port',
        '9000',
        '--ssh-port',
        '2200',
        '--identity',
        'C:\\keys\\cloud.pem'
      ])
    ).toMatchObject({
      user: 'ubuntu',
      host: 'example.com',
      port: 9000,
      sshPort: 2200,
      identity: 'C:\\keys\\cloud.pem'
    })
  })

  it('rejects schemes, port 22, matching ports and unknown flags', () => {
    expect(() => parseSetupArgs(['node', 's', '--host', 'http://example.com'])).toThrow(/协议/)
    expect(() => parseSetupArgs(['node', 's', '--host', 'example.com:22'])).toThrow(/协议/)
    expect(() => parseSetupArgs(['node', 's', '--user', 'bad user'])).toThrow(/用户名/)
    expect(() => parseSetupArgs(['node', 's', '--port', '22'])).toThrow(/22/)
    expect(() => parseSetupArgs(['node', 's', '--ssh-port', '0'])).toThrow(/SSH 端口/)
    expect(() => parseSetupArgs(['node', 's', '--port', '2200', '--ssh-port', '2200'])).toThrow(/不能相同/)
    expect(() => parseSetupArgs(['node', 's', '--user'])).toThrow(/缺少/)
    expect(() => parseSetupArgs(['node', 's', '--foo'])).toThrow(/未知参数/)
    expect(parseSetupArgs(['node', 's', '--help']).help).toBe(true)
  })

  it('builds a quoted authorized_keys update and a root-or-sudo command', () => {
    expect(shellSingleQuote("a'b")).toBe(`'a'\\''b'`)
    expect(assertPublicKey(`  ${KEY}\n`)).toBe(KEY)
    expect(() => assertPublicKey('not-a-key')).toThrow(/公钥/)
    const command = installAuthorizedKeysCommand([KEY])
    expect(command).toContain(`grep -qxF '${KEY}'`)
    expect(command).toContain(`printf '%s\\n' '${KEY}'`)
    expect(command).toContain('chmod 600 ~/.ssh/authorized_keys')
    expect(remoteSetupCommand(9000, false)).toContain('sudo bash "$f" 9000')
    expect(remoteSetupCommand(9000, true)).toContain('sudo -n bash "$f" 9000')
    expect(remoteSetupCommand(9000, false)).toContain('rm -f "$f"')
    expect(() => remoteSetupCommand(22, false)).toThrow(/22/)
  })

  it('classifies ssh failures', () => {
    expect(classifySshFailure('root@host: Permission denied (publickey).')).toBe('denied')
    expect(classifySshFailure('ssh: connect to host example.com port 22: Connection timed out')).toBe('network')
    expect(classifySshFailure('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!')).toBe('other')
  })
})

describe('setup-public-server.sh sshd config and reload logic', () => {
  const bash = findBash()
  const scriptText = fs.readFileSync(SETUP_SH_PATH, 'utf8')
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(!bash)('passes bash -n syntax check', () => {
    const res = spawnSync(bash!.cmd, ['-n', SETUP_SH_PATH], { encoding: 'utf8', env: bash!.env, windowsHide: true })
    expect(res.status, res.stderr).toBe(0)
  })

  it.skipIf(!bash)('inserts missing directives before trailing Match blocks without altering Match directives', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-setup-sh-'))
    tmpDirs.push(dir)
    const cfgPath = path.join(dir, 'sshd_config')
    fs.writeFileSync(cfgPath, [
      'Port 22',
      '# Match User comment-should-not-trigger',
      '#AllowTcpForwarding no',
      '',
      'Match User sftp',
      '  ChrootDirectory /sftp',
      '  AllowTcpForwarding no',
      '',
      '  match group restricted',
      '  AllowStreamLocalForwarding no',
      ''
    ].join('\n'))

    const setDirectiveFn = extractShellFunction(scriptText, 'set_directive')
    const harness = [
      'set -euo pipefail',
      'CFG="$1"',
      setDirectiveFn,
      'set_directive AllowTcpForwarding yes',
      'set_directive AllowStreamLocalForwarding yes',
      'set_directive StreamLocalBindUnlink yes'
    ].join('\n')

    const res = spawnSync(bash!.cmd, ['-c', harness, '--', cfgPath.replace(/\\/g, '/')], { encoding: 'utf8', env: bash!.env, windowsHide: true })
    expect(res.status, res.stderr).toBe(0)

    const updated = fs.readFileSync(cfgPath, 'utf8')
    const lines = updated.trimEnd().split('\n')
    const firstMatchIdx = lines.indexOf('Match User sftp')
    expect(firstMatchIdx).toBeGreaterThan(0)

    expect(lines.indexOf('AllowTcpForwarding yes')).toBeGreaterThan(-1)
    expect(lines.indexOf('AllowTcpForwarding yes')).toBeLessThan(firstMatchIdx)
    expect(lines.indexOf('AllowStreamLocalForwarding yes')).toBeGreaterThan(-1)
    expect(lines.indexOf('AllowStreamLocalForwarding yes')).toBeLessThan(firstMatchIdx)
    expect(lines.indexOf('StreamLocalBindUnlink yes')).toBeGreaterThan(-1)
    expect(lines.indexOf('StreamLocalBindUnlink yes')).toBeLessThan(firstMatchIdx)

    // Directives inside Match blocks remain intact.
    expect(lines.slice(firstMatchIdx)).toEqual([
      'Match User sftp',
      '  ChrootDirectory /sftp',
      '  AllowTcpForwarding no',
      '',
      '  match group restricted',
      '  AllowStreamLocalForwarding no'
    ])
  })

  it.skipIf(!bash)('appends missing directives at EOF when sshd_config has no Match block', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-setup-sh-'))
    tmpDirs.push(dir)
    const cfgPath = path.join(dir, 'sshd_config')
    fs.writeFileSync(cfgPath, 'Port 22\n#AllowTcpForwarding no\n')

    const setDirectiveFn = extractShellFunction(scriptText, 'set_directive')
    const harness = [
      'set -euo pipefail',
      'CFG="$1"',
      setDirectiveFn,
      'set_directive AllowTcpForwarding yes',
      'set_directive AllowStreamLocalForwarding yes',
      'set_directive StreamLocalBindUnlink yes'
    ].join('\n')

    const res = spawnSync(bash!.cmd, ['-c', harness, '--', cfgPath.replace(/\\/g, '/')], { encoding: 'utf8', env: bash!.env, windowsHide: true })
    expect(res.status, res.stderr).toBe(0)

    expect(fs.readFileSync(cfgPath, 'utf8').trimEnd().split('\n')).toEqual([
      'Port 22',
      'AllowTcpForwarding yes',
      'AllowStreamLocalForwarding yes',
      'StreamLocalBindUnlink yes'
    ])
  })

  it.skipIf(!bash)('cleans up stray drop-in file when restore runs after fallback failure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-setup-sh-'))
    tmpDirs.push(dir)
    const cfgPath = path.join(dir, 'sshd_config')
    const backupPath = path.join(dir, 'sshd_config.bak')
    const dropinPath = path.join(dir, '00-agentdesktop-remote.conf')
    fs.writeFileSync(cfgPath, 'Port 22\nModified yes\n')
    fs.writeFileSync(backupPath, 'Port 22\n')
    fs.writeFileSync(dropinPath, 'AllowTcpForwarding yes\n')

    const restoreFn = extractShellFunction(scriptText, 'restore')
    const harness = [
      'set -euo pipefail',
      'CFG="$1"',
      'backup="$2"',
      'DROPIN="$3"',
      'dropin_written=1',
      restoreFn,
      'restore'
    ].join('\n')

    const res = spawnSync(
      bash!.cmd,
      ['-c', harness, '--', cfgPath.replace(/\\/g, '/'), backupPath.replace(/\\/g, '/'), dropinPath.replace(/\\/g, '/')],
      { encoding: 'utf8', env: bash!.env, windowsHide: true }
    )
    expect(res.status, res.stderr).toBe(0)
    expect(fs.existsSync(dropinPath)).toBe(false)
    expect(fs.readFileSync(cfgPath, 'utf8')).toBe('Port 22\n')
  })

  it('guards systemctl sshd/ssh reload with [[ -d /run/systemd/system ]] and tracks drop-in cleanup', () => {
    expect(scriptText).toContain('if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]] && systemctl cat sshd >/dev/null 2>&1; then')
    expect(scriptText).toContain('elif command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]] && systemctl cat ssh >/dev/null 2>&1; then')
    expect(scriptText).toContain('DROPIN=/etc/ssh/sshd_config.d/00-agentdesktop-remote.conf')
    expect(scriptText).toContain('rm -f "$DROPIN"')
  })
})
