import { describe, expect, it } from 'vitest'
import { paintUnreadBadge, pngsToIco, unreadBadgeLabel } from '../src/main/taskbar-icon'

describe('unread taskbar icon', () => {
  it.each([
    [0, ''], [1, '1'], [12, '12'], [99, '99'], [100, '99+'], [10_000, '99+'],
    [0.5, ''], [12.9, '12'], [99.5, '99'], [-1, ''], [NaN, ''], [Infinity, ''], [-Infinity, '']
  ])('formats unread count %s as %s', (count, label) => {
    expect(unreadBadgeLabel(Number(count))).toBe(label)
  })

  it('returns an unchanged copy when there are no unread tasks', () => {
    const original = Buffer.alloc(64 * 64 * 4, 42)
    const painted = paintUnreadBadge(original, 64, '')
    expect(painted).toEqual(original)
    expect(painted).not.toBe(original)
  })

  it.each(['1', '12', '99+'])('paints a red badge with white %s lettering in the top-right only', (label) => {
    const original = Buffer.alloc(64 * 64 * 4)
    for (let offset = 0; offset < original.length; offset += 4) {
      original.set([10, 20, 30, 255], offset)
    }
    const saved = Buffer.from(original)
    const painted = paintUnreadBadge(original, 64, label)
    let changed = 0
    let red = 0
    let white = 0
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const offset = (y * 64 + x) * 4
        const pixel = painted.subarray(offset, offset + 4)
        if (!pixel.equals(original.subarray(offset, offset + 4))) {
          changed++
          expect(x).toBeGreaterThanOrEqual(21)
          expect(y).toBeLessThan(27)
          if (pixel.equals(Buffer.from([46, 34, 207, 255]))) red++
          if (pixel.equals(Buffer.from([255, 255, 255, 255]))) white++
        }
      }
    }
    expect(changed).toBeGreaterThan(0)
    expect(red).toBeGreaterThan(0)
    expect(white).toBeGreaterThan(0)
    expect(original).toEqual(saved)
  })

  it.each([16, 32, 48, 64, 256])('preserves the rest of the original %s-pixel image', (size) => {
    const original = Buffer.alloc(size * size * 4, 40)
    const painted = paintUnreadBadge(original, size, '99+')
    expect(painted.length).toBe(original.length)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (x >= Math.floor(21 * size / 64) && y < Math.ceil(27 * size / 64)) continue
        const offset = (y * size + x) * 4
        expect(painted.subarray(offset, offset + 4)).toEqual(original.subarray(offset, offset + 4))
      }
    }
  })

  it('writes an ICO directory with each PNG payload at its advertised offset', () => {
    const images = [16, 32, 48, 64, 256].map((size) => ({ size, png: Buffer.from(`png-${size}`) }))
    const ico = pngsToIco(images)
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(images.length)
    let expectedOffset = 6 + images.length * 16
    images.forEach(({ size, png }, index) => {
      const entry = 6 + index * 16
      expect(ico[entry]).toBe(size === 256 ? 0 : size)
      expect(ico[entry + 1]).toBe(size === 256 ? 0 : size)
      expect(ico[entry + 2]).toBe(0)
      expect(ico[entry + 3]).toBe(0)
      expect(ico.readUInt16LE(entry + 4)).toBe(1)
      expect(ico.readUInt16LE(entry + 6)).toBe(32)
      expect(ico.readUInt32LE(entry + 8)).toBe(png.length)
      expect(ico.readUInt32LE(entry + 12)).toBe(expectedOffset)
      expect(ico.subarray(expectedOffset, expectedOffset + png.length)).toEqual(png)
      expectedOffset += png.length
    })
    expect(ico.length).toBe(expectedOffset)
  })
})
