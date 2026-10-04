import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/main/store'
import { settingsHandlers } from '../src/main/ipc/settings'
import type { IpcDeps } from '../src/main/ipc/deps'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => electron.userData } }))

describe('saved public SSH port', () => {
  let store: Store

  beforeEach(() => {
    electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-remote-settings-'))
    store = new Store()
  })

  afterEach(() => {
    store.flush()
    const dir = path.resolve(electron.userData)
    if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('agent-desktop-remote-settings-')) {
      throw new Error(`Unexpected test directory: ${dir}`)
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('saves a custom SSH port, restarts remote access, and keeps it after reload', async () => {
    const applyRemote = vi.fn().mockResolvedValue(undefined)
    const deps = { store, applyRemote, broadcast: vi.fn() } as unknown as IpcDeps
    const result = await settingsHandlers(deps)['settings:update']({ remotePublicSshPort: 2222 })
    expect(result).toMatchObject({ remotePublicSshPort: 2222, remotePublicPort: 8765 })
    expect(applyRemote).toHaveBeenCalledOnce()
    store.flush()
    store = new Store()
    expect(store.settings.remotePublicSshPort).toBe(2222)
  })

  it.each([undefined, null, '2222', 0, 65536, 22.5])('migrates a missing or invalid SSH port (%s) to 22', (sshPort) => {
    store.flush()
    const file = path.join(electron.userData, 'data', 'state.json')
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    state.settings.remotePublicSshPort = sshPort
    fs.writeFileSync(file, JSON.stringify(state))
    store = new Store()
    expect(store.settings.remotePublicSshPort).toBe(22)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).settings.remotePublicSshPort).toBe(22)
  })

  it.each([0, -1, 65536, 22.5, NaN, Infinity])('rejects invalid SSH port %s before changing stored settings', async (sshPort) => {
    const applyRemote = vi.fn()
    const broadcast = vi.fn()
    const deps = { store, applyRemote, broadcast } as unknown as IpcDeps
    await expect(settingsHandlers(deps)['settings:update']({ remotePublicSshPort: sshPort })).rejects.toThrow(/SSH/)
    expect(store.settings.remotePublicSshPort).toBe(22)
    expect(applyRemote).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
  })
})
