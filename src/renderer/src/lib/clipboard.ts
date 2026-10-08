type InputSelection = {
  element: HTMLInputElement | HTMLTextAreaElement
  start: number
  end: number
  direction: 'forward' | 'backward' | 'none' | null
}

/** Copy on the device displaying this client, including HTTP remote pages. */
export async function copyText(text: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // Clipboard permissions and secure contexts vary across browser clients.
  }
  copyWithSelection(text)
}

function copyWithSelection(text: string): void {
  if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') {
    throw new Error('Clipboard copying is unavailable')
  }

  const active = document.activeElement as HTMLElement | null
  let input: InputSelection | undefined
  if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') {
    const element = active as HTMLInputElement | HTMLTextAreaElement
    if (element.selectionStart !== null && element.selectionEnd !== null) {
      input = { element, start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection }
    }
  }

  const selection = document.getSelection()
  const ranges: Range[] = []
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index++) ranges.push(selection.getRangeAt(index).cloneRange())
  }
  const anchorNode = selection?.anchorNode
  const anchorOffset = selection?.anchorOffset ?? 0
  const focusNode = selection?.focusNode
  const focusOffset = selection?.focusOffset ?? 0
  const scroll = { x: window.scrollX, y: window.scrollY }
  const ancestors: { element: HTMLElement; left: number; top: number }[] = []
  for (let element = active?.parentElement; element; element = element.parentElement) {
    ancestors.push({ element, left: element.scrollLeft, top: element.scrollTop })
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;'
  try {
    document.body.appendChild(textarea)
    textarea.focus({ preventScroll: true })
    textarea.select()
    if (!document.execCommand('copy')) throw new Error('Clipboard copying failed')
  } finally {
    textarea.remove()
    try { active?.focus({ preventScroll: true }) } catch { /* The original element may have been removed. */ }
    try { input?.element.setSelectionRange(input.start, input.end, input.direction ?? undefined) } catch { /* Input type may have changed. */ }
    if (selection) {
      try {
        selection.removeAllRanges()
        for (const range of ranges) selection.addRange(range)
        // Keep the direction of a backwards selection when the browser supports it.
        if (ranges.length === 1 && anchorNode && focusNode && typeof selection.setBaseAndExtent === 'function') {
          selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)
        }
      } catch { /* Selected nodes may have been removed. */ }
    }
    for (const { element, left, top } of ancestors) {
      element.scrollLeft = left
      element.scrollTop = top
    }
    if (window.scrollX !== scroll.x || window.scrollY !== scroll.y) window.scrollTo(scroll.x, scroll.y)
  }
}
