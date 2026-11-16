import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { resolveBundle } from "@/concord/hooks/useCommunityActions";
import { useControlFold } from "@/concord/hooks/useControlPlane";
import { parseInviteLink, type InviteBundle } from "@/concord/lib/invite";
import {
  ANY_LINK,
  KIND_COMMUNITY_ANNOUNCEMENT,
  announcementFromEvent,
  announcementsForLinks,
  buildAnnouncementDeletion,
  linkCreator,
  listingAuthorized,
  type DiscoveredInvite,
} from "@/concord/lib/inviteDiscovery";
import { hasPermission, Permissions } from "@/concord/lib/roles";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { forgetDiscoverAnnouncements, useListingRelays } from "@/hooks/useDiscover";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { queryExplicitRelaysWithStatus } from "@/lib/nip65";

import type { Community } from "@/concord/lib/types";
import type { NostrFilter } from "@nostrify/nostrify";
import { t } from "@/i18n";

/**
 * Discover listings by LINK. A kind-3314 announcement carries only an invite
 * URL, so it ties to a community through the link signer, whose set is named by
 * the invite registry (vsk 8) and the creator's Invite List.
 */

/** How many announcements one read asks each relay for, per filter. */
const LISTING_READ_LIMIT = 500;
/** Announcement ids per deletion filter (`#e`), to keep each REQ a sane size. */
const DELETION_ID_CHUNK = 200;
/** Each read's own deadline; the deletions read doesn't inherit the listings read's leftover. */
const READ_TIMEOUT_MS = 8000;

/** No Discover relay answered a read, so an empty result would be a guess. */
export class DiscoverUnansweredError extends Error {}

function readSignal(outer: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

/**
 * Every standing announcement on the Discover relays whose link is one of
 * `linkSigners`, newest first, honoring deletions by each announcement's author.
 *
 * Relays can only narrow by AUTHOR, so `authors` are read deep; `includeRecent`
 * adds the network-wide newest page for anyone else. Deletions are read in a
 * second round by `#e` of exactly the found announcements, so old deletes aren't missed.
 *
 * A pool read turns an outage into an empty answer, so: the listings read throws
 * {@link DiscoverUnansweredError} when no relay answered; the deletions read
 * throws only under `strict` (unlisting), otherwise over-reporting is the safe
 * direction for display.
 */
export async function fetchLinkAnnouncements(
  nostr: Parameters<typeof queryExplicitRelaysWithStatus>[0],
  relays: string[],
  linkSigners: ReadonlySet<string> | typeof ANY_LINK,
  opts?: { authors?: string[]; includeRecent?: boolean; signal?: AbortSignal; strict?: boolean },
): Promise<DiscoveredInvite[]> {
  if (relays.length === 0 || (linkSigners !== ANY_LINK && linkSigners.size === 0)) return [];
  const authors = opts?.authors ? [...new Set(opts.authors)] : undefined;
  if (authors && authors.length === 0 && !opts?.includeRecent) return [];
  const listingFilters: NostrFilter[] = [];
  if (authors && authors.length > 0) {
    listingFilters.push({ kinds: [KIND_COMMUNITY_ANNOUNCEMENT], authors, limit: LISTING_READ_LIMIT });
  }
  if (!authors || opts?.includeRecent) {
    listingFilters.push({ kinds: [KIND_COMMUNITY_ANNOUNCEMENT], limit: LISTING_READ_LIMIT });
  }
  const listingRead = await queryExplicitRelaysWithStatus(nostr, relays, listingFilters, readSignal(opts?.signal));
  if (listingRead.answered.length === 0) throw new DiscoverUnansweredError(t({ id: "useDiscoverListings.noRelayAnswered", defaultMessage: "No Discover relay answered." }));
  const listings = listingRead.events.filter((e) => {
    if (e.kind !== KIND_COMMUNITY_ANNOUNCEMENT) return false;
    const signer = announcementFromEvent(e)?.linkSigner;
    return !!signer && (linkSigners === ANY_LINK || linkSigners.has(signer));
  });
  if (listings.length === 0) return [];

  const ids = [...new Set(listings.map((e) => e.id))];
  const listingAuthors = [...new Set(listings.map((e) => e.pubkey))];
  const deletionFilters: NostrFilter[] = [];
  for (let i = 0; i < ids.length; i += DELETION_ID_CHUNK) {
    deletionFilters.push({ kinds: [5], authors: listingAuthors, "#e": ids.slice(i, i + DELETION_ID_CHUNK) });
  }
  const deletionRead = await queryExplicitRelaysWithStatus(nostr, relays, deletionFilters, readSignal(opts?.signal));
  if (deletionRead.answered.length === 0 && opts?.strict) {
    throw new DiscoverUnansweredError(t({ id: "useDiscoverListings.noRelayAnsweredDeletions", defaultMessage: "No Discover relay answered the deletions read." }));
  }
  return announcementsForLinks([...listings, ...deletionRead.events], linkSigners);
}

/**
 * Discover listings carrying any of `linkSigners` (deep for `authors`, plus the
 * recent page). Empty signers answer empty without a read.
 */
export function useLinkAnnouncements(
  linkSigners: readonly string[],
  authors: readonly string[] = [],
  { enabled = true }: { enabled?: boolean } = {},
) {
  const { nostr } = useNostr();
  const relays = useListingRelays();
  const sorted = useMemo(() => [...new Set(linkSigners)].sort(), [linkSigners]);
  const sortedAuthors = useMemo(() => [...new Set(authors)].sort(), [authors]);

  return useQuery({
    queryKey: ["discover", "link-announcements", relays, sorted, sortedAuthors],
    enabled: enabled && relays.length > 0 && sorted.length > 0,
    staleTime: 30_000,
    queryFn: ({ signal }) =>
      fetchLinkAnnouncements(nostr, relays, new Set(sorted), {
        authors: sortedAuthors,
        includeRecent: true,
        signal,
      }),
  });
}

/**
 * Announcements by `sharers` whose link isn't in `known` but whose bundle resolves
 * to `communityId` and lets its sharer list it. A registry omits links that work,
 * so a community's listings are also found by what they open.
 */
export async function fetchResolvedCommunityAnnouncements(
  nostr: Parameters<typeof queryExplicitRelaysWithStatus>[0],
  relays: string[],
  communityId: string,
  sharers: string[],
  known: ReadonlySet<string>,
  resolve: (invite: DiscoveredInvite) => Promise<InviteBundle | undefined>,
  signal?: AbortSignal,
): Promise<Array<{ invite: DiscoveredInvite; creator: string }>> {
  if (sharers.length === 0) return [];
  const found = (await fetchLinkAnnouncements(nostr, relays, ANY_LINK, { authors: sharers, signal }))
    .filter((invite) => !known.has(invite.linkSigner));
  const bundles = new Map<string, InviteBundle>();
  await Promise.all(
    [...new Map(found.map((invite) => [invite.linkSigner, invite])).values()].map(async (invite) => {
      const bundle = await resolve(invite).catch(() => undefined);
      if (bundle?.community_id === communityId) bundles.set(invite.linkSigner, bundle);
    }),
  );
  const out: Array<{ invite: DiscoveredInvite; creator: string }> = [];
  for (const invite of found) {
    const bundle = bundles.get(invite.linkSigner);
    if (!bundle || !listingAuthorized(bundle, invite.source.pubkey)) continue;
    out.push({ invite, creator: linkCreator(bundle) ?? bundle.owner });
  }
  return out;
}

/**
 * This community's Discover listings: announcements carrying any live link in
 * its invite registry, plus `extraSigners` (the viewer's own links not yet in a
 * registry edition), plus any its owner or invite creators listed that open it.
 * `creatorOf` names who can revoke each listing.
 */
export function useCommunityDiscoverListings(
  community: Community | undefined,
  extraSigners: Iterable<string> = [],
  { enabled = true }: { enabled?: boolean } = {},
) {
  const { nostr } = useNostr();
  const relays = useListingRelays();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold(community);
  const { user } = useCurrentUser();
  const extra = [...extraSigners].sort().join(",");
  const { signers, registryCreators, authors, sharers } = useMemo(() => {
    const registryCreators = new Map<string, string>();
    for (const [creator, linkSigners] of folded?.registriesByCreator ?? []) {
      for (const signer of linkSigners) registryCreators.set(signer, creator);
    }
    const signers = new Set(registryCreators.keys());
    for (const signer of extra ? extra.split(",") : []) signers.add(signer);
    // Link creators (and the viewer) are the likely announcers; read them deep.
    const authors = new Set(registryCreators.values());
    if (user) authors.add(user.pubkey);
    // Who may list a link at all (`listingAuthorized`): the owner, or a link's creator.
    const sharers = new Set<string>();
    if (folded) {
      sharers.add(folded.ownerHex);
      for (const g of folded.roster.grants) {
        if (hasPermission(folded.roster, g.member, Permissions.CREATE_INVITE)) sharers.add(g.member);
      }
    }
    return { signers: [...signers], registryCreators, authors: [...authors], sharers: [...sharers].sort() };
  }, [folded, extra, user]);
  const query = useLinkAnnouncements(signers, authors, { enabled });

  const communityId = community?.idHex;
  const unregistered = useQuery({
    queryKey: ["discover", "community-listings-resolved", relays, communityId, sharers, signers],
    enabled: enabled && !!communityId && relays.length > 0 && sharers.length > 0,
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      fetchResolvedCommunityAnnouncements(nostr, relays, communityId!, sharers, new Set(signers), (invite) => {
        const parsed = parseInviteLink(invite.inviteUrl);
        if (!parsed) return Promise.resolve(undefined);
        // The same entry Discover's cards resolve into, so a link is resolved once.
        return queryClient.fetchQuery({
          queryKey: ["discover", "invite-bundle", invite.linkSigner],
          staleTime: 5 * 60_000,
          retry: false,
          queryFn: () => resolveBundle(nostr, parsed, parsed.bootstrapRelays),
        });
      }, signal),
  });

  const { listings, creatorOf } = useMemo(() => {
    const creatorOf = new Map(registryCreators);
    const byId = new Map<string, DiscoveredInvite>();
    for (const invite of query.data ?? []) byId.set(invite.source.id, invite);
    for (const { invite, creator } of unregistered.data ?? []) {
      byId.set(invite.source.id, invite);
      if (!creatorOf.has(invite.linkSigner)) creatorOf.set(invite.linkSigner, creator);
    }
    const listings = [...byId.values()].sort((a, b) => b.source.created_at - a.source.created_at);
    return { listings, creatorOf };
  }, [query.data, unregistered.data, registryCreators]);
  return { ...query, isLoading: query.isLoading || unregistered.isLoading, listings, creatorOf };
}

/**
 * Take the viewer's OWN Discover listings down (NIP-09); others' are dropped,
 * since only an author's delete counts. `unlistLinks` re-reads every copy of the
 * links first (Discover shows the NEWEST per link, so an older copy would take
 * over) and is strict: it throws unless a relay answered both rounds.
 */
export function useUnlistAnnouncements() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const relays = useListingRelays();
  const queryClient = useQueryClient();
  const { mutateAsync: publishEvent } = useNostrPublish();

  const unlist = useCallback(
    async (announcements: DiscoveredInvite[]): Promise<number> => {
      if (!user) throw new Error(t({ id: "useDiscoverListings.signInToRemove", defaultMessage: "Sign in to remove a listing." }));
      const ids = [...new Set(announcements.filter((a) => a.source.pubkey === user.pubkey).map((a) => a.source.id))];
      if (ids.length === 0) return 0;
      await publishEvent(buildAnnouncementDeletion(ids));
      await forgetDiscoverAnnouncements(queryClient, ids);
      void queryClient.invalidateQueries({ queryKey: ["discover", "my-announcements"] });
      void queryClient.invalidateQueries({ queryKey: ["discover", "link-announcements"] });
      return ids.length;
    },
    [user, publishEvent, queryClient],
  );

  const unlistLinks = useCallback(
    async (linkSigners: Iterable<string>, alsoKnown: DiscoveredInvite[] = []): Promise<number> => {
      if (!user) throw new Error(t({ id: "useDiscoverListings.signInToRemove", defaultMessage: "Sign in to remove a listing." }));
      const signers = new Set(linkSigners);
      const found = await fetchLinkAnnouncements(nostr, relays, signers, { authors: [user.pubkey], strict: true });
      return unlist([...found, ...alsoKnown]);
    },
    [nostr, relays, user, unlist],
  );

  const mutation = useMutation<number, Error, DiscoveredInvite[]>({ mutationFn: unlist });

  return {
    unlist: mutation.mutateAsync,
    isUnlisting: mutation.isPending,
    unlistLinks,
  };
}
