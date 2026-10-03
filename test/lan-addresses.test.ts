import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lanAddresses } from '../src/main/remote'

afterEach(() => vi.restoreAllMocks())

describe('LAN discovery on Linux', () => {
  it('degrades to no advertised LAN address when interface enumeration is restricted', () => {
    vi.spyOn(os, 'networkInterfaces').mockImplementation(() => {
      throw Object.assign(new Error('uv_interface_addresses: operation not permitted'), { code: 'EPERM' })
    })
    expect(lanAddresses()).toEqual([])
  })

  it('keeps physical private IPv4 interfaces ahead of virtual ones', () => {
    const nic = (address: string, family = 'IPv4', internal = false) => ({
      address, family, internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null
    }) as os.NetworkInterfaceInfo
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      lo: [nic('127.0.0.1', 'IPv4', true)],
      docker0: [nic('172.17.0.1')],
      eth0: [nic('192.168.1.50'), nic('fe80::1', 'IPv6'), nic('169.254.1.1')]
    })
    expect(lanAddresses()).toEqual(['192.168.1.50', '172.17.0.1'])
  })
})
