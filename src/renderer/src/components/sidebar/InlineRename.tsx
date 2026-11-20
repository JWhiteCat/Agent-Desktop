import { useEffect, useRef, useState } from 'react'

export function InlineRename({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const [text, setText] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      className="inline-rename"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onDone(text.trim() && text.trim() !== value ? text.trim() : null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setText(value)
          onDone(null)
        }
      }}
    />
  )
}
