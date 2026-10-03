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

/** Draw onto Windows' premultiplied BGRA bitmap, preserving pixels outside the badge. */
export function paintUnreadBadge(bitmap: Buffer, size: number, label: string): Buffer {
  const painted = Buffer.from(bitmap)
  if (!label) return painted
  const textWidth = label.length * 12 - 2
  const width = Math.max(26, textWidth + 8)
  const left = 63 - width
  const top = 1
  const height = 26
  const radius = height / 2
  const textLeft = left + (width - textWidth) / 2
  const textTop = top + 6
  const samples = 4
  for (let y = 0; y < Math.ceil((top + height) * size / 64); y++) {
    for (let x = Math.floor(left * size / 64); x < size; x++) {
      let red = 0
      let white = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = (x + (sx + 0.5) / samples) * 64 / size
          const py = (y + (sy + 0.5) / samples) * 64 / size
          const cx = Math.max(left + radius, Math.min(left + width - radius, px))
          if ((px - cx) ** 2 + (py - top - radius) ** 2 > radius ** 2) continue
          red++
          const tx = px - textLeft
          const ty = py - textTop
          const index = Math.floor(tx / 12)
          const column = Math.floor((tx - index * 12) / 2)
          const row = Math.floor(ty / 2)
          if (index >= 0 && index < label.length && column >= 0 && column < 5 && row >= 0 && row < 7 && DIGITS[label[index]]?.[row][column] === '1') white++
        }
      }
      if (!red) continue
      const alpha = red / (samples * samples)
      const light = white / (samples * samples)
      const offset = (y * size + x) * 4
      const color = [46, 34, 207]
      for (let channel = 0; channel < 3; channel++) {
        painted[offset + channel] = Math.round(painted[offset + channel] * (1 - alpha) + color[channel] * (alpha - light) + 255 * light)
      }
      painted[offset + 3] = Math.round(painted[offset + 3] * (1 - alpha) + 255 * alpha)
    }
  }
  return painted
}

/** Windows supports PNG image entries in ICO files; keep multiple sizes for display scaling. */
export function pngsToIco(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  for (const [index, image] of images.entries()) {
    const entry = 6 + index * 16
    header[entry] = image.size === 256 ? 0 : image.size
    header[entry + 1] = header[entry]
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(image.png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += image.png.length
  }
  return Buffer.concat([header, ...images.map((image) => image.png)])
}
