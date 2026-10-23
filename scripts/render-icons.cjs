// Usage (via `npm run icons --`):
//   (no args)          rasterize resources/icons/icon.svg into PNGs, icon.ico and icon.icns
//   <file.svg>         copy that SVG to resources/icons/icon.svg, then rasterize
//   --preview          draw docs/icons/*.svg side by side into docs/icons/preview.png
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const iconDir = path.join(root, 'resources/icons')
const candidateDir = path.join(root, 'docs/icons')
const PNG_SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024]
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

const svgUrl = (file) => `data:image/svg+xml;base64,${fs.readFileSync(file).toString('base64')}`
const fromDataUrl = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')

function rasterize(win, file, sizes) {
  return win.webContents.executeJavaScript(`(async () => {
    const img = new Image()
    img.src = ${JSON.stringify(svgUrl(file))}
    await img.decode()
    return ${JSON.stringify(sizes)}.map((size) => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      canvas.getContext('2d').drawImage(img, 0, 0, size, size)
      return canvas.toDataURL('image/png')
    })
  })()`).then((urls) => urls.map(fromDataUrl))
}

function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, i) => {
    const entry = 6 + i * 16
    header.writeUInt8(size >= 256 ? 0 : size, entry)
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map((image) => image.png)])
}

async function buildAppIcons(win, source) {
  const target = path.join(iconDir, 'icon.svg')
  if (source && path.resolve(source) !== target) fs.copyFileSync(source, target)
  const pngs = await rasterize(win, target, PNG_SIZES)
  PNG_SIZES.forEach((size, i) => fs.writeFileSync(path.join(iconDir, `${size}x${size}.png`), pngs[i]))
  fs.writeFileSync(path.join(iconDir, 'icon.ico'), ico(ICO_SIZES.map((size) => ({ size, png: pngs[PNG_SIZES.indexOf(size)] }))))
  // Modern ICNS elements contain PNG data; no macOS-only iconutil dependency is needed.
  const elements = [[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']].map(([size, type]) => {
    const png = pngs[PNG_SIZES.indexOf(size)]
    const header = Buffer.alloc(8)
    header.write(type)
    header.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([header, png])
  })
  const header = Buffer.alloc(8)
  header.write('icns')
  header.writeUInt32BE(8 + elements.reduce((total, element) => total + element.length, 0), 4)
  fs.writeFileSync(path.join(iconDir, 'icon.icns'), Buffer.concat([header, ...elements]))
  console.log(`Wrote ${PNG_SIZES.length} PNGs, icon.ico and icon.icns to ${path.relative(root, iconDir)}`)
}

async function buildPreview(win) {
  const files = fs.readdirSync(candidateDir).filter((name) => name.endsWith('.svg')).sort()
  const items = files.map((name) => ({ name: name.replace(/\.svg$/, ''), url: svgUrl(path.join(candidateDir, name)) }))
  const url = await win.webContents.executeJavaScript(`(async () => {
    const items = ${JSON.stringify(items)}
    const col = 240, width = col * items.length, height = 440
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#f4f4f5'
    ctx.fillRect(0, 0, width, 340)
    ctx.fillStyle = '#18181b'
    ctx.fillRect(0, 340, width, 100)
    for (const [i, item] of items.entries()) {
      const img = new Image()
      img.src = item.url
      await img.decode()
      const x = i * col
      ctx.drawImage(img, x + 24, 24, 192, 192)
      ctx.fillStyle = '#18181b'
      ctx.font = '600 16px Segoe UI, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(item.name, x + col / 2, 244)
      let sx = x + 36
      for (const size of [64, 32, 16]) {
        ctx.drawImage(img, sx, 292 - size / 2, size, size)
        ctx.drawImage(img, sx, 390 - size / 2, size, size)
        sx += size + 28
      }
    }
    return canvas.toDataURL('image/png')
  })()`)
  fs.writeFileSync(path.join(candidateDir, 'preview.png'), fromDataUrl(url))
  console.log(`Wrote preview of ${items.length} candidates to docs/icons/preview.png`)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('about:blank')
  const args = process.argv.slice(2).filter((arg) => arg !== '.' && !arg.endsWith('render-icons.cjs'))
  if (args.includes('--preview')) await buildPreview(win)
  else await buildAppIcons(win, args[0])
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
