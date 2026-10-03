import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hostHandlers } from '../src/main/ipc/host'

const shell = vi.hoisted(() => ({ openPath: vi.fn(), openExternal: vi.fn() }))

vi.mock('electron', () => ({ shell }))
vi.mock('../src/main/git', () => ({ gitDiff: vi.fn() }))
vi.mock('../src/main/skills', () => ({ userSkillsDir: vi.fn() }))
vi.mock('../src/main/window', () => ({ openInEditor: vi.fn() }))

beforeEach(() => {
  shell.openPath.mockReset().mockResolvedValue('')
  shell.openExternal.mockReset().mockResolvedValue(undefined)
})

describe('host link handlers', () => {
  it('opens a local file and resolves only after the shell accepts it', async () => {
    const file = 'D:/project/artifacts/preview.png'

    await expect(hostHandlers()['shell:openPath'](file)).resolves.toBeUndefined()

    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(file)
  })

  it('rejects the error string returned by Electron when a file cannot be opened', async () => {
    shell.openPath.mockResolvedValueOnce('Failed to open path')

    await expect(hostHandlers()['shell:openPath']('D:/missing.png')).rejects.toThrow('Failed to open path')
  })

  it('preserves rejected shell opening errors', async () => {
    shell.openPath.mockRejectedValueOnce(new Error('Permission denied'))

    await expect(hostHandlers()['shell:openPath']('D:/preview.png')).rejects.toThrow('Permission denied')
  })

  it.each(['https://example.com/preview', 'HTTP://localhost:5173/preview'])('opens web URL %s externally', async (href) => {
    await hostHandlers()['shell:openExternal'](href)

    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith(href)
  })

  it.each(['D:/project/preview.png', 'file:///D:/preview.png', 'javascript:alert(1)', 'data:text/html,preview'])
    ('does not dispatch unsupported external URL %s', async (href) => {
      await hostHandlers()['shell:openExternal'](href)

      expect(shell.openExternal).not.toHaveBeenCalled()
    })
})
