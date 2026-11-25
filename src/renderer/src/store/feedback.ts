import { getState, setState } from './state'

let toastSeq = 0
const reportedErrors = new WeakSet<object>()

export function toast(text: string, level: 'info' | 'error' = 'info'): void {
  const id = ++toastSeq
  setState({ toast: { id, text, level } })
  setTimeout(() => {
    if (getState().toast?.id === id) setState({ toast: undefined })
  }, level === 'error' ? 6000 : 3000)
}

/** Shows an error toast at most once per Error/object instance across layered catch handlers. */
export function toastError(err: unknown): void {
  if (err && typeof err === 'object') {
    if (reportedErrors.has(err)) return
    reportedErrors.add(err)
  }
  toast(errorText(err), 'error')
}

export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
