import { isValidElement, memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { QUESTION_BLOCK_LANG } from '@shared/questions'
import { CodeBlock } from './primitives'
import { QuestionBlock } from './Questions'

const mdComponents: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        if (href) window.api.openExternal(href)
      }}
    >
      {children}
    </a>
  ),
  pre: ({ children }) => {
    const code = isValidElement<{ className?: string; children?: React.ReactNode }>(children) ? children.props : undefined
    const text = String(code?.children ?? '').replace(/\n$/, '')
    const lang = /language-([\w+-]+)/.exec(code?.className ?? '')?.[1]
    if (lang === QUESTION_BLOCK_LANG) return <QuestionBlock body={text} />
    return <CodeBlock lang={lang} text={text} />
  },
  code: ({ children }) => <code className="inline-code">{children}</code>,
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  )
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
