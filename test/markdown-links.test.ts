import { describe, expect, it } from 'vitest'
import { isLocalFileLink, localPathFromLink } from '../src/shared/markdown-links'

describe('Markdown local file links', () => {
  it.each([
    ['D:/files/demo/preview.html', 'D:\\files\\demo\\preview.html'],
    ['D:\\files\\demo\\preview.html', 'D:\\files\\demo\\preview.html'],
    ['D:%5Cfiles%5Cdemo%5Cpreview.html', 'D:\\files\\demo\\preview.html'],
    ['/D:/files/demo/preview.html', 'D:\\files\\demo\\preview.html'],
    ['file:///D:/files/demo/preview.html', 'D:\\files\\demo\\preview.html'],
    ['file://localhost/D:/files/demo/preview.html', 'D:\\files\\demo\\preview.html'],
    ['file:///tmp/preview.html', '/tmp/preview.html'],
    ['file://localhost/tmp/preview.html', '/tmp/preview.html'],
    ['/tmp/preview.html', '/tmp/preview.html'],
    ['D:/files/../demo/./preview.html', 'D:\\demo\\preview.html'],
    ['/tmp/../demo/./preview.html', '/demo/preview.html'],
    ['D:/../../preview.html', 'D:\\preview.html'],
    ['/../../preview.html', '/preview.html']
  ])('resolves the absolute local link %s', (href, expected) => {
    expect(localPathFromLink(href)).toBe(expected)
    expect(isLocalFileLink(href)).toBe(true)
  })

  it.each([
    ['D:/files/demo%20%E9%A2%84%E8%A7%88.html', 'D:\\files\\demo 预览.html'],
    ['file:///tmp/demo%20%E9%A2%84%E8%A7%88.html', '/tmp/demo 预览.html'],
    ['/tmp/100%.html', '/tmp/100%.html'],
    ['/tmp/100%25.html', '/tmp/100%.html'],
    ['/tmp/literal%2520.html', '/tmp/literal%20.html'],
    ['/tmp/demo#draft.html', '/tmp/demo#draft.html'],
    ['/tmp/demo%23L12', '/tmp/demo#L12'],
    ['/tmp/demo%3A12', '/tmp/demo:12'],
    ['file:///tmp/demo%23draft.html#heading', '/tmp/demo#draft.html'],
    ['file:///tmp/demo.html?theme=dark#heading', '/tmp/demo.html']
  ])('decodes filenames and preserves escaped punctuation in %s', (href, expected) => {
    expect(localPathFromLink(href)).toBe(expected)
  })

  it.each([':12', ':12:3', '#L12', '#L12C3', ':12:3#L12C3'])('removes the code position %s', (position) => {
    expect(localPathFromLink(`D:/files/main.ts${position}`)).toBe('D:\\files\\main.ts')
    expect(localPathFromLink(`/tmp/main.ts${position}`)).toBe('/tmp/main.ts')
    expect(localPathFromLink(`file:///tmp/main.ts${position}`)).toBe('/tmp/main.ts')
  })

  it.each([
    ['./preview.html', 'D:/worktrees/task', 'D:\\worktrees\\task\\preview.html'],
    ['../preview.html', 'D:\\worktrees\\task', 'D:\\worktrees\\preview.html'],
    ['src%5Cpreview.html', 'D:/worktrees/task', 'D:\\worktrees\\task\\src\\preview.html'],
    ['./preview.html', '/worktrees/task', '/worktrees/task/preview.html'],
    ['../preview.html', '/worktrees/task', '/worktrees/preview.html'],
    ['preview%20%E9%A2%84%E8%A7%88.html', '/worktrees/task', '/worktrees/task/preview 预览.html'],
    ['main.ts:12', 'D:/worktrees/task', 'D:\\worktrees\\task\\main.ts'],
    ['main.ts:12:3', '/worktrees/task', '/worktrees/task/main.ts'],
    ['main.ts:12:3#L12C3', '/worktrees/task', '/worktrees/task/main.ts'],
    ['foo.bar:12', '/worktrees/task', '/worktrees/task/foo.bar'],
    ['src/main.ts:12:3', '/worktrees/task', '/worktrees/task/src/main.ts'],
    ['preview.html', '/tmp/literal%20', '/tmp/literal%20/preview.html']
  ])('resolves %s from the conversation cwd %s', (href, cwd, expected) => {
    expect(localPathFromLink(href, cwd)).toBe(expected)
    expect(isLocalFileLink(href, cwd)).toBe(true)
    expect(localPathFromLink(href)).toBeUndefined()
    expect(isLocalFileLink(href)).toBe(false)
  })

  it.each([
    '', ' ', '#heading', '?theme=dark',
    'https://example.com/preview.html', 'http://localhost:3000/',
    'javascript:alert(1)', 'javascript%3Aalert(1)', 'data:text/html,<h1>Hi</h1>',
    'javascript:123', 'javascript:12:3', 'javascript:12#L3', 'javascript%3A123',
    'data:123', 'mailto:123', 'custom:123', 'javascript:payload.js:123',
    'mailto:person@example.com', 'vscode://file/D:/preview.html', 'custom:preview',
    '//server/share/preview.html', '\\\\server\\share\\preview.html', '/\\server/share/preview.html',
    '%2F%2Fserver/share/preview.html', '%5C%5Cserver%5Cshare%5Cpreview.html',
    'file://server/share/preview.html', 'file:////server/share/preview.html',
    'file://user@localhost/tmp/preview.html', 'file:///tmp/%00preview.html',
    '/tmp/preview%0A.html', '/tmp/%FF.html', 'java\nscript:alert(1)',
    'D:preview.html', '\\preview.html'
  ])('rejects unsupported or unsafe target %s even with a cwd', (href) => {
    expect(localPathFromLink(href)).toBeUndefined()
    expect(localPathFromLink(href, 'D:/worktree')).toBeUndefined()
    expect(localPathFromLink(href, '/worktree')).toBeUndefined()
    expect(isLocalFileLink(href)).toBe(false)
    expect(isLocalFileLink(href, '/worktree')).toBe(false)
  })

  it.each(['relative/path', '//server/share', '\\\\server\\share', 'https://example.com/', ''])('does not use a nonlocal or relative cwd %s', (cwd) => {
    expect(localPathFromLink('preview.html', cwd)).toBeUndefined()
  })
})
