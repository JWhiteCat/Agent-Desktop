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
    expect(verify).toContain("import { assertVersion } from './scripts/changelog.mjs'; assertVersion(process.argv[1])")
    expect(verify.indexOf('assertVersion(process.argv[1])')).toBeLessThan(verify.indexOf('package_version='))
    expect(verify).toContain('refs/heads/release/')
    expect(verify).toContain('git fetch --no-tags origin')
    expect(verify).toContain('git rev-parse HEAD')
    expect(verify).not.toContain('GITHUB_SHA')
    expect(verify).not.toContain("startsWith(github.ref, 'refs/tags/v')")
    expect(verify).not.toContain('electron-builder')
    expect(verify).toContain('node scripts/changelog.mjs "$version"')

    for (const name of ['build-windows', 'build-linux', 'build-macos', 'publish']) {
      expect(jobBlock(workflow, name)).toContain("startsWith(github.ref, 'refs/tags/v')")
    }
    expect(jobBlock(workflow, 'build-windows')).toContain('electron-builder --win portable nsis --x64 --publish never')
    expect(jobBlock(workflow, 'build-linux')).toContain('npm run dist:linux')
    expect(jobBlock(workflow, 'build-linux')).toContain('test/release-publication.test.ts')
    const publish = jobBlock(workflow, 'publish')
    const mac = jobBlock(workflow, 'build-macos')
    expect(mac).toContain('runner: macos-15\n')
    expect(mac).toContain('runner: macos-15-intel')
    expect(mac).toContain('process.arch')
    expect(mac).toContain('npm ci --include=dev --include=optional')
    expect(mac).toContain('npm run typecheck')
    expect(mac).toContain('npm test')
    expect(mac).toContain('npm run dist:mac:${{ matrix.arch }}')
    expect(mac).toContain('npm run verify:mac --')
    expect(publish).toContain('needs: [verify, build-windows, build-linux, build-macos]')
    expect(publish).toContain('node scripts/changelog.mjs "$VERSION"')
    expect(publish).toContain('node scripts/release-artifacts.mjs artifacts "$VERSION"')
    expect(publish).toContain('gh release create "$tag" --verify-tag --draft --title "Agent Desktop ${tag}" --notes-file release-notes.md')
    expect(publish.indexOf('gh release upload')).toBeLessThan(publish.indexOf('--draft=false'))
    expect(publish).toContain('--draft=false --prerelease=false --latest="$latest"')
    expect(publish).toContain('group: agent-desktop-release-publication')
    expect(publish).toContain('cancel-in-progress: false\n      queue: max')
    expect(publish).toContain('gh api --paginate --slurp "repos/${GITHUB_REPOSITORY}/releases?per_page=100"')
    expect(publish).toContain('node scripts/release-latest.mjs "$VERSION" published-releases.json')
    expect(publish.indexOf('gh release upload')).toBeLessThan(publish.indexOf('gh api --paginate'))
    expect(publish.indexOf('gh api --paginate')).toBeLessThan(publish.indexOf('--draft=false'))
    for (const name of ['build-windows', 'build-linux', 'build-macos']) {
      expect(jobBlock(workflow, name)).not.toContain('agent-desktop-release-publication')
    }
    expect(publish).not.toContain('--generate-notes')
    expect(publish).toContain('gh release upload "$tag" "${files[@]}" --clobber')
    expect(workflow.match(/contents:\s*write/g)).toEqual(['contents: write'])
    expect(workflow).not.toContain('--publish always')

    expect(pkg.scripts.dist).toBe('electron-vite build && electron-builder')
    expect(pkg.scripts['dist:win:portable']).toBe('electron-vite build && electron-builder --win portable --x64 --publish never')
    expect(pkg.scripts['dist:linux']).toBe('electron-vite build && electron-builder --linux --x64 --publish never')
    expect(pkg.scripts['dist:linux:dir']).toBe('electron-vite build && electron-builder --linux --x64 --dir --publish never')
  })
})
