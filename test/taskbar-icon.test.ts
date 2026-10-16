import { describe, expect, it } from 'vitest'
import { createUnreadBadgeBitmap, unreadBadgeLabel } from '../src/main/taskbar-icon'

describe('unread taskbar icon', () => {
  it.each([
    [0, ''], [1, '1'], [12, '12'], [99, '99'], [100, '99+'], [10_000, '99+'],
    [0.5, ''], [12.9, '12'], [99.5, '99'], [-1, ''], [NaN, ''], [Infinity, ''], [-Infinity, '']
  ])('formats unread count %s as %s', (count, label) => {
    expect(unreadBadgeLabel(Number(count))).toBe(label)
  })

  it('returns a transparent overlay when there are no unread tasks', () => {
    expect(createUnreadBadgeBitmap(32, '')).toEqual(Buffer.alloc(32 * 32 * 4))
  })

  it.each(['1', '2', '12', '99+'])('draws a standalone red circle with white %s lettering', (label) => {
    const painted = createUnreadBadgeBitmap(32, label)
    let red = 0
    let white = 0
    for (let offset = 0; offset < painted.length; offset += 4) {
      const pixel = painted.subarray(offset, offset + 4)
      if (pixel.equals(Buffer.from([46, 34, 207, 255]))) red++
      if (pixel.equals(Buffer.from([255, 255, 255, 255]))) white++
    }
    expect(red).toBeGreaterThan(0)
    expect(white).toBeGreaterThan(0)
    // Transparent corners leave the underlying application icon visible.
    for (const [x, y] of [[0, 0], [31, 0], [0, 31], [31, 31]]) {
      expect(painted.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)).toEqual(Buffer.alloc(4))
    }
    expect(painted).not.toEqual(createUnreadBadgeBitmap(32, label === '1' ? '2' : '1'))
  })

  it.each([16, 20, 24, 32, 48, 64])('keeps a %s-pixel overlay premultiplied and visible at taskbar display scales', (size) => {
    const painted = createUnreadBadgeBitmap(size, '99+')
    expect(painted.length).toBe(size * size * 4)
    let antialiased = false
    const textByThird = [0, 0, 0]
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const offset = (y * size + x) * 4
        const [blue, green, red, alpha] = painted.subarray(offset, offset + 4)
        expect(Math.max(blue, green, red)).toBeLessThanOrEqual(alpha)
        if (alpha > 0 && alpha < 255) antialiased = true
        if (blue > 128 && green > 128 && red > 128 && alpha === 255) {
          textByThird[Math.min(2, Math.floor(x * 3 / size))]++
        }
      }
    }
    expect(antialiased).toBe(true)
    expect(textByThird.every(count => count > 0)).toBe(true)
  })
})
