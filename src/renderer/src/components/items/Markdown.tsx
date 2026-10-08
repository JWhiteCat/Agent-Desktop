import { createContext, isValidElement, memo, useContext } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { QUESTION_BLOCK_LANG } from '@shared/questions'
import { isLocalFileLink } from '@shared/markdown-links'
import { openMarkdownLink } from '../../lib/markdown-links'
import { Hyperlink } from '../Hyperlink'
import { CodeBlock } from './primitives'
import { QuestionBlock } from './Questions'

export const MarkdownDirectoryContext = createContext<string | undefined>(undefined)

function MarkdownLink({ href, children }: React.ComponentProps<'a'>) {
  const cwd = useContext(MarkdownDirectoryContext)
  return (
    <Hyperlink
      href={href}
      cwd={cwd}
      onClick={(e) => {
        e.preventDefault()
        void openMarkdownLink(href, cwd)
      }}
    >
      {children}
    </Hyperlink>
  )
}

const mdComponents: Components = {
  a: MarkdownLink,
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
  const cwd = useContext(MarkdownDirectoryContext)
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={mdComponents}
        urlTransform={(url, key, node) =>
          key === 'href' && node.tagName === 'a' && isLocalFileLink(url, cwd) ? url : defaultUrlTransform(url)
        }
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
