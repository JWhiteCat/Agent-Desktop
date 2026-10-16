const DIGITS: Record<string, string[]> = {
  '0': ['01110', '11011', '11011', '11011', '11011', '11011', '01110'],
  '1': ['00110', '01110', '00110', '00110', '00110', '00110', '01111'],
  '2': ['01110', '11011', '00011', '00110', '01100', '11000', '11111'],
  '3': ['11110', '00011', '00011', '01110', '00011', '00011', '11110'],
  '4': ['00011', '00111', '01111', '11011', '11111', '00011', '00011'],
  '5': ['11111', '11000', '11000', '11110', '00011', '11011', '01110'],
  '6': ['01110', '11000', '11000', '11110', '11011', '11011', '01110'],
  '7': ['11111', '00011', '00110', '00110', '01100', '01100', '01100'],
  '8': ['01110', '11011', '11011', '01110', '11011', '11011', '01110'],
  '9': ['01110', '11011', '11011', '01111', '00011', '00011', '01110'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000']
}

export function unreadBadgeLabel(count: number): string {
  const whole = Math.floor(count)
  if (!Number.isFinite(whole) || whole <= 0) return ''
  return whole > 99 ? '99+' : String(whole)
}

/** A standalone premultiplied BGRA overlay; Windows positions it on the taskbar icon. */
export function createUnreadBadgeBitmap(size: number, label: string): Buffer {
  const painted = Buffer.alloc(size * size * 4)
  if (!label) return painted
  const textWidth = label.length * 12 - 2
  const diameter = Math.max(26, textWidth + 6)
  const canvasWidth = diameter + 2
  const center = canvasWidth / 2
  const radius = diameter / 2
  const digitRowHeight = label.length > 2 ? 3 : 2
  const textLeft = (canvasWidth - textWidth) / 2
  const textTop = (canvasWidth - 7 * digitRowHeight) / 2
  const samples = 4
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let red = 0
      let white = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = (x + (sx + 0.5) / samples) * canvasWidth / size
          const py = (y + (sy + 0.5) / samples) * canvasWidth / size
          if ((px - center) ** 2 + (py - center) ** 2 > radius ** 2) continue
          red++
          const tx = px - textLeft
          const ty = py - textTop
          const index = Math.floor(tx / 12)
          const column = Math.floor((tx - index * 12) / 2)
          const row = Math.floor(ty / digitRowHeight)
          if (index >= 0 && index < label.length && column >= 0 && column < 5 && row >= 0 && row < 7 && DIGITS[label[index]]?.[row][column] === '1') white++
        }
      }
      if (!red) continue
      const alpha = red / (samples * samples)
      const light = white / (samples * samples)
      const offset = (y * size + x) * 4
      const color = [46, 34, 207]
      for (let channel = 0; channel < 3; channel++) {
        painted[offset + channel] = Math.round(color[channel] * (alpha - light) + 255 * light)
      }
      painted[offset + 3] = Math.round(255 * alpha)
    }
  }
  return painted
}
