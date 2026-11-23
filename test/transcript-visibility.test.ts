import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCliTranscript } from '../src/main/history'
import { StreamReducer } from '../src/main/reducer'
import { finalizeTurnItems } from '../src/main/session/finalize'
import {
  isBackgroundFollowupTool,
  isCursorAgentToolsTool,
  isCursorTerminalTool,
  latestTurnPreview,
  visibleAssistantIndices,
  visibleAssistantText
} from '../src/shared/transcript'
import type { AssistantItem, Item, ThinkingItem, ToolItem, UserItem } from '../src/shared/types'

const user = (id: string, text = 'prompt'): UserItem => ({ id, kind: 'user', text, createdAt: 1 })
const assistant = (id: string, text: string): AssistantItem => ({ id, kind: 'assistant', text })
const thinking = (id: string, text = 'Thinking'): ThinkingItem => ({ id, kind: 'thinking', text, done: true, startedAt: 1, endedAt: 2 })
const tool = (id: string, name: string, args: Record<string, unknown> = {}): ToolItem => ({
  id, kind: 'tool', callId: id, tool: name, args, status: 'success', startedAt: 1, endedAt: 2
})

function encodeVarint(value: number): number[] {
  const out: number[] = []
  let n = value
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}

function encodeRootBlob(messageIdsHex: string[]): Buffer {
  const chunks: Buffer[] = []
  for (const hex of messageIdsHex) {
    const raw = Buffer.from(hex, 'hex')
    chunks.push(Buffer.from([...encodeVarint((1 << 3) | 2), ...encodeVarint(raw.length)]), raw)
  }
  return Buffer.concat(chunks)
}

describe('transcript visible assistant selection', () => {
  it('keeps main answer and trailing background follow-up separated by thinking', () => {
    const steps: Item[] = [
      tool('t1', 'shell', { command: 'git log' }),
      thinking('th1'),
      assistant('main', '完整的 48 个提交排查结论。'),
      thinking('th2'),
      assistant('followup', '后台查询任务已结束，结果与上述结论一致。')
    ]
    expect(visibleAssistantIndices(steps)).toEqual([2, 4])
    expect(visibleAssistantText(steps)).toBe('完整的 48 个提交排查结论。\n\n后台查询任务已结束，结果与上述结论一致。')
  })

  it('keeps main answer followed by Cursor background terminal log read', () => {
    const termRead = tool('t2', 'read', {
      path: 'C:\\Users\\demo\\.cursor\\projects\\repo\\terminals\\555420.txt'
    })
    expect(isCursorTerminalTool(termRead)).toBe(true)
    expect(isBackgroundFollowupTool(termRead)).toBe(true)

    const steps: Item[] = [
      tool('t1', 'grep', { pattern: 'Throttle' }),
      assistant('main', '基于当前代码，存在以下问题。'),
      thinking('th1'),
      termRead,
      assistant('followup', '后台全量搜索已结束，结果一致。')
    ]
    expect(visibleAssistantIndices(steps)).toEqual([1, 4])
  })

  it('keeps substantial main answer followed by agent-tools check or follow-up verification shell', () => {
    const bigAnswer = '已完成全部修改说明：' + '详细内容。'.repeat(60)
    const agentToolsShell = tool('t2', 'shell', {
      command: 'rg -v foo "C:\\Users\\demo\\.cursor\\projects\\repo\\agent-tools\\abc.txt"'
    })
    expect(isCursorAgentToolsTool(agentToolsShell)).toBe(true)

    const stepsWithAgentTools: Item[] = [
      tool('t1', 'edit', { path: 'a.ts' }),
      assistant('main', bigAnswer),
      thinking('th1'),
      agentToolsShell,
      assistant('followup', '后台复核搜索已完成，无新增命中。')
    ]
    expect(visibleAssistantIndices(stepsWithAgentTools)).toEqual([1, 4])

    const stepsWithTerminalThenShell: Item[] = [
      assistant('main', bigAnswer),
      thinking('th1'),
      tool('t2', 'read', { path: '/home/u/.cursor/projects/repo/terminals/788802.txt' }),
      assistant('mid', '后台历史查询已完成，我再抽查一个提交。'),
      tool('t3', 'shell', { command: 'git show abc123' }),
      assistant('followup', '抽查完毕，之前结论不变。')
    ]
    expect(visibleAssistantIndices(stepsWithTerminalThenShell)).toEqual([0, 5])
  })

  it('collapses short pre-tool commentary, mid-turn agent-tools reads, and retriable stream errors', () => {
    const codingTurn: Item[] = [
      assistant('c1', '先看下代码结构。'),
      tool('t1', 'read', { path: 'src/index.ts' }),
      assistant('c2', '现在开始修改。'),
      tool('t2', 'edit', { path: 'src/index.ts' }),
      assistant('final', '修改完成，测试通过。')
    ]
    expect(visibleAssistantIndices(codingTurn)).toEqual([4])

    const midTurnAgentTools: Item[] = [
      assistant('c1', '我把脚本换到临时目录再解析一次。'),
      tool('t1', 'shell', { command: 'py analyze.py "C:\\u\\.cursor\\projects\\p\\agent-tools\\1.txt"' }),
      assistant('c2', '再展开工作线程看看。'),
      tool('t2', 'shell', { command: 'py analyze2.py "C:\\u\\.cursor\\projects\\p\\agent-tools\\2.txt"' }),
      assistant('final', '最终详细性能分析结论：' + '数据细节。'.repeat(80))
    ]
    expect(visibleAssistantIndices(midTurnAgentTools)).toEqual([4])

    const retriableErrorTurn: Item[] = [
      assistant('err', '  Error: RetriableError: Stream ended without turnEnded — connection likely dropped.'),
      thinking('th1'),
      assistant('final', '真正恢复后的完整回答。')
    ]
    expect(visibleAssistantIndices(retriableErrorTurn)).toEqual([2])
  })

  it('preserves replies before Antigravity reactive wakeup result boundaries', () => {
    const steps: Item[] = [
      assistant('initial', '已启动后台构建，先汇报初步结论。'),
      thinking('th2'),
      tool('t2', 'shell', { command: 'npm test' }),
      assistant('wakeup', '后台构建与测试已全部通过。')
    ]
    expect(visibleAssistantIndices(steps, [1])).toEqual([0, 3])
  })
})

describe('turn preview and finalization', () => {
  it('uses the substantial main answer in latestTurnPreview and finalizeTurnItems instead of only the short background follow-up', () => {
    const main = '统计范围：UE4181 仓库共 48 个提交的完整开关状态汇总。' + '详细表格与结论说明。'.repeat(25)
    const followup = '后台查询任务已结束，无需补充调整。'
    const items: Item[] = [user('u1')]
    const reducer = new StreamReducer(items, undefined, 'cursor')
    reducer.handleAcp({ sessionUpdate: 'agent_message_chunk', content: { text: main } })
    reducer.handleAcp({ sessionUpdate: 'agent_thought_chunk', content: { text: 'Background task done' } })
    reducer.handleAcp({ sessionUpdate: 'agent_message_chunk', content: { text: followup } })
    reducer.gotResult = true

    const finalized = finalizeTurnItems({
      items,
      reducer,
      provider: 'cursor',
      model: 'gemini-4-neon-high',
      stopped: false,
      stderr: '',
      code: 0,
      recover: false
    })

    expect(finalized.preview).toBe(main.slice(0, 120))
    expect(latestTurnPreview(items)).toBe(finalized.preview)
  })

  it('keeps the final reply as preview when the earlier visible reply is only a short interim status', () => {
    const items: Item[] = [
      user('u1'),
      assistant('a1', 'Deploying now...'),
      thinking('th1'),
      assistant('a2', '部署完成。')
    ]
    expect(latestTurnPreview(items, { currentTurnOnly: true })).toBe('部署完成。')
  })

  it('does not leak an earlier turn preview when the current turn produced no assistant output', () => {
    const items: Item[] = [
      user('u1', 'first'),
      assistant('a1', '第一轮的回答'),
      { id: 'r1', kind: 'result', isError: false },
      user('u2', 'second')
    ]
    expect(latestTurnPreview(items, { currentTurnOnly: true })).toBe('')
    expect(latestTurnPreview(items)).toBe('第一轮的回答')
  })
})

describe('Cursor CLI transcript import with background task system notifications', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips injected <system_notification> task prompts so both answers stay in one turn', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-cursor-bg-'))
    tempDirs.push(home)
    vi.spyOn(os, 'homedir').mockReturnValue(home)

    const chatId = '33533393-test-chat'
    const chatDir = path.join(home, '.cursor', 'chats', 'ws-hash', chatId)
    fs.mkdirSync(chatDir, { recursive: true })
    fs.writeFileSync(path.join(chatDir, 'meta.json'), JSON.stringify({ cwd: home, createdAtMs: 1000 }))

    const db = new DatabaseSync(path.join(chatDir, 'store.db'))
    try {
      db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);')
      const messages = [
        { role: 'user', content: '<user_query>查一下所有开关</user_query>' },
        { role: 'assistant', content: [{ type: 'text', text: '完整排查报告内容。' }] },
        {
          role: 'user',
          content: '<timestamp>Mon</timestamp>\n<system_notification>\nThe following task has finished.\n</system_notification>\n<user_query>Briefly inform the user about the task result and perform any follow-up actions (if needed).</user_query>'
        },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Checking completed task' },
            { type: 'text', text: '后台查询任务已结束，结论一致。' }
          ]
        }
      ]
      const ids: string[] = []
      const insertBlob = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)')
      messages.forEach((msg, index) => {
        const id = (index + 1).toString(16).padStart(64, '0')
        ids.push(id)
        insertBlob.run(id, Buffer.from(JSON.stringify(msg), 'utf8'))
      })
      const rootId = 'f'.repeat(64)
      insertBlob.run(rootId, encodeRootBlob(ids))
      const metaHex = Buffer.from(JSON.stringify({ latestRootBlobId: rootId }), 'utf8').toString('hex')
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', metaHex)
    } finally {
      db.close()
    }

    const transcript = readCliTranscript(chatId)
    expect(transcript).toBeDefined()
    expect(transcript!.filter((it) => it.kind === 'user')).toHaveLength(1)
    expect(transcript!.filter((it) => it.kind === 'assistant').map((it) => it.text)).toEqual([
      '完整排查报告内容。',
      '后台查询任务已结束，结论一致。'
    ])
  })
})
