import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import { catchUpIsManual, catchUpIsRefused, catchUpVerdictsVersion, subscribeCatchUpVerdicts } from "@/concord/lib/catchUpVerdicts";

import { assertNotBanned, assertNotBlocked, assertNotDissolved, bundleToEntry } from "@/concord/hooks/useCommunityActions";
import { useCommunityList, useUpdateCommunityList } from "@/concord/hooks/useCommunityList";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { concordInviteReadKey, useReadState } from "@/hooks/useReadState";
import {
  directInviteExpired,
  heldMembershipOf,
  isCatchUpBundle,
  parseDirectInviteRumor,
  unwrapDirectInvite,
  type HeldMembership,
} from "@/concord/lib/directInvite";
import { buildJoinRumor, currentGuestbookGroup, sealGuestbook } from "@/concord/lib/guestbook";
import {
  advanceInviteInboxCursor,
  drainLiveInviteWraps,
  hasBufferedLiveInviteWraps,
  inviteInboxSince,
  queryStoredInvites,
  rebufferLiveInviteWraps,
  writeStoredInvites,
} from "@/concord/lib/inviteInbox";
import { liveEntries, rehydrateCommunity } from "@/concord/lib/communityList";
import { inviteDeliveryRelays, recipientInboxRelays } from "@/concord/lib/inviteRelays";
import { useIsBlocked } from "@/lib/blocklistStore";
import { getDecryptConsent } from "@/lib/decryptConsent";
import { signerNeedsApproval } from "@/lib/bulkDecryptGate";
import { useDecryptConsent } from "@/hooks/useDecryptConsent";
import { useWireScopes } from "@/wire/useWireScopes";
import type { InviteBundle } from "@/concord/lib/invite";
import { KIND_DIRECT_INVITE, KIND_WRAP } from "@/concord/lib/kinds";

import type { NostrEvent } from "@nostrify/nostrify";
import { t } from "@/i18n";

/** The signed-in user this module's background invite paths operate for. */
type InviteUser = NonNullable<ReturnType<typeof useCurrentUser>["user"]>;

/** A direct invite received over a gift wrap, awaiting the user's consent. */
export interface ParkedInvite {
  /** Gift-wrap event id. */
  wrapId: string;
  /** Seal author, verified. */
  sender: string;
  bundle: InviteBundle;
  communityId: string;
  name: string;
  /**
   * The rumor's `created_at` (unix seconds). The sender's word, fine here: it only
   * drives ordering and the unread mark.
   */
  receivedAt: number;
  /**
   * An invite for a community I'm ALREADY in, on the base I hold, carrying
   * private-channel keys I lack (`isCatchUpBundle`). Accepting only adds those:
   * the base itself advances by a rekey, never by an invite.
   */
  catchUp?: boolean;
}

/**
 * May this signer decrypt in the background without popping the consent prompt?
 * A local nsec always may; prompting signers wait for interactive consent.
 */
function mayDecryptInvites(method: string | undefined): boolean {
  return !signerNeedsApproval(method) || getDecryptConsent() === "allowed";
}

/**
 * Unwrap and persist invite wraps not already stored (caller gates consent).
 * Returns the fresh count and the newest wrap `created_at` (the cursor floor).
 */
async function storeFreshInviteWraps(
  user: InviteUser,
  wraps: NostrEvent[],
  signal?: AbortSignal,
): Promise<{ stored: number; newestWrap: number }> {
  const seen = new Set((await queryStoredInvites(user.pubkey, { signal })).map((i) => i.wrapId));
  const fresh: { wrap: NostrEvent; unwrapped: NonNullable<Awaited<ReturnType<typeof unwrapDirectInvite>>> }[] = [];
  let newestWrap = 0;
  for (const wrap of wraps) {
    if (wrap.created_at > newestWrap) newestWrap = wrap.created_at;
    if (seen.has(wrap.id)) continue;
    const unwrapped = await unwrapDirectInvite(wrap, user.signer);
    if (!unwrapped) continue;
    fresh.push({ wrap, unwrapped });
  }
  await writeStoredInvites(user.pubkey, fresh);
  return { stored: fresh.length, newestWrap };
}

/**
 * The background network sweep (CORD-05 §6): fetch wraps newer than the cursor
 * from my inbox relays, decrypt, persist, advance. Returns true if it wrote
 * something. Always run un-awaited; it must never block a render.
 */
export async function sweepInviteInbox(
  nostr: ReturnType<typeof useNostr>["nostr"],
  user: InviteUser,
  signal?: AbortSignal,
): Promise<boolean> {
  const pubkey = user.pubkey;
  // No consent: nothing fetched could be opened or kept, and the cursor stays
  // put, so the first poll after an "allow" scans everything anyway.
  if (!mayDecryptInvites(user.method)) return false;
  // The cursor is rewound by NIP-59's backdate window (these wraps backdate).
  const since = await inviteInboxSince(pubkey);
  const filter: { kinds: number[]; "#p": string[]; "#k": string[]; limit: number; since?: number } = {
    kinds: [KIND_WRAP],
    "#p": [pubkey],
    "#k": [String(KIND_DIRECT_INVITE)],
    limit: 200,
  };
  if (since > 0) filter.since = since;
  // Scan where senders deliver (CORD-05 §6): my published inbox, else the stock
  // floor. A FAILED lookup is not "no list" — scanning stock then would leak my
  // `#p` REQ — so skip this round.
  const myInbox = await recipientInboxRelays(nostr, pubkey);
  if (myInbox === null) return false;
  const scanRelays = inviteDeliveryRelays(myInbox);
  const timeout = AbortSignal.timeout(8000);
  const perRelay = await Promise.all(
    scanRelays.map((url) =>
      nostr
        .relay(url)
        .query([filter], { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
        .catch(() => [] as NostrEvent[]),
    ),
  );
  const seenWrap = new Set<string>();
  const wraps = perRelay.flat().filter((e) => (seenWrap.has(e.id) ? false : seenWrap.add(e.id)));
  if (wraps.length === 0) return false;
  const { stored, newestWrap } = await storeFreshInviteWraps(user, wraps, signal);
  if (newestWrap > 0) await advanceInviteInboxCursor(pubkey, newestWrap);
  return stored > 0;
}

/**
 * Decrypt the invite wraps the wire buffered live (no relay round-trip).
 * Consent-gated like the sweep: without consent, wraps re-buffer for the poll.
 */
async function openLiveInviteWraps(user: InviteUser): Promise<"changed" | "nochange" | "deferred"> {
  if (!user.signer.nip44) return "nochange";
  const wraps = drainLiveInviteWraps();
  if (wraps.length === 0) return "nochange";
  if (!mayDecryptInvites(user.method)) {
    rebufferLiveInviteWraps(wraps);
    return "deferred";
  }
  const { stored, newestWrap } = await storeFreshInviteWraps(user, wraps);
  if (newestWrap > 0) await advanceInviteInboxCursor(user.pubkey, newestWrap);
  return stored > 0 ? "changed" : "nochange";
}

/**
 * In-flight live drain, so the many mounted copies of {@link useDirectInvites}
 * coalesce onto one destructive drain. Mirrors useDm17's `openLiveDm17Wraps`.
 */
let liveInvitePass: Promise<"changed" | "nochange" | "deferred"> | undefined;

async function drainLiveInvitesOnce(user: InviteUser): Promise<"changed" | "nochange" | "deferred"> {
  const prior = liveInvitePass;
  if (prior) {
    const result = await prior;
    // Drain again if wraps arrived meanwhile; never loop on "deferred" (it re-buffered).
    if (result === "deferred" || !hasBufferedLiveInviteWraps()) return result;
    return drainLiveInvitesOnce(user);
  }
  const pass = openLiveInviteWraps(user);
  liveInvitePass = pass;
  try {
    return await pass;
  } finally {
    liveInvitePass = undefined;
  }
}

/** Membership context the store read filters against. */
interface ParkFilter {
  /** Communities I'm already a live member of (a non-catch-up invite skips). */
  known: ReadonlySet<string>;
  /** Newest tombstone time (ms) per community — suppresses invites SENT BEFORE it. */
  tombstonedAt: ReadonlyMap<string, number>;
  /** The held base/epoch/channel-keys per joined community, for catch-up classification. */
  heldByCommunity: ReadonlyMap<string, HeldMembership>;
}

/**
 * Collapse the parked set to one invite per community (newest wrap wins, ties by
 * wrap id). Catch-ups are keyed by channel set too: each vends a private-channel
 * key that may exist in no other wrap.
 */
export function dedupeParkedInvites(invites: ParkedInvite[]): ParkedInvite[] {
  const byKey = new Map<string, ParkedInvite>();
  for (const inv of invites) {
    const key = inv.catchUp
      ? // Per sender too: a newer copy from anyone must not bury the genuine vend.
        `${inv.communityId}|${inv.sender}|${(inv.bundle.channels ?? []).map((c) => c.id.toLowerCase()).sort().join(",")}`
      : inv.communityId;
    const existing = byKey.get(key);
    if (
      !existing ||
      inv.receivedAt > existing.receivedAt ||
      (inv.receivedAt === existing.receivedAt && inv.wrapId < existing.wrapId)
    ) {
      byKey.set(key, inv);
    }
  }
  return [...byKey.values()];
}

/**
 * Read parked invites from the store (no re-decrypt), apply consent filters, and
 * dedupe — the one place a stored record becomes a {@link ParkedInvite}.
 */
async function readParkedInvites(
  pubkey: string,
  filter: ParkFilter,
  signal?: AbortSignal,
): Promise<ParkedInvite[]> {
  const parked = new Map<string, ParkedInvite>();
  for (const record of await queryStoredInvites(pubkey, { signal })) {
    // The `k` tag was a hint; the rumor's kind + validation are the authority.
    const bundle = parseDirectInviteRumor(record.rumor.kind, record.rumor.content);
    if (!bundle) continue;
    if (directInviteExpired(bundle)) continue;
    // A tombstone suppresses only invites predating it (anti-nag, not authority).
    const buriedAt = filter.tombstonedAt.get(bundle.community_id);
    if (buriedAt !== undefined && record.rumor.created_at * 1000 <= buriedAt) continue;
    // A role-gate key vend on the base we hold parks as a catch-up; anything else
    // for a joined community (incl. a base swap) skips.
    const catchUp = isCatchUpBundle(filter.heldByCommunity.get(bundle.community_id), bundle);
    if (filter.known.has(bundle.community_id) && !catchUp) continue;
    parked.set(record.wrapId, {
      wrapId: record.wrapId,
      sender: record.sender,
      bundle,
      communityId: bundle.community_id,
      name: bundle.name,
      receivedAt: record.rumor.created_at,
      catchUp,
    });
  }
  return dedupeParkedInvites([...parked.values()]);
}

/**
 * The direct-invite inbox: `{ kinds: [1059], "#p": [me], "#k": ["3313"] }`
 * (CORD-05 §6). Invites are decrypted once, persisted, and **parked** — never
 * auto-joined. Joined or tombstoned communities are filtered out.
 *
 * The query is a PURE STORE READ ({@link readParkedInvites}); wraps arrive via
 * the un-awaited {@link sweepInviteInbox} and the live `c2inv:wrap` wake, both
 * re-reading into the cache via setQueryData.
 */
export function useDirectInvites() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: list, isFetched: listFetched } = useCommunityList();
  const { consent } = useDecryptConsent();
  const queryClient = useQueryClient();

  const known = new Set(list ? liveEntries(list.list).map((e) => e.community_id) : []);
  // A tombstone suppresses only invites SENT BEFORE it, never a fresh re-invite.
  const tombstonedAt = new Map<string, number>();
  for (const t of list?.list.tombstones ?? []) {
    const prev = tombstonedAt.get(t.community_id);
    if (prev === undefined || t.removed_at > prev) tombstonedAt.set(t.community_id, t.removed_at);
  }

  // What each joined community holds, so a key vend for a channel we lack is a
  // CATCH-UP, and a bundle proposing a DIFFERENT base is dropped.
  const heldByCommunity = useMemo(() => {
    const m = new Map<string, HeldMembership>();
    if (list) {
      for (const e of liveEntries(list.list)) m.set(e.community_id, heldMembershipOf(e));
    }
    return m;
  }, [list]);

  // An undecryptable list is an untrusted empty one; treating it as ready would
  // re-park invites for joined communities on launch.
  const decryptFailed = Boolean(list?.decryptFailed);
  const listReady = !decryptFailed && (list !== undefined || listFetched);

  const filter: ParkFilter = { known, tombstonedAt, heldByCommunity };
  const queryKey = [
    "concord",
    "direct-invites",
    user?.pubkey,
    consent,
    [...known].sort().join(","),
    [...tombstonedAt.entries()].map(([id, at]) => `${id}@${at}`).sort().join(","),
  ];

  // Live wake: drain the buffered wrap and re-read into the cache (NOT an
  // invalidate, which would re-run the sweep). Gated like the query's `enabled`.
  useWireScopes((scopes) => {
    if (!user?.signer.nip44 || !listReady || !scopes.has("c2inv:wrap")) return;
    const pubkey = user.pubkey;
    void drainLiveInvitesOnce(user)
      .then((result) => (result === "changed" ? readParkedInvites(pubkey, filter) : undefined))
      .then((rows) => {
        if (rows) queryClient.setQueryData<ParkedInvite[]>(queryKey, rows);
      })
      .catch(() => {
      });
  });

  return useQuery<ParkedInvite[]>({
    queryKey,
    enabled: Boolean(user?.signer.nip44) && listReady,
    staleTime: 30_000,
    // Not latency-critical, and the cursor means a gap only delays discovery.
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const pubkey = user!.pubkey;

      // Un-awaited network sweep; catches invites that arrived while the wire was deaf.
      void sweepInviteInbox(nostr, user!, signal)
        .then((changed) => (changed ? readParkedInvites(pubkey, filter) : undefined))
        .then((rows) => {
          if (rows) queryClient.setQueryData<ParkedInvite[]>(queryKey, rows);
        })
        .catch(() => {
        });

      return readParkedInvites(pubkey, filter, signal);
    },
  });
}

/** One row of the invite inbox: a parked invite and whether it's still unseen. */
export interface InviteInboxItem {
  invite: ParkedInvite;
  unread: boolean;
}

export interface InviteInbox {
  /** Invites from known senders, plus every catch-up waiting on a manual Accept. */
  items: InviteInboxItem[];
  /** Every parked catch-up, listed or not, for the adopter to judge. */
  catchUps: ParkedInvite[];
  /** Invites from senders the viewer doesn't know: listed, never badged or toasted. */
  requests: InviteInboxItem[];
  /** How many of `items` haven't been seen yet (drives the rail badge / toast). */
  unreadCount: number;
}

/**
 * Sort parked invites into the inbox and the request tier, newest first, by the
 * DM request rule. Muted senders' invites are dropped. A catch-up is in `items`
 * only once `manual` judges it a manual Accept: it is for a community already
 * joined, and one adopted without a click is no invite to the member.
 */
export function splitInviteInbox(
  invites: readonly ParkedInvite[],
  lastRead: number,
  isKnown: (pubkey: string) => boolean,
  muted: ReadonlySet<string>,
  manual: (wrapId: string) => boolean = () => true,
): InviteInbox {
  const items: InviteInboxItem[] = [];
  const catchUps: ParkedInvite[] = [];
  const requests: InviteInboxItem[] = [];
  const sorted = [...invites].sort((a, b) => b.receivedAt - a.receivedAt);
  for (const invite of sorted) {
    const item = { invite, unread: invite.receivedAt > lastRead };
    if (invite.catchUp) {
      catchUps.push(invite);
      if (manual(invite.wrapId)) items.push(item);
    }
    else if (muted.has(invite.sender)) continue;
    else if (isKnown(invite.sender)) items.push(item);
    else requests.push(item);
  }
  const unreadCount = items.reduce((n, it) => n + (it.unread ? 1 : 0), 0);
  return { items, requests, unreadCount, catchUps };
}

/**
 * The invite inbox as a mail-style list, tagged unread against a single
 * last-seen mark ({@link concordInviteReadKey}); senders are sorted by
 * {@link useKnownDmPeers}, as DMs are.
 */
export function useInviteInbox(): InviteInbox {
  const { data: invites } = useDirectInvites();
  const { getLastRead } = useReadState();
  const { isKnown, mutedPeers } = useKnownDmPeers();
  const isBlocked = useIsBlocked();
  const verdicts = useSyncExternalStore(subscribeCatchUpVerdicts, catchUpVerdictsVersion);

  return useMemo(
    () => {
      void verdicts;
      return splitInviteInbox(
        (invites ?? []).filter((invite) => !isBlocked(invite.bundle.community_id)),
        getLastRead(concordInviteReadKey()),
        (pubkey) => isKnown(pubkey, false),
        new Set(mutedPeers),
        catchUpIsManual,
      );
    },
    [invites, getLastRead, isKnown, mutedPeers, isBlocked, verdicts],
  );
}

/**
 * Accept a parked direct invite: record it in the Community List vault, then
 * send a self-signed Guestbook Join attributed to the inviter (CORD-05 §6).
 * A catch-up goes through the same epoch-monotonic `add` merge and sends no Join.
 */
export function useAcceptDirectInvite() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const queryClient = useQueryClient();

  return useMutation<{ communityId: string; name: string }, Error, { invite: ParkedInvite }>({
    mutationFn: async ({ invite }) => {
      if (!user) throw new Error(t({ id: "useDirectInvites.signInToAccept", defaultMessage: "Sign in to accept an invite." }));
      const { bundle } = invite;
      if (directInviteExpired(bundle)) throw new Error(t({ id: "useDirectInvites.expired", defaultMessage: "This invite has expired." }));
      if (invite.catchUp && catchUpIsRefused(invite.wrapId)) {
        throw new Error(t({ id: "useDirectInvites.catchUpRefused", defaultMessage: "These channel keys can't be accepted." }));
      }

      // No accepting into a blocked or dissolved community, as with link joins (`completeJoin`).
      await assertNotBlocked(nostr, bundle.community_id);
      await assertNotDissolved(nostr, bundle);
      const entry = bundleToEntry(bundle);
      // A banned npub must not accept (CORD-04 §4) — catch-ups included, since the
      // sender is seal-verified but never rank-checked.
      const community = rehydrateCommunity(entry);
      if (community) await assertNotBanned(nostr, community, user.pubkey);
      // The merge takes the higher epoch's whole snapshot, base included; safe only
      // because a catch-up is pinned to the held base (so it adds channel keys only).
      await updateList({ type: "add", entry });

      if (!invite.catchUp) {
        // Best-effort Join attributed to the seal-verified sender; coalesce self-heals.
        void (async () => {
          if (!community) return;
          const rumor = buildJoinRumor(user.pubkey, Date.now(), { creator: invite.sender, label: bundle.label });
          const wrap = await sealGuestbook(rumor, currentGuestbookGroup(community), user.signer);
          await Promise.allSettled(
            community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
          );
        })().catch(() => undefined);
      }

      return { communityId: bundle.community_id, name: bundle.name };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["concord", "direct-invites"] });
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
    },
  });
}

/** Decline a parked invite: tombstone the community so it stops re-nagging. */
export function useDeclineDirectInvite() {
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const queryClient = useQueryClient();

  return useMutation<void, Error, { communityId: string }>({
    mutationFn: async ({ communityId }) => {
      await updateList({ type: "remove", communityId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["concord", "direct-invites"] });
    },
  });
}
