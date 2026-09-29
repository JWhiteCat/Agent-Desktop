import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitDiff } from '../src/main/git'

describe('Git changes', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-git-'))
  })

  afterEach(() => {
    const resolved = path.resolve(root)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agent-desktop-git-')) {
      throw new Error(`Unexpected test directory: ${resolved}`)
    }
    fs.rmSync(resolved, { recursive: true, force: true })
  })

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  }

  function init(format = 'sha1'): void {
    git('init', `--object-format=${format}`)
    git('config', 'core.autocrlf', 'false')
  }

  it.each(['sha1', 'sha256'])('shows the working contents before the first %s commit', async (format) => {
    init(format)
    fs.writeFileSync(path.join(root, 'file.txt'), 'staged version\n')
    git('add', 'file.txt')
    fs.writeFileSync(path.join(root, 'file.txt'), 'working version\n')
    fs.writeFileSync(path.join(root, 'new file.txt'), 'untracked contents\n')

    const result = await gitDiff(root)

    expect(result.isRepo).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.diff).toContain('+working version')
    expect(result.diff).not.toContain('+staged version')
    expect(result.diff).toContain('+untracked contents')
  })

  it('omits a staged file removed from the working tree before the first commit', async () => {
    init()
    const file = path.join(root, 'removed.txt')
    fs.writeFileSync(file, 'already removed\n')
    git('add', 'removed.txt')
    fs.rmSync(file)

    const result = await gitDiff(root)

    expect(result.error).toBeUndefined()
    expect(result.status).toContain('AD removed.txt')
    expect(result.diff).toBe('')
  })

})
