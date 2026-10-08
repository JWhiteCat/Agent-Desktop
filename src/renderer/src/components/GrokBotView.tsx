import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { GrokBotInfo, GrokBotList, GrokBotMessage, GrokBotTurn } from '@shared/types'
import { grokBotBusy, mergeGrokBotMessages, unresolvedGrokBotMessages, validateGrokBotName } from '@shared/grokbot'
import { useT } from '../lib/i18n'
import { relativeTime } from '../lib/format'
import { errorText, openGrokBot, toast, useStore } from '../store'
import { applyGrokBotPoll, cachedGrokBotChat, rememberGrokBotChat } from '../store/grokbot'
import { GrokBotMessageExtras } from './GrokBotAttachments'
import { IconArrowUp, IconBot, IconPlus, IconRefresh, IconStop, IconX, Spinner } from './icons'
import { Markdown } from './items/Markdown'
import { Modal } from './Modal'

const BUSY_POLL_MS = 1_500
const IDLE_POLL_MS = 10_000
/** A turn may still report idle right after a send, before the bot picks the message up. */
const AFTER_SEND_FAST_MS = 20_000
/** The Grok Bot app may cache a delivered file a little after the API reports the message. */
const ATTACHMENT_RECHECK_MS = 10 * 60_000

interface Props {
  botId?: string
  onOpenSettings: () => void
}

interface Chat {
  bot: string
  messages: GrokBotMessage[]
  cursor: string
  turn?: GrokBotTurn
  sessionId?: string
  loading: boolean
  error: string
}

const AVATAR_COLORS: Record<string, string> = {
  brown: '#a1735a',
  violet: '#8b5cf6',
  blue: '#3b82f6',
  green: '#22a06b',
  red: '#e5484d',
  orange: '#f76b15',
  yellow: '#d6a10b',
  pink: '#e93d82',
  teal: '#12a594',
  gray: '#8b8d98'
}

function CreateBotDialog({ bots, onClose, onDone }: { bots: GrokBotInfo[]; onClose: () => void; onDone: (bot: GrokBotInfo) => void }) {
  const t = useT()
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (busy) return
    let wanted: string
    try {
      wanted = validateGrokBotName(name)
    } catch (err) {
      setError(errorText(err))
      return
    }
    const existing = bots.find((b) => b.name === wanted)
    if (existing) {
      // The API resolves bots by name, so it would open this one rather than create another.
      if (window.confirm(t('列表里已经有叫「{name}」的 Bot。Grok Bot 按名称查找，不会再新建一个。要打开已有的这个吗？', { name: wanted }))) onDone(existing)
      return
    }
    setBusy(true)
    setError('')
    try {
      onDone(await window.api.grokbotCreate(wanted))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('新建 Bot')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('取消')}
          </button>
          <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
            {busy ? <Spinner size={12} /> : t('创建')}
          </button>
        </>
      }
    >
      <div className="grokbot-create">
        <input
          className="input"
          autoFocus
          value={name}
          disabled={busy}
          placeholder={t('Bot 名称')}
          aria-label={t('Bot 名称')}
          onChange={(e) => {
            setName(e.target.value)
            setError('')
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit()
          }}
        />
        <p className="muted small">
          {t('会在你的 Grok Bot 账号里新建一个这个名字的 Bot，并加入设置 → Grok Bot 的手动列表。如果账号里已有同名 Bot，会直接打开它。')}
        </p>
        {error && <div className="grokbot-error">{error}</div>}
      </div>
    </Modal>
  )
}

function BotAvatar({ bot }: { bot: GrokBotInfo }) {
  return (
    <span className="grokbot-avatar" style={{ background: AVATAR_COLORS[bot.color] ?? 'var(--muted)' }}>
      {bot.name.trim().slice(0, 1).toUpperCase()}
    </span>
  )
}

export function GrokBotView({ botId, onOpenSettings }: Props) {
  const t = useT()
  const [list, setList] = useState<GrokBotList | null>(null)
  const [listError, setListError] = useState('')
  const [chat, setChat] = useState<Chat | null>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const manualNames = useStore((s) => s.app.settings.grokbotBots)
  /** State broadcasts replace the settings object; reload the list only when the names change. */
  const manualKey = (manualNames ?? []).join('\n')
  const sentAt = useRef(0)
  /** Merges messages into the active chat from outside the polling effect. */
  const applyMessages = useRef<(messages: GrokBotMessage[]) => void>(() => {})
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)

  const loadList = useCallback(async () => {
    setListError('')
    try {
      setList(await window.api.grokbotList())
    } catch (err) {
      setListError(errorText(err))
    }
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList, manualKey])

  const bots = list?.bots ?? []
  const selected = bots.find((b) => b.id === botId) ?? (botId ? undefined : bots[0])
  const selectedId = selected?.id
  const selectedName = selected?.name
  const selectedManual = !!selected?.manual
  const sharedName = !!selected && bots.some((b) => b.id !== selected.id && b.name === selected.name)
  const hasKey = list?.hasApiKey !== false

  useEffect(() => {
    setPending(null)
    if (!selectedName || !hasKey) {
      setChat(null)
      return
    }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    // A bot shown earlier in this session appears at once and continues from its cursor.
    const remembered = cachedGrokBotChat(selectedName)
    let state: Chat = remembered
      ? { bot: selectedName, ...remembered, loading: false, error: '' }
      : { bot: selectedName, messages: [], cursor: '', loading: true, error: '' }
    setChat(state)
    atBottom.current = true

    const update = (next: Partial<Chat>) => {
      state = { ...state, ...next }
      if (!state.loading && state.cursor) {
        rememberGrokBotChat(selectedName, { messages: state.messages, cursor: state.cursor, turn: state.turn, sessionId: state.sessionId })
      }
      if (alive) setChat(state)
    }
    applyMessages.current = (messages) => {
      if (alive && messages.length) update({ messages: mergeGrokBotMessages(state.messages, messages) })
    }
    /** Files of recent deliveries can land in the Grok Bot app's cache after the API reports them. */
    const recheckAttachments = async () => {
      if (selectedManual) return
      const pendingFiles = unresolvedGrokBotMessages(state.messages, Date.now() - ATTACHMENT_RECHECK_MS)
      if (!pendingFiles.length) return
      try {
        const found = await window.api.grokbotAttachments(selectedName, pendingFiles)
        applyMessages.current(found.filter((m) => m.attachments !== undefined))
      } catch {
        // The next tick tries again.
      }
    }
    const schedule = () => {
      if (!alive) return
      const fast = grokBotBusy(state.turn) || Date.now() - sentAt.current < AFTER_SEND_FAST_MS
      timer = setTimeout(tick, fast ? BUSY_POLL_MS : IDLE_POLL_MS)
    }
    const tick = async () => {
      if (!alive) return
      if (document.hidden || !state.cursor) return schedule()
      try {
        const page = await window.api.grokbotPoll(selectedName, state.cursor, state.sessionId)
        if (!alive) return
        if (page.messages.some((m) => m.role === 'user')) setPending(null)
        update({ ...applyGrokBotPoll(state, page), error: '' })
        await recheckAttachments()
      } catch (err) {
        update({ error: errorText(err) })
      }
      schedule()
    }
    const loadHistory = () =>
      window.api.grokbotHistory(selectedName).then(
        (history) => {
          if (!alive) return
          update({ messages: history.messages, cursor: history.cursor, turn: history.turn, sessionId: history.sessionId, loading: false, error: '' })
          schedule()
        },
        (err) => update({ loading: false, error: errorText(err) })
      )
    if (remembered) {
      void tick()
    } else {
      // Messages the desktop host saved on an earlier run show without waiting for the network.
      window.api.grokbotCached(selectedName).then(
        (saved) => {
          if (!alive) return
          if (!saved) return void loadHistory()
          update({ messages: saved.messages, cursor: saved.cursor, turn: saved.turn, sessionId: saved.sessionId, loading: false })
          if (saved.truncated) void loadHistory()
          else void tick()
        },
        () => alive && void loadHistory()
      )
    }
    const wake = () => {
      if (document.hidden || !timer) return
      clearTimeout(timer)
      void tick()
    }
    document.addEventListener('visibilitychange', wake)
    return () => {
      alive = false
      applyMessages.current = () => {}
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [selectedId, selectedName, selectedManual, hasKey])

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [chat?.messages, pending])

  const busy = grokBotBusy(chat?.turn)
  const canSend = !!selectedName && !!chat && !chat.loading && !busy && !sending && !!text.trim()

  const send = async () => {
    if (!canSend || !selectedName) return
    const body = text.trim()
    setSending(true)
    try {
      await window.api.grokbotSend(selectedName, body)
      sentAt.current = Date.now()
      setPending(body)
      setText('')
      atBottom.current = true
    } catch (err) {
      toast(errorText(err), 'error')
    } finally {
      setSending(false)
    }
  }

  const interrupt = async () => {
    if (!selectedName) return
    try {
      await window.api.grokbotInterrupt(selectedName)
    } catch (err) {
      toast(errorText(err), 'error')
    }
  }

  const recheck = async (message: GrokBotMessage) => {
    if (!selectedName) return
    try {
      const [found] = await window.api.grokbotAttachments(selectedName, [message])
      if (found?.attachments !== undefined) applyMessages.current([found])
      else toast(t('Grok Bot 桌面端缓存里还没有这条消息的内容'))
    } catch (err) {
      toast(errorText(err), 'error')
    }
  }

  const removeManual = async (bot: GrokBotInfo) => {
    if (!window.confirm(t('从手动列表移除「{name}」？只会从本应用移除，不会删除 Grok Bot 里的 Bot。', { name: bot.name }))) return
    try {
      await window.api.updateSettings({ grokbotBots: (manualNames ?? []).filter((name) => name !== bot.name) })
      if (bot.id === selected?.id) openGrokBot()
    } catch (err) {
      toast(errorText(err), 'error')
    }
  }

  const created = (bot: GrokBotInfo) => {
    setCreating(false)
    void loadList().then(() => openGrokBot(bot.id))
  }

  const emptyReason = (): string => {
    if (listError) return listError
    if (list?.reason === 'no-app') return t('未检测到 Grok Bot 桌面端。请在这台电脑上安装并登录 Grok Bot，然后刷新。')
    if (list?.reason === 'no-roster') return t('Grok Bot 桌面端还没有缓存 Bot 列表。请打开一次 Grok Bot，然后刷新。')
    if (list?.reason === 'unreadable') return t('无法读取 Grok Bot 的 Bot 列表，可能是 Grok Bot 版本已更新。')
    return t('还没有 Bot。请先在 Grok Bot 中创建。')
  }

  return (
    <div className="grokbot-view">
      <aside className="grokbot-list">
        <div className="grokbot-list-head drag">
          <span>Grok Bot</span>
          <span className="grokbot-list-actions no-drag">
            <button className="icon-btn tiny" title={t('新建 Bot')} aria-label={t('新建 Bot')} onClick={() => setCreating(true)}>
              <IconPlus size={14} />
            </button>
            <button className="icon-btn tiny" title={t('刷新')} aria-label={t('刷新')} onClick={() => void loadList()}>
              <IconRefresh size={14} />
            </button>
          </span>
        </div>
        <div className="grokbot-list-scroll">
          {!list && !listError && (
            <div className="center-hint">
              <Spinner />
            </div>
          )}
          {list && !bots.length && (
            <div className="empty-hint">
              {emptyReason()}
              <br />
              {t('也可以点上方的 + 新建 Bot，或在设置 → Grok Bot 中手动添加已有 Bot 的名称。')}
            </div>
          )}
          {listError && list && <div className="empty-hint">{listError}</div>}
          {bots.map((b) => (
            <div key={b.id} className={`grokbot-row-wrap ${b.manual ? 'manual' : ''}`}>
              <button
                className={`grokbot-row ${b.id === selected?.id ? 'active' : ''}`}
                title={b.manual ? t('手动添加的 Bot（设置 → Grok Bot）') : b.description || b.name}
                onClick={() => openGrokBot(b.id)}
              >
                <BotAvatar bot={b} />
                <span className="grokbot-row-text">
                  <span className="grokbot-row-name">
                    <span>{b.name}</span>
                    {b.lastActivityAt > 0 && <span className="grokbot-row-time">{relativeTime(b.lastActivityAt)}</span>}
                  </span>
                  {b.lastText ? (
                    <span className="grokbot-row-last">{b.lastText}</span>
                  ) : (
                    b.manual && <span className="grokbot-row-last">{t('手动添加')}</span>
                  )}
                </span>
              </button>
              {b.manual && (
                <button
                  className="icon-btn tiny grokbot-row-remove"
                  title={t('从手动列表移除')}
                  aria-label={t('从手动列表移除')}
                  onClick={() => void removeManual(b)}
                >
                  <IconX size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      </aside>

      <section className="grokbot-chat">
        <header className="main-header drag">
          <div className="header-title no-drag">
            <h1>{selected?.name ?? 'Grok Bot'}</h1>
            {selected?.description && <span className="header-project grokbot-desc">{selected.description}</span>}
          </div>
        </header>

        {!hasKey ? (
          <div className="grokbot-empty">
            <IconBot size={28} />
            <p>{t('Grok Bot 需要 Cursor API Key。请在设置 → CLI → Cursor 中填写，或设置环境变量 CURSOR_API_KEY。')}</p>
            <button className="btn" onClick={onOpenSettings}>
              {t('打开设置')}
            </button>
          </div>
        ) : !selected ? (
          <div className="grokbot-empty">
            <IconBot size={28} />
            <p>{botId && list ? t('这个 Bot 已不在 Grok Bot 列表中，请刷新') : t('选择左侧的 Bot 开始对话')}</p>
          </div>
        ) : (
          <>
            <div
              className="messages"
              ref={scroller}
              onScroll={(e) => {
                const el = e.currentTarget
                atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
              }}
            >
              <div className="messages-inner">
                {sharedName && (
                  <div className="grokbot-notice">
                    {t('有多个 Bot 叫「{name}」。Grok Bot API 按名称查找，这里的对话可能属于其中任意一个。建议在 Grok Bot 中改名。', { name: selected.name })}
                  </div>
                )}
                {chat?.loading && (
                  <div className="center-hint">
                    <Spinner />
                  </div>
                )}
                {chat && !chat.loading && !chat.messages.length && !pending && (
                  <div className="center-hint muted">{t('还没有消息，发一条开始对话吧。')}</div>
                )}
                {chat?.messages.map((m) =>
                  m.role === 'user' ? (
                    <div key={m.seq} className="msg-user">
                      <div className="bubble">{m.text}</div>
                    </div>
                  ) : (
                    <div key={m.seq} className="msg-assistant-wrap grokbot-reply">
                      <div className="msg-assistant">
                        {m.text.trim() && <Markdown text={m.text} />}
                        <GrokBotMessageExtras message={m} onRecheck={selectedManual ? undefined : () => recheck(m)} />
                      </div>
                    </div>
                  )
                )}
                {pending && (
                  <div className="msg-user pending">
                    <div className="bubble">{pending}</div>
                  </div>
                )}
                {(busy || pending) && (
                  <div className="grokbot-working">
                    <Spinner />
                    <span>{t('{name} 正在处理…', { name: selected.name })}</span>
                  </div>
                )}
                {chat?.error && <div className="grokbot-error">{chat.error}</div>}
              </div>
            </div>
            <div className="composer-dock">
              <div className="composer">
                <textarea
                  rows={2}
                  value={text}
                  disabled={sending}
                  placeholder={t('给 {name} 发消息，Enter 发送，Shift+Enter 换行', { name: selected.name })}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                />
                {busy && <div className="composer-hint">{t('Bot 还在处理上一条消息，完成后才能继续发送。')}</div>}
                <div className="composer-bar">
                  <div className="composer-left" />
                  {busy ? (
                    <button className="send-btn stop" title={t('中断')} onClick={() => void interrupt()}>
                      <IconStop size={14} />
                    </button>
                  ) : (
                    <button className="send-btn" title={t('发送 (Enter)')} disabled={!canSend} onClick={() => void send()}>
                      <IconArrowUp size={16} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </section>
      {creating && <CreateBotDialog bots={bots} onClose={() => setCreating(false)} onDone={created} />}
    </div>
  )
}
