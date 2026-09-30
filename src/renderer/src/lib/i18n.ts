import { useCallback, useSyncExternalStore } from 'react'
import { getLocale, subscribeLocale, translate, type t } from '@shared/i18n'

/** Subscribe even when the component does not read application state. */
export function useT(): typeof t {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
  return useCallback((source, params) => translate(locale, source, params), [locale])
}
