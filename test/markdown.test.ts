import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import { unifiedDiff } from '../src/shared/unified-diff'
import { StreamReducer } from '../src/main/reducer'
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

describe('conversation changed-file lists', () => {
  const binary = (path: string) => ({ path, diff: `diff --git a/${path} b/${path}\nBinary files differ\n` })
  const text = (path: string) => ({ path, diff: unifiedDiff(path, 'before\n', 'after\n').text })
  const changes = (files: { path: string; diff: string }[]): Item => ({
    id: 'changes', kind: 'result', isError: false, fileChanges: files
  })

  it.each([
    ['zh-CN', '二进制文件（2）', '修改了 4 个文件'],
    ['en', 'Binary files (2)', 'Files changed: 4']
  ] as const)('hides binary names below the reply with correct %s counts and text order', (language, label, count) => {
    setLanguage(language)
    const html = renderThread([user, assistant('reply', 'Done'), changes([
      binary('hidden.dat'), text('second.ts'), binary('hidden.png'), text('first.ts')
    ])])
    expect(html).toContain(label)
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('hidden.dat')
    expect(html).not.toContain('hidden.png')
    expect(html).toContain(count)
    expect(html).toContain('<span class="add">+2</span>')
    expect(html).toContain('<span class="del">−2</span>')
    expect(html.indexOf('second.ts')).toBeLessThan(html.indexOf('first.ts'))
    expect(html.indexOf('first.ts')).toBeLessThan(html.indexOf(label))
    expect(html).not.toContain('class="diff-lines"')
  })

  it('keeps binary-only turns in the summary and omits groups for text-only or empty turns', () => {
    const binaryOnly = renderThread([changes([binary('hidden.dat')])])
    expect(binaryOnly).toContain('修改了 1 个文件')
    expect(binaryOnly).toContain('二进制文件（1）')
    expect(binaryOnly).not.toContain('hidden.dat')
    const textOnly = renderThread([changes([text('text.png')])])
    expect(textOnly).toContain('text.png')
    expect(textOnly).not.toContain('changes-binary-toggle')
    expect(renderThread([changes([])])).not.toContain('class="turn-files"')
  })

  it('renders a separate collapsed binary group for each completed turn', () => {
    const html = renderThread([
      user, changes([binary('first.dat')]),
      { ...user, id: 'next-user' }, { ...changes([binary('second.dat'), binary('third.dat')]), id: 'next-result' }
    ])
    expect(html.match(/changes-binary-toggle" aria-expanded="false"/g)).toHaveLength(2)
    expect(html).toContain('二进制文件（1）')
    expect(html).toContain('二进制文件（2）')
    for (const name of ['first.dat', 'second.dat', 'third.dat']) expect(html).not.toContain(name)
  })
})

describe('Chinese strong emphasis', () => {
  const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }))

  it.each([
    ['**xxx**', '<p><strong>xxx</strong></p>'],
    ['**中文粗体**', '<p><strong>中文粗体</strong></p>'],
    ['这是**粗体**文字', '<p>这是<strong>粗体</strong>文字</p>'],
    ['这是**“重点”**内容', '<p>这是<strong>“重点”</strong>内容</p>'],
    ['这是**重点：**内容', '<p>这是<strong>重点：</strong>内容</p>'],
    ['这是**（重点）**内容', '<p>这是<strong>（重点）</strong>内容</p>'],
    ['这是**「重点」**内容', '<p>这是<strong>「重点」</strong>内容</p>'],
    ['这是**"重点"**内容', '<p>这是<strong>&quot;重点&quot;</strong>内容</p>'],
    ['这是**“重点”**。', '<p>这是<strong>“重点”</strong>。</p>'],
    ['**重点：**内容', '<p><strong>重点：</strong>内容</p>'],
    ['**粗体和 *斜体***', '<p><strong>粗体和 <em>斜体</em></strong></p>'],
    ['***粗斜体***', '<p><em><strong>粗斜体</strong></em></p>'],
    ['这是**“含 *斜体*”**内容', '<p>这是<strong>“含 <em>斜体</em>”</strong>内容</p>']
  ])('renders %s', (text, expected) => {
    expect(render(text)).toBe(`<div class="markdown">${expected}</div>`)
  })

  it('renders multiple strong spans in paragraphs, lists, and GFM tables', () => {
    const html = render('这是**“甲”**以及**乙：**内容\n\n- 选择**（丙）**继续\n\n| 内容 |\n| --- |\n| 这是**“丁”**内容 |')
    expect(html.match(/<strong>/g)).toHaveLength(4)
    expect(html).toContain('<p>这是<strong>“甲”</strong>以及<strong>乙：</strong>内容</p>')
    expect(html).toContain('<li>选择<strong>（丙）</strong>继续</li>')
    expect(html).toContain('<td>这是<strong>“丁”</strong>内容</td>')
  })

  it.each([
    ['这是\\*\\*“重点”\\*\\*内容', '<p>这是**“重点”**内容</p>'],
    ['这是**“重点”', '<p>这是**“重点”</p>'],
    ['这是** 重点 **内容', '<p>这是** 重点 **内容</p>'],
    ['这是*“重点”*内容', '<p>这是*“重点”*内容</p>'],
    ['这是__“重点”__内容', '<p>这是__“重点”__内容</p>'],
    ['word**"bold"**word', '<p>word**&quot;bold&quot;**word</p>'],
    ['这是`**“重点”**`内容', '<p>这是<code class="inline-code">**“重点”**</code>内容</p>']
  ])('preserves literal or standard Markdown behavior for %s', (text, expected) => {
    expect(render(text)).toBe(`<div class="markdown">${expected}</div>`)
  })

  it('preserves fenced and indented code and link destinations', () => {
    const literal = '这是**“重点”**内容'
    for (const text of [`\`\`\`text\n${literal}\n\`\`\``, `    ${literal}`]) {
      const html = render(text)
      expect(html).toContain(`<pre><code>${literal}</code></pre>`)
      expect(html).not.toContain('<strong>')
    }
    const html = render('[链接](https://example.com/**bold**/file)')
    expect(html).toContain('href="https://example.com/**bold**/file"')
    expect(html).not.toContain('<strong>')
  })

  it('reparses streamed delimiters without changing saved or copied Markdown', () => {
    const text = '这是**“重点”**内容'
    const items: Item[] = [user]
    const reducer = new StreamReducer(items)
    for (const chunk of ['这是*', '*“重点”', '*', '*', '内容']) {
      reducer.handleAcp({ sessionUpdate: 'agent_message_chunk', messageId: 'final', content: { text: chunk } })
      const html = renderThread(items, true)
      const reply = items.at(-1) as AssistantItem
      if (reply.text === '这是**“重点”**' || reply.text === text) {
        expect(html).toContain('<strong>“重点”</strong>')
      } else {
        expect(html).not.toContain('<strong>')
      }
    }
    expect(items.at(-1)).toMatchObject({ kind: 'assistant', text })
    const before = JSON.stringify(items)
    items.push(result)
    const html = renderThread(items)
    expect(html).toContain('这是<strong>“重点”</strong>内容')
    expect(actions.copyTexts).toContain(text)
    expect(JSON.stringify(items.slice(0, -1))).toBe(before)
  })
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

  it.each([
    ['commentary', 'final'], ['known', undefined], [undefined, 'known']
  ])('does not rejoin independent ACP messages across background activity (%s, %s)', (first, second) => {
    const items = [
      { ...assistant('first', 'Progress.'), messageId: first }, background(),
      { ...assistant('second', questions), messageId: second }
    ]
    expect(mergeInterruptedAssistantMessages(items)).toEqual(items)
  })

  it('rejoins fragments of the same identified ACP message', () => {
    const tool = background()
    const merged = mergeInterruptedAssistantMessages([
      { ...assistant('first', prefix), messageId: 'same' }, tool,
      { ...assistant('second', suffix), messageId: 'same' }
    ])
    expect(merged).toEqual([tool, { ...assistant('second', questions), messageId: 'same' }])
  })
})

describe('Markdown at ACP message boundaries', () => {
  it.each([false, true])('renders and copies the final questions card after commentary (background=%s)', (withBackground) => {
    const items: Item[] = [user]
    const reducer = new StreamReducer(items)
    reducer.handleAcp({ sessionUpdate: 'agent_message_chunk', messageId: 'commentary', content: { text: '已找到存档。' } })
    if (withBackground) {
      reducer.handleAcp({
        sessionUpdate: 'tool_call', toolCallId: 'child-done', status: 'completed',
        rawInput: { agentThreadId: 'child', activityKind: 'completed' }
      })
    }
    const final = questions.slice(questions.indexOf('```questions'))
    const split = final.indexOf('Which') + 2
    reducer.handleAcp({ sessionUpdate: 'agent_message_chunk', messageId: 'final', content: { text: final.slice(0, split) } })
    reducer.handleAcp({ sessionUpdate: 'agent_message_chunk', messageId: 'final', content: { text: final.slice(split) } })
    const finalId = items.at(-1)!.id
    items.push(result)
    const html = renderThread(items)

    expect(html).toContain('Choose a color')
    expect(html).toContain('Which color?')
    expect(html).toContain('class="question-actions"')
    expect(html).not.toContain('class="code-block"')
    expect(actions.copyTexts).toContain(final)
    expect(actions.copyTexts).not.toContain('已找到存档。' + final)
    actions.forks.at(-1)!()
    expect(actions.forkThread).toHaveBeenCalledWith(thread.id, finalId)
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
