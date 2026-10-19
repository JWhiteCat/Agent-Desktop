/** New order after dropping `from` before `to`, or after it when `after` is set. */
export function moveQueued(ids: string[], from: string, to: string, after: boolean): string[] {
  if (from === to) return ids
  const rest = ids.filter((id) => id !== from)
  const at = rest.indexOf(to)
  if (at < 0) return ids
  rest.splice(after ? at + 1 : at, 0, from)
  return rest
}
