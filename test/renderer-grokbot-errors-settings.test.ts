import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import {
  DEFAULT_SETTINGS,
  type AppState,
  type GitDiff,
  type GrokBotList,
  type GrokBotMessage,
  type GrokBotTurn,
  type QueuedMessage,
  type RemoteInfo,
  type ThreadMeta,
  type ToolItem
} from '../src/shared/types'

interface GrokBotPollResult {
  messages: GrokBotMessage[]
  cursor: string
  turn: GrokBotTurn
  sessionId?: string
  reset?: boolean
}

interface HookCell {
  value: unknown
  deps?: unknown[]
  cleanup?: (() => void) | void
  kind: 'state' | 'ref' | 'memo' | 'layout' | 'effect' | 'id'
}

function depsChanged(prev: unknown[] | undefined, next: unknown[] | undefined): boolean {
  if (!prev || !next || prev.length !== next.length) return true
  for (let i = 0; i < prev.length; i++) {
    if (!Object.is(prev[i], next[i])) return true
  }
  return false
}

const hooks = vi.hoisted(() => ({
  active: false,
  cells: [] as HookCell[],
  index: 0,
  pendingLayouts: [] as Array<{ cell: HookCell; create: () => (() => void) | void; deps?: unknown[] }>,
  pendingEffects: [] as Array<{ cell: HookCell; create: () => (() => void) | void; deps?: unknown[] }>,
  contexts: new Map<unknown, unknown>(),
  renderStateChanged: false,
  onUpdate: null as (() => void) | null
}))

vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (!hooks.active) return actual.useState(initial)
      const i = hooks.index++
      if (!hooks.cells[i]) {
        hooks.cells[i] = {
          kind: 'state',
          value: typeof initial === 'function' ? (initial as () => unknown)() : initial
        }
      }
      const cell = hooks.cells[i]
      const setState = (next: unknown) => {
        const value = typeof next === 'function' ? (next as (prev: unknown) => unknown)(cell.value) : next
        if (Object.is(cell.value, value)) return
        cell.value = value
        if (hooks.onUpdate) hooks.onUpdate()
        else hooks.renderStateChanged = true
      }
      return [cell.value, setState]
    },
    useRef: (initial: unknown) => {
      if (!hooks.active) return actual.useRef(initial)
      const i = hooks.index++
      if (!hooks.cells[i]) hooks.cells[i] = { kind: 'ref', value: { current: initial } }
      return hooks.cells[i].value
    },
    useMemo: (factory: () => unknown, deps?: unknown[]) => {
      if (!hooks.active) return actual.useMemo(factory, deps ?? [])
      const i = hooks.index++
      const cell = hooks.cells[i]
      if (!cell || depsChanged(cell.deps, deps)) {
        hooks.cells[i] = { kind: 'memo', value: factory(), deps }
      }
      return hooks.cells[i].value
    },
    useCallback: (fn: unknown, deps?: unknown[]) => {
      if (!hooks.active) return actual.useCallback(fn as (...args: never[]) => unknown, deps ?? [])
      const i = hooks.index++
      const cell = hooks.cells[i]
      if (!cell || depsChanged(cell.deps, deps)) {
        hooks.cells[i] = { kind: 'memo', value: fn, deps }
      }
      return hooks.cells[i].value
    },
    useLayoutEffect: (create: () => (() => void) | void, deps?: unknown[]) => {
      if (!hooks.active) return actual.useLayoutEffect(create, deps)
      const i = hooks.index++
      if (!hooks.cells[i]) hooks.cells[i] = { kind: 'layout', value: undefined }
      const cell = hooks.cells[i]
      if (cell.deps === undefined || depsChanged(cell.deps, deps)) {
        hooks.pendingLayouts.push({ cell, create, deps })
      }
    },
    useEffect: (create: () => (() => void) | void, deps?: unknown[]) => {
      if (!hooks.active) return actual.useEffect(create, deps)
      const i = hooks.index++
      if (!hooks.cells[i]) hooks.cells[i] = { kind: 'effect', value: undefined }
      const cell = hooks.cells[i]
      if (cell.deps === undefined || depsChanged(cell.deps, deps)) {
        hooks.pendingEffects.push({ cell, create, deps })
      }
    },
    useImperativeHandle: (ref: unknown, create: () => unknown) => {
      if (!hooks.active) return actual.useImperativeHandle(ref as never, create)
      if (ref && typeof ref === 'object' && 'current' in ref) {
        ;(ref as { current: unknown }).current = create()
      }
    },
    useContext: (ctx: { _currentValue?: unknown }) => {
      if (!hooks.active) return actual.useContext(ctx as never)
      if (hooks.contexts.has(ctx)) return hooks.contexts.get(ctx)
      return ctx._currentValue
    },
    useId: () => {
      if (!hooks.active) return actual.useId()
      const i = hooks.index++
      if (!hooks.cells[i]) hooks.cells[i] = { kind: 'id', value: `:id-${i}:` }
      return hooks.cells[i].value
    },
    useSyncExternalStore: (sub: (cb: () => void) => () => void, getSnapshot: () => unknown, getServerSnapshot?: () => unknown) => {
      if (!hooks.active) return actual.useSyncExternalStore(sub as never, getSnapshot, getServerSnapshot)
      const i = hooks.index++
      if (!hooks.cells[i]) {
        const unsub = sub(() => {
          if (hooks.onUpdate) hooks.onUpdate()
        })
        hooks.cells[i] = { kind: 'effect', value: undefined, cleanup: unsub }
      }
      return getSnapshot()
    }
  }
})

const mocks = vi.hoisted(() => ({
  state: {
    app: {
      projects: [] as AppState['projects'],
      threads: [] as ThreadMeta[],
      running: [] as string[],
      waitingForInput: [] as string[],
      queued: {} as NonNullable<AppState['queued']>,
      settings: {} as AppState['settings']
    } as AppState,
    items: {} as Record<string, unknown[]>,
    models: [] as unknown[],
    modelsByCli: {} as Record<string, unknown[]>,
    view: { kind: 'home' } as { kind: 'home'; projectId?: string } | { kind: 'thread'; id: string } | { kind: 'grokbot'; botId?: string },
    sidebarReveal: undefined,
    taskNavigationPending: false
  },
  toasts: [] as Array<{ text: string; level: string }>,
  removeQueued: vi.fn(),
  reorderQueued: vi.fn(),
  sendQueuedNow: vi.fn(),
  openGrokBot: vi.fn(),
  rememberModel: vi.fn(),
  loadModels: vi.fn(),
  addProjectInteractive: vi.fn(),
  collapseAllProjects: vi.fn(),
  goHome: vi.fn(),
  openNextRunningThread: vi.fn(),
  openNextUnreadThread: vi.fn(),
  qrToDataURL: vi.fn(async () => 'data:image/png;base64,fake')
}))

vi.mock('qrcode', () => ({
  default: { toDataURL: (...args: unknown[]) => mocks.qrToDataURL(...(args as [])) }
}))

vi.mock('../src/renderer/src/store/feedback', async (original) => {
  const actual = await original<typeof import('../src/renderer/src/store/feedback')>()
  return {
    ...actual,
    toast: (text: string, level: 'info' | 'error' = 'info') => {
      mocks.toasts.push({ text, level })
    },
    toastError: (err: unknown) => {
      if (err && typeof err === 'object') {
        if ((err as { __mockReported?: boolean }).__mockReported) return
        ;(err as { __mockReported?: boolean }).__mockReported = true
      }
      mocks.toasts.push({ text: actual.errorText(err), level: 'error' })
    }
  }
})

vi.mock('../src/renderer/src/store', async () => {
  const feedback = await import('../src/renderer/src/store/feedback')
  return {
    useStore: (selector: (s: typeof mocks.state) => unknown) => selector(mocks.state),
    toast: feedback.toast,
    toastError: feedback.toastError,
    errorText: feedback.errorText,
    removeQueued: (...args: unknown[]) => mocks.removeQueued(...args),
    reorderQueued: (...args: unknown[]) => mocks.reorderQueued(...args),
    sendQueuedNow: (...args: unknown[]) => mocks.sendQueuedNow(...args),
    openGrokBot: (...args: unknown[]) => mocks.openGrokBot(...args),
    rememberModel: (...args: unknown[]) => mocks.rememberModel(...args),
    loadModels: (...args: unknown[]) => mocks.loadModels(...args),
    addProjectInteractive: (...args: unknown[]) => mocks.addProjectInteractive(...args),
    collapseAllProjects: (...args: unknown[]) => mocks.collapseAllProjects(...args),
    goHome: (...args: unknown[]) => mocks.goHome(...args),
    openNextRunningThread: (...args: unknown[]) => mocks.openNextRunningThread(...args),
    openNextUnreadThread: (...args: unknown[]) => mocks.openNextUnreadThread(...args)
  }
})

vi.mock('../src/renderer/src/components/ResizeHandle', () => ({ ResizeHandle: () => null }))
vi.mock('../src/renderer/src/components/CliInstallAction', () => ({
  CliInstallAction: () => null,
  useCliInstallStatus: () => null
}))

import { GrokBotView } from '../src/renderer/src/components/GrokBotView'
import { forgetGrokBotChat } from '../src/renderer/src/store/grokbot'
import { Composer } from '../src/renderer/src/components/Composer'
import { QueuedMessages } from '../src/renderer/src/components/QueuedMessages'
import { PlanCard } from '../src/renderer/src/components/items/PlanCard'
import { QuestionForm } from '../src/renderer/src/components/items/Questions'
import { ItemDraftContext, TurnActionsContext } from '../src/renderer/src/components/items/TurnActions'
import { ImportDialog } from '../src/renderer/src/components/ImportDialog'
import { ChangesPanel } from '../src/renderer/src/components/ChangesPanel'
import { CliCard } from '../src/renderer/src/components/settings/CliCard'
import { RemoteSettings } from '../src/renderer/src/components/settings/RemoteSettings'
import { Sidebar } from '../src/renderer/src/components/Sidebar'
import { toastError } from '../src/renderer/src/store/feedback'

function mountComponent<P>(
  Component: (props: P) => ReactNode,
  initialProps: P,
  contexts: Array<[unknown, unknown]> = []
) {
  hooks.active = true
  hooks.cells = []
  hooks.index = 0
  hooks.pendingLayouts = []
  hooks.pendingEffects = []
  hooks.contexts = new Map(contexts)
  hooks.renderStateChanged = false
  hooks.onUpdate = null

  let props = initialProps
  let tree: ReactNode = null

  const render = () => {
    hooks.active = true
    hooks.onUpdate = null
    let guard = 0
    do {
      hooks.renderStateChanged = false
      hooks.index = 0
      hooks.pendingLayouts = []
      hooks.pendingEffects = []
      tree = Component(props)
      if (++guard > 20) throw new Error('Too many synchronous re-renders')
    } while (hooks.renderStateChanged)

    hooks.onUpdate = () => render()
    const layouts = hooks.pendingLayouts.splice(0)
    for (const item of layouts) {
      if (typeof item.cell.cleanup === 'function') item.cell.cleanup()
      item.cell.deps = item.deps
      item.cell.cleanup = item.create()
    }
    const effects = hooks.pendingEffects.splice(0)
    for (const item of effects) {
      if (typeof item.cell.cleanup === 'function') item.cell.cleanup()
      item.cell.deps = item.deps
      item.cell.cleanup = item.create()
    }
    return tree
  }

  render()

  return {
    get tree() {
      return tree
    },
    rerender(nextProps: P) {
      props = nextProps
      return render()
    },
    unmount() {
      hooks.onUpdate = null
      for (const cell of hooks.cells) {
        if (cell.kind === 'layout' && typeof cell.cleanup === 'function') {
          cell.cleanup()
          cell.cleanup = undefined
        }
      }
      for (const cell of hooks.cells) {
        if (cell.kind === 'effect' && typeof cell.cleanup === 'function') {
          cell.cleanup()
          cell.cleanup = undefined
        }
      }
      hooks.active = false
    }
  }
}

function findElement(
  node: ReactNode,
  predicate: (el: ReactElement<Record<string, unknown>>) => boolean
): ReactElement<Record<string, unknown>> | null {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate)
      if (found) return found
    }
    return null
  }
  if (!isValidElement(node)) return null
  const el = node as ReactElement<Record<string, unknown>>
  if (predicate(el)) return el
  return findElement(el.props.children as ReactNode, predicate)
}

function findAllElements(
  node: ReactNode,
  predicate: (el: ReactElement<Record<string, unknown>>) => boolean,
  out: Array<ReactElement<Record<string, unknown>>> = []
): Array<ReactElement<Record<string, unknown>>> {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAllElements(child, predicate, out)
    return out
  }
  if (!isValidElement(node)) return out
  const el = node as ReactElement<Record<string, unknown>>
  if (predicate(el)) out.push(el)
  findAllElements(el.props.children as ReactNode, predicate, out)
  return out
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createFakeDocument(hidden = false) {
  const listeners = new Map<string, Set<() => void>>()
  const doc = {
    hidden,
    addEventListener: vi.fn((event: string, fn: () => void) => {
      const set = listeners.get(event) ?? new Set()
      set.add(fn)
      listeners.set(event, set)
    }),
    removeEventListener: vi.fn((event: string, fn: () => void) => {
      listeners.get(event)?.delete(fn)
    }),
    setHidden(next: boolean) {
      doc.hidden = next
      for (const fn of listeners.get('visibilitychange') ?? []) fn()
    }
  }
  return doc
}

async function flushMicrotasks() {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

beforeEach(() => {
  hooks.active = false
  setLanguage('zh-CN')
  forgetGrokBotChat()
  mocks.toasts = []
  mocks.removeQueued.mockReset()
  mocks.reorderQueued.mockReset()
  mocks.sendQueuedNow.mockReset()
  mocks.state.app = {
    projects: [],
    threads: [],
    running: [],
    waitingForInput: [],
    queued: {},
    settings: { ...DEFAULT_SETTINGS }
  }
  mocks.state.items = {}
  mocks.state.view = { kind: 'home' }
})

afterEach(() => {
  hooks.active = false
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setLanguage('system', 'zh-CN')
})

describe('Bug #17 & #18: GrokBotView polling loops, history retry, and send() bot-switch guard', () => {
  const botsList: GrokBotList = {
    hasApiKey: true,
    bots: [
      { id: 'bot-a', name: 'BotA', color: 'blue', description: '', lastText: '', lastActivityAt: 1 },
      { id: 'bot-b', name: 'BotB', color: 'green', description: '', lastText: '', lastActivityAt: 2 }
    ]
  }

  it('does not spawn duplicate concurrent polling loops when visibility toggles during an in-flight poll', async () => {
    vi.useFakeTimers()
    const doc = createFakeDocument(false)
    vi.stubGlobal('document', doc)

    const poll1 = deferred<GrokBotPollResult>()
    const poll2 = deferred<GrokBotPollResult>()
    const grokbotPoll = vi
      .fn()
      .mockReturnValueOnce(poll1.promise)
      .mockReturnValueOnce(poll2.promise)
      .mockResolvedValue({ messages: [], cursor: 'c2' })

    vi.stubGlobal('window', {
      api: {
        grokbotList: vi.fn().mockResolvedValue(botsList),
        grokbotCached: vi.fn().mockResolvedValue({ messages: [], cursor: 'c1', truncated: false }),
        grokbotHistory: vi.fn(),
        grokbotPoll,
        grokbotSend: vi.fn()
      }
    })

    const mounted = mountComponent(GrokBotView, { botId: 'bot-a', onOpenSettings: vi.fn() })
    await flushMicrotasks()

    expect(grokbotPoll).toHaveBeenCalledTimes(1)

    // Toggle visibility repeatedly while poll1 is still in flight
    doc.setHidden(true)
    doc.setHidden(false)
    doc.setHidden(true)
    doc.setHidden(false)
    await flushMicrotasks()

    // Must still have only 1 in-flight poll!
    expect(grokbotPoll).toHaveBeenCalledTimes(1)

    // Finish poll1 -> schedules exactly one timer (10s idle)
    poll1.resolve({ messages: [], cursor: 'c1', turn: { idle: true, inFlight: false, queued: 0 } })
    await flushMicrotasks()
    expect(grokbotPoll).toHaveBeenCalledTimes(1)

    // Advance 10s -> triggers poll2 once
    vi.advanceTimersByTime(10_000)
    await flushMicrotasks()
    expect(grokbotPoll).toHaveBeenCalledTimes(2)

    // Visibility toggle during poll2 must still not spawn another concurrent poll
    doc.setHidden(true)
    doc.setHidden(false)
    await flushMicrotasks()
    expect(grokbotPoll).toHaveBeenCalledTimes(2)

    poll2.resolve({ messages: [], cursor: 'c2', turn: { idle: true, inFlight: false, queued: 0 } })
    await flushMicrotasks()

    // Only one timer fires on next interval
    vi.advanceTimersByTime(10_000)
    await flushMicrotasks()
    expect(grokbotPoll).toHaveBeenCalledTimes(3)

    mounted.unmount()
  })

  it('keeps scheduling retries when initial grokbotHistory fails and recovers on subsequent retry', async () => {
    vi.useFakeTimers()
    const doc = createFakeDocument(false)
    vi.stubGlobal('document', doc)

    const grokbotHistory = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValueOnce({
        messages: [{ seq: 1, role: 'assistant', text: 'Recovered!', createdAt: 10 }],
        cursor: 'c-recovered'
      })
    const grokbotPoll = vi.fn().mockResolvedValue({ messages: [], cursor: 'c-recovered' })

    vi.stubGlobal('window', {
      api: {
        grokbotList: vi.fn().mockResolvedValue(botsList),
        grokbotCached: vi.fn().mockResolvedValue(null),
        grokbotHistory,
        grokbotPoll,
        grokbotSend: vi.fn()
      }
    })

    const mounted = mountComponent(GrokBotView, { botId: 'bot-a', onOpenSettings: vi.fn() })
    await flushMicrotasks()

    expect(grokbotHistory).toHaveBeenCalledTimes(1)
    const errEl = findElement(mounted.tree, (el) => el.props.className === 'grokbot-error')
    expect(errEl?.props.children).toBe('temporary outage')

    // After idle interval, polling retries loadHistory because cursor is still empty
    vi.advanceTimersByTime(10_000)
    await flushMicrotasks()
    expect(grokbotHistory).toHaveBeenCalledTimes(2)
    expect(findElement(mounted.tree, (el) => el.props.className === 'grokbot-error')).toBeNull()

    // Subsequent poll now uses recovered cursor
    vi.advanceTimersByTime(10_000)
    await flushMicrotasks()
    expect(grokbotPoll).toHaveBeenCalledWith('BotA', 'c-recovered', undefined)

    mounted.unmount()
  })

  it('guards send() resolution when switching to another bot so pending and draft are not leaked/wiped', async () => {
    const doc = createFakeDocument(false)
    vi.stubGlobal('document', doc)

    const sendA = deferred<void>()
    const grokbotSend = vi.fn(() => sendA.promise)

    vi.stubGlobal('window', {
      api: {
        grokbotList: vi.fn().mockResolvedValue(botsList),
        grokbotCached: vi.fn().mockResolvedValue({ messages: [], cursor: 'c1', truncated: false }),
        grokbotHistory: vi.fn(),
        grokbotPoll: vi.fn().mockResolvedValue({ messages: [], cursor: 'c1' }),
        grokbotSend
      }
    })

    const mounted = mountComponent(GrokBotView, { botId: 'bot-a', onOpenSettings: vi.fn() })
    await flushMicrotasks()

    // Type message in Bot A and send
    const taA = findElement(mounted.tree, (el) => el.type === 'textarea')!
    ;(taA.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'hello BotA' } })
    const sendBtnA = findElement(mounted.tree, (el) => el.type === 'button' && el.props.className === 'send-btn')!
    ;(sendBtnA.props.onClick as () => void)()
    expect(grokbotSend).toHaveBeenCalledWith('BotA', 'hello BotA')

    // Switch to Bot B before Bot A's send resolves
    mounted.rerender({ botId: 'bot-b', onOpenSettings: vi.fn() })
    await flushMicrotasks()

    // Bot B's textarea must not be stuck disabled, and user types a draft for Bot B
    const taB = findElement(mounted.tree, (el) => el.type === 'textarea')!
    expect(taB.props.disabled).toBe(false)
    ;(taB.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'draft for BotB' } })

    // Now Bot A's send resolves late
    sendA.resolve(undefined)
    await flushMicrotasks()

    // Bot B's draft must remain intact and no pending bubble or spinner should leak into Bot B
    const taBAfter = findElement(mounted.tree, (el) => el.type === 'textarea')!
    expect(taBAfter.props.value).toBe('draft for BotB')
    expect(findElement(mounted.tree, (el) => el.props.className === 'msg-user pending')).toBeNull()
    expect(findElement(mounted.tree, (el) => el.props.className === 'grokbot-working')).toBeNull()

    mounted.unmount()
  })
})

describe('Bug #19: Surface async errors without silent swallowing or double-toasting', () => {
  it('Composer slash command choose() displays inline sendError when onSend throws', async () => {
    vi.stubGlobal('window', { api: { platform: 'win32', isRemote: false }, innerHeight: 900 })
    const onSend = vi.fn().mockRejectedValue(new Error('对话正在运行，请稍后再分叉'))

    const ComposerRender = (Composer as unknown as { render: (props: Record<string, unknown>, ref: unknown) => ReactNode }).render
    const mounted = mountComponent((props: Record<string, unknown>) => ComposerRender(props, null), {
      projectId: 'p1',
      threadId: 't1',
      draftScope: 'test-composer-choose',
      running: true,
      initial: { mode: 'agent', force: false },
      commands: [{ name: 'fork', description: 'Fork' }],
      onSend
    })

    const popover = findElement(mounted.tree, (el) => typeof el.props.onSelect === 'function')!
    ;(popover.props.onSelect as (cmd: { name: string }) => void)({ name: 'fork' })
    await flushMicrotasks()

    const alert = findElement(mounted.tree, (el) => el.props.role === 'alert')
    expect(alert?.props.children).toBe('对话正在运行，请稍后再分叉')
    const textarea = findElement(mounted.tree, (el) => el.type === 'textarea')!
    expect(textarea.props.value).toBe('/fork')
    mounted.unmount()
  })

  it('QueuedMessages edit() toasts attachment restore failure and does not double-toast removeQueued failure', async () => {
    const item: QueuedMessage = {
      id: 'q1',
      prompt: 'queued text',
      model: 'auto',
      mode: 'agent',
      force: false,
      attachments: [{ id: 'a1', name: 'img.png', mimeType: 'image/png', size: 10 }],
      createdAt: 1
    }
    mocks.state.app.queued = { t1: { items: [item], paused: false } }

    // Case 1: onEdit (restoreDraftAttachments) fails -> must toast!
    const onEditFail = vi.fn().mockRejectedValue(new Error('attachment missing'))
    const mounted1 = mountComponent(QueuedMessages, { threadId: 't1', running: true, onEdit: onEditFail })
    const editBtn1 = findElement(mounted1.tree, (el) => el.type === 'button' && el.props['aria-label'] === '编辑')!
    ;(editBtn1.props.onClick as () => void)()
    await flushMicrotasks()
    expect(mocks.toasts).toEqual([{ text: 'attachment missing', level: 'error' }])
    expect(mocks.removeQueued).not.toHaveBeenCalled()
    mounted1.unmount()

    // Case 2: onEdit succeeds, removeQueued fails (already toasted by store) -> must not double-toast!
    mocks.toasts = []
    mocks.removeQueued.mockImplementation(async () => {
      const err = new Error('remove failed')
      toastError(err)
      throw err
    })
    const onEditOk = vi.fn().mockResolvedValue(true)
    const mounted2 = mountComponent(QueuedMessages, { threadId: 't1', running: true, onEdit: onEditOk })
    const editBtn2 = findElement(mounted2.tree, (el) => el.type === 'button' && el.props['aria-label'] === '编辑')!
    ;(editBtn2.props.onClick as () => void)()
    await flushMicrotasks()
    expect(mocks.toasts).toEqual([{ text: 'remove failed', level: 'error' }])
    mounted2.unmount()
  })

  it('PlanCard toasts unreported buildPlan errors once and avoids double-toasting reported errors', async () => {
    vi.stubGlobal('window', { api: { isRemote: false } })
    const planItem: ToolItem = {
      id: 'plan-1', kind: 'tool', callId: 'c1', tool: 'createPlan',
      args: { name: 'My Plan' }, status: 'success', startedAt: 1
    }

    // Unreported pre-send error (e.g. cliMissing)
    const buildPlanUnreported = vi.fn().mockRejectedValue(new Error('请先安装选中的 CLI。'))
    const mounted1 = mountComponent(PlanCard, { item: planItem }, [
      [TurnActionsContext, { buildPlan: buildPlanUnreported, planId: 'plan-1' }],
      [ItemDraftContext, { scope: 'plan-test-1', itemId: 'plan-1' }]
    ])
    const btn1 = findElement(mounted1.tree, (el) => el.type === 'button' && el.props.className === 'question-submit')!
    ;(btn1.props.onClick as () => void)()
    await flushMicrotasks()
    expect(mocks.toasts).toEqual([{ text: '请先安装选中的 CLI。', level: 'error' }])
    mounted1.unmount()

    // Already-reported sendMessage error -> still only 1 toast
    mocks.toasts = []
    const buildPlanReported = vi.fn(async () => {
      const err = new Error('send failed')
      toastError(err)
      throw err
    })
    const mounted2 = mountComponent(PlanCard, { item: planItem }, [
      [TurnActionsContext, { buildPlan: buildPlanReported, planId: 'plan-1' }],
      [ItemDraftContext, { scope: 'plan-test-2', itemId: 'plan-1' }]
    ])
    const btn2 = findElement(mounted2.tree, (el) => el.type === 'button' && el.props.className === 'question-submit')!
    ;(btn2.props.onClick as () => void)()
    await flushMicrotasks()
    expect(mocks.toasts).toEqual([{ text: 'send failed', level: 'error' }])
    mounted2.unmount()
  })

  it('QuestionForm toasts unreported submit/skip errors once and avoids double-toasting reported errors', async () => {
    const questions = [{
      id: 'q1',
      prompt: 'Pick one',
      options: [{ id: 'a', label: 'A' }]
    }]

    // Unreported error on skip
    const onSkipUnreported = vi.fn().mockRejectedValue(new Error('当前不能发送'))
    const mounted1 = mountComponent(QuestionForm, {
      questions,
      onSubmit: vi.fn(),
      onSkip: onSkipUnreported
    })
    const skipBtn = findElement(mounted1.tree, (el) => el.type === 'button' && el.props.className === 'question-skip')!
    ;(skipBtn.props.onClick as () => void)()
    await flushMicrotasks()
    expect(mocks.toasts).toEqual([{ text: '当前不能发送', level: 'error' }])
    expect(findElement(mounted1.tree, (el) => el.type === 'button' && el.props.className === 'question-skip')?.props.disabled).toBe(false)
    mounted1.unmount()

    // Reported error on skip -> still only 1 toast
    mocks.toasts = []
    const onSkipReported = vi.fn(async () => {
      const err = new Error('answer failed')
      toastError(err)
      throw err
    })
    const mounted2 = mountComponent(QuestionForm, {
      questions,
      onSubmit: vi.fn(),
      onSkip: onSkipReported
    })
    const skipBtn2 = findElement(mounted2.tree, (el) => el.type === 'button' && el.props.className === 'question-skip')!
    ;(skipBtn2.props.onClick as () => void)()
    await flushMicrotasks()
    expect(mocks.toasts).toEqual([{ text: 'answer failed', level: 'error' }])
    mounted2.unmount()
  })
})

describe('Bug #20: ImportDialog scan error handling & ChangesPanel error + stale response cancellation', () => {
  it('ImportDialog stops spinning and shows error when scanCliSessions rejects', async () => {
    vi.stubGlobal('window', {
      api: {
        scanCliSessions: vi.fn().mockRejectedValue(new Error('disk read error'))
      }
    })

    const mounted = mountComponent(ImportDialog, { onClose: vi.fn() })
    expect(findElement(mounted.tree, (el) => el.props.className === 'center-hint')).toBeTruthy()

    await flushMicrotasks()

    expect(findElement(mounted.tree, (el) => el.props.className === 'center-hint')).toBeNull()
    expect(findElement(mounted.tree, (el) => el.props.className === 'empty-hint')).toBeNull()
    const alert = findElement(mounted.tree, (el) => el.props.role === 'alert')
    expect(alert?.props.children).toBe('disk read error')
    expect(mocks.toasts).toEqual([{ text: 'disk read error', level: 'error' }])
    mounted.unmount()
  })

  it('ChangesPanel catches gitDiff errors and ignores stale responses after cwd changes', async () => {
    const diffA = deferred<GitDiff>()
    const diffB = deferred<GitDiff>()
    const gitDiff = vi
      .fn()
      .mockReturnValueOnce(diffA.promise)
      .mockReturnValueOnce(diffB.promise)
      .mockRejectedValueOnce(new Error('git rpc timeout'))

    vi.stubGlobal('window', { api: { gitDiff } })

    const threadA: ThreadMeta = {
      id: 't1', projectId: 'p1', cwd: '/repo-a', title: 'T',
      mode: 'agent', source: 'app', createdAt: 1, updatedAt: 1
    }
    const threadB: ThreadMeta = { ...threadA, cwd: '/repo-b' }

    // Render inner ChangesPanelBody via ChangesPanel's returned element type
    const wrapper = ChangesPanel({ thread: threadA, onClose: vi.fn() }) as ReactElement<Record<string, unknown>>
    const Body = wrapper.type as (props: { thread: ThreadMeta; onClose: () => void }) => ReactNode

    const mounted = mountComponent(Body, { thread: threadA, onClose: vi.fn() })
    // Switch to Git tab -> triggers gitDiff('/repo-a')
    const gitTab = findAllElements(mounted.tree, (el) => el.type === 'button' && String(el.props.className ?? '').includes('tab'))[2]!
    ;(gitTab.props.onClick as () => void)()
    expect(gitDiff).toHaveBeenCalledWith('/repo-a')

    // Change cwd to '/repo-b' while '/repo-a' is still in flight
    mounted.rerender({ thread: threadB, onClose: vi.fn() })
    expect(gitDiff).toHaveBeenCalledWith('/repo-b')

    // '/repo-b' finishes first
    diffB.resolve({ isRepo: true, branch: 'branch-b', status: '', diff: '' })
    await flushMicrotasks()
    expect(findElement(mounted.tree, (el) => el.props.className === 'badge')?.props.children).toEqual([expect.anything(), ' ', 'branch-b'])

    // Stale '/repo-a' finishes late -> MUST NOT overwrite branch-b!
    diffA.resolve({ isRepo: true, branch: 'branch-a-stale', status: '', diff: '' })
    await flushMicrotasks()
    expect(findElement(mounted.tree, (el) => el.props.className === 'badge')?.props.children).toEqual([expect.anything(), ' ', 'branch-b'])

    // Manual refresh rejects -> must show alert without unhandled rejection
    const refreshBtn = findElement(mounted.tree, (el) => el.type === 'button' && el.props.title === '刷新')!
    ;(refreshBtn.props.onClick as () => void)()
    await flushMicrotasks()
    const alert = findElement(mounted.tree, (el) => el.props.role === 'alert')
    expect(alert?.props.children).toBe('git rpc timeout')

    mounted.unmount()
  })
})

describe('Bug #33: CliCard Antigravity API endpoint label and description are translated', () => {
  it('renders translated English label and description for Antigravity API endpoint', () => {
    setLanguage('en')
    const html = renderToStaticMarkup(createElement(CliCard, {
      active: true,
      provider: 'antigravity',
      pathValue: '',
      pathPlaceholder: '',
      pathDesc: 'Path desc',
      keyValue: '',
      keyPlaceholder: '',
      keyDesc: 'Key desc',
      endpoint: { value: '', onSave: vi.fn() },
      missing: 'Missing',
      install: 'Install',
      onPath: vi.fn(),
      onKey: vi.fn()
    }))
    expect(html).toContain('API endpoint')
    expect(html).toContain('Enter a Gemini-compatible API URL. Leave blank to use GOOGLE_GEMINI_BASE_URL or Google’s default endpoint.')
    expect(html).not.toContain('API 端点')
    expect(html).not.toContain('填写兼容 Gemini API 的服务地址')
  })
})

describe('Bug #34: RemoteSettings clamps urlIndex on shrinking urls and supports #grokbot route', () => {
  it('clamps urlIndex back to 0 when Public Access is disabled and info.urls shrinks', async () => {
    const info3: RemoteInfo = {
      enabled: true,
      port: 41830,
      running: true,
      urls: ['http://192.168.1.2:41830/?t=1', 'http://10.0.0.2:41830/?t=1', 'http://public.example:8765/c/abc/?t=1'],
      publicUrl: 'http://public.example:8765/c/abc/?t=1',
      publicStatus: 'up'
    }
    const info2: RemoteInfo = {
      enabled: true,
      port: 41830,
      running: true,
      publicStatus: 'off',
      urls: ['http://192.168.1.2:41830/?t=1', 'http://10.0.0.2:41830/?t=1']
    }
    const remoteInfo = vi.fn().mockResolvedValueOnce(info3).mockResolvedValueOnce(info2)
    vi.stubGlobal('window', { api: { remoteInfo } })

    mocks.state.app.settings = { ...DEFAULT_SETTINGS, remoteEnabled: true, remotePublicEnabled: true }
    mocks.state.view = { kind: 'grokbot', botId: 'bot 1' }

    const mounted = mountComponent(RemoteSettings, {})
    await flushMicrotasks()

    const select3 = findElement(mounted.tree, (el) => el.type === 'select')!
    expect(select3.props.value).toBe(2)
    const link3 = findElement(mounted.tree, (el) => String(el.props.className ?? '').includes('remote-link'))!
    expect(link3.props.children).toBe('http://public.example:8765/c/abc/?t=1#grokbot=bot%201')
    expect(findAllElements(mounted.tree, (el) => el.props.children === '扫码后打开当前正在查看的 Grok Bot')).toHaveLength(1)

    // Disable Public Access -> remoteInfo returns only 2 LAN URLs
    mocks.state.app.settings = { ...DEFAULT_SETTINGS, remoteEnabled: true, remotePublicEnabled: false }
    mounted.rerender({})
    await flushMicrotasks()

    const select2 = findElement(mounted.tree, (el) => el.type === 'select')!
    expect(select2.props.value).toBe(0)
    const link2 = findElement(mounted.tree, (el) => String(el.props.className ?? '').includes('remote-link'))!
    expect(link2.props.children).toBe('http://192.168.1.2:41830/?t=1#grokbot=bot%201')
    mounted.unmount()
  })
})

describe('Bug #35: Sidebar passes total thread count including hidden archived threads to ProjectRow', () => {
  it('counts archived threads even when showArchived is false', () => {
    vi.stubGlobal('window', { api: { platform: 'win32', isRemote: false } })
    mocks.state.app = {
      projects: [{ id: 'p1', name: 'Repo', path: '/repo', createdAt: 1 }],
      threads: [
        { id: 't1', projectId: 'p1', title: 'Active', mode: 'agent', source: 'app', createdAt: 1, updatedAt: 3 },
        { id: 't2', projectId: 'p1', title: 'Archived 1', archived: true, mode: 'agent', source: 'app', createdAt: 1, updatedAt: 2 },
        { id: 't3', projectId: 'p1', title: 'Archived 2', archived: true, mode: 'agent', source: 'app', createdAt: 1, updatedAt: 1 }
      ],
      running: [],
      waitingForInput: [],
      settings: { ...DEFAULT_SETTINGS, showArchived: false }
    }

    const SidebarRender = (Sidebar as unknown as { render: (props: Record<string, unknown>, ref: unknown) => ReactNode }).render
    const mounted = mountComponent((props: Record<string, unknown>) => SidebarRender(props, null), {
      onOpenSettings: vi.fn(),
      onOpenImport: vi.fn()
    })

    const projectRow = findElement(mounted.tree, (el) => typeof el.type === 'function' && (el.type as { name?: string }).name === 'ProjectRow')!
    expect(projectRow).toBeTruthy()
    expect(projectRow.props.count).toBe(3)

    // Only 1 visible thread row is rendered while archived threads are hidden
    const threadRows = findAllElements(mounted.tree, (el) => typeof el.type === 'function' && (el.type as { name?: string }).name === 'ThreadRow')
    expect(threadRows).toHaveLength(1)
    mounted.unmount()
  })
})
