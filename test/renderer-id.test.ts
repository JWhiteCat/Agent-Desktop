import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomId } from '../src/renderer/src/lib/id'
import { emptyMcpDraft, emptySkillDraft } from '../src/renderer/src/components/AgentConfigSettings'

afterEach(() => vi.unstubAllGlobals())

describe('configuration IDs', () => {
  it('uses the browser UUID implementation when available', () => {
    const randomUUID = vi.fn(() => 'b6c1c39c-ea67-4f71-860d-ad698fd8a560')
    vi.stubGlobal('crypto', { randomUUID })

    expect(randomId()).toBe('b6c1c39c-ea67-4f71-860d-ad698fd8a560')
    expect(randomUUID).toHaveBeenCalledOnce()
  })

  it('creates MCP and Skill drafts on HTTP pages without randomUUID', () => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) })

    const ids = Array.from({ length: 20 }, () => [emptyMcpDraft().id, emptySkillDraft().id]).flat()

    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
