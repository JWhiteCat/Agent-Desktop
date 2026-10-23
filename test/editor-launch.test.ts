import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import spawn from 'cross-spawn'
import { findTerminalExecutable } from '../src/main/toolbar-terminal'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
let openInEditor: typeof import('../src/main/window').openInEditor
async function load(name: NodeJS.Platform) {
  vi.resetModules()
  Object.defineProperty(process, 'platform', { ...platform, value: name })
  return (await import('../src/main/window')).openInEditor
}

vi.mock('electron', () => ({ app: {}, nativeTheme: {} }))
vi.mock('cross-spawn', () => ({ default: vi.fn() }))
vi.mock('../src/main/toolbar-terminal', () => ({ findTerminalExecutable: vi.fn() }))

beforeEach(async () => {
  vi.mocked(findTerminalExecutable).mockReset().mockImplementation((name) => `/bin/${name}`)
  vi.mocked(spawn).mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    queueMicrotask(() => child.emit('spawn'))
    return child as unknown as ReturnType<typeof spawn>
  })
  openInEditor = await load('win32')
})

afterEach(() => Object.defineProperty(process, 'platform', platform))

describe('editor launch', () => {
  it.each([['cursor', undefined], ['code', 'vscode']] as const)('opens %s using a literal argument array', async (command, editor) => {
    const target = 'D:/中文 project/with "quotes" & %PATH%/'
    await expect(openInEditor(target, editor)).resolves.toBe(true)
    expect(spawn).toHaveBeenCalledWith(`/bin/${command}`, [target], expect.objectContaining({ shell: false, detached: true, windowsHide: true }))
  })

  it('reports missing editors without opening a shell', async () => {
    vi.mocked(findTerminalExecutable).mockReturnValue(undefined)
    await expect(openInEditor('/project', 'vscode')).resolves.toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([['cursor', 'Cursor'], ['vscode', 'Visual Studio Code']] as const)('opens the macOS %s app without a CLI launcher', async (editor, application) => {
    openInEditor = await load('darwin')
    vi.mocked(findTerminalExecutable).mockReturnValue(undefined)
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
      queueMicrotask(() => { child.emit('spawn'); child.emit('close', 0) })
      return child as unknown as ReturnType<typeof spawn>
    })
    const target = '/Users/test/中文 project/with "quotes" & $(literal)'
    await expect(openInEditor(target, editor)).resolves.toBe(true)
    expect(spawn).toHaveBeenCalledWith('/usr/bin/open', ['-a', application, '--', target], expect.objectContaining({ shell: false }))
  })

  it('reports Launch Services errors when a macOS editor is absent', async () => {
    openInEditor = await load('darwin')
    vi.mocked(findTerminalExecutable).mockReturnValue(undefined)
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
      queueMicrotask(() => { child.emit('spawn'); child.emit('close', 1) })
      return child as unknown as ReturnType<typeof spawn>
    })
    await expect(openInEditor('/project', 'vscode')).resolves.toBe(false)
  })
})
