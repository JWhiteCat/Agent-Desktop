export type DiagramTheme = 'light' | 'dark'

type MermaidApi = typeof import('mermaid')['default']
type MermaidLoader = () => Promise<{ default: MermaidApi }>

let mermaidApi: Promise<MermaidApi> | undefined
let renderQueue: Promise<unknown> = Promise.resolve()
let nextDiagramId = 0

function loadMermaid(): Promise<MermaidApi> {
  return mermaidApi ??= import('mermaid')
    .then(async (mod) => {
      const value = mod.default as MermaidApi | MermaidLoader
      return typeof value === 'function' ? (await value()).default : value
    })
    .catch((error) => {
      mermaidApi = undefined
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
    const mermaid = await loadMermaid()
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
