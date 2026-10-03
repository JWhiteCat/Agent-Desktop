import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hostHandlers } from '../src/main/ipc/host'
import { openInEditor } from '../src/main/window'

const shell = vi.hoisted(() => ({ openPath: vi.fn(), openExternal: vi.fn() }))

vi.mock('electron', () => ({ shell }))
vi.mock('../src/main/git', () => ({ gitDiff: vi.fn() }))
vi.mock('../src/main/skills', () => ({ userSkillsDir: vi.fn() }))
vi.mock('../src/main/window', () => ({ openInEditor: vi.fn() }))

beforeEach(() => {
  shell.openPath.mockReset().mockResolvedValue('')
  shell.openExternal.mockReset().mockResolvedValue(undefined)
  vi.mocked(openInEditor).mockReset().mockResolvedValue(false)
})

describe('host link handlers', () => {
  it('opens a Linux file path containing spaces without shell parsing', async () => {
    const file = '/home/test/my project/preview image.png'
    await hostHandlers()['shell:openPath'](file)
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(file)
  })

  it('falls back to the file manager when Cursor is not available', async () => {
    const dir = '/home/test/my project'
    await expect(hostHandlers()['shell:openInEditor'](dir)).resolves.toBe(false)
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(dir)
  })

  it('reports file-manager fallback errors instead of silently succeeding', async () => {
    shell.openPath.mockResolvedValueOnce('No application is registered')
    await expect(hostHandlers()['shell:openInEditor']('/home/test/project')).rejects.toThrow('No application is registered')
  })

  it('does not open the file manager when Cursor starts successfully', async () => {
    vi.mocked(openInEditor).mockResolvedValueOnce(true)
    await expect(hostHandlers()['shell:openInEditor']('/home/test/project')).resolves.toBe(true)
    expect(shell.openPath).not.toHaveBeenCalled()
  })

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
