import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const scriptPath = path.join(dir, 'setup-public-server.sh')
const gatewayPath = path.join(dir, 'public-gateway.py')
const DEFAULT_HOST = '43.167.166.239'
const SSH_USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/
const HOST_LABEL = /^(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])$/
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const PUBLIC_KEY = /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com) [A-Za-z0-9+/]+={0,3}(?: [^ \r\n]+)?$/
const FLAGS = new Set(['--user', '--host', '--port', '--ssh-port', '--identity'])

export const USAGE = `用法
  npm run setup:public-server -- [选项]

在你自己的 Linux 服务器上配置公网远程控制：允许 SSH Unix 套接字反向隧道，并安装共用一个端口的入口。

选项
  --user <用户>       SSH 登录用户，默认 root
  --host <地址>       服务器域名或 IP，默认 ${DEFAULT_HOST}
  --port <端口>       公网入口端口，默认 8765
  --ssh-port <端口>   SSH 端口，默认 22
  --identity <私钥>   初次登录用的另一把私钥。应用之后仍使用本机默认密钥
  -h, --help          显示本说明

没有无口令的默认密钥时，会生成 ~/.ssh/id_ed25519。这把公钥还不能登录时，会提示输入一次 SSH 密码，并写入 authorized_keys。
非 root 用户通过 sudo 配置；需要密码时在提示里输入。服务器没有 python3 时会尝试安装。
完成后，在应用的远程控制里填写相同的 SSH 用户、服务器地址和公网端口。`

function validateUser(user) {
  const value = user.trim()
  if (!SSH_USER.test(value)) throw new Error('SSH 用户名无效')
  return value
}

function validateHost(host) {
  const value = host.trim()
  if (!value || value.includes('://') || value.includes('/') || value.includes('@') || /[\s:]/.test(value)) {
    throw new Error('服务器地址不能包含协议、端口或路径')
  }
  if (IPV4.test(value)) return value
  const labels = value.split('.')
  if (labels.length > 0 && labels.every((label) => HOST_LABEL.test(label))) return value
  throw new Error('服务器地址无效')
}

function validatePort(raw, kind) {
  if (!/^[0-9]+$/.test(raw)) throw new Error(kind === 'ssh' ? 'SSH 端口需在 1–65535 之间' : '公网端口需在 1–65535 之间，且不能是 22')
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(kind === 'ssh' ? 'SSH 端口需在 1–65535 之间' : '公网端口需在 1–65535 之间，且不能是 22')
  }
  if (kind === 'public' && value === 22) throw new Error('公网端口需在 1–65535 之间，且不能是 22')
  return value
}

export function parseSetupArgs(argv) {
  const args = argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    return { help: true, user: 'root', host: DEFAULT_HOST, port: 8765, sshPort: 22 }
  }
  const values = {}
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (!token.startsWith('--')) throw new Error('请用 --host 指定服务器')
    if (!FLAGS.has(token)) throw new Error(`未知参数 ${token}。运行 npm run setup:public-server -- --help 查看用法`)
    const value = args[i + 1]
    if (!value || value.startsWith('-')) throw new Error(`${token} 缺少参数`)
    values[token] = value
    i++
  }
  const port = validatePort(values['--port'] ?? '8765', 'public')
  const sshPort = validatePort(values['--ssh-port'] ?? '22', 'ssh')
  if (port === sshPort) throw new Error('公网端口和 SSH 端口不能相同')
  const identity = values['--identity']
  if (identity !== undefined && /[\r\n]/.test(identity)) throw new Error('私钥路径无效')
  return {
    help: false,
    user: validateUser(values['--user'] ?? 'root'),
    host: validateHost(values['--host'] ?? DEFAULT_HOST),
    port,
    sshPort,
    identity
  }
}

export function shellSingleQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function assertPublicKey(text) {
  const line = text.trim()
  if (!PUBLIC_KEY.test(line) || line.includes("'")) throw new Error('公钥格式无效')
  return line
}

export function installAuthorizedKeysCommand(keys) {
  if (!keys.length) throw new Error('缺少公钥')
  const lines = keys.map((key) => {
    const quoted = shellSingleQuote(assertPublicKey(key))
    return `grep -qxF ${quoted} ~/.ssh/authorized_keys || printf '%s\\n' ${quoted} >> ~/.ssh/authorized_keys`
  })
  return `umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; ${lines.join('; ')}; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys`
}

export function remoteSetupCommand(port, passwordlessSudo) {
  validatePort(String(port), 'public')
  const sudo = passwordlessSudo ? 'sudo -n' : 'sudo'
  return `f=/tmp/agent-desktop-setup.sh; trap 'rm -f "$f"' EXIT; if [ "$(id -u)" -eq 0 ]; then bash "$f" ${port}; elif command -v sudo >/dev/null 2>&1; then ${sudo} bash "$f" ${port}; else echo "请用 root 登录，或为该用户安装 sudo 后重试" >&2; exit 1; fi`
}

export function classifySshFailure(stderr) {
  if (/permission denied/i.test(stderr)) return 'denied'
  if (/timed out|connection refused|no route|network is unreachable|could not resolve|name or service not known/i.test(stderr)) return 'network'
  return 'other'
}

function resolveTool(name) {
  if (process.platform === 'win32') {
    const candidate = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', `${name}.exe`)
    if (fs.existsSync(candidate)) return candidate
  }
  return name
}

function tail(text) {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-5)
    .join('\n')
}

function runCaptured(bin, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    })
    const out = []
    const err = []
    child.stdout?.on('data', (chunk) => out.push(chunk))
    child.stderr?.on('data', (chunk) => err.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8')
      })
    })
    if (input !== undefined) {
      child.stdin?.write(input)
      child.stdin?.end()
    }
  })
}

function runInherit(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit', windowsHide: true })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

function toolError(error, name) {
  if (error && error.code === 'ENOENT') return new Error(name === 'ssh' ? '未找到 OpenSSH 客户端' : '未找到 ssh-keygen')
  return error instanceof Error ? error : new Error(String(error))
}

function sshArgv(target, remoteCommand) {
  const args = []
  if (target.tty) args.push('-t')
  args.push(
    '-o',
    'ConnectTimeout=8',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ServerAliveInterval=30',
    '-p',
    String(target.sshPort)
  )
  if (target.batch) args.push('-o', 'BatchMode=yes')
  if (target.identitiesOnly) args.push('-o', 'IdentitiesOnly=yes')
  if (target.identity) args.push('-i', target.identity)
  args.push(`${target.user}@${target.host}`)
  if (remoteCommand !== undefined) args.push(remoteCommand)
  return args
}

async function readUnlockedPublic(keygen, privatePath) {
  let result
  try {
    result = await runCaptured(keygen, ['-y', '-P', '', '-f', privatePath])
  } catch (error) {
    throw toolError(error, 'ssh-keygen')
  }
  if (result.code !== 0) return null
  const line = result.stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith('ssh-') || item.startsWith('ecdsa-') || item.startsWith('sk-'))
  if (!line) return null
  return assertPublicKey(line)
}

async function resolveAppKeys(keygen) {
  const sshDir = path.join(os.homedir(), '.ssh')
  const names = ['id_rsa', 'id_ecdsa', 'id_ed25519']
  const keys = []
  for (const name of names) {
    const privatePath = path.join(sshDir, name)
    if (!fs.existsSync(privatePath)) continue
    const publicKey = await readUnlockedPublic(keygen, privatePath)
    if (publicKey) keys.push({ privatePath, publicKey })
  }
  if (keys.length) return { keys, generated: null }
  const dest = path.join(sshDir, 'id_ed25519')
  if (fs.existsSync(dest)) {
    throw new Error('默认 SSH 密钥有口令，应用无法在后台登录。请换成无口令密钥，或先执行 ssh-add')
  }
  fs.mkdirSync(sshDir, { recursive: true })
  console.log(`没有找到无口令的默认 SSH 密钥，正在生成 ${dest}`)
  let created
  try {
    created = await runCaptured(keygen, ['-t', 'ed25519', '-f', dest, '-N', '', '-C', 'agent-desktop', '-q'])
  } catch (error) {
    throw toolError(error, 'ssh-keygen')
  }
  if (created.code !== 0) throw new Error(tail(created.stderr) || '生成 SSH 密钥失败')
  const publicKey = await readUnlockedPublic(keygen, dest)
  if (!publicKey) throw new Error('生成 SSH 密钥失败')
  return { keys: [{ privatePath: dest, publicKey }], generated: dest }
}

async function probe(ssh, target, identity) {
  try {
    return await runCaptured(
      ssh,
      sshArgv({ ...target, identity, identitiesOnly: true, batch: true, tty: false }, 'echo agent-desktop-ok')
    )
  } catch (error) {
    throw toolError(error, 'ssh')
  }
}

function probeOk(result) {
  return result.code === 0 && result.stdout.includes('agent-desktop-ok')
}

async function runRemote(ssh, target, identity, command, input) {
  const args = sshArgv({ ...target, identity, identitiesOnly: Boolean(identity), batch: true, tty: false }, command)
  try {
    return input === undefined ? await runCaptured(ssh, args) : await runCaptured(ssh, args, input)
  } catch (error) {
    throw toolError(error, 'ssh')
  }
}

async function ensureLogin(ssh, options, keys) {
  const publicKeys = keys.map((key) => key.publicKey)
  const install = installAuthorizedKeysCommand(publicKeys)
  const primary = keys[0].privatePath
  const base = { user: options.user, host: options.host, sshPort: options.sshPort }
  let login = await probe(ssh, base, primary)
  let loginIdentity = primary
  if (!probeOk(login) && classifySshFailure(login.stderr) !== 'network' && options.identity) {
    login = await probe(ssh, base, options.identity)
    loginIdentity = options.identity
  }
  if (!probeOk(login)) {
    const kind = classifySshFailure(login.stderr)
    if (kind === 'network') {
      console.error('无法连接服务器')
      const detail = tail(login.stderr)
      if (detail) console.error(detail)
      return false
    }
    if (kind !== 'denied') {
      console.error(tail(login.stderr) || '无法登录服务器')
      return false
    }
    if (!process.stdin.isTTY) {
      console.error('本机默认密钥还不能登录。请在终端中重新运行，以便输入 SSH 密码；或把下面的公钥写入该用户的 ~/.ssh/authorized_keys：')
      for (const key of publicKeys) console.error(key)
      return false
    }
    console.log('本机默认密钥还不能登录。请按提示完成一次登录，脚本会把公钥写入 authorized_keys。')
    let code
    try {
      code = await runInherit(
        ssh,
        sshArgv({ ...base, identity: options.identity, identitiesOnly: false, batch: false, tty: true }, install)
      )
    } catch (error) {
      throw toolError(error, 'ssh')
    }
    if (code !== 0) {
      console.error('公钥没有写入。请把下面的公钥加入该用户的 ~/.ssh/authorized_keys 后重试：')
      for (const key of publicKeys) console.error(key)
      return false
    }
  } else {
    const appended = await runRemote(ssh, base, loginIdentity, install)
    if (appended.code !== 0) {
      console.error(tail(appended.stderr) || '写入公钥失败')
      return false
    }
  }
  const ready = await probe(ssh, base, primary)
  if (!probeOk(ready)) {
    console.error(tail(ready.stderr) || '默认密钥仍不能登录')
    return false
  }
  return true
}

async function configureServer(ssh, options, identity) {
  const script = fs.readFileSync(scriptPath, 'utf8').replace(/\r\n/g, '\n')
  const gatewayB64 = Buffer.from(fs.readFileSync(gatewayPath, 'utf8').replace(/\r\n/g, '\n')).toString('base64')
  const payload = `GATEWAY_B64='${gatewayB64}'\n${script}`
  const base = { user: options.user, host: options.host, sshPort: options.sshPort }
  const uploaded = await runRemote(ssh, base, identity, 'cat > /tmp/agent-desktop-setup.sh && chmod 700 /tmp/agent-desktop-setup.sh', payload)
  if (uploaded.code !== 0) {
    console.error(tail(uploaded.stderr) || '上传配置脚本失败')
    return 1
  }
  const tty = Boolean(process.stdin.isTTY)
  let code
  try {
    code = await runInherit(
      ssh,
      sshArgv(
        { ...base, identity, identitiesOnly: true, batch: true, tty },
        remoteSetupCommand(options.port, !tty)
      )
    )
  } catch (error) {
    throw toolError(error, 'ssh')
  }
  if (code !== 0 && !tty) console.error('如果刚才提示需要 sudo 密码，请在终端中重新运行本命令。')
  return code
}

async function main() {
  const options = parseSetupArgs(process.argv)
  if (options.help) {
    console.log(USAGE)
    return
  }
  if (options.identity && !fs.existsSync(options.identity)) {
    throw new Error('找不到指定的私钥')
  }
  const ssh = resolveTool('ssh')
  const keygen = resolveTool('ssh-keygen')
  const { keys, generated } = await resolveAppKeys(keygen)
  if (generated) console.log(`已生成 ${generated}`)
  console.log(`正在连接 ${options.user}@${options.host} …`)
  const loggedIn = await ensureLogin(ssh, options, keys)
  if (!loggedIn) process.exit(1)
  console.log('正在配置服务器…')
  const code = await configureServer(ssh, options, keys[0].privatePath)
  if (code !== 0) process.exit(code)
  console.log('')
  console.log('服务器已配置。请在应用的「远程控制」中填写：')
  console.log(`SSH 用户：${options.user}`)
  console.log(`服务器地址：${options.host}`)
  console.log(`公网端口：${options.port}`)
  console.log('然后打开远程控制和公网访问。云安全组放行该 TCP 端口。')
}

function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) return false
  return path.resolve(entry) === fileURLToPath(import.meta.url)
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
