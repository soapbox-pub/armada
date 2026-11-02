import type { ContentToken } from "@/components/chat/ChatContent";

/**
 * Tokenized bodies keyed by dialect and event id, surviving remounts (events
 * are immutable). Content is compared on lookup for synthesized events and
 * `contentOverride` edits. Holds decrypted text: cleared on logout.
 */
export const TOKEN_CACHE = new Map<string, { content: string; tokens: ContentToken[] }>();

const TOKEN_CACHE_MAX = 800;

export function cacheTokens(id: string, content: string, tokens: ContentToken[]): ContentToken[] {
  if (TOKEN_CACHE.size >= TOKEN_CACHE_MAX) {
    const oldest = TOKEN_CACHE.keys().next().value;
    if (oldest !== undefined) TOKEN_CACHE.delete(oldest);
  }
  TOKEN_CACHE.set(id, { content, tokens });
  return tokens;
}

/** Drop a removed message's tokenized text, in every dialect. */
export function forgetTokenizedContent(eventId: string): void {
  for (const key of TOKEN_CACHE.keys()) if (key.endsWith(`:${eventId}`)) TOKEN_CACHE.delete(key);
}

export function clearTokenCache(): void {
  TOKEN_CACHE.clear();
}
