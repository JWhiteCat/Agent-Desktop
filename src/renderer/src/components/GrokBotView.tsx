import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { GrokBotInfo, GrokBotList, GrokBotMessage, GrokBotTurn } from '@shared/types'
import { grokBotBusy, mergeGrokBotMessages } from '@shared/grokbot'
import { useT } from '../lib/i18n'
import { relativeTime } from '../lib/format'
import { errorText, openGrokBot, toast } from '../store'
import { IconArrowUp, IconBot, IconRefresh, IconStop, Spinner } from './icons'
import { Markdown } from './items/Markdown'

const BUSY_POLL_MS = 1_500
const IDLE_POLL_MS = 10_000
/** A turn may still report idle right after a send, before the bot picks the message up. */
const AFTER_SEND_FAST_MS = 20_000

interface Props {
  botId?: string
  onOpenSettings: () => void
}

interface Chat {
  bot: string
  messages: GrokBotMessage[]
  cursor: string
  turn?: GrokBotTurn
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
  const sentAt = useRef(0)
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
  }, [loadList])

  const bots = list?.bots ?? []
  const selected = bots.find((b) => b.id === botId) ?? (botId ? undefined : bots[0])
  const selectedId = selected?.id
  const selectedName = selected?.name
  const sharedName = !!selected && bots.some((b) => b.id !== selected.id && b.name === selected.name)
  const hasKey = list?.hasApiKey !== false

  useEffect(() => {
    setChat(null)
    setPending(null)
    if (!selectedName || !hasKey) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let state: Chat = { bot: selectedName, messages: [], cursor: '', loading: true, error: '' }
    setChat(state)
    atBottom.current = true

    const update = (next: Partial<Chat>) => {
      state = { ...state, ...next }
      if (alive) setChat(state)
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
        const page = await window.api.grokbotPoll(selectedName, state.cursor)
        if (!alive) return
        if (page.messages.some((m) => m.role === 'user')) setPending(null)
        update({ messages: mergeGrokBotMessages(state.messages, page.messages), cursor: page.cursor, turn: page.turn, error: '' })
      } catch (err) {
        update({ error: errorText(err) })
      }
      schedule()
    }
    window.api.grokbotHistory(selectedName).then(
      (history) => {
        update({ messages: history.messages, cursor: history.cursor, turn: history.turn, loading: false })
        schedule()
      },
      (err) => update({ loading: false, error: errorText(err) })
    )
    const wake = () => {
      if (document.hidden || !timer) return
      clearTimeout(timer)
      void tick()
    }
    document.addEventListener('visibilitychange', wake)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [selectedId, selectedName, hasKey])

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
          <button className="icon-btn tiny no-drag" title={t('刷新')} onClick={() => void loadList()}>
            <IconRefresh size={14} />
          </button>
        </div>
        <div className="grokbot-list-scroll">
          {!list && !listError && (
            <div className="center-hint">
              <Spinner />
            </div>
          )}
          {list && !bots.length && <div className="empty-hint">{emptyReason()}</div>}
          {listError && list && <div className="empty-hint">{listError}</div>}
          {bots.map((b) => (
            <button
              key={b.id}
              className={`grokbot-row ${b.id === selected?.id ? 'active' : ''}`}
              title={b.description || b.name}
              onClick={() => openGrokBot(b.id)}
            >
              <BotAvatar bot={b} />
              <span className="grokbot-row-text">
                <span className="grokbot-row-name">
                  <span>{b.name}</span>
                  {b.lastActivityAt > 0 && <span className="grokbot-row-time">{relativeTime(b.lastActivityAt)}</span>}
                </span>
                {b.lastText && <span className="grokbot-row-last">{b.lastText}</span>}
              </span>
            </button>
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
                        <Markdown text={m.text} />
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
    </div>
  )
}
