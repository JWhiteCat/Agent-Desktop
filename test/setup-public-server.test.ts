import { describe, expect, it } from 'vitest'
import {
  assertPublicKey,
  classifySshFailure,
  installAuthorizedKeysCommand,
  parseSetupArgs,
  remoteSetupCommand,
  shellSingleQuote
} from '../scripts/setup-public-server.mjs'

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGtestkeyvalueforagentdesktoponly agent-desktop'

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
