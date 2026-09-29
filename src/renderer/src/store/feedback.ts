import { getState, setState } from './state'

let toastSeq = 0

export function toast(text: string, level: 'info' | 'error' = 'info'): void {
  const id = ++toastSeq
  setState({ toast: { id, text, level } })
  setTimeout(() => {
    if (getState().toast?.id === id) setState({ toast: undefined })
  }, level === 'error' ? 6000 : 3000)
}

export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
