import { describe, expect, it } from 'vitest'
import { moveQueued } from '../src/renderer/src/lib/queue'

describe('moveQueued', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('drops before or after the target row', () => {
    expect(moveQueued(ids, 'd', 'b', false)).toEqual(['a', 'd', 'b', 'c'])
    expect(moveQueued(ids, 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveQueued(ids, 'a', 'd', true)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('keeps the order for a drop on itself or an unknown row', () => {
    expect(moveQueued(ids, 'b', 'b', true)).toBe(ids)
    expect(moveQueued(ids, 'b', 'x', false)).toBe(ids)
  })
})
