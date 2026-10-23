import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
const workflow = fs.readFileSync(path.resolve('.github/workflows/release.yml'), 'utf8').replace(/\r\n/g, '\n')

function jobBlock(source: string, name: string): string {
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => line === `  ${name}:`)
  expect(start, `job ${name}`).toBeGreaterThanOrEqual(0)
  let end = lines.findIndex((line, index) => index > start && /^  [a-z0-9-]+:$/.test(line))
  if (end === -1) end = lines.length
  return lines.slice(start, end).join('\n')
}

describe('GitHub release workflow', () => {
  it('checks release branches and publishes only matching tags without changing local packaging', () => {
    const trigger = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\njobs:\n'))
    expect(trigger).toContain("- 'v*'")
    expect(trigger).toContain("- 'release/*'")
    expect(trigger).not.toContain('pull_request')
    expect(trigger).not.toContain('workflow_dispatch')

    const verify = jobBlock(workflow, 'verify')
    expect(verify).toContain("grep -Eq '^[0-9]+\\.[0-9]+\\.[0-9]+$'")
    expect(verify).toContain('refs/heads/release/')
    expect(verify).toContain('git fetch --no-tags origin')
    expect(verify).toContain('git rev-parse HEAD')
    expect(verify).not.toContain('GITHUB_SHA')
    expect(verify).not.toContain("startsWith(github.ref, 'refs/tags/v')")
    expect(verify).not.toContain('electron-builder')

    for (const name of ['build-windows', 'build-linux', 'publish']) {
      expect(jobBlock(workflow, name)).toContain("startsWith(github.ref, 'refs/tags/v')")
    }
    expect(jobBlock(workflow, 'build-windows')).toContain('electron-builder --win portable nsis --x64 --publish never')
    expect(jobBlock(workflow, 'build-linux')).toContain('npm run dist:linux')
    expect(jobBlock(workflow, 'publish')).toContain('gh release create "$tag" --generate-notes')
    expect(jobBlock(workflow, 'publish')).toContain('gh release upload "$tag" "${files[@]}" --clobber')
    expect(workflow.match(/contents:\s*write/g)).toEqual(['contents: write'])
    expect(workflow).not.toContain('--publish always')

    expect(pkg.scripts.dist).toBe('electron-vite build && electron-builder')
    expect(pkg.scripts['dist:win:portable']).toBe('electron-vite build && electron-builder --win portable --x64 --publish never')
    expect(pkg.scripts['dist:linux']).toBe('electron-vite build && electron-builder --linux --x64 --publish never')
    expect(pkg.scripts['dist:linux:dir']).toBe('electron-vite build && electron-builder --linux --x64 --dir --publish never')
  })
})
