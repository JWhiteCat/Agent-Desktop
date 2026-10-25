import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWorkflow, requiredStep } from './helpers/workflow'

const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
const workflow = readWorkflow()
const builds = ['build-windows', 'build-linux', 'build-macos'] as const

describe('GitHub release workflow', () => {
  it('runs only for release branches and tags, and validates the checked-out tag', () => {
    expect(workflow.on).toEqual({ push: { tags: ['v*'], branches: ['release/*'] } })
    const verify = requiredStep(workflow.jobs.verify, 'Check version').run!
    expect(verify).toContain("import { assertVersion } from './scripts/changelog.mjs'; assertVersion(process.argv[1])")
    expect(verify.indexOf('assertVersion(process.argv[1])')).toBeLessThan(verify.indexOf('package_version='))
    expect(verify).toContain('refs/heads/release/')
    expect(verify).toContain('git fetch --no-tags origin')
    expect(verify).toContain('git rev-parse HEAD')
    expect(verify).not.toContain('GITHUB_SHA')
    expect(verify).not.toContain('electron-builder')
    expect(verify).toContain('node scripts/changelog.mjs "$version"')
    for (const name of builds) {
      expect(workflow.jobs[name].needs).toBe('verify')
      expect(workflow.jobs[name].if).toBe("${{ startsWith(github.ref, 'refs/tags/v') && needs.verify.result == 'success' }}")
    }
    expect(workflow.jobs.publish.if).toBe("${{ startsWith(github.ref, 'refs/tags/v') && success() }}")
  })

  it.each(builds)('runs offline tests and types before packaging in %s', (name) => {
    const job = workflow.jobs[name]
    const tests = requiredStep(job, 'Offline tests')
    const types = requiredStep(job, 'Type check')
    expect(tests.run).toBe('npm test -- --maxWorkers=4')
    expect(tests.env?.NODE_ENV).toBe('test')
    expect(types.run).toBe('npm run typecheck')
    const install = requiredStep(job, 'Install dependencies')
    expect(install.run).toBe('npm ci --include=dev --include=optional')
    const packageIndex = job.steps.findIndex((step) => step.name?.startsWith('Package '))
    expect(packageIndex).toBeGreaterThan(-1)
    for (const step of [types, tests]) {
      expect(job.steps.indexOf(step)).toBeGreaterThan(job.steps.indexOf(install))
      expect(job.steps.indexOf(step)).toBeLessThan(packageIndex)
    }
  })

  it('builds native macOS architectures and verifies the packaged app', () => {
    const mac = workflow.jobs['build-macos']
    expect(mac.strategy?.matrix.include).toEqual([
      { arch: 'arm64', runner: 'macos-15' }, { arch: 'x64', runner: 'macos-15-intel' }
    ])
    expect(requiredStep(mac, 'Check native architecture').run).toContain('process.arch')
    expect(requiredStep(mac, 'Package macOS installer').run).toBe('npm run dist:mac:${{ matrix.arch }}')
    expect(requiredStep(mac, 'Verify packaged macOS application').run).toBe('npm run verify:mac -- release/agent-desktop-${{ needs.verify.outputs.version }}-mac-${{ matrix.arch }}.dmg ${{ matrix.arch }}')
  })

  it('serializes publication with all platform builds required and narrowly scoped write permission', () => {
    const publish = workflow.jobs.publish
    expect(publish.needs).toEqual(['verify', ...builds])
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(publish.permissions).toEqual({ contents: 'write' })
    expect(workflow.concurrency).toEqual({ group: 'release-${{ github.ref }}', 'cancel-in-progress': false, queue: 'max' })
    expect(publish.concurrency).toEqual({ group: 'agent-desktop-release-publication', 'cancel-in-progress': false, queue: 'max' })
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name !== 'publish') {
        expect(job.permissions?.contents).not.toBe('write')
        expect(job.concurrency?.group).not.toBe('agent-desktop-release-publication')
      }
    }
    // Shell ordering, draft safety, uploads and latest policy are executed by
    // release-publication.test.ts, rather than checking source formatting here.
    expect(requiredStep(publish, 'Publish GitHub Release').env).toEqual({
      GH_TOKEN: '${{ github.token }}', VERSION: '${{ needs.verify.outputs.version }}'
    })
  })

  it('keeps local packaging non-publishing and the required Windows/Linux targets', () => {
    expect(requiredStep(workflow.jobs['build-windows'], 'Package Windows installers').run).toBe('npx electron-builder --win portable nsis --x64 --publish never')
    expect(requiredStep(workflow.jobs['build-linux'], 'Package Linux installers').run).toBe('npm run dist:linux')
    expect(pkg.scripts.dist).toBe('electron-vite build && electron-builder')
    for (const [script, target] of Object.entries({
      'dist:win:portable': '--win portable --x64', 'dist:linux': '--linux --x64', 'dist:linux:dir': '--linux --x64 --dir'
    })) expect(pkg.scripts[script]).toBe(`electron-vite build && electron-builder ${target} --publish never`)
    expect(Object.values(workflow.jobs).flatMap((job) => job.steps).some((step) => step.run?.includes('--publish always'))).toBe(false)
  })
})
