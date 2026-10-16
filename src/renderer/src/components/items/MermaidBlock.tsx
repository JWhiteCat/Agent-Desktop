import { useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { useT } from '../../lib/i18n'
import { renderMermaid, type DiagramTheme } from '../../lib/mermaid'
import { CopyButton } from './primitives'
import { TurnActionsContext } from './TurnActions'

function getTheme(): DiagramTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

interface DiagramResult {
  text: string
  theme: DiagramTheme
  svg?: string
  failed?: boolean
}

export function MermaidBlock({ text }: { text: string }) {
  const t = useT()
  const { streaming } = useContext(TurnActionsContext)
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => 'light' as const)
  const [result, setResult] = useState<DiagramResult>()
  const current = result?.text === text && result.theme === theme ? result : undefined

  useEffect(() => {
    let active = true
    // Incomplete streamed syntax is common. Debounce it and discard obsolete queued renders.
    const timer = setTimeout(() => {
      void renderMermaid(text, theme, () => active).then(
        (svg) => { if (active && svg) setResult({ text, theme, svg }) },
        () => { if (active) setResult({ text, theme, failed: true }) }
      )
    }, streaming ? 200 : 0)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [text, theme, streaming])

  return (
    <div className="code-block mermaid-block">
      <div className="code-head">
        <span>mermaid</span>
        <CopyButton text={text} />
      </div>
      {current?.svg ? (
        <>
          {/* Mermaid sanitizes its SVG output in strict mode; no diagram callbacks are bound. */}
          <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: current.svg }} />
          <details className="mermaid-source">
            <summary>{t('查看源码')}</summary>
            <pre><code>{text}</code></pre>
          </details>
        </>
      ) : (
        <>
          <div className="mermaid-status" role="status">
            {current?.failed && !streaming ? t('图表渲染失败，已显示源码') : t('正在绘制图表…')}
          </div>
          <pre><code>{text}</code></pre>
        </>
      )}
    </div>
  )
}
