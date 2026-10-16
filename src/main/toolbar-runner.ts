// This entry is bundled separately and copied outside app.asar. It must not import Electron.
import spawn from 'cross-spawn'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { Console } from 'node:console'
import tty from 'node:tty'
import type { ToolbarCommandPayload, ToolbarCommandStatus } from './toolbar-command-payload'

const payloadFile = process.argv[2]
const directory = path.dirname(payloadFile)
let payload: ToolbarCommandPayload | undefined
let input: NodeJS.ReadableStream = process.stdin
let output: NodeJS.WritableStream = process.stdout
let stdio: 'inherit' | [number, number, number] = 'inherit'
let terminal = console

function status(value: ToolbarCommandStatus): void {
  const temporary = path.join(directory, 'status.tmp')
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
    fs.renameSync(temporary, path.join(directory, 'status.json'))
  } catch (error) {
    terminal.error(error)
  }
}

function hold(code: number): void {
  process.exitCode = code
  terminal.log(`\n${payload?.messages.close ?? 'Press Enter to close.'}`)
  const prompt = readline.createInterface({ input, output })
  prompt.once('line', () => {
    prompt.close()
    input.pause()
    if (input instanceof tty.ReadStream) input.unref()
    if (output instanceof tty.WriteStream) output.unref()
  })
}

try {
  // A GUI app may give PowerShell NUL standard handles even though Windows created a console.
  // Attach explicitly to that console so both the target and the Enter prompt remain usable.
  if (process.platform === 'win32' && process.env.AGENT_DESKTOP_TOOLBAR_CONSOLE === '1') {
    const inputFd = fs.openSync('\\\\.\\CONIN$', 'r+')
    const outputFd = fs.openSync('\\\\.\\CONOUT$', 'r+')
    input = new tty.ReadStream(inputFd)
    output = new tty.WriteStream(outputFd)
    stdio = [inputFd, outputFd, outputFd]
    terminal = new Console({ stdout: output, stderr: output })
  }
  payload = JSON.parse(fs.readFileSync(payloadFile, 'utf8')) as ToolbarCommandPayload
  // Retain launch mode for this runner only: programs such as VS Code are Electron apps too.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.AGENT_DESKTOP_TOOLBAR_CONSOLE
  const child = spawn(payload.program, payload.args, { cwd: payload.cwd, env, stdio, shell: false })
  let failed = false
  child.once('error', (error) => {
    failed = true
    status({ kind: 'error', message: error.message })
    terminal.error(`${payload!.messages.failed}: ${error.message}`)
    hold(1)
  })
  child.once('spawn', () => status({ kind: 'started' }))
  child.once('close', (code, signal) => {
    if (failed) return
    terminal.log(`\n${payload!.messages.finished}: ${code ?? signal ?? '?'}`)
    hold(code ?? 1)
  })
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  try { status({ kind: 'error', message }) } catch { /* The launcher may already have cleaned up. */ }
  terminal.error(`${payload?.messages.failed ?? 'Command failed'}: ${message}`)
  hold(1)
}
