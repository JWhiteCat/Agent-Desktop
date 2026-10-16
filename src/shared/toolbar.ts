import type { BuiltinToolbarAction, ToolbarButton } from './types'

const ACTIONS: BuiltinToolbarAction[] = ['fork', 'files', 'vscode', 'cursor', 'changes']

export const DEFAULT_THREAD_TOOLBAR_BUTTONS: ToolbarButton[] = ACTIONS.map((action) => ({
  id: action, kind: 'builtin', action, visible: true
}))

type CommandButton = Extract<ToolbarButton, { kind: 'command' }>
const singleLine = (value: unknown): value is string => typeof value === 'string' && !/[\0\r\n]/.test(value)

/** Preserve configured order and hidden actions; repair older or hand-edited settings. */
export function normalizeToolbarButtons(value: unknown): ToolbarButton[] {
  if (!Array.isArray(value)) return DEFAULT_THREAD_TOOLBAR_BUTTONS.map((button) => ({ ...button }))
  const buttons: ToolbarButton[] = []
  const ids = new Set<string>()
  const builtins = new Set<BuiltinToolbarAction>()
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (item.kind === 'builtin' && ACTIONS.includes(item.action as BuiltinToolbarAction)) {
      const action = item.action as BuiltinToolbarAction
      if (builtins.has(action)) continue
      builtins.add(action)
      ids.add(action)
      buttons.push({ id: action, kind: 'builtin', action, visible: item.visible !== false })
    } else if (item.kind === 'command' && singleLine(item.id) && item.id.trim()
      && !ACTIONS.includes(item.id as BuiltinToolbarAction) && !ids.has(item.id)
      && singleLine(item.name) && item.name.trim() && singleLine(item.program) && item.program.trim()
      && Array.isArray(item.args) && item.args.every(singleLine)) {
      ids.add(item.id)
      buttons.push({
        id: item.id, kind: 'command', visible: item.visible !== false,
        name: item.name.trim(), program: item.program.trim(), args: item.args.slice()
      })
    }
  }
  for (const action of ACTIONS) {
    if (!builtins.has(action)) buttons.push({ id: action, kind: 'builtin', action, visible: true })
  }
  return buttons
}

/** Replace supported tokens once so braces in actual paths remain literal data. */
export function expandToolbarCommand(button: CommandButton, cwd: string, projectPath: string): { program: string; args: string[] } {
  const replace = (value: string) => value.replace(/\{(cwd|projectPath)\}/g, (_token, name: string) => name === 'cwd' ? cwd : projectPath)
  return { program: replace(button.program), args: button.args.map(replace) }
}
