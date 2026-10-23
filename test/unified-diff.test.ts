import { describe, expect, it } from 'vitest'
import { unifiedDiff } from '../src/shared/unified-diff'
import { parseUnifiedDiff } from '../src/shared/parsed-diff'
import { toolDiff } from '../src/renderer/src/lib/tools'

describe('unified diff file existence', () => {
  it.each(['', 'same\n', null])('omits unchanged content (%j)', (text) => {
    expect(unifiedDiff('file.txt', text, text)).toEqual({ text: '', added: 0, removed: 0 })
  })

  it.each(['', 'old\n'])('distinguishes deleting a file from clearing it (%j)', (oldText) => {
    const deleted = unifiedDiff('file.txt', oldText, null)
    expect(deleted.text).toContain('deleted file mode 100644')
    expect(deleted.text).toContain('+++ /dev/null')
    const cleared = unifiedDiff('file.txt', oldText, '')
    expect(cleared.text).not.toContain('deleted file mode')
    expect(cleared.text).not.toContain('/dev/null')
    if (oldText) expect(cleared.text).toContain('+++ b/file.txt')
    expect(deleted.removed).toBe(oldText ? 1 : 0)
    expect(cleared.removed).toBe(deleted.removed)
    expect(parseUnifiedDiff(deleted.text)[0]).toMatchObject({ path: 'file.txt', added: 0, removed: deleted.removed })
  })

  it.each(['', '\n', '\r\n', 'new\n'])('retains new-file metadata and blank lines (%j)', (text) => {
    const built = unifiedDiff('file.txt', null, text)
    expect(built.text).toContain('new file mode 100644\n--- /dev/null\n+++ b/file.txt')
    expect(built.added).toBe(text ? 1 : 0)
    expect(parseUnifiedDiff(built.text)[0]).toMatchObject({ path: 'file.txt', added: built.added, removed: 0 })
  })

  it('does not classify removal of a string fragment as file deletion', () => {
    const text = toolDiff({ id: 't', kind: 'tool', callId: 'c', tool: 'edit', status: 'success', startedAt: 0,
      args: { path: 'file.txt', old_string: 'remove\n', new_string: '' } })
    expect(text).toContain('-remove')
    expect(text).toContain('+++ b/file.txt')
    expect(text).not.toContain('deleted file mode')
  })
})
