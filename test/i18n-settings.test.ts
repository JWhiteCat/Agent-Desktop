import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocale, setLanguage } from '../src/shared/i18n'
import { Store } from '../src/main/store'
import { settingsHandlers } from '../src/main/ipc/settings'
import type { IpcDeps } from '../src/main/ipc/deps'
import type { Settings } from '../src/shared/types'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => electron.userData } }))

describe('saved application language', () => {
  let store: Store

  beforeEach(() => {
    electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-i18n-settings-'))
    setLanguage('system', 'zh-CN')
    store = new Store()
  })

  afterEach(() => {
    store.flush()
    const dir = path.resolve(electron.userData)
    if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('agent-desktop-i18n-settings-')) {
      throw new Error(`Unexpected test directory: ${dir}`)
    }
    fs.rmSync(dir, { recursive: true, force: true })
    setLanguage('system', 'zh-CN')
  })

  it.each(['en', 'zh-CN', 'system'] as const)('persists %s through the settings handler and a reload', async (language) => {
    const broadcast = vi.fn()
    const dropIdle = vi.fn()
    const applyRemote = vi.fn()
    const deps = { store, broadcast, sessions: { dropIdle }, applyRemote } as unknown as IpcDeps
    const result = await settingsHandlers(deps)['settings:update']({ language })
    expect(result.language).toBe(language)
    expect(getLocale()).toBe(language === 'en' ? 'en' : 'zh-CN')
    expect(broadcast).toHaveBeenCalledOnce()
    expect(dropIdle).not.toHaveBeenCalled()
    expect(applyRemote).not.toHaveBeenCalled()
    store.flush()
    store = new Store()
    expect(store.settings.language).toBe(language)
  })

  it.each([undefined, 'unsupported'])('opens old or invalid preferences (%s) using System', (language) => {
    store.flush()
    const file = path.join(electron.userData, 'data', 'state.json')
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    state.settings.language = language
    fs.writeFileSync(file, JSON.stringify(state))
    store = new Store()
    expect(store.settings.language).toBe('system')
  })

  it('normalizes an invalid incoming language without replacing other settings', async () => {
    const deps = { store, broadcast: vi.fn() } as unknown as IpcDeps
    await settingsHandlers(deps)['settings:update']({ language: 'invalid' as Settings['language'] })
    expect(store.settings.language).toBe('system')
    expect(store.settings.cliProvider).toBe('cursor')
  })
})
