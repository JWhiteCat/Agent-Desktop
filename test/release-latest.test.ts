import { describe, expect, it } from 'vitest'
import { shouldMakeLatest } from '../scripts/release-latest.mjs'

const stable = (version: string) => ({ tag_name: `v${version}`, draft: false, prerelease: false })

describe('stable release Latest policy (inside the publish lock)', () => {
  it('promotes the first release and newer versions using numeric rather than lexical order', () => {
    expect(shouldMakeLatest('1.0.0', [[]])).toBe(true)
    expect(shouldMakeLatest('1.10.0', [[stable('1.9.9')]])).toBe(true)
    expect(shouldMakeLatest('1.9.9', [[stable('1.10.0')]])).toBe(false)
    expect(shouldMakeLatest('2.0.0', [[stable('1.99.99')]])).toBe(true)
    expect(shouldMakeLatest('1.1.1', [[stable('1.1.2')]])).toBe(false)
  })

  it('checks all pages, ignoring drafts, prereleases and unrelated tags', () => {
    expect(shouldMakeLatest('1.2.0', [[stable('1.0.0')], [stable('2.0.0')]])).toBe(false)
    expect(shouldMakeLatest('1.2.0', [[
      { ...stable('9.0.0'), draft: true },
      { ...stable('8.0.0'), prerelease: true },
      { ...stable('7.0.0-beta.1'), prerelease: true },
      { ...stable('1.0.0'), tag_name: 'unrelated-tag' }
    ]])).toBe(true)
  })

  it('keeps the highest version Latest for either serialized completion order and backfills', () => {
    for (const completionOrder of [['1.2.0', '2.0.0', '1.1.0'], ['2.0.0', '1.1.0', '1.2.0']]) {
      const published = [stable('1.0.0')]
      let latest = '1.0.0'
      for (const version of completionOrder) {
        if (shouldMakeLatest(version, [published])) latest = version
        published.push(stable(version))
      }
      expect(latest).toBe('2.0.0')
      expect(published).toHaveLength(4) // Older releases are not canceled or withdrawn.
    }
  })

  it('fails closed on malformed metadata or invalid candidate versions', () => {
    for (const pages of [null, {}, [stable('1.0.0')], [[null]], [[{ tag_name: 'v1.0.0' }]]]) {
      expect(() => shouldMakeLatest('1.0.0', pages)).toThrow()
    }
    for (const version of ['01.2.3', '1.0.0-beta.1', '1.0.0+build', 'v1.0.0']) {
      expect(() => shouldMakeLatest(version, [[]])).toThrow()
    }
  })
})
