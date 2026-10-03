import { coreMessages } from './locales/core'
import { settingsMessages } from './locales/settings'
import { shellMessages } from './locales/shell'
import { messagesMessages } from './locales/messages'
import { attachmentBackendMessages } from './locales/attachments-backend'
import { attachmentsMessages } from './locales/attachments'

export type Locale = 'zh-CN' | 'en'
export type Language = 'system' | Locale
export type TranslationParams = Record<string, string | number>
export interface LocalizedMessage {
  source: string
  params?: TranslationParams
}

/** Chinese source messages are the fallback catalog. Keep placeholders identical in English. */
export const englishMessages: Readonly<Record<string, string>> = {
  ...coreMessages,
  ...settingsMessages,
  ...shellMessages,
  ...messagesMessages,
  ...attachmentBackendMessages,
  ...attachmentsMessages
}

let language: Language = 'system'
let systemLocale = 'zh-CN'
let locale: Locale = 'zh-CN'
const listeners = new Set<() => void>()

export function normalizeLanguage(value: unknown): Language {
  return value === 'zh-CN' || value === 'en' ? value : 'system'
}

export function resolveLocale(value: unknown, system = 'zh-CN'): Locale {
  const preference = normalizeLanguage(value)
  if (preference !== 'system') return preference
  return /^zh(?:[-_]|$)/i.test(system) ? 'zh-CN' : 'en'
}

/** System uses the desktop OS language, shared with connected browsers. */
export function setLanguage(value: unknown, system?: string): void {
  language = normalizeLanguage(value)
  if (system) systemLocale = system
  const next = resolveLocale(language, systemLocale)
  if (next === locale) return
  locale = next
  for (const listener of listeners) listener()
}

export function getLocale(): Locale {
  return locale
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function translate(locale: Locale, source: string, params?: TranslationParams): string {
  const message = locale === 'en' && Object.hasOwn(englishMessages, source) ? englishMessages[source] : source
  // Substitute once so braces in user-supplied values are always treated as literal text.
  return params ? message.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match) : message
}

export function t(source: string, params?: TranslationParams): string {
  return translate(locale, source, params)
}

/** Keep text for older clients and a source message for live language switching. */
export function localizedMessage(source: string, params?: TranslationParams): { text: string; message: LocalizedMessage } {
  return { text: t(source, params), message: { source, ...(params ? { params } : {}) } }
}
