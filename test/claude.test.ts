import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeModeId, isClaudeShellShim, modelsFromClaudeSession, resolveClaude } from '../src/main/claude'
import { claudeTranscriptItems, scanClaudeSessions, visibleUserText } from '../src/main/claude-history'
import { normalizeCliProvider } from '../src/shared/types'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('claude mode and models', () => {
  it('treats Windows npm shims as unspawnable and keeps a native binary', () => {
    expect(isClaudeShellShim('C:/npm/claude', 'win32')).toBe(true)
    expect(isClaudeShellShim('C:/npm/claude.cmd', 'win32')).toBe(true)
    expect(isClaudeShellShim('C:/npm/claude.ps1', 'win32')).toBe(true)
    expect(isClaudeShellShim('C:/npm/claude.exe', 'win32')).toBe(false)
    expect(isClaudeShellShim('/usr/local/bin/claude', 'linux')).toBe(false)
  })

  it('ignores an npm claude shim on PATH and keeps the bundled binary', () => {
    if (process.platform !== 'win32') return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-claude-shim-'))
    roots.push(dir)
    fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nexit 0\n')
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\n')
    const previous = process.env.PATH
    process.env.PATH = dir
    try {
      expect(resolveClaude('')).toMatchObject({ bundled: true, claudePath: undefined })
    } finally {
      process.env.PATH = previous
    }
  })

  it('maps the three app modes onto Claude permission modes', () => {
    expect(claudeModeId('agent', false)).toBe('acceptEdits')
    expect(claudeModeId('agent', true)).toBe('bypassPermissions')
    expect(claudeModeId('plan', true)).toBe('plan')
    expect(claudeModeId('ask', true)).toBe('default')
  })

  it('keeps an unknown saved CLI on Cursor and accepts claude', () => {
    expect(normalizeCliProvider(undefined)).toBe('cursor')
    expect(normalizeCliProvider('nope')).toBe('cursor')
    expect(normalizeCliProvider('codex')).toBe('codex')
    expect(normalizeCliProvider('claude')).toBe('claude')
  })

  it('expands model and effort selects and skips the default effort', () => {
    const listed = modelsFromClaudeSession({
      configOptions: [
        {
          id: 'model',
          currentValue: 'sonnet',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'sonnet', name: 'Sonnet' },
            { value: 'opus', name: 'Opus' }
          ]
        },
        {
          id: 'effort',
          currentValue: 'high',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' }
          ]
        }
      ]
    })
    expect(listed.recommended).toBe('sonnet[high]')
    expect(listed.models.map((model) => model.id)).toEqual(['sonnet[high]', 'sonnet[low]', 'opus[low]', 'opus[high]'])
  })
})

describe('claude history', () => {
  it('drops the client hint and keeps the typed question', () => {
    expect(visibleUserText('<agent_desktop_client>\nhint\n</agent_desktop_client>\n\n<user_query>\nhello\n</user_query>')).toBe('hello')
  })

  it('rebuilds user, thinking, assistant, and tool items and skips sidechains', () => {
    const text = [
      JSON.stringify({
        type: 'user',
        sessionId: 's1',
        cwd: 'D:/repo',
        timestamp: '2026-01-02T00:00:00.000Z',
        message: { role: 'user', content: '<agent_desktop_client>hint</agent_desktop_client>\n\nhello' }
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a' } }
          ]
        }
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }
      }),
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'hidden' }] }
      })
    ].join('\n')
    const items = claudeTranscriptItems(text)
    expect(items.map((item) => item.kind)).toEqual(['user', 'thinking', 'assistant', 'tool'])
    expect(items[0]).toMatchObject({ kind: 'user', text: 'hello' })
    expect(items[3]).toMatchObject({ kind: 'tool', tool: 'Read', status: 'success' })
  })

  it('scans project jsonl files and skips subagents', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-claude-hist-'))
    roots.push(root)
    const dir = path.join(root, 'D--repo')
    fs.mkdirSync(path.join(dir, 'subagents'), { recursive: true })
    const session = [
      JSON.stringify({ type: 'user', sessionId: 'sess-1', cwd: 'D:/repo', timestamp: '2026-01-02T00:00:00.000Z', message: { role: 'user', content: '第一句' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } })
    ].join('\n')
    fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), session)
    fs.writeFileSync(
      path.join(dir, 'subagents', 'child.jsonl'),
      JSON.stringify({ type: 'user', sessionId: 'child', cwd: 'D:/repo', message: { role: 'user', content: '不要导入' } })
    )
    const found = scanClaudeSessions(new Set(['sess-1']), root)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ chatId: 'sess-1', cli: 'claude', cwd: 'D:/repo', title: '第一句', imported: true })
  })
})
