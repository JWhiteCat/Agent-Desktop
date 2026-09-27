import { describe, expect, it } from 'vitest'
import {
  buildSshArgs,
  explainSshFailure,
  newRemoteClientId,
  publicRemoteUrl,
  publicSocketPath,
  retryDelay,
  validClientId,
  validatePublicHost,
  validatePublicPort,
  validatePublicUser
} from '../src/main/public-tunnel'

describe('public tunnel settings', () => {
  it('accepts a user, host and port', () => {
    expect(validatePublicUser(' root ')).toBe('root')
    expect(validatePublicHost('43.167.166.239')).toBe('43.167.166.239')
    expect(validatePublicHost('example.com')).toBe('example.com')
    expect(validatePublicPort(8765)).toBe(8765)
  })

  it('rejects schemes, paths, port 22 and bad names', () => {
    expect(() => validatePublicUser('-root')).toThrow(/用户名/)
    expect(() => validatePublicUser('')).toThrow(/用户名/)
    expect(() => validatePublicHost('http://43.167.166.239')).toThrow(/协议/)
    expect(() => validatePublicHost('43.167.166.239/app')).toThrow(/协议/)
    expect(() => validatePublicHost('root@host')).toThrow(/协议/)
    expect(() => validatePublicHost('host:8765')).toThrow(/协议/)
    expect(() => validatePublicPort(22)).toThrow(/22/)
    expect(() => validatePublicPort(0)).toThrow(/22/)
    expect(() => validatePublicPort(70000)).toThrow(/22/)
  })

  it('builds the reverse-forward command and the public link', () => {
    const clientId = 'aaaaaaaaaaaaaaaa'
    expect(validClientId(clientId)).toBe(true)
    expect(validClientId('short')).toBe(false)
    expect(newRemoteClientId()).toMatch(/^[a-f0-9]{16}$/)
    expect(publicSocketPath(clientId)).toBe('/run/agent-desktop/aaaaaaaaaaaaaaaa')
    expect(
      buildSshArgs({ user: 'root', host: '43.167.166.239', port: 8765, localPort: 8765, clientId })
    ).toEqual([
      '-N',
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-R',
      '/run/agent-desktop/aaaaaaaaaaaaaaaa:127.0.0.1:8765',
      'root@43.167.166.239'
    ])
    expect(publicRemoteUrl('example.com', 9000, clientId, 'a b')).toBe(
      'http://example.com:9000/c/aaaaaaaaaaaaaaaa/?token=a%20b'
    )
    expect(retryDelay(0)).toBe(1000)
    expect(retryDelay(3)).toBe(10000)
    expect(retryDelay(9)).toBe(10000)
  })

  it('turns ssh failures into short messages', () => {
    expect(explainSshFailure('root@host: Permission denied (publickey).')).toMatch(/公钥/)
    expect(explainSshFailure('Error: remote port forwarding failed for listen port 8765')).toMatch(/Unix 套接字/)
    expect(explainSshFailure('connect to address: Connection timed out')).toMatch(/无法连接/)
    expect(explainSshFailure('')).toBe('隧道已断开')
  })
})
