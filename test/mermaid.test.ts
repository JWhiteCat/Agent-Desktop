import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fakeDocument() {
  const attached = new Set<unknown>()
  const nodes: Array<{ style: Record<string, string>; setAttribute: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }> = []
  const appendChild = vi.fn((node: unknown) => {
    attached.add(node)
    return node
  })
  const createElement = vi.fn(() => {
    const node = { style: {}, setAttribute: vi.fn(), remove: vi.fn(() => { attached.delete(node) }) }
    nodes.push(node)
    return node
  })
  vi.stubGlobal('document', { createElement, body: { appendChild, append: appendChild } })
  return { attached, nodes, createElement, appendChild }
}

let loads: number
let onLoad: (() => void) | undefined
let currentTheme: string | undefined
const initialize = vi.fn((config: { theme?: string }) => { currentTheme = config.theme })
const render = vi.fn(async (_id: string, _text: string, _container: unknown) => ({ svg: '<svg>diagram</svg>' }))

beforeEach(() => {
  vi.resetModules()
  loads = 0
  onLoad = undefined
  currentTheme = undefined
  initialize.mockClear()
  render.mockReset().mockResolvedValue({ svg: '<svg>diagram</svg>' })
  vi.doMock('mermaid', () => {
    loads++
    onLoad?.()
    return { default: { initialize, render } }
  })
})

afterEach(() => { vi.unstubAllGlobals() })

describe('Mermaid rendering', () => {
  it('loads Mermaid only for a live diagram and reuses the loaded module', async () => {
    const dom = fakeDocument()
    const { renderMermaid } = await import('../src/renderer/src/lib/mermaid')
    expect(loads).toBe(0)

    expect(await renderMermaid('graph TD; A-->B', 'light')).toBe('<svg>diagram</svg>')
    expect(await renderMermaid('graph TD; B-->C', 'dark')).toBe('<svg>diagram</svg>')

    expect(loads).toBe(1)
    expect(initialize.mock.calls.map(([config]) => config)).toEqual([
      expect.objectContaining({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'default' }),
      expect.objectContaining({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'dark' })
    ])
    const ids = render.mock.calls.map(([id]) => id)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(2)
    expect(render.mock.calls.map(([, text]) => text)).toEqual(['graph TD; A-->B', 'graph TD; B-->C'])
    expect(render.mock.calls.map(([, , container]) => container)).toEqual(dom.nodes)
    expect(dom.createElement).toHaveBeenCalledWith('div')
    expect(dom.appendChild).toHaveBeenCalledTimes(2)
    expect(dom.attached.size).toBe(0)
    expect(dom.nodes.every((node) => node.remove.mock.calls.length === 1)).toBe(true)
    for (const node of dom.nodes) expect(node.setAttribute).toHaveBeenCalledWith('aria-hidden', 'true')
  })

  it('serializes initialization and rendering so concurrent diagrams keep their themes', async () => {
    fakeDocument()
    const firstResult = deferred<{ svg: string }>()
    const themes: Array<string | undefined> = []
    render.mockImplementationOnce(async () => {
      themes.push(currentTheme)
      return firstResult.promise
    }).mockImplementationOnce(async () => {
      themes.push(currentTheme)
      return { svg: '<svg>dark</svg>' }
    })
    const { renderMermaid } = await import('../src/renderer/src/lib/mermaid')
    const first = renderMermaid('graph TD; Light-->Diagram', 'light')
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1))
    const second = renderMermaid('graph TD; Dark-->Diagram', 'dark')
    await Promise.resolve()
    await Promise.resolve()

    expect(initialize).toHaveBeenCalledTimes(1)
    expect(render).toHaveBeenCalledTimes(1)
    expect(currentTheme).toBe('default')
    firstResult.resolve({ svg: '<svg>light</svg>' })
    expect(await first).toBe('<svg>light</svg>')
    expect(await second).toBe('<svg>dark</svg>')
    expect(themes).toEqual(['default', 'dark'])
  })

  it('skips a cancelled diagram before loading Mermaid', async () => {
    const dom = fakeDocument()
    const { renderMermaid } = await import('../src/renderer/src/lib/mermaid')

    expect(await renderMermaid('graph TD; A-->B', 'light', () => false)).toBeUndefined()
    expect(loads).toBe(0)
    expect(initialize).not.toHaveBeenCalled()
    expect(render).not.toHaveBeenCalled()
    expect(dom.createElement).not.toHaveBeenCalled()
  })

  it('checks cancellation again after loading Mermaid', async () => {
    const dom = fakeDocument()
    let current = true
    onLoad = () => { current = false }
    const { renderMermaid } = await import('../src/renderer/src/lib/mermaid')

    expect(await renderMermaid('graph TD; A-->B', 'light', () => current)).toBeUndefined()
    expect(loads).toBe(1)
    expect(initialize).not.toHaveBeenCalled()
    expect(render).not.toHaveBeenCalled()
    expect(dom.createElement).not.toHaveBeenCalled()
  })

  it('skips a diagram cancelled while waiting for another render', async () => {
    const dom = fakeDocument()
    const firstResult = deferred<{ svg: string }>()
    render.mockImplementationOnce(() => firstResult.promise)
    const { renderMermaid } = await import('../src/renderer/src/lib/mermaid')
    const first = renderMermaid('graph TD; A-->B', 'light')
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1))
    let current = true
    const cancelled = renderMermaid('graph TD; B-->C', 'dark', () => current)
    current = false
    firstResult.resolve({ svg: '<svg>first</svg>' })

    await expect(first).resolves.toBe('<svg>first</svg>')
    await expect(cancelled).resolves.toBeUndefined()
    expect(initialize).toHaveBeenCalledTimes(1)
    expect(render).toHaveBeenCalledTimes(1)
    expect(dom.attached.size).toBe(0)
  })

  it('removes failed render containers and allows queued diagrams to recover', async () => {
    const dom = fakeDocument()
    const error = new Error('Parse error in diagram')
    render.mockRejectedValueOnce(error).mockResolvedValueOnce({ svg: '<svg>recovered</svg>' })
    const { renderMermaid } = await import('../src/renderer/src/lib/mermaid')
    const failed = renderMermaid('invalid graph', 'light')
    const rejected = expect(failed).rejects.toBe(error)
    const recovered = renderMermaid('graph TD; A-->B', 'dark')

    await rejected
    await expect(recovered).resolves.toBe('<svg>recovered</svg>')
    expect(render).toHaveBeenCalledTimes(2)
    expect(dom.nodes).toHaveLength(2)
    expect(dom.nodes.every((node) => node.remove.mock.calls.length === 1)).toBe(true)
    expect(dom.attached.size).toBe(0)
  })
})

describe('Markdown Mermaid fences', () => {
  it.each(['mermaid', 'Mermaid', 'MERMAID'])('dispatches %s fences to the diagram component with source available while pending', async (lang) => {
    const { Markdown } = await import('../src/renderer/src/components/items/Markdown')
    const html = renderToStaticMarkup(createElement(Markdown, { text: '```' + lang + '\ngraph TD; A-->B\n```' }))

    expect(html).toMatch(/class="[^"]*\bmermaid-block\b/)
    expect(html).toContain('graph TD; A--&gt;B')
    expect(html).not.toContain('class="inline-code"')
    expect(loads).toBe(0)
    expect(render).not.toHaveBeenCalled()
  })

  it('keeps ordinary fenced and inline code rendering intact', async () => {
    const { Markdown } = await import('../src/renderer/src/components/items/Markdown')
    const html = renderToStaticMarkup(createElement(Markdown, {
      text: '`mermaid`\n\n```ts\nconst diagram = "mermaid";\n```'
    }))

    expect(html).toContain('<code class="inline-code">mermaid</code>')
    expect(html).toContain('class="code-block"')
    expect(html).toContain('<span>ts</span>')
    expect(html).toContain('<pre><code>const diagram = &quot;mermaid&quot;;</code></pre>')
    expect(html).not.toContain('mermaid-block')
    expect(loads).toBe(0)
  })
})
