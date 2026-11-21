import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it } from 'vitest'
import { Notice } from '../src/renderer/src/components/items/Messages'
import { setLanguage } from '../src/shared/i18n'
import type { NoticeItem } from '../src/shared/types'

const source = '请使用当前 Antigravity 账号完成验证，然后重试。'
const notice: NoticeItem = { kind: 'notice', id: 'notice', level: 'error', text: source, message: { source } }

afterEach(() => setLanguage('system', 'zh-CN'))

it('shows the localized verification action in an external link with the original challenge', () => {
  setLanguage('en')
  const verificationUrl = 'https://accounts.google.com/signin/continue?challenge=abc%2B123&service=code'
  const html = renderToStaticMarkup(createElement(Notice, { item: { ...notice, verificationUrl } }))
  expect(html).toContain('Verify the Google account you use for Antigravity, then try again.')
  expect(html).toContain('Verify your Google account</a>')
  expect(html).toContain(`href="${verificationUrl.replace('&', '&amp;')}"`)
  expect(html).toContain('target="_blank"')
  expect(html).toContain('rel="noreferrer"')
})

it.each([
  undefined, 'http://accounts.google.com/check', 'https://accounts.google.com.example.org/',
  'https://user@accounts.google.com/check', 'https://accounts.google.com:444/check'
])('keeps a notice plain text without a trusted verification URL (%s)', (verificationUrl) => {
  const html = renderToStaticMarkup(createElement(Notice, { item: { ...notice, verificationUrl } }))
  expect(html).toContain(source)
  expect(html).not.toContain('<a ')
})
