import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const scriptPath = path.join(dir, 'setup-public-server.sh')
const gatewayPath = path.join(dir, 'public-gateway.py')
const script = fs.readFileSync(scriptPath).toString('utf8').replace(/\r\n/g, '\n')
const gatewayB64 = Buffer.from(fs.readFileSync(gatewayPath).toString('utf8').replace(/\r\n/g, '\n')).toString('base64')

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const user = arg('--user', 'root')
const host = arg('--host', '43.167.166.239')
const port = arg('--port', '8765')
const portNum = Number(port)

if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(user)) {
  console.error('SSH 用户名无效')
  process.exit(1)
}
if (host.includes('://') || host.includes('/') || host.includes('@') || /[\s:]/.test(host) || !/^[A-Za-z0-9.-]+$/.test(host)) {
  console.error('服务器地址不能包含协议、端口或路径')
  process.exit(1)
}
if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535 || portNum === 22) {
  console.error('公网端口需在 1–65535 之间，且不能是 22')
  process.exit(1)
}

const ssh = spawn(
  'ssh',
  ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', `${user}@${host}`, 'bash -s -- ' + String(portNum)],
  { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true }
)
ssh.on('error', (err) => {
  console.error(err.code === 'ENOENT' ? '未找到 OpenSSH 客户端' : err.message)
  process.exit(1)
})
ssh.on('exit', (code) => process.exit(code ?? 1))
ssh.stdin.write(`GATEWAY_B64='${gatewayB64}'\n${script}`)
ssh.stdin.end()
