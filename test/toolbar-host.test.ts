import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hostHandlers } from '../src/main/ipc/host'
import { launchToolbarCommand } from '../src/main/toolbar-terminal'
import type { Store } from '../src/main/store'
import type { ToolbarButton } from '../src/shared/types'

vi.mock('electron', () => ({ shell: {} }))
vi.mock('../src/main/window', () => ({ openInEditor: vi.fn() }))
vi.mock('../src/main/toolbar-terminal', () => ({ launchToolbarCommand: vi.fn() }))
vi.mock('../src/main/skills', () => ({ userSkillsDir: vi.fn() }))

const button: ToolbarButton = { id: 'custom', kind: 'command', name: 'Tool', visible: true, program: '{projectPath}/bin/tool', args: ['{cwd}', '{projectPath}', '& literal'] }
function handlers(buttons = [button], cwd: string | undefined = '/project/worktree') {
  return hostHandlers({ store: {
    settings: { threadToolbarButtons: buttons },
    threads: [{ id: 'thread', projectId: 'project', cwd }],
    projects: [{ id: 'project', path: '/project/root' }]
  } as Store })
}
beforeEach(() => vi.mocked(launchToolbarCommand).mockReset().mockResolvedValue(undefined))

describe('saved toolbar command dispatch', () => {
  it('loads the saved command and resolves worktree/project placeholders in the host', async () => {
    await handlers()['shell:runToolbarCommand']('custom', 'thread')
    expect(launchToolbarCommand).toHaveBeenCalledExactlyOnceWith({
      program: '/project/root/bin/tool', args: ['/project/worktree', '/project/root', '& literal'], cwd: '/project/worktree'
    })
  })

  it('uses the project path before a thread has a working directory', async () => {
    await handlers([button], '')['shell:runToolbarCommand']('custom', 'thread')
    expect(launchToolbarCommand).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/project/root' }))
  })

  it.each(['missing', 'fork', 'cursor'])('rejects unavailable command ID %s', async (id) => {
    await expect(handlers()['shell:runToolbarCommand'](id, 'thread')).rejects.toThrow('自定义命令不可用')
    expect(launchToolbarCommand).not.toHaveBeenCalled()
  })

  it('rejects hidden commands and unknown sessions without starting a terminal', async () => {
    await expect(handlers([{ ...button, visible: false }])['shell:runToolbarCommand']('custom', 'thread')).rejects.toThrow('自定义命令不可用')
    await expect(handlers()['shell:runToolbarCommand']('custom', 'missing')).rejects.toThrow('未找到会话')
    expect(launchToolbarCommand).not.toHaveBeenCalled()
  })
})
