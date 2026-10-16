import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_THREAD_TOOLBAR_BUTTONS, expandToolbarCommand, normalizeToolbarButtons } from '../src/shared/toolbar'
import type { ToolbarButton } from '../src/shared/types'
import { Store } from '../src/main/store'
import { settingsHandlers } from '../src/main/ipc/settings'
import type { IpcDeps } from '../src/main/ipc/deps'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => electron.userData } }))

const command: Extract<ToolbarButton, { kind: 'command' }> = {
  id: 'custom-command', kind: 'command', visible: true, name: '开发终端',
  program: '{projectPath}/tools/run', args: ['{cwd}', '--root={projectPath}', '  literal "text" &|<>^%!()  ']
}

describe('toolbar configuration', () => {
  it('adds VS Code immediately before Cursor when old settings omit the toolbar', () => {
    const buttons = normalizeToolbarButtons(undefined)
    expect(buttons.map((button) => button.id)).toEqual(['fork', 'files', 'vscode', 'cursor', 'changes'])
    expect(buttons.every((button) => button.visible)).toBe(true)
    buttons[0].visible = false
    expect(DEFAULT_THREAD_TOOLBAR_BUTTONS[0].visible).toBe(true)
  })

  it('preserves custom order, hidden actions and literal parameters while repairing malformed entries', () => {
    const buttons = normalizeToolbarButtons([
      { ...command, name: '  开发终端  ' },
      { id: 'legacy-cursor', kind: 'builtin', action: 'cursor', visible: false },
      { id: 'duplicate', kind: 'builtin', action: 'cursor', visible: true },
      { ...command, name: 'Duplicate' },
      { ...command, id: 'cursor' },
      { ...command, id: 'invalid', program: 'node\nmalformed' },
      { ...command, id: 'invalid-arg', args: ['arg\0value'] },
      { kind: 'builtin', action: 'unknown' }
    ])
    expect(buttons[0]).toEqual(command)
    expect(buttons[1]).toEqual({ id: 'cursor', kind: 'builtin', action: 'cursor', visible: false })
    expect(buttons.map((button) => button.id)).toEqual(['custom-command', 'cursor', 'fork', 'files', 'vscode', 'changes'])
    expect(normalizeToolbarButtons(buttons)).toEqual(buttons)
  })

  it('can hide all builtins without restoring their visibility', () => {
    const hidden = DEFAULT_THREAD_TOOLBAR_BUTTONS.map((button) => ({ ...button, visible: false }))
    expect(normalizeToolbarButtons(hidden)).toEqual(hidden)
  })

  it('expands supported path tokens only once and leaves shell characters literal', () => {
    expect(expandToolbarCommand(command, 'D:/工作/{projectPath}', 'D:/repo with spaces')).toEqual({
      program: 'D:/repo with spaces/tools/run',
      args: ['D:/工作/{projectPath}', '--root=D:/repo with spaces', '  literal "text" &|<>^%!()  ']
    })
  })
})

describe('persisted toolbar settings', () => {
  let store: Store
  beforeEach(() => {
    electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-toolbar-'))
    store = new Store()
  })
  afterEach(() => {
    store.flush()
    const dir = path.resolve(electron.userData)
    if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('agent-desktop-toolbar-')) throw new Error('Unexpected fixture directory')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('migrates legacy state and writes the default toolbar back to disk', () => {
    store.flush()
    const file = path.join(store.dataDir, 'state.json')
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    delete state.settings.threadToolbarButtons
    fs.writeFileSync(file, JSON.stringify(state))
    store = new Store()
    expect(store.settings.threadToolbarButtons).toEqual(DEFAULT_THREAD_TOOLBAR_BUTTONS)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).settings.threadToolbarButtons).toEqual(DEFAULT_THREAD_TOOLBAR_BUTTONS)
  })

  it('saves toolbar changes without dropping sessions and preserves them through restart', async () => {
    const deps = { store, broadcast: vi.fn(), sessions: { dropIdle: vi.fn() } }
    const configured = [command, ...DEFAULT_THREAD_TOOLBAR_BUTTONS.map((button) => ({ ...button, visible: false }))]
    await settingsHandlers(deps as unknown as IpcDeps)['settings:update']({ threadToolbarButtons: configured })
    expect(deps.broadcast).toHaveBeenCalledOnce()
    expect(deps.sessions.dropIdle).not.toHaveBeenCalled()
    store.flush()
    store = new Store()
    expect(store.settings.threadToolbarButtons).toEqual(configured)
    await settingsHandlers(deps as unknown as IpcDeps)['settings:update']({ showArchived: true })
    expect(store.settings.threadToolbarButtons).toEqual(configured)
  })
})
