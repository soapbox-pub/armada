import type { NostrMetadata } from "@nostrify/nostrify";

import { useCommunityNickname } from "@/contexts/CommunityNicknamesContext";
import { useServerScope } from "@/contexts/ServerScopeContext";
import { useServerProfile } from "@/hooks/useServerProfile";
import { getDisplayName } from "@/lib/getDisplayName";

export interface ScopedIdentity {
  /** Per-server nickname if set, else the global display name. */
  displayName: string;
  /** Per-server username color (CSS hex). */
  color?: string;
  label?: string;
}

/**
 * A Concord Community's Nickname (CORD-04 §10), else the per-server nickname/color/label
 * under a {@link ServerScopeProvider}, else the global kind-0 name. Queried only from the scoped relay, so they never leak to other servers.
 */
export function useScopedIdentity(
  pubkey: string | undefined,
  metadata: NostrMetadata | undefined,
): ScopedIdentity {
  const relayUrl = useServerScope();
  const { data: profile } = useServerProfile(relayUrl, pubkey);
  const communityNickname = useCommunityNickname(pubkey);
  return {
    displayName: communityNickname || profile?.nickname?.trim() || getDisplayName(metadata, pubkey),
    color: profile?.color,
    label: profile?.label?.trim() || undefined,
  };
}

/** Name-only wrapper over {@link useScopedIdentity}. */
export function useScopedDisplayName(
  pubkey: string | undefined,
  metadata: NostrMetadata | undefined,
): string {
  return useScopedIdentity(pubkey, metadata).displayName;
}
