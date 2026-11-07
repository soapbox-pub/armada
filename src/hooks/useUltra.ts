import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { t } from "@/i18n";
import { seedAuthorCache } from "@/lib/authorCache";
import { fetchFreshEvent } from "@/lib/fetchFreshEvent";
import { carriedProfileTags, profileImetaTags } from "@/lib/profileImeta";
import { readUltra, withUltra, type UltraProfile } from "@/lib/ultra";

/** The logged-in account's profile and its Ultra membership. */
export function useMyUltra() {
  const { user } = useCurrentUser();
  const author = useAuthor(user?.pubkey);
  const metadata = author.data?.metadata;
  return { pubkey: user?.pubkey, metadata, imeta: author.data?.imeta, ultra: readUltra(metadata), isLoading: author.isLoading };
}

/** A freshly uploaded profile picture to save along with Ultra. */
export interface UltraPicture {
  url: string;
  /** Its NIP-92 `imeta` tag, from the upload. */
  imeta: string[];
}

/**
 * Writes Ultra into the account's kind 0, or removes it. Only from an explicit
 * press. Read-modify-write over the freshest profile, so no other field is lost.
 */
export function usePublishUltra() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const { mutateAsync: publishEvent, isPending } = useNostrPublish();

  const publish = useCallback(async (ultra: UltraProfile | undefined, opts?: { picture?: UltraPicture }) => {
    if (!user) throw new Error(t({ id: "useUltra.notLoggedIn", defaultMessage: "You must be logged in." }));

    const store = await eventStore;
    const prev = await fetchFreshEvent(nostr, { kinds: [0], authors: [user.pubkey] }, { store });
    // An empty read can be a failed one, and rebuilding from nothing would wipe the profile.
    if (!prev) throw new Error(t({ id: "useUltra.noProfile", defaultMessage: "Couldn't load your profile. Set your name in Profile first, or try again." }));

    let content: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(prev.content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      content = parsed as Record<string, unknown>;
    } catch {
      throw new Error(t({ id: "useUltra.badProfile", defaultMessage: "Your profile couldn't be read, so it was left alone." }));
    }

    const next = withUltra(content, ultra);
    let tags = prev.tags;
    if (opts?.picture) {
      next.picture = opts.picture.url;
      tags = [...carriedProfileTags(prev.tags, ["picture"]), ...profileImetaTags(next, [opts.picture.imeta, ...prev.tags])];
    }

    const event = await publishEvent({
      kind: 0,
      content: JSON.stringify(next),
      tags,
      prev,
    });
    seedAuthorCache(queryClient, user.pubkey, event);
  }, [user, eventStore, nostr, publishEvent, queryClient]);

  return { publish, isPending };
}
