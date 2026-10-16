import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import spawn from 'cross-spawn'
import { openInEditor } from '../src/main/window'
import { findTerminalExecutable } from '../src/main/toolbar-terminal'

vi.mock('electron', () => ({ app: {}, nativeTheme: {} }))
vi.mock('cross-spawn', () => ({ default: vi.fn() }))
vi.mock('../src/main/toolbar-terminal', () => ({ findTerminalExecutable: vi.fn() }))

beforeEach(() => {
  vi.mocked(findTerminalExecutable).mockReset().mockImplementation((name) => `/bin/${name}`)
  vi.mocked(spawn).mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    queueMicrotask(() => child.emit('spawn'))
    return child as unknown as ReturnType<typeof spawn>
  })
})

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
})
