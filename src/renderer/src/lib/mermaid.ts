export type DiagramTheme = 'light' | 'dark'

let mermaidModule: Promise<typeof import('mermaid')> | undefined
let renderQueue: Promise<unknown> = Promise.resolve()
let nextDiagramId = 0

function loadMermaid() {
  return mermaidModule ??= import('mermaid').catch((error) => {
    mermaidModule = undefined
    throw error
  })
}

/** Mermaid shares configuration and a render queue; keep initialization in that same queue. */
export function renderMermaid(
  text: string,
  theme: DiagramTheme,
  isCurrent: () => boolean = () => true
): Promise<string | undefined> {
  const result = renderQueue.then(async () => {
    if (!isCurrent()) return
    const { default: mermaid } = await loadMermaid()
    if (!isCurrent()) return
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      // Diagram directives must not weaken security or inject an error graphic into the page.
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering'],
      theme: theme === 'dark' ? 'dark' : 'default',
      fontFamily: '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    })
    // Keep text measurement in the document without flashing temporary diagrams or errors.
    const container = document.createElement('div')
    container.className = 'mermaid-measure'
    container.setAttribute('aria-hidden', 'true')
    document.body.appendChild(container)
    try {
      const { svg } = await mermaid.render(`mermaid-${++nextDiagramId}`, text, container)
      return svg
    } finally {
      container.remove()
    }
  })
  renderQueue = result.catch(() => undefined)
  return result
}
