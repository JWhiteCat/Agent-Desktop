import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CACHE_DIR = path.join('node_modules', '.cache', 'agent-desktop')
const LOCK_STAMP_PATH = path.join(CACHE_DIR, 'lock.sha256')
const BUILD_STAMP_PATH = path.join(CACHE_DIR, 'preview-build-stamp.json')
const BUILD_INPUT_FILES = [
  'package.json',
  'package-lock.json',
  'electron.vite.config.ts',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json'
]
const BUILD_OUTPUT_FILES = [
  path.join('out', 'main', 'index.js'),
  path.join('out', 'main', 'toolbar-runner.cjs'),
  path.join('out', 'preload', 'index.js'),
  path.join('out', 'renderer', 'index.html'),
  path.join('out', 'renderer', 'vendor', 'mermaid', 'mermaid.esm.min.mjs')
]

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export function isSupportedNodeVersion(version = process.versions.node) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return (major === 22 && minor >= 12) || major === 24 || major >= 26
}

export function dependenciesNeedInstall(rootDir) {
  const lockPath = path.join(rootDir, 'package-lock.json')
  const installedLockPath = path.join(rootDir, 'node_modules', '.package-lock.json')
  if (!fs.existsSync(installedLockPath)) return true

  const pkgPath = path.join(rootDir, 'package.json')
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    const expected = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {})
    ])
    for (const name of expected) {
      if (!fs.existsSync(path.join(rootDir, 'node_modules', ...name.split('/'), 'package.json'))) {
        return true
      }
    }
  }

  if (fs.existsSync(lockPath)) {
    const lockStat = fs.statSync(lockPath)
    const installedStat = fs.statSync(installedLockPath)
    if (lockStat.mtimeMs > installedStat.mtimeMs) {
      const stampPath = path.join(rootDir, LOCK_STAMP_PATH)
      const lockHash = sha256File(lockPath)
      const recorded = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8').trim() : ''
      if (recorded !== lockHash) return true
    }
  }

  return false
}

export function writeDependencyStamp(rootDir) {
  const lockHash = sha256File(path.join(rootDir, 'package-lock.json'))
  if (!lockHash) return
  const stampFile = path.join(rootDir, LOCK_STAMP_PATH)
  fs.mkdirSync(path.dirname(stampFile), { recursive: true })
  fs.writeFileSync(stampFile, `${lockHash}\n`)
}

export function resolveElectronBinary(rootDir) {
  const electronDir = path.join(rootDir, 'node_modules', 'electron')
  const pathTxt = path.join(electronDir, 'path.txt')
  const pkgJson = path.join(electronDir, 'package.json')
  const versionTxt = path.join(electronDir, 'dist', 'version')
  if (!fs.existsSync(pathTxt) || !fs.existsSync(pkgJson)) return null
  const relExe = fs.readFileSync(pathTxt, 'utf8').trim()
  if (!relExe) return null
  const exePath = path.join(electronDir, 'dist', relExe)
  if (!fs.existsSync(exePath)) return null
  if (fs.existsSync(versionTxt)) {
    const expected = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version
    const installed = fs.readFileSync(versionTxt, 'utf8').trim().replace(/^v/, '')
    if (expected && installed && expected !== installed) return null
  }
  return exePath
}

function collectFilesSorted(dirPath, rootDir, out) {
  if (!fs.existsSync(dirPath)) return
  const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      collectFilesSorted(full, rootDir, out)
    } else if (entry.isFile()) {
      const stat = fs.statSync(full)
      out.push(`${path.relative(rootDir, full).replace(/\\/g, '/')}:${stat.size}:${Math.trunc(stat.mtimeMs)}`)
    }
  }
}

export function computeBuildFingerprint(rootDir) {
  const lines = []
  collectFilesSorted(path.join(rootDir, 'src'), rootDir, lines)
  for (const rel of BUILD_INPUT_FILES) {
    const full = path.join(rootDir, rel)
    if (fs.existsSync(full)) {
      const stat = fs.statSync(full)
      lines.push(`${rel}:${stat.size}:${Math.trunc(stat.mtimeMs)}`)
    }
  }
  const mermaidPkg = path.join(rootDir, 'node_modules', 'mermaid', 'package.json')
  if (fs.existsSync(mermaidPkg)) {
    const stat = fs.statSync(mermaidPkg)
    lines.push(`mermaid:${stat.size}:${Math.trunc(stat.mtimeMs)}`)
  }
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex')
}

export function previewNeedsBuild(rootDir) {
  for (const rel of BUILD_OUTPUT_FILES) {
    if (!fs.existsSync(path.join(rootDir, rel))) return true
  }
  const stampFile = path.join(rootDir, BUILD_STAMP_PATH)
  if (!fs.existsSync(stampFile)) return true
  try {
    const parsed = JSON.parse(fs.readFileSync(stampFile, 'utf8'))
    return parsed.fingerprint !== computeBuildFingerprint(rootDir)
  } catch {
    return true
  }
}

export function writeBuildStamp(rootDir) {
  const stampFile = path.join(rootDir, BUILD_STAMP_PATH)
  fs.mkdirSync(path.dirname(stampFile), { recursive: true })
  fs.writeFileSync(stampFile, JSON.stringify({ fingerprint: computeBuildFingerprint(rootDir) }) + '\n')
}

export function getPreflightState(rootDir, mode = 'preview', nodeVersion = process.versions.node) {
  const nodeOk = isSupportedNodeVersion(nodeVersion)
  const needInstall = nodeOk ? dependenciesNeedInstall(rootDir) : true
  const electronExe = nodeOk && !needInstall ? resolveElectronBinary(rootDir) : null
  const needBuild = mode === 'preview' ? (!nodeOk || needInstall || previewNeedsBuild(rootDir)) : false
  return { nodeOk, needInstall, electronExe, needBuild }
}

function main() {
  const [command, ...args] = process.argv.slice(2)
  const rootDir = process.cwd()
  switch (command) {
    case 'preflight': {
      const mode = args[0] === 'dev' ? 'dev' : 'preview'
      const state = getPreflightState(rootDir, mode)
      process.stdout.write([
        `LAUNCHER_NODE_OK=${state.nodeOk ? '1' : '0'}`,
        `LAUNCHER_NEED_INSTALL=${state.needInstall ? '1' : '0'}`,
        `LAUNCHER_ELECTRON_EXE=${state.electronExe ?? ''}`,
        `LAUNCHER_NEED_BUILD=${state.needBuild ? '1' : '0'}`
      ].join('\n') + '\n')
      process.exit(0)
    }
    case 'mark-installed':
      writeDependencyStamp(rootDir)
      process.exit(0)
    case 'electron-exe': {
      const exe = resolveElectronBinary(rootDir)
      if (!exe) process.exit(1)
      process.stdout.write(`${exe}\n`)
      process.exit(0)
    }
    case 'mark-built':
      writeBuildStamp(rootDir)
      process.exit(0)
    default:
      process.stderr.write(`Unknown command: ${command ?? ''}\n`)
      process.exit(2)
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isDirectRun) main()
