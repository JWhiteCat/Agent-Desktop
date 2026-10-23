/** Format translated shortcut hints using the desktop platform's modifier key. */
export function shortcutHint(label: string): string {
  return window.api.platform === 'darwin' ? label.replace(/Ctrl\+Shift\+/g, '⌘⇧').replace(/Ctrl\+/g, '⌘') : label
}
