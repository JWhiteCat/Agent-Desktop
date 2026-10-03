import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import { mergeInterruptedAssistantMessages } from '../src/shared/transcript'
import { DEFAULT_SETTINGS, type AssistantItem, type Item, type ThreadMeta, type ToolItem } from '../src/shared/types'
import { ThreadView } from '../src/renderer/src/components/ThreadView'
import { Markdown } from '../src/renderer/src/components/items/Markdown'

const state = vi.hoisted(() => ({ current: {} as unknown }))
const actions = vi.hoisted(() => ({
  copyTexts: [] as string[],
  forks: [] as Array<() => void>,
  forkThread: vi.fn()
}))

vi.mock('../src/renderer/src/store', () => ({
  useStore: (selector: (value: unknown) => unknown) => selector(state.current),
  cliCommands: () => [],
  chatModel: vi.fn(),
  forkThread: actions.forkThread,
  prepareCommands: vi.fn(),
  sendMessage: vi.fn(),
  setCliProvider: vi.fn(),
  answerQuestion: vi.fn()
}))
vi.mock('../src/renderer/src/components/Composer', () => ({ Composer: () => null }))
vi.mock('../src/renderer/src/components/items/primitives', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/renderer/src/components/items/primitives')>()
  return {
    ...original,
    CopyButton: (props: Parameters<typeof original.CopyButton>[0]) => {
      actions.copyTexts.push(props.text)
      return createElement(original.CopyButton, props)
    },
    ForkButton: (props: Parameters<typeof original.ForkButton>[0]) => {
      actions.forks.push(props.onFork)
      return createElement(original.ForkButton, props)
    }
  }
})

function assistant(id: string, text: string): AssistantItem {
  return { id, kind: 'assistant', text }
}

function background(id = 'background'): ToolItem {
  return {
    id, kind: 'tool', callId: id, tool: 'Background agent completed', status: 'success',
    args: { agentThreadId: 'child-session', agentPath: '/root/reviewer', activityKind: 'completed' },
    result: { success: { stdout: 'Review complete' } }, startedAt: 1, endedAt: 2
  }
}

const questions = 'Please choose:\n\n```questions\n' + JSON.stringify({
  title: 'Choose a color',
  questions: [{ id: 'color', prompt: 'Which color?', options: ['Blue', 'Green'] }]
}) + '\n```\n\nThanks.'
const splitAt = questions.indexOf('Which') + 2
const prefix = questions.slice(0, splitAt)
const suffix = questions.slice(splitAt)
const user: Item = { id: 'user', kind: 'user', text: 'Help me choose', createdAt: 1 }
const result: Item = { id: 'result', kind: 'result', isError: false, cli: 'codex' }
const thread: ThreadMeta = {
  id: 'thread', projectId: 'project', title: 'Markdown regression', cli: 'codex',
  mode: 'agent', createdAt: 1, updatedAt: 2, source: 'app'
}

function renderThread(items: Item[], running = false): string {
  state.current = {
    items: { [thread.id]: items },
    app: {
      running: running ? [thread.id] : [], projects: [{ id: 'project', path: 'C:/example', name: 'Example' }],
      settings: DEFAULT_SETTINGS
    },
    modelsByCli: { codex: [] }, models: [], commandsByThread: {}
  }
  return renderToStaticMarkup(createElement(ThreadView, { thread, changesOpen: false, onToggleChanges: () => {} }))
}

beforeEach(() => {
  setLanguage('zh-CN', 'zh-CN')
  vi.stubGlobal('window', { api: { isRemote: true } })
  actions.copyTexts.length = 0
  actions.forks.length = 0
  actions.forkThread.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('system', 'zh-CN')
})

describe('assistant messages interrupted by background completions', () => {
  it('joins exact text without mutating history, preserving tools and the final fork checkpoint', () => {
    const tool = background()
    Object.freeze(tool.args)
    Object.freeze(tool.result)
    const items = Object.freeze([
      Object.freeze(assistant('prefix', prefix)), Object.freeze(tool), Object.freeze(assistant('suffix', suffix))
    ])
    const before = JSON.stringify(items)
    const merged = mergeInterruptedAssistantMessages(items)

    expect(merged).toEqual([tool, assistant('suffix', questions)])
    expect(merged[0]).toBe(tool)
    expect(merged[1]).not.toBe(items[2])
    expect(JSON.stringify(items)).toBe(before)
    expect(mergeInterruptedAssistantMessages(merged)).toEqual(merged)
    const checkpoint = items.findIndex((item) => item.id === merged[1].id)
    expect(items.slice(0, checkpoint + 1).filter((item) => item.kind === 'assistant').map((item) => item.text).join('')).toBe(questions)
  })

  it('preserves whitespace through multiple interrupted fragments and consecutive notifications', () => {
    const first = background('first')
    const second = background('second')
    const third = background('third')
    const fragments = ['```js\r\nconst value = "', 'a  b";\r\n', '```\n']
    const merged = mergeInterruptedAssistantMessages([
      assistant('a', fragments[0]), first, second, assistant('b', fragments[1]), third, assistant('c', fragments[2])
    ])
    expect(merged).toEqual([first, second, third, assistant('c', fragments.join(''))])
    expect(merged.slice(0, 3)).toEqual([first, second, third])
  })

  const boundaries: Item[] = [
    { ...background('ordinary-tool'), tool: 'shell', args: { command: 'echo done' } },
    { ...background('active-child'), args: { agentThreadId: 'child-session', activityKind: 'started' } },
    { ...background('missing-child'), args: { activityKind: 'completed' } },
    { id: 'thinking', kind: 'thinking', text: 'Thinking', done: true, startedAt: 1 },
    user, result,
    { id: 'notice', kind: 'notice', level: 'info', text: 'Notice' },
    { id: 'question', kind: 'question', toolCallId: 'ask', questions: [], status: 'answered' }
  ]

  it.each(boundaries)('does not join across $id', (boundary) => {
    const items = [assistant('prefix', prefix), background(), boundary, assistant('suffix', suffix)]
    expect(mergeInterruptedAssistantMessages(items)).toEqual(items)
  })

  it('keeps adjacent assistant messages and notifications without a following fragment unchanged', () => {
    for (const items of [
      [assistant('first', 'First reply'), assistant('second', 'Second reply')],
      [assistant('first', prefix), background()],
      [background(), assistant('first', suffix)]
    ]) {
      expect(mergeInterruptedAssistantMessages(items)).toEqual(items)
    }
  })
})

describe('Markdown rendering after background activity', () => {
  it('renders a questions block split inside a JSON token as one complete question card', () => {
    const merged = mergeInterruptedAssistantMessages([assistant('prefix', prefix), background(), assistant('suffix', suffix)])
    const reply = merged.find((item): item is AssistantItem => item.kind === 'assistant')!
    const html = renderToStaticMarkup(createElement(Markdown, { text: reply.text }))

    expect(html).toContain('class="question-card locked"')
    expect(html).toContain('Choose a color')
    expect(html).toContain('Which color?')
    expect(html).toContain('Blue')
    expect(html).toContain('Green')
    expect(html).toContain('<p>Thanks.</p>')
    expect(html).not.toContain('class="code-block"')
  })

  it('restores a standard fenced code block interrupted inside the opening fence', () => {
    const text = 'Example:\n\n```ts\nconst message = "hello";\n```\n\nDone.'
    const split = text.indexOf('```') + 2
    const merged = mergeInterruptedAssistantMessages([
      assistant('prefix', text.slice(0, split)), background(), assistant('suffix', text.slice(split))
    ])
    const reply = merged.find((item): item is AssistantItem => item.kind === 'assistant')!
    const html = renderToStaticMarkup(createElement(Markdown, { text: reply.text }))

    expect(html.match(/class="code-block"/g)).toHaveLength(1)
    expect(html).toContain('<span>ts</span>')
    expect(html).toContain('<pre><code>const message = &quot;hello&quot;;</code></pre>')
    expect(html).toContain('<p>Done.</p>')
  })

  it('shows and copies the full idle answer and forks through its final persisted fragment', () => {
    const html = renderThread([user, assistant('prefix', prefix), background(), assistant('suffix', suffix), result])

    expect(html).toContain('Choose a color')
    expect(html).toContain('Which color?')
    expect(html).toContain('class="question-actions"')
    expect(html).not.toContain('class="code-block"')
    expect(html.match(/class="msg-assistant-wrap"/g)).toHaveLength(1)
    expect(actions.copyTexts).toContain(questions)
    actions.forks.at(-1)!()
    expect(actions.forkThread).toHaveBeenCalledWith(thread.id, 'suffix')
  })

  it('keeps a partial questions block loading while background completions trail the active assistant', () => {
    const html = renderThread([user, assistant('prefix', prefix), background('first'), background('second')], true)

    expect(html).toContain('class="msg-assistant streaming"')
    expect(html).toContain('class="question-card locked question-loading"')
    expect(html).toContain('正在准备问题…')
    expect(html).not.toContain('class="code-block"')
    expect(html).not.toContain('class="working"')
  })

  it.each(['tool', 'thinking'] as const)('does not continue assistant streaming through genuine %s work', (kind) => {
    const active: Item = kind === 'tool'
      ? { ...background('active'), tool: 'shell', args: { command: 'echo working' }, status: 'running' }
      : { id: 'active', kind: 'thinking', text: 'Thinking', done: false, startedAt: 1 }
    const html = renderThread([user, assistant('prefix', prefix), active, background()], true)

    expect(html).not.toContain('class="msg-assistant streaming"')
    expect(html).not.toContain('question-loading')
    expect(html).not.toContain('class="working"')
  })
})
