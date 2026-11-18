import type { CliInstallTarget } from './managed-cli-location'

export interface CliArtifact {
  version: string
  url: string
  format: 'zip' | 'tar.gz' | 'binary'
  integrity: { algorithm: 'sha256' | 'sha512'; digest: string; encoding: 'hex' | 'base64' }
  command: string
  archiveEntry?: string
  prefixArgs?: string[]
}

// Match the native packages in package-lock.json that ship with the ACP adapters.
export const CODEX_VERSION = '0.156.1'
export const CLAUDE_SDK_VERSION = '0.3.280'

const CURSOR_VERSION = '2026.11.17-f532c45'
const cursorChecksums = {
  'win32-x64': '74c2bc22d0f1b8e424fa8bc5cf8ffc756ebc0e89706be5cdbfd56c57e4b9eaf8',
  'darwin-x64': '291995e57b14290abf0d7a154055a1460a24b89770754812ad70b4f723bd8fa6',
  'darwin-arm64': '2e4a679c498d98eb2706ad7d90ccd256e5eb2f6cb3fe2cb4a9dd7f2dbd3efce0',
  'linux-x64': '189ed41d8963cd22dcdafbbd62f072cc55ac08374c922dbd04aee525f4018ab6'
}
const registryManifest = 'https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json'
const agyManifests = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests'
const agyReleasePaths = {
  'win32-x64': 'windows-x64/cli_windows_x64.exe',
  'darwin-x64': 'darwin-x64/cli_mac_x64.tar.gz',
  'darwin-arm64': 'darwin-arm/cli_mac_arm64.tar.gz',
  'linux-x64': 'linux-x64/cli_linux_x64.tar.gz'
}
const npmRegistry = 'https://registry.npmjs.org'

export function supportedInstallPlatform(platform = process.platform, arch = process.arch): boolean {
  return Object.hasOwn(cursorChecksums, `${platform}-${arch}`)
}

export async function cliArtifact(
  provider: CliInstallTarget, readJson: (url: string) => Promise<any>,
  platform = process.platform, arch = process.arch
): Promise<CliArtifact> {
  if (!supportedInstallPlatform(platform, arch)) throw new Error('Unsupported CLI installation platform')
  const target = `${platform}-${arch}` as keyof typeof cursorChecksums
  const win = platform === 'win32'
  const machine = arch === 'arm64' ? 'aarch64' : 'x86_64'
  const ext = win ? '.exe' : ''

  if (provider === 'cursor') {
    const format = win ? 'zip' : 'tar.gz'
    return {
      version: CURSOR_VERSION,
      url: `https://downloads.cursor.com/lab/${CURSOR_VERSION}/${win ? 'windows' : platform}/${arch}/agent-cli-package.${format}`,
      integrity: { algorithm: 'sha256', digest: cursorChecksums[target], encoding: 'hex' },
      format, command: `dist-package/cursor-agent${ext}`
    }
  }
  if (provider === 'antigravity') {
    const manifestPlatform = `${win ? 'windows' : platform}_${arch === 'arm64' ? 'arm64' : 'amd64'}`
    const manifest = await readJson(`${agyManifests}/${manifestPlatform}.json`)
    const { version, url, sha512 } = manifest ?? {}
    const release = typeof url === 'string' && /^https:\/\/storage\.googleapis\.com\/antigravity-public\/antigravity-cli\/(\d+\.\d+\.\d+)-\d+\/([^?#]+)$/.exec(url)
    if (!release || release[1] !== version || release[2] !== agyReleasePaths[target]
      || typeof sha512 !== 'string' || !/^[a-f0-9]{128}$/i.test(sha512)) throw new Error('Invalid Antigravity CLI release')
    return {
      version, url, format: win ? 'binary' : 'tar.gz', command: `agy${ext}`,
      ...(win ? {} : { archiveEntry: 'antigravity' }),
      integrity: { algorithm: 'sha512', digest: sha512.toLowerCase(), encoding: 'hex' }
    }
  }
  if (provider === 'antigravity-registry') {
    const manifest = await readJson(registryManifest)
    const build = manifest?.distribution?.binary?.[`${win ? 'windows' : platform}-${machine}`]
    const command = win ? 'agy_acp_server.exe' : 'agy_acp_server.par'
    const args = platform === 'linux' ? ['--uid='] : []
    const version = manifest?.version
    if (manifest?.id !== 'antigravity-acp' || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)
      || !build || build.cmd !== `./${command}` || JSON.stringify(build.args ?? []) !== JSON.stringify(args)
      || typeof build.archive !== 'string' || !/^https:\/\/dl\.google\.com\/agy-extensions\/releases\/[A-Za-z0-9/._-]+\.zip$/.test(build.archive)
      || typeof build.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(build.sha256)) throw new Error('Invalid Antigravity ACP release')
    return {
      version, url: build.archive, format: 'zip', command, prefixArgs: args,
      integrity: { algorithm: 'sha256', digest: build.sha256.toLowerCase(), encoding: 'hex' }
    }
  }

  const codex = provider === 'codex'
  const version = codex ? CODEX_VERSION : CLAUDE_SDK_VERSION
  const name = codex ? '@openai/codex' : `@anthropic-ai/claude-agent-sdk-${target}`
  const packageVersion = codex ? `${version}-${target}` : version
  const release = await readJson(`${npmRegistry}/${name.replace('/', '%2f')}/${packageVersion}`)
  const integrity = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(release?.dist?.integrity ?? '')
  const filename = name.split('/')[1]
  const url = `${npmRegistry}/${name}/-/${filename}-${packageVersion}.tgz`
  if (release?.name !== name || release?.version !== packageVersion || release?.dist?.tarball !== url || !integrity) {
    throw new Error('Invalid npm CLI release')
  }
  const abi = win ? 'pc-windows-msvc' : platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'
  return {
    version, url, format: 'tar.gz',
    command: codex ? `package/vendor/${machine}-${abi}/bin/codex${ext}` : `package/claude${ext}`,
    integrity: { algorithm: 'sha512', digest: integrity[1], encoding: 'base64' }
  }
}
