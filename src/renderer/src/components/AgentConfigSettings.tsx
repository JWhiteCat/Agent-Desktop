import { useState } from 'react'
import { t } from '@shared/i18n'
import { isValidSkillName, mcpServerReady, skillReady } from '@shared/agent-config'
import type { McpServerConfig, McpTransport, NamedValue, Settings, SkillConfig } from '@shared/types'
import { useT } from '../lib/i18n'
import { errorText, toast, useStore } from '../store'

const EMPTY_SERVERS: McpServerConfig[] = []
const EMPTY_SKILLS: SkillConfig[] = []

interface McpDraft {
  id: string
  name: string
  enabled: boolean
  transport: McpTransport
  command: string
  argsText: string
  envText: string
  url: string
  headersText: string
}

interface SkillDraft {
  id: string
  name: string
  description: string
  enabled: boolean
  body: string
}

async function persist(patch: Partial<Settings>): Promise<boolean> {
  try {
    await window.api.updateSettings(patch)
    return true
  } catch (err) {
    toast(errorText(err), 'error')
    return false
  }
}

function newId(): string {
  return crypto.randomUUID()
}

export function McpSettings() {
  const t = useT()
  const servers = useStore((s) => s.app.settings.mcpServers) ?? EMPTY_SERVERS
  const [draft, setDraft] = useState<McpDraft | null>(null)

  const saveList = (next: McpServerConfig[]) => persist({ mcpServers: next })

  return (
    <div className="config-block">
      <div className="muted small">
        {t('启用的服务器会在新建或恢复会话时交给 Cursor CLI。stdio 填写启动命令，HTTP / SSE 填写服务地址。这里的配置不会改写 ~/.cursor/mcp.json。')}
      </div>
      <div className="config-list">
        {servers.map((server) => (
          <div key={server.id} className="config-item">
            <input
              type="checkbox"
              className="toggle"
              checked={server.enabled}
              title={server.enabled ? t('停用') : t('启用')}
              onChange={() => {
                if (!server.enabled && !mcpServerReady(server)) {
                  toast(t('请先补全命令或地址'), 'error')
                  return
                }
                void saveList(servers.map((item) => (item.id === server.id ? { ...item, enabled: !item.enabled } : item)))
              }}
            />
            <div className="config-main">
              <div className="config-title">{server.name}</div>
              <div className="config-sub">
                {server.transport === 'stdio' ? server.command || t('未填写命令') : server.url || t('未填写地址')}
                {server.enabled && !mcpServerReady(server) ? t(' · 配置不完整') : ''}
              </div>
            </div>
            <button className="btn small" type="button" onClick={() => setDraft(toMcpDraft(server))}>
              {t('编辑')}
            </button>
            <button
              className="btn small"
              type="button"
              onClick={() => {
                if (!window.confirm(t('删除 MCP 服务器「{name}」？', { name: server.name }))) return
                if (draft?.id === server.id) setDraft(null)
                void saveList(servers.filter((item) => item.id !== server.id))
              }}
            >
              {t('删除')}
            </button>
          </div>
        ))}
        {servers.length === 0 && <div className="empty-hint">{t('还没有 MCP 服务器')}</div>}
      </div>
      {draft ? (
        <McpForm
          draft={draft}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={async () => {
            const next = mcpFromDraft(draft)
            const error = validateMcp(next, servers) ?? (draft.transport === 'stdio' ? pairLineError(draft.envText, '=') : pairLineError(draft.headersText, ':'))
            if (error) {
              toast(error, 'error')
              return
            }
            const exists = servers.some((item) => item.id === next.id)
            const list = exists ? servers.map((item) => (item.id === next.id ? next : item)) : [...servers, next]
            if (await saveList(list)) setDraft(null)
          }}
        />
      ) : (
        <button className="btn" type="button" onClick={() => setDraft(emptyMcpDraft())}>
          {t('添加服务器')}
        </button>
      )}
    </div>
  )
}

export function SkillSettings() {
  const t = useT()
  const skills = useStore((s) => s.app.settings.skills) ?? EMPTY_SKILLS
  const [draft, setDraft] = useState<SkillDraft | null>(null)

  const saveList = (next: SkillConfig[]) => persist({ skills: next })

  return (
    <div className="config-block">
      <div className="muted small">
        {t('启用的 Skill 会写入 ~/.cursor/skills/<名称>/SKILL.md，以及 Codex 的 ~/.agents/skills 和 ~/.codex/skills。CLI 会按描述自动选用。名称只能是小写字母、数字和连字符。已有同名、且不是本应用创建的目录不会被覆盖。')}
      </div>
      <div className="config-list">
        {skills.map((skill) => (
          <div key={skill.id} className="config-item">
            <input
              type="checkbox"
              className="toggle"
              checked={skill.enabled}
              title={skill.enabled ? t('停用') : t('启用')}
              onChange={() => {
                const enabled = !skill.enabled
                if (enabled && !isValidSkillName(skill.name.trim())) {
                  toast(t('Skill 名称只能使用小写字母、数字和连字符'), 'error')
                  return
                }
                if (enabled && !skill.description.trim()) {
                  toast(t('启用前需要填写描述'), 'error')
                  return
                }
                void saveList(skills.map((item) => (item.id === skill.id ? { ...item, enabled } : item)))
              }}
            />
            <div className="config-main">
              <div className="config-title">{skill.name || t('未命名')}</div>
              <div className="config-sub">
                {skill.description || t('没有描述')}
                {skill.enabled && !skillReady(skill) ? t(' · 配置不完整') : ''}
              </div>
            </div>
            <button className="btn small" type="button" onClick={() => setDraft(toSkillDraft(skill))}>
              {t('编辑')}
            </button>
            <button
              className="btn small"
              type="button"
              onClick={() => {
                if (!window.confirm(t('删除 Skill「{name}」？', { name: skill.name }))) return
                if (draft?.id === skill.id) setDraft(null)
                void saveList(skills.filter((item) => item.id !== skill.id))
              }}
            >
              {t('删除')}
            </button>
          </div>
        ))}
        {skills.length === 0 && <div className="empty-hint">{t('还没有 Skill')}</div>}
      </div>
      <div className="row-gap wrap">
        {draft ? null : (
          <button className="btn" type="button" onClick={() => setDraft(emptySkillDraft())}>
            {t('添加 Skill')}
          </button>
        )}
        {!window.api.isRemote && (
          <button className="btn" type="button" onClick={() => void window.api.openSkillsDir()}>
            {t('打开目录')}
          </button>
        )}
      </div>
      {draft && (
        <SkillForm
          draft={draft}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={async () => {
            const next = skillFromDraft(draft)
            const error = validateSkill(next, skills)
            if (error) {
              toast(error, 'error')
              return
            }
            const exists = skills.some((item) => item.id === next.id)
            const list = exists ? skills.map((item) => (item.id === next.id ? next : item)) : [...skills, next]
            if (await saveList(list)) setDraft(null)
          }}
        />
      )}
    </div>
  )
}

function McpForm({
  draft,
  onChange,
  onSave,
  onCancel
}: {
  draft: McpDraft
  onChange: (draft: McpDraft) => void
  onSave: () => void
  onCancel: () => void
}) {
  const t = useT()
  const set = (patch: Partial<McpDraft>) => onChange({ ...draft, ...patch })
  const remote = draft.transport !== 'stdio'
  return (
    <div className="stack-form">
      <label className="stack-field">
        <span>{t('名称')}</span>
        <input className="input" value={draft.name} spellCheck={false} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="stack-field">
        <span>{t('传输')}</span>
        <select className="input" value={draft.transport} onChange={(e) => set({ transport: e.target.value as McpTransport })}>
          <option value="stdio">stdio</option>
          <option value="http">HTTP</option>
          <option value="sse">SSE</option>
        </select>
      </label>
      {remote ? (
        <>
          <label className="stack-field">
            <span>{t('地址')}</span>
            <input className="input" value={draft.url} spellCheck={false} placeholder="https://example.com/mcp" onChange={(e) => set({ url: e.target.value })} />
          </label>
          <label className="stack-field">
            <span>{t('请求头')}</span>
            <textarea className="textarea" value={draft.headersText} spellCheck={false} placeholder={'Authorization: Bearer token'} onChange={(e) => set({ headersText: e.target.value })} />
          </label>
        </>
      ) : (
        <>
          <label className="stack-field">
            <span>{t('命令')}</span>
            <input className="input" value={draft.command} spellCheck={false} placeholder="npx" onChange={(e) => set({ command: e.target.value })} />
          </label>
          <label className="stack-field">
            <span>{t('参数')}</span>
            <textarea className="textarea" value={draft.argsText} spellCheck={false} placeholder={t('一行一个参数\n-y\n@modelcontextprotocol/server-filesystem')} onChange={(e) => set({ argsText: e.target.value })} />
          </label>
          <label className="stack-field">
            <span>{t('环境变量')}</span>
            <textarea className="textarea" value={draft.envText} spellCheck={false} placeholder="API_KEY=value" onChange={(e) => set({ envText: e.target.value })} />
          </label>
        </>
      )}
      <label className="check-line">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        {t('启用')}
      </label>
      <div className="row-gap">
        <button className="btn primary" type="button" onClick={onSave}>
          {t('保存')}
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          {t('取消')}
        </button>
      </div>
    </div>
  )
}

function SkillForm({
  draft,
  onChange,
  onSave,
  onCancel
}: {
  draft: SkillDraft
  onChange: (draft: SkillDraft) => void
  onSave: () => void
  onCancel: () => void
}) {
  const t = useT()
  const set = (patch: Partial<SkillDraft>) => onChange({ ...draft, ...patch })
  return (
    <div className="stack-form">
      <label className="stack-field">
        <span>{t('名称')}</span>
        <input className="input" value={draft.name} spellCheck={false} placeholder="review-diff" onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="stack-field">
        <span>{t('描述')}</span>
        <input className="input" value={draft.description} placeholder={t('什么时候该使用这个 Skill')} onChange={(e) => set({ description: e.target.value })} />
      </label>
      <label className="stack-field">
        <span>{t('正文')}</span>
        <textarea className="textarea tall" value={draft.body} placeholder={t('写给代理的操作说明')} onChange={(e) => set({ body: e.target.value })} />
      </label>
      <label className="check-line">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        {t('启用')}
      </label>
      <div className="row-gap">
        <button className="btn primary" type="button" onClick={onSave}>
          {t('保存')}
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          {t('取消')}
        </button>
      </div>
    </div>
  )
}

function emptyMcpDraft(): McpDraft {
  return { id: newId(), name: '', enabled: true, transport: 'stdio', command: '', argsText: '', envText: '', url: '', headersText: '' }
}

function toMcpDraft(server: McpServerConfig): McpDraft {
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    transport: server.transport,
    command: server.command,
    argsText: server.args.join('\n'),
    envText: formatPairs(server.env, '='),
    url: server.url,
    headersText: formatPairs(server.headers, ': ')
  }
}

function mcpFromDraft(draft: McpDraft): McpServerConfig {
  return {
    id: draft.id,
    name: draft.name.trim(),
    enabled: draft.enabled,
    transport: draft.transport,
    command: draft.command.trim(),
    args: lines(draft.argsText),
    env: parsePairs(draft.envText, '='),
    url: draft.url.trim(),
    headers: parsePairs(draft.headersText, ':')
  }
}

function validateMcp(server: McpServerConfig, existing: McpServerConfig[]): string | undefined {
  if (!server.name) return t('请填写名称')
  if (existing.some((item) => item.id !== server.id && item.name === server.name)) return t('已经有同名 MCP 服务器')
  if (server.enabled && !mcpServerReady(server)) return server.transport === 'stdio' ? t('启用前需要填写命令') : t('启用前需要填写地址')
  return undefined
}

function emptySkillDraft(): SkillDraft {
  return { id: newId(), name: '', description: '', enabled: true, body: '' }
}

function toSkillDraft(skill: SkillConfig): SkillDraft {
  return { id: skill.id, name: skill.name, description: skill.description, enabled: skill.enabled, body: skill.body }
}

function skillFromDraft(draft: SkillDraft): SkillConfig {
  return {
    id: draft.id,
    name: draft.name.trim(),
    description: draft.description.trim(),
    enabled: draft.enabled,
    body: draft.body
  }
}

function validateSkill(skill: SkillConfig, existing: SkillConfig[]): string | undefined {
  if (!skill.name) return t('请填写名称')
  if (!isValidSkillName(skill.name)) return t('名称只能使用小写字母、数字和连字符')
  if (existing.some((item) => item.id !== skill.id && item.name === skill.name)) return t('已经有同名 Skill')
  if (skill.enabled && !skill.description) return t('启用前需要填写描述')
  return undefined
}

function pairLineError(text: string, sep: '=' | ':'): string | undefined {
  const bad = text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return false
    return trimmed.indexOf(sep) <= 0
  })
  if (!bad) return undefined
  return sep === '=' ? t('环境变量需要写成 KEY=VALUE，一行一个') : t('请求头需要写成 Name: Value，一行一个')
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

function parsePairs(text: string, sep: '=' | ':'): NamedValue[] {
  const out: NamedValue[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf(sep)
    if (index <= 0) continue
    const name = trimmed.slice(0, index).trim()
    const value = trimmed.slice(index + sep.length).trim()
    if (!name) continue
    out.push({ name, value })
  }
  return out
}

function formatPairs(pairs: NamedValue[], sep: string): string {
  return pairs.map((pair) => `${pair.name}${sep}${pair.value}`).join('\n')
}
