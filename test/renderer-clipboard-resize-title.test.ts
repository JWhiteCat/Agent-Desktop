import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import { DEFAULT_SETTINGS, type AppState, type ThreadMeta } from '../src/shared/types'

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

const hooks = vi.hoisted(() => {
  const ctx = {
    cells: [] as HookCell[],
    index: 0,
    pendingLayouts: [] as Array<{ cell: HookCell; create: () => (() => void) | void; deps?: unknown[] }>,
    pendingEffects: [] as Array<{ cell: HookCell; create: () => (() => void) | void; deps?: unknown[] }>,
    renderStateChanged: false,
    onUpdate: null as (() => void) | null
  }
  return ctx
})

vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => {
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
      const i = hooks.index++
      if (!hooks.cells[i]) hooks.cells[i] = { kind: 'ref', value: { current: initial } }
      return hooks.cells[i].value
    },
    useMemo: (factory: () => unknown, deps?: unknown[]) => {
      const i = hooks.index++
      const cell = hooks.cells[i]
      if (!cell || depsChanged(cell.deps, deps)) {
        hooks.cells[i] = { kind: 'memo', value: factory(), deps }
      }
      return hooks.cells[i].value
    },
    useCallback: (fn: unknown, deps?: unknown[]) => {
      const i = hooks.index++
      const cell = hooks.cells[i]
      if (!cell || depsChanged(cell.deps, deps)) {
        hooks.cells[i] = { kind: 'memo', value: fn, deps }
      }
      return hooks.cells[i].value
    },
    useLayoutEffect: (create: () => (() => void) | void, deps?: unknown[]) => {
      const i = hooks.index++
      if (!hooks.cells[i]) hooks.cells[i] = { kind: 'layout', value: undefined }
      const cell = hooks.cells[i]
      if (cell.deps === undefined || depsChanged(cell.deps, deps)) {
        hooks.pendingLayouts.push({ cell, create, deps })
      }
    },
    useEffect: (create: () => (() => void) | void, deps?: unknown[]) => {
      const i = hooks.index++
      if (!hooks.cells[i]) hooks.cells[i] = { kind: 'effect', value: undefined }
      const cell = hooks.cells[i]
      if (cell.deps === undefined || depsChanged(cell.deps, deps)) {
        hooks.pendingEffects.push({ cell, create, deps })
      }
    },
    useId: () => {
      const i = hooks.index++
      if (!hooks.cells[i]) hooks.cells[i] = { kind: 'id', value: `:id-${i}:` }
      return hooks.cells[i].value
    },
    useSyncExternalStore: (_sub: unknown, getSnapshot: () => unknown) => getSnapshot()
  }
})

const storeMock = vi.hoisted(() => ({
  state: {
    app: {
      projects: [{ id: 'p1', name: 'Demo', path: '/demo', createdAt: 1 }],
      threads: [] as ThreadMeta[],
      running: [] as string[],
      settings: {} as AppState['settings']
    } as AppState,
    items: {} as Record<string, unknown[]>,
    models: [] as unknown[],
    modelsByCli: {} as Record<string, unknown[]>,
    commandsByThread: {} as Record<string, unknown[]>,
    view: { kind: 'home' as const }
  },
  toast: vi.fn(),
  forkThread: vi.fn(),
  openThread: vi.fn(),
  setState: vi.fn(),
  syncThreadFromCli: vi.fn(),
  loadSkillCommands: vi.fn(),
  prepareCommands: vi.fn(),
  sendMessage: vi.fn(),
  setCliProvider: vi.fn(),
  chatModel: vi.fn((..._args: unknown[]) => undefined),
  cliCommands: vi.fn((..._args: unknown[]) => []),
  skillCommands: vi.fn((..._args: unknown[]) => [])
}))

vi.mock('../src/renderer/src/store/feedback', () => ({
  toast: (...args: unknown[]) => storeMock.toast(...args),
  errorText: (err: unknown) => (err instanceof Error ? err.message : String(err))
}))

vi.mock('../src/renderer/src/store', () => ({
  useStore: (selector: (s: typeof storeMock.state) => unknown) => selector(storeMock.state),
  toast: (...args: unknown[]) => storeMock.toast(...args),
  errorText: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  forkThread: (...args: unknown[]) => storeMock.forkThread(...args),
  openThread: (...args: unknown[]) => storeMock.openThread(...args),
  setState: (...args: unknown[]) => storeMock.setState(...args),
  syncThreadFromCli: (...args: unknown[]) => storeMock.syncThreadFromCli(...args),
  loadSkillCommands: (...args: unknown[]) => storeMock.loadSkillCommands(...args),
  prepareCommands: (...args: unknown[]) => storeMock.prepareCommands(...args),
  sendMessage: (...args: unknown[]) => storeMock.sendMessage(...args),
  setCliProvider: (...args: unknown[]) => storeMock.setCliProvider(...args),
  chatModel: (...args: unknown[]) => storeMock.chatModel(...args),
  cliCommands: (...args: unknown[]) => storeMock.cliCommands(...args),
  skillCommands: (...args: unknown[]) => storeMock.skillCommands(...args)
}))

vi.mock('../src/renderer/src/store/threads', () => ({
  markDisplayedThreadRead: vi.fn()
}))

import { CopyButton } from '../src/renderer/src/components/items/primitives'
import { ThreadRow } from '../src/renderer/src/components/sidebar/ThreadRow'
import { ResizeHandle } from '../src/renderer/src/components/ResizeHandle'
import { ThreadView } from '../src/renderer/src/components/ThreadView'
import { panelLayout } from '../src/renderer/src/lib/panel-layout'

function mountComponent<P>(Component: (props: P) => ReactNode, initialProps: P) {
  hooks.cells = []
  hooks.index = 0
  hooks.pendingLayouts = []
  hooks.pendingEffects = []
  hooks.renderStateChanged = false
  hooks.onUpdate = null

  let props = initialProps
  let tree: ReactNode = null

  const render = () => {
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
    }
  }
}

function findElement(node: ReactNode, predicate: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> | null {
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

function createFakeClipboardDom(execResult = true) {
  const textarea = {
    value: '',
    style: { cssText: '' },
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    remove: vi.fn()
  }
  const execCommand = vi.fn(() => execResult)
  vi.stubGlobal('navigator', {})
  vi.stubGlobal('document', {
    activeElement: null,
    body: { appendChild: vi.fn() },
    createElement: vi.fn(() => textarea),
    getSelection: vi.fn(() => null),
    execCommand
  })
  vi.stubGlobal('window', { scrollX: 0, scrollY: 0, scrollTo: vi.fn(), api: { isRemote: true } })
  return { textarea, execCommand }
}

beforeEach(() => {
  setLanguage('zh-CN')
  storeMock.state.app.settings = { ...DEFAULT_SETTINGS }
  storeMock.toast.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setLanguage('system', 'zh-CN')
})

describe('Bug #6: HTTP LAN clipboard copy in CopyButton and ThreadRow', () => {
  it('CopyButton copies via copyText fallback when navigator.clipboard is undefined and sets done after resolution', async () => {
    vi.useFakeTimers()
    const { textarea, execCommand } = createFakeClipboardDom(true)
    const mounted = mountComponent(CopyButton, { text: 'hello-http' })
    const btn = findElement(mounted.tree, (el) => el.type === 'button')!
    expect(btn).toBeTruthy()
    const onClick = btn.props.onClick as (e: { stopPropagation: () => void }) => void
    onClick({ stopPropagation: vi.fn() })
    await vi.waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'))
    expect(textarea.value).toBe('hello-http')
    expect(storeMock.toast).not.toHaveBeenCalled()

    // Check checkmark icon is shown after success, then resets after 1200ms
    const afterSuccess = findElement(mounted.tree, (el) => el.type === 'button')!
    expect((afterSuccess.props.children as ReactElement).type).toHaveProperty('name', 'IconCheck')
    vi.advanceTimersByTime(1200)
    const afterReset = findElement(mounted.tree, (el) => el.type === 'button')!
    expect((afterReset.props.children as ReactElement).type).toHaveProperty('name', 'IconCopy')
    mounted.unmount()
  })

  it('CopyButton does not show checkmark and toasts error when copyText fails', async () => {
    createFakeClipboardDom(false)
    const mounted = mountComponent(CopyButton, { text: 'secret' })
    const btn = findElement(mounted.tree, (el) => el.type === 'button')!
    ;(btn.props.onClick as (e: { stopPropagation: () => void }) => void)({ stopPropagation: vi.fn() })
    await vi.waitFor(() => expect(storeMock.toast).toHaveBeenCalledWith('无法复制：Clipboard copying failed', 'error'))
    const afterFail = findElement(mounted.tree, (el) => el.type === 'button')!
    expect((afterFail.props.children as ReactElement).type).toHaveProperty('name', 'IconCopy')
    mounted.unmount()
  })

  it('ThreadRow copies CLI session ID over HTTP without navigator.clipboard and toasts on failure', async () => {
    const thread: ThreadMeta = {
      id: 't1', projectId: 'p1', title: 'Test', chatId: 'chat-123',
      mode: 'agent', source: 'app', createdAt: 1, updatedAt: 1
    }
    const { textarea, execCommand } = createFakeClipboardDom(true)
    const mounted = mountComponent(ThreadRow, {
      thread, active: false, running: false, editing: false,
      onEdit: vi.fn(), onEditDone: vi.fn()
    })
    const menuBtn = findElement(mounted.tree, (el) => Array.isArray(el.props.items))!
    const items = menuBtn.props.items as Array<{ label?: string; onSelect?: () => void }>
    const copyEntry = items.find((entry) => typeof entry === 'object' && entry.label === '复制 CLI 会话 ID')!
    expect(copyEntry).toBeTruthy()
    copyEntry.onSelect!()
    await vi.waitFor(() => expect(storeMock.toast).toHaveBeenCalledWith('已复制会话 ID，可用 agent --resume <id> 在终端继续'))
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(textarea.value).toBe('chat-123')

    // Failure path
    storeMock.toast.mockReset()
    execCommand.mockReturnValue(false)
    copyEntry.onSelect!()
    await vi.waitFor(() => expect(storeMock.toast).toHaveBeenCalledWith('无法复制：Clipboard copying failed', 'error'))
    mounted.unmount()
  })
})

describe('Bug #7: ResizeHandle cleans up active drag state on unmount', () => {
  it('cancels RAF, removes body.panel-resizing, and ends drag so PanelLayout.load() works again', () => {
    const bodyClasses = new Set<string>()
    const cssVars = new Map<string, string>()
    const cancelAnimationFrame = vi.fn()
    const requestAnimationFrame = vi.fn(() => 42)
    const updateSettings = vi.fn().mockResolvedValue({})

    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame)
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    vi.stubGlobal('window', { innerWidth: 1600, api: { platform: 'win32', updateSettings } })
    vi.stubGlobal('document', {
      documentElement: { style: { setProperty: (name: string, value: string) => cssVars.set(name, value) } },
      body: {
        classList: {
          add: (c: string) => bodyClasses.add(c),
          remove: (c: string) => bodyClasses.delete(c),
          contains: (c: string) => bodyClasses.has(c)
        }
      }
    })

    const layout = panelLayout()
    layout.load({ sidebar: 272 })

    const mounted = mountComponent(ResizeHandle, { panel: 'sidebar', label: 'Resize sidebar' })
    const handle = findElement(mounted.tree, (el) => el.props.role === 'separator')!
    const targetClasses = new Set<string>()
    const currentTarget = {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
      classList: {
        add: (c: string) => targetClasses.add(c),
        remove: (c: string) => targetClasses.delete(c)
      }
    }

    ;(handle.props.onPointerDown as (e: unknown) => void)({
      button: 0, pointerId: 7, clientX: 272, preventDefault: vi.fn(), currentTarget
    })
    expect(bodyClasses.has('panel-resizing')).toBe(true)

    ;(handle.props.onPointerMove as (e: unknown) => void)({ pointerId: 7, clientX: 320 })
    expect(requestAnimationFrame).toHaveBeenCalledOnce()

    // While dragging, panelLayout().load() is blocked
    layout.load({ sidebar: 350 })
    expect(layout.preferred().sidebar).toBe(272)

    // Unmount mid-drag (e.g. Ctrl+B)
    mounted.unmount()

    expect(cancelAnimationFrame).toHaveBeenCalledWith(42)
    expect(bodyClasses.has('panel-resizing')).toBe(false)

    // PanelLayout.load() must no longer be frozen
    layout.load({ sidebar: 360 })
    expect(layout.preferred().sidebar).toBe(360)
  })
})

describe('Bug #16: ThreadView inline title editing does not overwrite another thread on switch', () => {
  it('exits edit mode synchronously on thread.id change before composer focus blurs the input', () => {
    const updateThread = vi.fn()
    vi.stubGlobal('window', { api: { updateThread, platform: 'win32', isRemote: false } })

    const threadA: ThreadMeta = {
      id: 'thread-a', projectId: 'p1', title: 'Title A',
      mode: 'agent', source: 'app', createdAt: 1, updatedAt: 1
    }
    const threadB: ThreadMeta = {
      id: 'thread-b', projectId: 'p1', title: 'Title B',
      mode: 'agent', source: 'app', createdAt: 2, updatedAt: 2
    }
    storeMock.state.app.threads = [threadA, threadB]
    storeMock.state.items = { 'thread-a': [], 'thread-b': [] }

    const mounted = mountComponent(ThreadView, {
      thread: threadA, changesOpen: false, onToggleChanges: vi.fn()
    })

    // Start editing Thread A's header title
    const h1A = findElement(mounted.tree, (el) => el.type === 'h1')!
    expect(h1A.props.children).toBe('Title A')
    ;(h1A.props.onDoubleClick as () => void)()

    const inputA = findElement(mounted.tree, (el) => el.type === 'input' && el.props.className === 'title-input')!
    expect(inputA).toBeTruthy()
    expect(inputA.props.defaultValue).toBe('Title A')

    // Switch to Thread B while editing Thread A (e.g. desktop notification click)
    mounted.rerender({ thread: threadB, changesOpen: false, onToggleChanges: vi.fn() })

    // Input must already be unmounted during render (not left mounted for blur)
    const inputB = findElement(mounted.tree, (el) => el.type === 'input' && el.props.className === 'title-input')
    expect(inputB).toBeNull()
    const h1B = findElement(mounted.tree, (el) => el.type === 'h1')!
    expect(h1B.props.children).toBe('Title B')
    expect(updateThread).not.toHaveBeenCalled()

    // Switching back to Thread A must not re-open title edit mode
    mounted.rerender({ thread: threadA, changesOpen: false, onToggleChanges: vi.fn() })
    expect(findElement(mounted.tree, (el) => el.type === 'input' && el.props.className === 'title-input')).toBeNull()
    expect(updateThread).not.toHaveBeenCalled()
    mounted.unmount()
  })

  it('still saves renamed title on normal blur and cancels cleanly on Escape', () => {
    const updateThread = vi.fn()
    vi.stubGlobal('window', { api: { updateThread, platform: 'win32', isRemote: false } })

    const threadA: ThreadMeta = {
      id: 'thread-a', projectId: 'p1', title: 'Title A',
      mode: 'agent', source: 'app', createdAt: 1, updatedAt: 1
    }
    storeMock.state.app.threads = [threadA]
    storeMock.state.items = { 'thread-a': [] }

    const mounted = mountComponent(ThreadView, {
      thread: threadA, changesOpen: false, onToggleChanges: vi.fn()
    })

    // Normal rename + blur
    ;(findElement(mounted.tree, (el) => el.type === 'h1')!.props.onDoubleClick as () => void)()
    const input = findElement(mounted.tree, (el) => el.type === 'input' && el.props.className === 'title-input')!
    ;(input.props.onBlur as (e: { target: { value: string } }) => void)({ target: { value: 'Renamed A' } })
    expect(updateThread).toHaveBeenCalledExactlyOnceWith('thread-a', { title: 'Renamed A' })

    // Escape followed by synthetic blur must not save
    updateThread.mockReset()
    ;(findElement(mounted.tree, (el) => el.type === 'h1')!.props.onDoubleClick as () => void)()
    const input2 = findElement(mounted.tree, (el) => el.type === 'input' && el.props.className === 'title-input')!
    ;(input2.props.onKeyDown as (e: { key: string }) => void)({ key: 'Escape' })
    ;(input2.props.onBlur as (e: { target: { value: string } }) => void)({ target: { value: 'Canceled A' } })
    expect(updateThread).not.toHaveBeenCalled()
    mounted.unmount()
  })
})
