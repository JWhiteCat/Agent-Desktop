import { createContext } from 'react'
import type { ToolItem } from '@shared/types'

/** Actions that only make sense on the newest part of an idle thread. */
export interface TurnActions {
  /** Sends a reply in the current mode. */
  reply?: (text: string) => Promise<void> | void
  /** Starts implementing a CreatePlan result in agent mode. */
  buildPlan?: (item: ToolItem) => Promise<void> | void
  /** The CreatePlan item that `buildPlan` applies to. */
  planId?: string
}

export const TurnActionsContext = createContext<TurnActions & { streaming?: boolean }>({})

/** Stable transcript identity for card drafts, including identical blocks in different messages. */
export const ItemDraftContext = createContext<{ scope?: string; itemId?: string }>({})

export function TurnActionsProvider({ value, children }: { value: TurnActions & { streaming?: boolean }; children: React.ReactNode }) {
  return <TurnActionsContext.Provider value={value}>{children}</TurnActionsContext.Provider>
}
