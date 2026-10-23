import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Verify the actual DMG on its native runner, without credentials or model calls.
const [image, arch] = process.argv.slice(2)
assert(process.platform === 'darwin', 'Run this check on macOS')
assert(['arm64', 'x64'].includes(arch) && process.arch === arch, 'Use a runner matching the DMG architecture')
assert(image && fs.statSync(image).size > 0, 'Expected a nonempty DMG')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-mac-check-'))
const mount = path.join(root, 'mount')
const home = path.join(root, 'home')
fs.mkdirSync(mount)
fs.mkdirSync(home)
const env = {
  ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'),
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_CONFIG_HOME: path.join(home, '.config'),
  ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1'
}
for (const directory of [env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.XDG_CONFIG_HOME]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
for (const key of ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_OPTIONS']) delete env[key]

function run(command, args, extra = {}) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000, ...extra })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${command}: ${result.stderr || result.stdout}`)
  return result.stdout
}

function checkArchitecture(file) {
  fs.accessSync(file, fs.constants.X_OK)
  const expected = arch === 'x64' ? 'x86_64' : 'arm64'
  assert(run('/usr/bin/lipo', ['-archs', file]).trim().split(/\s+/).includes(expected), `Wrong architecture: ${file}`)
}

async function stop(child) {
  if (!child.pid) return
  await new Promise((resolve) => {
    const kill = (signal) => { try { process.kill(-child.pid, signal) } catch { /* already gone */ } }
    const timer = setTimeout(() => kill('SIGKILL'), 2_000)
    child.once('close', () => { clearTimeout(timer); resolve() })
    kill('SIGTERM')
    if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); kill('SIGKILL'); resolve() }
  })
}

async function initializeAdapter(executable, entry, extraEnv = {}) {
  const child = spawn(executable, [entry], { cwd: home, env: { ...env, ...extraEnv }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    await new Promise((resolve, reject) => {
      let lines = ''
      let errors = ''
      const timer = setTimeout(() => reject(new Error(`ACP initialization timed out: ${entry}\n${errors}`)), 30_000)
      const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve() }
      child.once('error', finish)
      child.once('exit', (code) => finish(new Error(`ACP exited before initialization (${code}): ${errors}`)))
      child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-4096) })
      child.stdout.on('data', (chunk) => {
        lines += chunk
        const complete = lines.split('\n')
        lines = complete.pop()
        for (const line of complete) {
          let response
          try { response = JSON.parse(line) } catch { continue }
          if (response.id !== 1) continue
          if (response.error) finish(new Error(JSON.stringify(response.error)))
          else if (response.result?.protocolVersion === 1) finish()
          else finish(new Error(`Invalid ACP initialization: ${line}`))
        }
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agent-desktop-package-check', version: '1' }
      } }) + '\n')
    })
  } finally { await stop(child) }
}

async function smokeWindow(executable) {
  const profile = path.join(root, 'profile')
  const mock = path.join(root, 'mock-agent')
  fs.writeFileSync(mock, '#!/bin/sh\ncase "$1" in\n--version) echo mac-package-fixture;;\nmodels) echo "auto - Auto (default)";;\nstatus) echo offline-fixture;;\n*) exit 1;;\nesac\n', { mode: 0o755 })
  fs.mkdirSync(path.join(profile, 'data'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'data', 'state.json'), JSON.stringify({
    version: 1, projects: [], threads: [], settings: {
      agentPath: mock, codexPath: path.join(root, 'absent-codex'), claudePath: path.join(root, 'absent-claude'),
      remoteEnabled: false, remotePublicEnabled: false, notifyOnComplete: false
    }
  }))
  const guiEnv = { ...env, AGENT_DESKTOP_USER_DATA: profile }
  delete guiEnv.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], {
    cwd: home, env: guiEnv, detached: true, stdio: ['ignore', 'ignore', 'pipe']
  })
  let errors = ''
  let socket
  child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-16_384) })
  child.on('error', (error) => { errors += String(error) })
  const deadline = Date.now() + 30_000
  try {
    let target
    while (Date.now() < deadline && !target) {
      assert(child.exitCode === null && child.signalCode === null, `Application exited: ${errors}`)
      const address = errors.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]
      if (address) {
        const url = new URL(address)
        const targets = await fetch(`http://127.0.0.1:${url.port}/json/list`).then(response => response.json())
        target = targets.find(entry => entry.type === 'page' && entry.url.startsWith('file:'))
      }
      if (!target) await delay(100)
    }
    assert(target, `Packaged renderer did not open: ${errors}`)
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DevTools connection timed out')), 5_000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('DevTools connection failed')) }, { once: true })
    })
    let id = 0
    const evaluate = (expression) => new Promise((resolve, reject) => {
      const requestId = ++id
      const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('Renderer evaluation timed out')) }, 5_000)
      const receive = ({ data }) => {
        const message = JSON.parse(data)
        if (message.id !== requestId) return
        clearTimeout(timer)
        socket.removeEventListener('message', receive)
        if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message)))
        else resolve(message.result.result.value)
      }
      socket.addEventListener('message', receive)
      socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
    let rendered = false
    while (Date.now() < deadline && !rendered) {
      rendered = await evaluate('!!document.querySelector(".app") && window.api?.platform === "darwin"')
      if (!rendered) await delay(100)
    }
    assert(rendered, 'Packaged renderer failed to initialize')
    const version = await evaluate('window.api.cliInfo("cursor").then(info => info.version)')
    assert.equal(version, 'mac-package-fixture', 'Packaged CLI detection did not use the isolated fixture')
    console.log('Packaged window, preload IPC and mock CLI: OK')
  } finally {
    socket?.close()
    await stop(child)
  }
}

let attached = false
try {
  run('/usr/bin/hdiutil', ['attach', path.resolve(image), '-readonly', '-nobrowse', '-mountpoint', mount])
  attached = true
  const appName = 'Agent Desktop.app'
  const application = path.join(root, appName)
  run('/usr/bin/ditto', [path.join(mount, appName), application])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application])
  const resources = path.join(application, 'Contents', 'Resources')
  const executable = path.join(application, 'Contents', 'MacOS', 'Agent Desktop')
  const modules = path.join(resources, 'app.asar.unpacked', 'node_modules')
  const codex = path.join(modules, '@openai', `codex-darwin-${arch}`, 'vendor', `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`, 'bin', 'codex')
  const claude = path.join(modules, '@anthropic-ai', `claude-agent-sdk-darwin-${arch}`, 'claude')
  for (const file of [executable, codex, claude]) checkArchitecture(file)
  env.CODEX_PATH = codex
  env.CLAUDE_CODE_EXECUTABLE = claude
  const codexEntry = path.join(modules, '@agentclientprotocol', 'codex-acp', 'dist', 'index.js')
  const claudeEntry = path.join(modules, '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js')
  assert(run(executable, [path.join(modules, '@openai', 'codex', 'bin', 'codex.js'), '--version']).trim(), 'Missing Codex version')
  assert(run(executable, [claudeEntry, '--cli', '--version']).trim(), 'Missing Claude version')
  await initializeAdapter(executable, codexEntry)
  // Claude's initialize probes auth status; never let a local verification read Keychain logins.
  const authFixture = path.join(root, 'mock-claude-auth')
  fs.writeFileSync(authFixture, '#!/bin/sh\nprintf \'%s\\n\' \'{"loggedIn":false,"authMethod":"none"}\'\n', { mode: 0o755 })
  await initializeAdapter(executable, claudeEntry, { CLAUDE_CODE_EXECUTABLE: authFixture })
  const payloadFile = path.join(root, 'payload.json')
  const marker = 'literal 中文 "quotes" & $value\n'
  fs.writeFileSync(payloadFile, JSON.stringify({ program: '/usr/bin/printf', args: ['%s', marker], cwd: home, messages: { finished: 'exit', failed: 'failed', close: 'close' } }))
  const output = run(executable, [path.join(resources, 'toolbar-runner.cjs'), payloadFile], { input: '\n' })
  assert(output.includes(marker), 'Runner changed literal command arguments')
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'status.json'), 'utf8')).kind, 'started')
  await smokeWindow(executable)
  console.log(`DMG, signature, ${arch} binaries, ACP initialization and terminal runner: OK`)
} finally {
  try {
    if (attached) run('/usr/bin/hdiutil', ['detach', mount])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
