import { describe, expect, it } from 'vitest'
import { remoteUrl } from '../src/renderer/src/lib/web-api'

describe('remote page URLs', () => {
  it('keeps API calls on the LAN origin root', () => {
    expect(remoteUrl('http://192.168.1.8:8765/?token=abc', 'api/rpc/state:get')).toBe(
      'http://192.168.1.8:8765/api/rpc/state:get'
    )
  })

  it('keeps API calls under the public computer prefix', () => {
    const page = 'http://43.167.166.239:8765/c/aaaaaaaaaaaaaaaa/?token=abc#thread=1'
    expect(remoteUrl(page, 'api/events?token=abc')).toBe(
      'http://43.167.166.239:8765/c/aaaaaaaaaaaaaaaa/api/events?token=abc'
    )
  })
})
