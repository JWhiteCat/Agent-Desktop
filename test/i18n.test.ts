import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { englishMessages, getLocale, normalizeLanguage, resolveLocale, setLanguage, subscribeLocale, t, translate } from '../src/shared/i18n'
import { coreMessages } from '../src/shared/locales/core'
import { messagesMessages } from '../src/shared/locales/messages'
import { settingsMessages } from '../src/shared/locales/settings'
import { shellMessages } from '../src/shared/locales/shell'
import { displayQuotaText, parseCodexQuota, parseCursorQuota, windowLabel } from '../src/shared/quota'
import type { ResultItem } from '../src/shared/types'
import { ResultFooter } from '../src/renderer/src/components/items/ResultFooter'
import { relativeTime, resetsIn } from '../src/renderer/src/lib/format'

beforeEach(() => setLanguage('system', 'zh-CN'))
afterEach(() => setLanguage('system', 'zh-CN'))

describe('language preferences', () => {
  it.each(['zh-CN', 'en'] as const)('keeps the supported preference %s', (language) => {
    expect(normalizeLanguage(language)).toBe(language)
  })

  it.each(['system', 'zh-TW', 'en-US', '', null, undefined, 42, {}])('uses System for unsupported saved values: %j', (value) => {
    expect(normalizeLanguage(value)).toBe('system')
  })

  it.each(['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-Hans-CN', 'zh_Hant_TW', 'ZH-cn'])('resolves Chinese system locale %s', (system) => {
    expect(resolveLocale('system', system)).toBe('zh-CN')
  })

  it.each(['en', 'en-US', 'fr-FR', 'ja-JP', '', 'zho'])('uses English for other system locales: %j', (system) => {
    expect(resolveLocale('system', system)).toBe('en')
  })

  it('gives explicit saved preferences precedence over the system language', () => {
    expect(resolveLocale('en', 'zh-CN')).toBe('en')
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN')
    expect(resolveLocale('unsupported', 'zh-TW')).toBe('zh-CN')
    expect(resolveLocale(undefined, 'de-DE')).toBe('en')
  })
})

describe('active language', () => {
  it('applies saved preferences and remembers the system language when returning to System', () => {
    setLanguage('system', 'en-GB')
    expect(getLocale()).toBe('en')
    expect(t('设置')).toBe('Settings')

    setLanguage('zh-CN')
    expect(getLocale()).toBe('zh-CN')
    expect(t('设置')).toBe('设置')

    setLanguage('system')
    expect(getLocale()).toBe('en')
    expect(t('设置')).toBe('Settings')

    setLanguage('system', 'zh-TW')
    expect(getLocale()).toBe('zh-CN')
  })

  it('notifies subscribers only when the resolved language changes and supports unsubscribe', () => {
    const observed: string[] = []
    const listener = vi.fn(() => observed.push(t('设置')))
    const unsubscribe = subscribeLocale(listener)
    try {
      setLanguage('zh-CN')
      setLanguage('system', 'zh-HK')
      expect(listener).not.toHaveBeenCalled()

      setLanguage('en')
      expect(observed).toEqual(['Settings'])
      setLanguage('system', 'en-US')
      expect(listener).toHaveBeenCalledTimes(1)

      setLanguage('system', 'zh-CN')
      expect(observed).toEqual(['Settings', '设置'])

      unsubscribe()
      setLanguage('en')
      expect(listener).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribe()
    }
  })
})

describe('message translation', () => {
  it('keeps the original Chinese text and substitutes named parameters in both languages', () => {
    const source = '搜索结果 · {count}'
    expect(translate('zh-CN', source, { count: 0 })).toBe('搜索结果 · 0')
    expect(translate('en', source, { count: 12 })).toBe('Search results · 12')
    expect(translate('zh-CN', '设置')).toBe('设置')
    expect(translate('en', '设置')).toBe('Settings')
  })

  it('preserves unknown messages, including property names inherited from Object', () => {
    expect(translate('en', '用户自己的标题')).toBe('用户自己的标题')
    expect(translate('en', 'A user title')).toBe('A user title')
    expect(translate('en', 'constructor')).toBe('constructor')
    expect(translate('en', '__proto__')).toBe('__proto__')
    expect(translate('en', 'unknown {value}', { value: 0 })).toBe('unknown 0')
  })

  it('keeps placeholders when no matching parameter is supplied', () => {
    expect(translate('en', '搜索结果 · {count}')).toBe('Search results · {count}')
    expect(translate('en', '搜索结果 · {count}', {})).toBe('Search results · {count}')
    expect(translate('en', '{first} / {second}', { first: '' })).toBe(' / {second}')
    expect(translate('en', '{constructor}', {})).toBe('{constructor}')
  })

  it('treats braces, replacement syntax, and markup inside user values as literal text', () => {
    const name = '{other} $& $1 <script>example</script>'
    expect(translate('en', '按照计划「{name}」开始实施。', { name, other: 'must not replace' }))
      .toBe(`Start implementing the plan “${name}”.`)
    expect(translate('zh-CN', '{first} / {second}', { first: '{second}', second: 'value' }))
      .toBe('{second} / value')
  })

  it('translates against an explicit locale without changing the active preference', () => {
    expect(translate('en', '设置')).toBe('Settings')
    expect(getLocale()).toBe('zh-CN')
    expect(t('设置')).toBe('设置')
  })
})

function placeholders(message: string): string[] {
  return [...new Set([...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort()
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('translation catalogs', () => {
  it('preserves every named parameter in each English catalog entry', () => {
    const catalogs = { coreMessages, messagesMessages, settingsMessages, shellMessages }
    const issues: string[] = []
    for (const [catalogName, catalog] of Object.entries(catalogs)) {
      for (const [source, english] of Object.entries(catalog)) {
        if (!english.trim()) issues.push(`${catalogName}: empty translation for ${source}`)
        if (JSON.stringify(placeholders(source)) !== JSON.stringify(placeholders(english))) {
          issues.push(`${catalogName}: ${source} -> ${english}`)
        }
      }
    }
    expect(issues).toEqual([])
  })

  it('includes every explicit Chinese translation key used in application source', () => {
    const root = resolve('src')
    const missing: string[] = []
    for (const path of sourceFiles(root)) {
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
          const key = node.arguments[0]
          // Product names and technical labels may intentionally use the source fallback.
          if (key && ts.isStringLiteralLike(key) && /\p{Script=Han}/u.test(key.text) && !Object.hasOwn(englishMessages, key.text)) {
            const line = source.getLineAndCharacterOfPosition(key.getStart()).line + 1
            missing.push(`${relative(root, path)}:${line}: ${key.text}`)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(missing).toEqual([])
  })
})

describe('English presentation', () => {
  const now = Date.UTC(2026, 8, 30, 8)

  it('formats relative times and reset times in English, then switches back to Chinese', () => {
    setLanguage('en')
    expect(relativeTime(now, now)).toBe('Just now')
    expect(relativeTime(now - 60_000, now)).toBe('1 minute ago')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 hours ago')
    expect(resetsIn(now + 60_000, now)).toBe('in 1 minute')
    expect(resetsIn(now + 2 * 86_400_000, now)).toBe('in 2 days')
    expect(resetsIn(now - 1, now)).toBe('Resets soon')

    setLanguage('zh-CN')
    expect(relativeTime(now - 60_000, now)).toBe('1 分钟')
    expect(resetsIn(now + 2 * 86_400_000, now)).toBe('2 天后')
  })

  it('translates quota presentation without changing stored labels or snapshot parsing', () => {
    const rawCodex = {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 12, windowDurationMins: 300 },
        secondary: { usedPercent: 34, windowDurationMins: 10_080 }
      }
    }
    const rawCursor = { planUsage: { autoPercentUsed: 12, apiPercentUsed: 34 } }
    const chineseCodex = parseCodexQuota(rawCodex)
    const chineseCursor = parseCursorQuota(rawCursor, {})
    setLanguage('en')

    expect(parseCodexQuota(rawCodex)).toEqual(chineseCodex)
    expect(parseCursorQuota(rawCursor, {})).toEqual(chineseCursor)
    expect(windowLabel(18_000)).toBe('5小时')
    expect(windowLabel(604_800)).toBe('每周')
    expect(windowLabel(2_592_000)).toBe('每月')
    expect(displayQuotaText('5小时')).toBe('5 hours')
    expect(displayQuotaText('2小时')).toBe('2 hours')
    expect(displayQuotaText('10天')).toBe('10 days')
    expect(displayQuotaText('每周')).toBe('Weekly')
    expect(displayQuotaText('每月')).toBe('Monthly')
    expect(displayQuotaText('Cursor 模型')).toBe('Cursor models')
    expect(displayQuotaText('custom quota pool')).toBe('custom quota pool')
  })

  it('renders session totals and explanatory tooltips in English and preserves numeric readings', () => {
    const item: ResultItem = {
      id: 'result', kind: 'result', isError: false, model: 'gpt-5.4',
      usage: { inputTokens: 1_000 },
      codexSessionUsage: {
        threadId: 'session', status: 'available', weekly: 8,
        dataAsOf: '2026-09-30T08:00:00Z'
      },
      weeklyQuotaEstimate: {
        start: { sampledAt: now, weekly: { usedPercent: 30, resetsAt: now + 604_800_000 } },
        end: { sampledAt: now + 60_000, weekly: { usedPercent: 30.5, resetsAt: now + 604_799_000 } }
      }
    }
    const render = () => renderToStaticMarkup(createElement(ResultFooter, { item, cli: 'codex', models: [] }))

    setLanguage('en')
    const english = render()
    expect(english).toContain('Turn weekly quota: 8%')
    expect(english).toContain('Estimated turn weekly quota: 0.5%')
    expect(english).toContain('start 30%, end 30.5%')
    expect(english).toContain('Calculation: end − start.')
    expect(english).toContain('0% means the readings did not change')
    expect(english).toContain('Service data as of: 2026-09-30T08:00:00Z')
    expect(english).toContain('1.0k tokens')
    expect(english).toContain('>$0.0025</span>')
    expect(english).not.toMatch(/\p{Script=Han}/u)

    setLanguage('zh-CN')
    const chinese = render()
    expect(chinese).toContain('本轮周额度 8%')
    expect(chinese).toContain('本轮预估周额度 0.5%')
    expect(chinese).toContain('开始 30%，结束 30.5%')
    expect(chinese).toContain('>$0.0025</span>')
  })
})
