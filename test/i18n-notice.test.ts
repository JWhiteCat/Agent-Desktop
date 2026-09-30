import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import type { NoticeItem } from '../src/shared/types'
import { AssistantMessage, Notice, UserMessage } from '../src/renderer/src/components/items/Messages'

beforeEach(() => setLanguage('system', 'zh-CN'))
afterEach(() => setLanguage('system', 'zh-CN'))

describe('localized application notices', () => {
  it('renders the same saved source and parameters in either language', () => {
    const item: NoticeItem = {
      id: 'notice', kind: 'notice', level: 'info', text: '已分叉为「用户标题」',
      message: { source: '已分叉为「{title}」', params: { title: '用户标题' } }
    }
    const render = () => renderToStaticMarkup(createElement(Notice, { item }))

    expect(render()).toContain('已分叉为「用户标题」')
    setLanguage('en')
    expect(render()).toContain('Forked as “用户标题”')
    setLanguage('zh-CN')
    expect(render()).toContain('已分叉为「用户标题」')
    expect(item.text).toBe('已分叉为「用户标题」')
  })

  it('translates app messages even when compatibility text was saved in another language', () => {
    const item: NoticeItem = {
      id: 'notice', kind: 'notice', level: 'info', text: 'Stopped',
      message: { source: '已停止' }
    }
    expect(renderToStaticMarkup(createElement(Notice, { item }))).toContain('已停止')
    setLanguage('en')
    expect(renderToStaticMarkup(createElement(Notice, { item }))).toContain('Stopped')
  })

  it('preserves raw CLI output and legacy notices that have no message metadata', () => {
    setLanguage('en')
    for (const text of ['已停止', '隧道已断开', 'CLI output: 用户内容']) {
      const item: NoticeItem = { id: 'notice', kind: 'notice', level: 'error', text }
      expect(renderToStaticMarkup(createElement(Notice, { item }))).toContain(text)
    }
  })

  it('preserves user and assistant content that happens to match a translation key', () => {
    setLanguage('en')
    const user = renderToStaticMarkup(createElement(UserMessage, {
      item: { id: 'user', kind: 'user', text: '已停止', createdAt: 0 }
    }))
    const assistant = renderToStaticMarkup(createElement(AssistantMessage, { text: '隧道已断开' }))
    expect(user).toContain('已停止')
    expect(user).toContain('title="Copy"')
    expect(assistant).toContain('隧道已断开')
  })
})
