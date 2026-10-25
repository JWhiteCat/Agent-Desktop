import { describe, expect, it } from 'vitest'
import { assertVersion, promoteUnreleased, releaseNotes } from '../scripts/changelog.mjs'
import { assertOnlyChangelog } from '../scripts/release.mjs'

const notes = `# Changelog

## [Unreleased]

### Added

- Windows portable builds.

## [0.1.0] - 2026-01-01

- First release.
`

describe('changelog sections', () => {
  it.each(['0.0.0', '1.2.3', '9007199254740991.0.0', '0.9007199254740991.0', '0.0.9007199254740991'])('accepts canonical npm-compatible stable version %s', (version) => {
    expect(() => assertVersion(version)).not.toThrow()
  })

  it.each(['01.2.3', '1.02.3', '1.2.03', 'v1.2.3', '1.2.3-beta.1', '1.2.3+build',
    '1.2', '-1.2.3', ' 1.2.3', '1.2.3 ', '1.2.3\n', '1.2.3\r\n',
    '9007199254740992.0.0', '0.9007199254740992.0', '0.0.9007199254740992'])('rejects noncanonical or unsafe version %j', (version) => {
    expect(() => assertVersion(version)).toThrow(/MAJOR.MINOR.PATCH/)
    expect(() => promoteUnreleased(notes, version, '2026-10-25')).toThrow(/MAJOR.MINOR.PATCH/)
    expect(() => releaseNotes(notes, version)).toThrow(/MAJOR.MINOR.PATCH/)
  })

  it('moves Unreleased notes into a dated version section', () => {
    const changelog = promoteUnreleased(notes, '0.2.0', '2026-10-23')
    expect(changelog).toContain('## [Unreleased]\n\n## [0.2.0] - 2026-10-23')
    expect(releaseNotes(changelog, '0.2.0')).toBe(`## [0.2.0] - 2026-10-23

### Added

- Windows portable builds.
`)
    expect(changelog).toContain('## [0.1.0] - 2026-01-01')
    expect(promoteUnreleased.bind(null, changelog, '0.2.0', '2026-10-23')).toThrow(/already contains 0.2.0/)
  })

  it('rejects an empty Unreleased section and unrelated files', () => {
    expect(() => promoteUnreleased('# Changelog\n\n## [Unreleased]\n', '0.2.0', '2026-10-23')).toThrow(/Unreleased/)
    expect(() => promoteUnreleased(notes, 'v0.2.0', '2026-10-23')).toThrow(/MAJOR.MINOR.PATCH/)
    assertOnlyChangelog(' M CHANGELOG.md\n')
    expect(() => assertOnlyChangelog(' M CHANGELOG.md\n M package.json\n')).toThrow(/package.json/)
    expect(() => releaseNotes(notes, '1.0.0')).toThrow(/no dated section/)
    expect(() => releaseNotes('## [1.0.0] - 2026-10-23\n\n## [0.9.0] - 2026-10-01\n- Old\n', '1.0.0')).toThrow(/empty/)
  })
})
