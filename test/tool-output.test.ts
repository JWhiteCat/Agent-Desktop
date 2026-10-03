import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import type { Item, ToolItem } from '../src/shared/types'
import { StreamReducer } from '../src/main/reducer'
import { ToolDetail, ToolRow } from '../src/renderer/src/components/items/ToolRow'
import { toolForDisplay } from '../src/renderer/src/lib/tools'

afterEach(() => setLanguage('system', 'zh-CN'))

const command: ToolItem = {
  id: 'command', kind: 'tool', callId: 'exec-1', tool: 'shell',
  args: { command: 'gh search prs example' }, status: 'error', startedAt: 1
}

const mcp: ToolItem = {
  ...command, id: 'mcp', callId: 'mcp-1',
  args: { server: 'codex_apps', tool: 'github.search_prs', arguments: { query: 'example' } },
  result: {
    error: null,
    result: { content: [{ type: 'text', text: 'Action completed.' }], structuredContent: { issues: [] } }
  }
}

function detail(item: ToolItem): string {
  return renderToStaticMarkup(createElement(ToolDetail, { item }))
}

function row(item: ToolItem): string {
  return renderToStaticMarkup(createElement(ToolRow, { item }))
}

describe('Codex tool output', () => {
  it('renders stored command output and its nonzero exit code', () => {
    const item = { ...command, result: { formatted_output: 'Invalid search query\r\n', exit_code: 1 } }
    expect(detail(item)).toContain('Invalid search query')
    expect(detail(item)).toContain('退出码 1')
    expect(row(item)).toContain('step failed')
    expect(row(item)).toContain('退出码 1')
  })

  it.each(['completed', 'failed'])('renders output from a live ACP %s command', (status) => {
    const items: Item[] = []
    const reducer = new StreamReducer(items)
    reducer.handleAcp({ sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'execute', status: 'in_progress', rawInput: command.args })
    reducer.handleAcp({
      sessionUpdate: 'tool_call_update', toolCallId: 'c1', status,
      rawOutput: { formatted_output: 'command details\n', exit_code: status === 'failed' ? 1 : 0 }
    })
    const item = items[0] as ToolItem
    expect(detail(item)).toContain('command details')
    expect(detail(item)).toContain(`退出码 ${status === 'failed' ? 1 : 0}`)
    expect(row(item).includes('step failed')).toBe(status === 'failed')
  })

  it.each(['zh-CN', 'en'] as const)('explains genuinely empty command output in %s', (language) => {
    setLanguage(language)
    const html = detail({ ...command, result: { formatted_output: '', exit_code: 1 } })
    expect(html).toContain(language === 'en' ? 'The command produced no output.' : '命令未产生输出。')
    expect(html).toContain(language === 'en' ? 'Exit code 1' : '退出码 1')
  })

  it('does not show an empty-output message while the command is running', () => {
    expect(detail({ ...command, status: 'running' })).not.toContain('命令未产生输出。')
  })

  it('keeps Cursor-style stdout, stderr and command failures visible', () => {
    const html = detail({ ...command, result: { success: { stdout: 'partial result', stderr: 'permission denied', exitCode: 2 } } })
    expect(html).toContain('partial result\npermission denied')
    expect(html).toContain('退出码 2')
    expect(detail({ ...command, result: { error: { message: 'spawn failed' } } })).toContain('spawn failed')
  })

  it('displays a saved successful MCP call as a tool with its result, without mutating history', () => {
    const item = { ...mcp, status: 'success' as const }
    const before = JSON.stringify(item)
    const html = row(item)
    expect(html).not.toContain('step failed')
    expect(html).toContain('调用工具')
    expect(html).toContain('github.search_prs')
    expect(detail(item)).toContain('Action completed.')
    expect(detail(item)).toContain('structuredContent')
    expect(detail(item)).not.toContain('shell-cmd')
    expect(JSON.stringify(item)).toBe(before)
  })

  it.each([
    mcp.result,
    { error: { message: 'transport failed' }, result: null },
    { error: null, result: { isError: true, content: [{ type: 'text', text: 'tool failed' }] } },
    undefined
  ])('preserves a saved MCP failure or interrupted call: %j', (result) => {
    expect(row({ ...mcp, result })).toContain('step failed')
  })

  it('does not change explicitly failed MCP calls saved by the fixed reducer', () => {
    const item = { ...mcp, tool: 'mcp.codex_apps.github.search_prs' }
    expect(toolForDisplay(item)).toBe(item)
    expect(row(item)).toContain('step failed')
  })
})
