import { createContext } from "react";

/** Map of conversation id → last-read timestamp (unix seconds). */
export type ReadStateMap = Record<string, number>;

export interface ReadStateContextType {
  readState: ReadStateMap;
  /** Last-read unix timestamp for a conversation, or 0 if never read. */
  getLastRead: (key: string) => number;
  /** Mark read up to `timestamp` (unix s); monotonic. Persists and syncs (debounced). */
  markRead: (key: string, timestamp: number) => void;
  /** Replace the entire map (used when hydrating from synced settings). */
  hydrate: (map: ReadStateMap) => void;
}

/** Stable conversation key for a NIP-29 channel. */
export function channelReadKey(relayUrl: string, groupId: string): string {
  return `${relayUrl}::${groupId}`;
}

/** Stable conversation key for a direct-message thread. */
export function dmReadKey(pubkey: string): string {
  return `dm:${pubkey}`;
}

/** Stable conversation key for a Concord channel. */
export function concordReadKey(channelIdHex: string): string {
  return `c2:${channelIdHex}`;
}

/** Stable key for a Concord community's mentions-tab last-seen stamp. */
export function concordMentionReadKey(communityIdHex: string): string {
  return `c2m:${communityIdHex}`;
}

/** Stable key for a Concord thread's last-read stamp (by root rumor id). */
export function concordThreadReadKey(rootId: string): string {
  return `c2t:${rootId}`;
}

/**
 * Key for the direct-invite inbox's single last-seen stamp. No pubkey needed:
 * the read-state map is per-account.
 */
export function concordInviteReadKey(): string {
  return "c2inv";
}

export const ReadStateContext = createContext<ReadStateContextType | undefined>(undefined);

/**
 * The same state as a store whose identity never changes, for readers that select a
 * slice: the context above is a new value on every read anywhere, which re-rendered
 * every reader, each rail probe included, whatever it reads.
 */
export interface ReadStateStore {
  get(): ReadStateMap;
  subscribe(listener: () => void): () => void;
  getLastRead(key: string): number;
  markRead(key: string, timestamp: number): void;
}

export const ReadStateStoreContext = createContext<ReadStateStore | undefined>(undefined);
