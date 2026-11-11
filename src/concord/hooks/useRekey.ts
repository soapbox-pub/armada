import { settleAccepted } from "@/concord/lib/settleAccepted";
import { clockNowMs, nowSecs } from "@/lib/relayClock";
import { useNostr } from "@nostrify/react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useCommunityEntry, useUpdateCommunityList } from "@/concord/hooks/useCommunityList";
import { citationFor, foldStoredControl, publishEdition, useControlFold, useDissolved, withControlWrite } from "@/concord/hooks/useControlPlane";
import { resealedChannelContent } from "@/concord/lib/channelSeal";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { channelKeysToWire, heldChannelKeys, toJoinMaterial, type JoinMaterial } from "@/concord/lib/communityList";
import { clearReadCutPending, readCutPending, readCutPendingReady } from "@/concord/lib/readCutPending";
import { clearRefoundJournal, refoundJournal, refoundJournalReady, writeRefoundJournal, type RefoundJournal } from "@/concord/lib/refoundJournal";
import { currentControlGroup, foldControlState, openControlEditions, storedControlOf, type FoldedControl } from "@/concord/lib/control";
import type { AuthorityCitation, ParsedEdition } from "@/concord/lib/edition";
import { VSK_SYNC } from "@/concord/lib/roster";
import type { NostrRumor } from "@/lib/nostrRumor";
import { storedMemberlist } from "@/concord/lib/memberlist";
import { guestbookSweepReach, sweepControl, sweepGuestbook } from "@/concord/lib/planeSync";
import { channelRekeyGroupKey, controlGroupKey, controlSignerGroupKey, guestbookGroupKey } from "@/concord/lib/derive";
import {
  baseRekeyGroupKey,
  bytesToHex,
  epochKeyCommitment,
  hexToBytes,
  random32,
} from "@/concord/lib/derive";
import { buildNicknameRumor, buildSnapshotRumors, buildTimeoutRumor, currentGuestbookGroup, foldNicknameWinners, foldTimeouts, sealGuestbook, timeoutRunning, type FoldedTimeout } from "@/concord/lib/guestbook";
import { KIND_SEAL_ENCRYPTED, KIND_WRAP } from "@/concord/lib/kinds";
import {
  base64ToBytes,
  buildRekeyRumors,
  CHANNEL_REKEY_LOOKAHEAD,
  bytesToBase64,
  checkContinuity,
  decodeWrappedBaseKey,
  decodeWrappedKey,
  encodeWrappedBaseKey,
  encodeWrappedKey,
  findBlob,
  groupRotations,
  lowerKeyWins,
  mintOrReuseControlRoot,
  mintOrReuseRotationKey,
  myLocator,
  parseRekey,
  rotationExcludesMe,
  rotationPublishedAtMs,
  type ParsedRekey,
  type RekeyBlob,
} from "@/concord/lib/rekey";
import { buildChannelContentEdition, citationSatisfied } from "@/concord/lib/control";
import { isEntitled } from "@/concord/lib/channelAccess";
import { canActOnMember, hasPermission, isStaff, mayName, outranksMember, Permissions } from "@/concord/lib/roles";
import { queryPlane, queryRekeyRounds, readControlSnapshot, readStoredSeal, readStreamCursor, updateStreamCursor, writeOpened } from "@/concord/lib/rumorStore";
import { openWrap, rewrapSeal, sealRumor, wrapSeal, type OpenedEvent, type OpenedWireEvent } from "@/concord/lib/stream";
import { buildRefreshedBundleEvents, buildRevocationEvent, capBundleDescription, inviteEntryEpoch, type InviteBundle } from "@/concord/lib/invite";
import { fetchInviteList } from "@/concord/hooks/useInvites";
import { toast } from "@/hooks/useToast";
import type { CommunityMetadata, Community, HeldRoot, PrivateChannelKey } from "@/concord/lib/types";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NUser } from "@nostrify/react/login";
import { t } from "@/i18n";

/**
 * Re-post this user's live invite bundles for `rotated` at the CURRENT keys
 * (CORD-05 §2), using each link's `token` + `signer_sk` from the creator's
 * Invite List (13303, §4) — so each creator refreshes exactly their own links.
 * Tombstoned links are never resurrected. Best-effort. Exported for tests.
 */
export async function refreshInviteBundlesFor(
  nostr: ReturnType<typeof useNostr>["nostr"],
  user: NUser,
  rotated: Pick<Community, "id" | "idHex" | "owner" | "ownerSalt" | "root" | "rootEpoch" | "controlPk" | "privateChannels" | "relays" | "name">,
  metadata: Pick<CommunityMetadata, "name" | "icon" | "description"> | undefined,
  // For a relay-list change: the refreshed bundle must also overwrite the copy on
  // the OLD relays, where existing links' hints point.
  publishRelays?: string[],
  /** Refresh only links minted at this root epoch or later (a Severing Refounding's, CORD-06 §3). */
  mintedFrom?: bigint,
): Promise<void> {
  if (!user.signer.nip44) return;
  const { list } = await fetchInviteList(nostr, user);
  const mine = list.entries.filter((e) => e.community_id === rotated.idHex);
  const live = mine.filter((e) => mintedFrom === undefined || BigInt(inviteEntryEpoch(e)) >= mintedFrom);
  // A Severing Refounding's condemned links are retired, not refreshed (CORD-06 §3).
  const targets = publishRelays ?? rotated.relays;
  for (const e of mine.filter((x) => !live.includes(x))) {
    const tombstone = await buildRevocationEvent(hexToBytes(e.signer_sk)).catch(() => undefined);
    if (!tombstone) continue;
    await Promise.allSettled(targets.map((url) => nostr.relay(url).event(tombstone, { signal: AbortSignal.timeout(8000) })));
  }
  if (live.length === 0) return;

  // A link carries NO Private Channel keys (CORD-05 §2, CORD-03 §1). Doubly so
  // here, right after a rotation that may have CUT somebody: the cut floor admits
  // `epoch >= cut`, so a refreshed bundle at that epoch would undo the removal.
  const bundle: InviteBundle = {
    community_id: rotated.idHex,
    owner: rotated.owner,
    owner_salt: bytesToHex(rotated.ownerSalt),
    community_root: bytesToHex(rotated.root),
    root_epoch: Number(rotated.rootEpoch),
    ...(rotated.controlPk ? { control_pk: rotated.controlPk } : {}),
    channels: [],
    relays: rotated.relays,
    name: metadata?.name ?? rotated.name,
    ...(metadata?.icon ? { icon: metadata.icon } : {}),
    ...(metadata?.description?.trim()
      ? { description: capBundleDescription(metadata.description.trim()) }
      : {}),
    creator_npub: user.pubkey,
  };

  for (const bundleEvent of await buildRefreshedBundleEvents(bundle, live)) {
    await Promise.allSettled(
      targets.map((url) => nostr.relay(url).event(bundleEvent, { signal: AbortSignal.timeout(8000) })),
    );
  }
}

/**
 * What a Refounding's compaction re-wraps (CORD-06 §3): every folded head, and
 * beside a Channel sync's head the predecessor naming the Category it left, which
 * a reader needs to judge it (CORD-04 §8).
 */
export function compactionEditions(folded: FoldedControl, editions: ParsedEdition[]): ParsedEdition[] {
  const out = [...folded.headEditions.values()];
  const byHash = new Map(editions.map((e) => [bytesToHex(e.selfHash), e]));
  for (const head of folded.headEditions.values()) {
    if (head.vsk !== VSK_SYNC || !head.prevHash) continue;
    const prev = byHash.get(bytesToHex(head.prevHash));
    if (prev && !out.includes(prev)) out.push(prev);
  }
  return out;
}

/**
 * The Guestbook rumors a Refounder re-issues into the new epoch (CORD-04 §8, §10):
 * each running Timeout it could issue itself (dated at the original's whole second,
 * `until` as capped), and each standing Nickname someone set for a member it
 * re-keyed, when it could set that one itself (dated as first issued).
 */
export async function reissuedGuestbook(
  community: Community,
  folded: FoldedControl,
  me: string,
  recipients: string[],
  authority: AuthorityCitation | undefined,
  removed: readonly string[] = [],
): Promise<NostrRumor[]> {
  const opened = await queryPlane(community.idHex, "guestbook");
  const nowMs = clockNowMs();
  const timeouts = foldTimeouts(opened, {
    nowMs,
    ownerHex: folded.ownerHex,
    banned: folded.banned,
    mayTimeout: (actor, target, citation) =>
      canActOnMember(folded.roster, actor, folded.ownerHex, target, Permissions.MODERATE_MEMBERS) && citationSatisfied(folded, community.id, actor, citation),
  });
  const out: NostrRumor[] = [];
  const gone = new Set(removed);
  for (const [target, t] of timeouts) {
    if (gone.has(target) || !timeoutRunning(t, nowMs) || !canActOnMember(folded.roster, me, folded.ownerHex, target, Permissions.MODERATE_MEMBERS)) continue;
    out.push(buildTimeoutRumor(me, target, t.until, t.fromSecs * 1000, authority));
  }
  const rekeyed = new Set(recipients);
  for (const n of standingNicknames(opened, folded, community, timeouts, nowMs)) {
    if (n.author === n.target || !rekeyed.has(n.target) || !mayName(folded.roster, me, folded.ownerHex, n.target)) continue;
    out.push(buildNicknameRumor(me, n.target, n.nick, n.ms, authority));
  }
  return out;
}

/** The Nickname rumor that decides each target on the live epoch, as the Guestbook's reader judges it (CORD-04 §10). */
function standingNicknames(opened: OpenedEvent[], folded: FoldedControl, community: Community, timeouts: Map<string, FoldedTimeout>, nowMs: number) {
  const live = currentGuestbookGroup(community).pk;
  const names = foldNicknameWinners(opened.filter((e) => e.streamPk === live), {
    nowMs,
    banned: folded.banned,
    timeouts,
    mayName: (actor, target, citation) =>
      mayName(folded.roster, actor, folded.ownerHex, target) && (actor === target || citationSatisfied(folded, community.id, actor, citation)),
  });
  return [...names].map(([target, n]) => ({ target, author: n.author, nick: n.nick, ms: n.ms }));
}

/**
 * Watch the NEXT epoch's base-rekey address (CORD-06 §2):
 *
 *   - a complete, authorized, continuity-checked rotation carrying MY blob →
 *     adopt the new root (retaining the prior) and record the refounder as the
 *     epoch's snapshot authority;
 *   - a complete rotation with NO blob for me, published at/after I joined →
 *     excluded: marked read-only but kept on the rail (only Leave or Dissolve
 *     removes an icon). A missing chunk is never an exclusion, and a rotation
 *     predating my join is history (see `stranded`).
 */
/**
 * The complete-or-not base rotations off `(prevEpoch, prevRoot)` a reader honors.
 * Authority is the roster, never key possession (CORD-06); banned rotators are
 * dropped outright (CORD-04 §4), and the cited Grant must be satisfied (CORD-04 §5),
 * so a just-demoted admin's Refounding isn't honored.
 */
function honoredRootRotations(
  parsed: ParsedRekey[],
  folded: FoldedControl,
  communityId: Uint8Array,
  prevEpoch: bigint,
  prevRoot: Uint8Array,
): ReturnType<typeof groupRotations> {
  return groupRotations(parsed).filter(
    (set) =>
      set.scopeIdHex === "0".repeat(64) &&
      !folded.banned.has(set.rotator) &&
      (set.rotator === folded.ownerHex || hasPermission(folded.roster, set.rotator, Permissions.BAN)) &&
      citationSatisfied(folded, communityId, set.rotator, set.authority) &&
      checkContinuity(set, prevEpoch, prevRoot).ok,
  );
}

/**
 * This rotator's set rotating `ch` one epoch on, off its current key, as the relays
 * hold it: what a second rotation at that epoch would merge with.
 */
async function myRotationAt(
  nostr: ReturnType<typeof useNostr>["nostr"],
  community: Community,
  ch: PrivateChannelKey,
  me: string,
): Promise<ReturnType<typeof groupRotations>[number] | undefined> {
  const next = ch.epoch + 1n;
  const address = channelRekeyGroupKey(community.root, ch.id, next);
  const filter = { kinds: [KIND_WRAP], authors: [address.pk], limit: 200 };
  const results = await Promise.all(
    community.relays.map((url) =>
      nostr.relay(url).query([filter], { signal: AbortSignal.timeout(5000) }).catch(() => [] as NostrEvent[]),
    ),
  );
  const parsed: ParsedRekey[] = [];
  const seen = new Set<string>();
  for (const wrap of results.flat()) {
    if (seen.has(wrap.id)) continue;
    seen.add(wrap.id);
    try {
      parsed.push(parseRekey(openWrap(wrap, address)));
    } catch {
      // not a rekey at this address
    }
  }
  const prevCommit = bytesToHex(epochKeyCommitment(ch.epoch, ch.key));
  return groupRotations(parsed).find((set) => set.rotator === me && set.newEpoch === next && set.prevCommit === prevCommit);
}

/** Rekey wraps asked for per page. */
const REKEY_PAGE = 50;
/** Pages one filter is walked per relay per poll; what lies past them waits for a later poll. */
const REKEY_MAX_PAGES = 40;
/** Limit for the one wide ask that drains a second holding a full page. */
const REKEY_WALL_PAGE = 5000;
const REKEY_QUERY_TIMEOUT_MS = 8000;
/** How far behind a cursor the next read starts: a rotator's clock may run behind the wraps already read. */
const REKEY_REWIND_SECS = 10 * 60;

type RekeyFilter = {
  kinds: number[];
  authors: string[];
  limit: number;
  since?: number;
};

/** A rekey filter resuming from `cursor`, or reading the address whole without one. */
function rekeyFilter(authors: string[], cursor: { newest: number } | undefined): RekeyFilter {
  const base = { kinds: [KIND_WRAP], authors, limit: REKEY_PAGE };
  // `created_at` is the publisher's, so a stored cursor is never trusted past the clock.
  return cursor?.newest ? { ...base, since: Math.max(0, Math.min(cursor.newest, nowSecs()) - REKEY_REWIND_SECS) } : base;
}

/**
 * Everything a rekey filter holds on one relay, given its newest page. Whoever holds
 * the prior key can sign at a rekey address — the member a rotation removes included —
 * so the newest page is not the rotation's by right, and a full one is paged by
 * inclusive `until` down to the filter's `since`. `complete` is false when the walk
 * stopped short (budget, a failed page, a second it could not read whole).
 */
async function walkRekeyFilter(
  nostr: ReturnType<typeof useNostr>["nostr"],
  url: string,
  filter: RekeyFilter,
  first: NostrEvent[],
  signal: AbortSignal,
): Promise<{ events: NostrEvent[]; complete: boolean }> {
  const wanted = new Set(filter.authors);
  const seen = new Map(first.map((e) => [e.id, e]));
  const ask = async (page: RekeyFilter & { until: number }) => {
    const events = await nostr
      .relay(url)
      .query([page], { signal: AbortSignal.any([signal, AbortSignal.timeout(REKEY_QUERY_TIMEOUT_MS)]) });
    // A relay's answer isn't the filter sent: an off-filter event must not drag the walk.
    return events.filter((e) => e.kind === KIND_WRAP && wanted.has(e.pubkey) && e.created_at <= page.until);
  };

  let complete = true;
  let full = first.length >= REKEY_PAGE;
  let until = full ? Math.min(...first.map((e) => e.created_at)) : 0;
  try {
    for (let pages = 0; full; pages++) {
      if (pages >= REKEY_MAX_PAGES) {
        complete = false;
        break;
      }
      const page = await ask({ ...filter, until });
      for (const e of page) seen.set(e.id, e);
      full = page.length >= REKEY_PAGE;
      const lowest = page.length > 0 ? Math.min(...page.map((e) => e.created_at)) : until;
      if (lowest < until) {
        until = lowest;
        continue;
      }
      if (!full) break;
      // A full page that didn't move is one second holding more than a page: ask for it whole.
      const second = await ask({ ...filter, since: until, until, limit: REKEY_WALL_PAGE });
      for (const e of second) seen.set(e.id, e);
      // Credible only strictly between the two limits; a capped relay looks the same as a drained second.
      if (second.length <= REKEY_PAGE || second.length >= REKEY_WALL_PAGE) complete = false;
      until -= 1;
      if (until < (filter.since ?? 0)) break;
    }
  } catch {
    complete = false;
  }
  return { events: [...seen.values()], complete };
}

/** The cursor a COMPLETE read of `events` earns: the newest wrap, never past the clock. */
function rekeyCursor(events: NostrEvent[]): number {
  return Math.min(Math.max(...events.map((e) => e.created_at)), nowSecs());
}

/** How long after a rotation its epoch is still checked for a racing one. */
const CONVERGE_WINDOW_SECS = 24 * 3600;

/**
 * Racing Refoundings converge on the lowest new base key (CORD-06 §3), but the forward
 * walk only breaks the tie stepping INTO an epoch: a member that adopted the higher key
 * first — or the losing rotator, who recorded its own — would stay on a forked root.
 * So the epoch I'm on is read again for a while (in `useRekeyWatch`'s own REQ, as
 * Vector's current-head heal rides its catch-up), and this is the community moved onto
 * a lower key I hold a blob for, at the same epoch, or undefined.
 */
async function convergeOnLowerKey(
  rounds: OpenedEvent[],
  community: Community,
  prior: HeldRoot,
  folded: FoldedControl,
  me: string,
  nip44: { decrypt: (pubkey: string, ciphertext: string) => Promise<string> },
): Promise<Community | undefined> {
  const parsed: ParsedRekey[] = [];
  for (const opened of rounds) {
    try {
      parsed.push(parseRekey(opened));
    } catch {
      // not a rekey
    }
  }
  let lowest: { key: Uint8Array; rotator: string; controlPk?: string; controlRoot?: Uint8Array } | undefined;
  for (const set of honoredRootRotations(parsed, folded, community.id, prior.epoch, prior.key)) {
    if (!set.complete) continue;
    const blob = findBlob(set, myLocator(set.rotator, me, set.scopeIdHex, set.newEpoch));
    if (!blob) continue;
    try {
      const w = decodeWrappedBaseKey(base64ToBytes(await nip44.decrypt(set.rotator, blob.wrapped)), community.id, set.newEpoch);
      if (!lowest || lowerKeyWins(lowest.key, w.newRoot) === w.newRoot) {
        lowest = { key: w.newRoot, rotator: set.rotator, ...(w.controlPk ? { controlPk: w.controlPk } : {}), ...(w.controlRoot ? { controlRoot: w.controlRoot } : {}) };
      }
    } catch {
      // undecryptable: not mine to adopt
    }
  }
  if (!lowest || bytesToHex(lowest.key) === bytesToHex(community.root) || lowerKeyWins(community.root, lowest.key) !== lowest.key) return undefined;
  const winner = lowest;
  return {
    ...community,
    root: winner.key,
    controlPk: winner.controlPk,
    controlRoot: winner.controlRoot,
    heldRoots: community.heldRoots.map((r) =>
      r.epoch === community.rootEpoch
        ? { epoch: r.epoch, key: winner.key, refounder: winner.rotator, ...(winner.controlPk ? { controlPk: winner.controlPk } : {}) }
        : r,
    ),
    refounder: winner.rotator,
  };
}

export function useRekeyWatch(community: Community | undefined): { stranded: boolean } {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold(community);
  const { data: dissolved } = useDissolved(community);
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const entry = useCommunityEntry(community?.idHex);
  const queryClient = useQueryClient();
  // One adoption/removal per (community, epoch) per session.
  const handled = useRef(new Set<string>());
  // STRANDED: a stale public invite dropped a fresh joiner onto an epoch already
  // rotated past (the rotation predates the join, so no blob). No wire path
  // forward — only a refreshed link or Direct Invite heals it (CORD-05 §2).
  const [stranded, setStranded] = useState(false);

  // Reset when the held epoch advances; the main effect re-derives it if still behind.
  const heldEpoch = community?.rootEpoch;
  const heldId = community?.idHex;
  useEffect(() => {
    setStranded(false);
  }, [heldId, heldEpoch]);

  const nextEpoch = community ? community.rootEpoch + 1n : 0n;
  // A racing Refounding at the epoch I'm on (see `convergeOnLowerKey`): read in the same
  // REQ, for a while after the rotation, since the forward walk never looks back at it.
  const prior = community && community.rootEpoch > 0n
    ? community.heldRoots.find((r) => r.epoch === community.rootEpoch - 1n)
    : undefined;
  const converging = prior?.retiredAt !== undefined && Date.now() / 1000 - prior.retiredAt < CONVERGE_WINDOW_SECS;
  const query = useQuery<{ next: OpenedEvent[]; current: OpenedEvent[] }>({
    queryKey: ["concord", "rekey", community?.idHex ?? null, nextEpoch.toString(), converging],
    enabled: Boolean(community),
    staleTime: 30_000,
    // Rekeys are rare and this runs only for the open community; per-relay cursors
    // mean a longer gap only delays adoption.
    refetchInterval: 2 * 60_000,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const address = baseRekeyGroupKey(community!.root, community!.id, nextEpoch);
      const currentAddress = converging ? baseRekeyGroupKey(prior!.key, community!.id, community!.rootEpoch) : undefined;
      // PER-RELAY `since` cursors, so a fast relay can't advance past a chunk a
      // lagging one still owes; a skipped chunk would block adoption forever.
      const results = await Promise.all(
        community!.relays.map(async (url) => {
          const scopes = [
            { scope: `rekey:${community!.idHex}:${nextEpoch}|${url}`, pk: address.pk },
            ...(currentAddress ? [{ scope: `rekey:${community!.idHex}:${community!.rootEpoch}|${url}`, pk: currentAddress.pk }] : []),
          ];
          const filters = await Promise.all(scopes.map(async ({ scope, pk }) => rekeyFilter([pk], await readStreamCursor(scope))));
          try {
            const events = await nostr
              .relay(url)
              .query(filters, { signal: AbortSignal.any([signal, AbortSignal.timeout(REKEY_QUERY_TIMEOUT_MS)]) });
            const all: NostrEvent[] = [];
            for (const [i, { scope, pk }] of scopes.entries()) {
              const walked = await walkRekeyFilter(nostr, url, filters[i], events.filter((e) => e.pubkey === pk), signal);
              all.push(...walked.events);
              // Only a read that reached its floor may move it.
              if (walked.complete && walked.events.length > 0) await updateStreamCursor(scope, { newest: rekeyCursor(walked.events) });
            }
            return all;
          } catch {
            // Failed/aborted — the cursors stay put.
            return [] as NostrEvent[];
          }
        }),
      );
      // Decrypt the stream layer once and persist, so a seen round is never refetched.
      const fresh: OpenedWireEvent[] = [];
      for (const wrap of results.flat()) {
        const at = wrap.pubkey === address.pk ? address : wrap.pubkey === currentAddress?.pk ? currentAddress : undefined;
        if (!at) continue;
        try {
          fresh.push(openWrap(wrap, at));
        } catch {
          // not this address / malformed
        }
      }
      if (fresh.length > 0) writeOpened(community!.idHex, fresh, "rekey");
      // Match rounds by their own `scope` + `newepoch`, not the arrival address.
      const rounds = async (epoch: bigint) => {
        const stored = await queryRekeyRounds(community!.idHex, [{ scopeIdHex: bytesToHex(community!.id), newEpoch: epoch }]);
        const byId = new Map<string, OpenedEvent>();
        for (const e of stored) byId.set(e.rumorId, e);
        for (const e of fresh) byId.set(e.rumorId, e);
        return [...byId.values()];
      };
      return { next: await rounds(nextEpoch), current: converging ? await rounds(community!.rootEpoch) : [] };
    },
  });

  // A lower key at the epoch I'm on, from a racing Refounding: step down to it.
  useEffect(() => {
    if (!community || !prior || !user || !folded || !entry || !query.data?.current.length) return;
    const nip44 = user.signer.nip44;
    if (!nip44) return;
    let cancelled = false;
    void (async () => {
      const converged = await convergeOnLowerKey(query.data.current, community, prior, folded, user.pubkey, nip44);
      if (cancelled || !converged) return;
      // The epoch belongs to the winner now: an unfinished carry of my own key is moot.
      clearRefoundJournal(user.pubkey, community.idHex);
      await updateList({
        type: "refresh-current",
        current: toJoinMaterial(converged, { prior: entry.current, relays: entry.current.relays }),
      }).catch(() => undefined);
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.idHex, community?.rootEpoch, community?.root, user?.pubkey, folded, query.data, entry?.added_at]);

  useEffect(() => {
    if (!community || !user || !folded || !query.data || query.data.next.length === 0) return;
    // The removal decision needs my join time; wait rather than risk a false removal.
    if (!entry) return;
    // Death wins every race (CORD-02 §9): no epoch advance past the tombstone.
    if (dissolved) return;
    const key = `${community.idHex}:${nextEpoch}`;
    if (handled.current.has(key)) return;
    const nip44 = user.signer.nip44;
    if (!nip44) return;

    let cancelled = false;
    void (async () => {
      const parsed: ParsedRekey[] = [];
      for (const opened of query.data!.next) {
        try {
          parsed.push(parseRekey(opened));
        } catch {
          // not a rekey / not ours
        }
      }

      // Authority is the roster, never key possession (CORD-06); banned rotators are
      // dropped outright (CORD-04 §4).
      const rotations = honoredRootRotations(parsed, folded, community.id, community.rootEpoch, community.root);
      if (rotations.length === 0) return;

      // A rotation predating my join isn't an exclusion.
      const joinedAt = entry?.added_at ?? 0;

      // My blob, decrypted under the rotator↔me pairwise key. `publishedAtMs` becomes
      // the superseded root's `retiredAt`. The blob carries the next epoch's control
      // pair (CORD-06 §1): pk in every 104/136-byte blob, secret only in staff's 136;
      // a legacy 72-byte blob carries neither.
      let adopted:
        | { key: Uint8Array; rotator: string; publishedAtMs: number; controlPk?: string; controlRoot?: Uint8Array; severed: boolean }
        | undefined;
      let sawExcludingRotation = false;
      let sawStrandingRotation = false;
      for (const set of rotations) {
        if (!set.complete) continue;
        // A stale-invite joiner lands ON a past Refounding with no blob for them; that
        // must not read as a removal. A rotation is my removal only if it postdates my
        // join AND its Rotator strictly outranks me (CORD-06 §Authority).
        const postDatesMyJoin = rotationExcludesMe(rotationPublishedAtMs(set), joinedAt);
        const couldExcludeMe =
          postDatesMyJoin && outranksMember(folded.roster, set.rotator, folded.ownerHex, user.pubkey);
        const locator = myLocator(set.rotator, user.pubkey, set.scopeIdHex, set.newEpoch);
        const blob = findBlob(set, locator);
        if (!blob) {
          if (couldExcludeMe) sawExcludingRotation = true;
          // Stranded: predates my join and advances past my epoch. Tested on join time,
          // not `!couldExcludeMe`: a non-outranking rotator's rotation isn't about me at all.
          else if (!postDatesMyJoin && set.newEpoch > community.rootEpoch) sawStrandingRotation = true;
          continue;
        }
        try {
          const plainB64 = await nip44.decrypt(set.rotator, blob.wrapped);
          const wrapped = decodeWrappedBaseKey(base64ToBytes(plainB64), community.id, set.newEpoch);
          // Racing rotations converge on the lowest new BASE key; the control pair rides
          // the winner's blobs (CORD-06 §3).
          if (!adopted || lowerKeyWins(adopted.key, wrapped.newRoot) === wrapped.newRoot) {
            adopted = {
              key: wrapped.newRoot,
              rotator: set.rotator,
              publishedAtMs: rotationPublishedAtMs(set),
              severed: set.severed,
              ...(wrapped.controlPk ? { controlPk: wrapped.controlPk } : {}),
              ...(wrapped.controlRoot ? { controlRoot: wrapped.controlRoot } : {}),
            };
          }
        } catch {
          // Undecryptable blob at my locator: treat as absent.
          if (couldExcludeMe) sawExcludingRotation = true;
        }
      }
      if (cancelled) return;

      if (adopted) {
        handled.current.add(key);
        setStranded(false);
        // The prior root is RETIRED at the rotation's publish time: the hard read
        // cutoff (see `HeldRoot.retiredAt`).
        const retiredAt = Math.floor(adopted.publishedAtMs / 1000);
        const heldRoots: HeldRoot[] = [
          // The rotator is this epoch's snapshot authority (CORD-02 §5), recorded per root.
          {
            epoch: nextEpoch,
            key: adopted.key,
            refounder: adopted.rotator,
            ...(adopted.controlPk ? { controlPk: adopted.controlPk } : {}),
          },
          ...community.heldRoots.map((r) =>
            r.epoch === community.rootEpoch && r.retiredAt === undefined ? { ...r, retiredAt } : r,
          ),
        ];
        // The control pair is the BLOB's, never inherited (it rolls with the root,
        // CORD-02 §2). Member blobs leave `controlRoot` unset; legacy blobs leave both.
        const rotated: Community = {
          ...community,
          root: adopted.key,
          rootEpoch: nextEpoch,
          controlPk: adopted.controlPk,
          controlRoot: adopted.controlRoot,
          heldRoots,
          refounder: adopted.rotator,
        };
        await updateList({
          type: "refresh-current",
          current: toJoinMaterial(rotated, { prior: entry?.current, relays: entry?.current.relays }),
        }).catch(() => handled.current.delete(key));
        queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
        // Only I hold my links' signer_sk, so refresh them to the new epoch (CORD-05 §2);
        // a Severing Refounding's condemned links, minted before it, never are (CORD-06 §3).
        refreshInviteBundlesFor(nostr, user, rotated, folded.metadata, undefined, adopted.severed ? nextEpoch : undefined).catch(() => undefined);
        return;
      }

      // A complete post-join rotation with no blob for me: excluded. Mark read-only
      // at this epoch but KEEP it on the rail; a later re-including Refounding clears it.
      if (sawExcludingRotation) {
        handled.current.add(key);
        await updateList({
          type: "exclude",
          communityId: community.idHex,
          epoch: Number(nextEpoch),
        }).catch(() => handled.current.delete(key));
        queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
      }

      // See `stranded` above: surface it so the UI can explain rather than silently
      // leaving the current epoch unreadable.
      setStranded(sawStrandingRotation);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.idHex, community?.rootEpoch, user?.pubkey, folded, dissolved, query.data, entry?.added_at]);

  return { stranded };
}

/**
 * Keep this creator's OWN live invite links vending the CURRENT epoch (CORD-05
 * §2). A creator who wasn't online for a Refounding (or rotated on another
 * device) would otherwise leave links on the dead epoch, and only they hold
 * each `signer_sk`. Re-mints once per (community, epoch) per session; idempotent.
 */
export function useLinkRefreshWatch(community: Community | undefined): void {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold(community);
  // Once per (community, epoch, relay set): the bundle VENDS relays, so a relay
  // move must re-post too.
  const refreshed = useRef(new Set<string>());
  const { data: dissolved } = useDissolved(community);

  useEffect(() => {
    if (!community || !user?.signer.nip44 || !folded) return;
    // A dissolved community's links must stay dead (else back on Discover); wait for
    // a known-alive answer.
    if (dissolved !== null) return;
    // Only an authorized creator may re-post; a stripped one would resurrect links
    // the authority watcher is retiring.
    if (user.pubkey !== folded.ownerHex && !hasPermission(folded.roster, user.pubkey, Permissions.CREATE_INVITE)) return;
    const key = `${community.idHex}:${community.rootEpoch}:${community.relays.join(",")}`;
    if (refreshed.current.has(key)) return;

    let cancelled = false;
    void (async () => {
      // fetchInviteList already drops tombstoned entries.
      let hasLinks = false;
      try {
        const { list } = await fetchInviteList(nostr, user);
        hasLinks = list.entries.some((e) => e.community_id === community.idHex);
      } catch {
        // Transient failure: leave unmarked so a later open retries.
        return;
      }
      if (cancelled || !hasLinks) return;
      // Mark BEFORE the refresh so a mid-flight re-render doesn't double-fire.
      refreshed.current.add(key);
      await refreshInviteBundlesFor(nostr, user, community, folded.metadata).catch(() => {
        refreshed.current.delete(key);
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.idHex, community?.rootEpoch, community?.relays.join(","), user?.pubkey, folded, dissolved]);
}

/**
 * Watch each held Private Channel's NEXT-epoch rekey address (CORD-06 §2),
 * mirroring {@link useRekeyWatch} per channel:
 *
 *   - a complete, authorized, continuity-checked rotation with MY blob → adopt
 *     the new key/epoch (scope-bound inside the ciphertext);
 *   - a complete post-join rotation with NO blob for me → removed: drop it from
 *     `current` (the original key survives in `seed`).
 *
 * A Refounding seals channel rekeys under the PRIOR root (§3), so every held
 * root is watched, and adoption chains across missed rotations. Authority:
 * MANAGE_CHANNELS (single-channel Rekey), BAN (Refounding), or owner; never a
 * banned rotator.
 */
export function useChannelRekeyWatch(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold(community);
  const { data: dissolved } = useDissolved(community);
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const entry = useCommunityEntry(community?.idHex);
  const queryClient = useQueryClient();
  const handled = useRef(new Set<string>());

  // Re-keys when an adoption moves any channel forward.
  const watchKey = (community?.privateChannels ?? [])
    .map((ch) => `${bytesToHex(ch.id)}:${(ch.epoch + 1n).toString()}`)
    .sort()
    .join(",");

  const query = useQuery<OpenedEvent[]>({
    queryKey: ["concord", "chrekey", community?.idHex ?? null, watchKey],
    enabled: Boolean(community && community.privateChannels.length > 0),
    staleTime: 15_000,
    // Faster than the base watcher: a lagging cut reads as "revoking did nothing"
    // to the moderator. The REQ is cheap.
    refetchInterval: 45_000,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      // Under EVERY held root: a refound-driven channel rekey is sealed under the
      // then-prior root (§3).
      const roots = community!.heldRoots.length > 0 ? community!.heldRoots : [{ epoch: community!.rootEpoch, key: community!.root }];
      const byPk = new Map<string, ReturnType<typeof channelRekeyGroupKey>>();
      for (const ch of community!.privateChannels) {
        for (const r of roots) {
          // A WINDOW of epochs, so a member who missed a rotation can still catch up.
          for (let ahead = 1n; ahead <= BigInt(CHANNEL_REKEY_LOOKAHEAD); ahead++) {
            const address = channelRekeyGroupKey(r.key, ch.id, ch.epoch + ahead);
            byPk.set(address.pk, address);
          }
        }
      }
      const authors = [...byPk.keys()];

      // PER-RELAY `since` cursors, as in the base watcher.
      const results = await Promise.all(
        community!.relays.map(async (url) => {
          const scope = `chrekey:${community!.idHex}:${watchKey}|${url}`;
          const filter = rekeyFilter(authors, await readStreamCursor(scope));
          try {
            const first = await nostr
              .relay(url)
              .query([filter], { signal: AbortSignal.any([signal, AbortSignal.timeout(REKEY_QUERY_TIMEOUT_MS)]) });
            const walked = await walkRekeyFilter(nostr, url, filter, first.filter((e) => byPk.has(e.pubkey)), signal);
            if (walked.complete && walked.events.length > 0) {
              await updateStreamCursor(scope, { newest: rekeyCursor(walked.events) });
            }
            return walked.events;
          } catch {
            return [] as NostrEvent[];
          }
        }),
      );
      const fresh: OpenedWireEvent[] = [];
      for (const wrap of results.flat()) {
        const address = byPk.get(wrap.pubkey);
        if (!address) continue;
        try {
          fresh.push(openWrap(wrap, address));
        } catch {
          // not this address / malformed
        }
      }
      if (fresh.length > 0) writeOpened(community!.idHex, fresh, "rekey");
      // Read back the SAME window the REQ covers: `since` advances past a rotation
      // once, so reading only `held + 1` would truncate the walk on every later poll.
      // Roots collapse here (a round names scope and epoch, not its sealing root).
      const stored = await queryRekeyRounds(
        community!.idHex,
        community!.privateChannels.flatMap((ch) =>
          Array.from({ length: CHANNEL_REKEY_LOOKAHEAD }, (_, i) => ({
            scopeIdHex: bytesToHex(ch.id),
            newEpoch: ch.epoch + BigInt(i + 1),
          })),
        ),
      );
      const byId = new Map<string, OpenedEvent>();
      for (const e of stored) byId.set(e.rumorId, e);
      for (const e of fresh) byId.set(e.rumorId, e);
      return [...byId.values()];
    },
  });

  useEffect(() => {
    if (!community || !user || !folded || !query.data || query.data.length === 0) return;
    if (community.privateChannels.length === 0) return;
    if (!entry) return; // the removal decision needs my join time
    if (dissolved) return; // death wins every race (CORD-02 §9)
    const nip44 = user.signer.nip44;
    if (!nip44) return;

    let cancelled = false;
    void (async () => {
      const parsed: ParsedRekey[] = [];
      for (const opened of query.data!) {
        try {
          parsed.push(parseRekey(opened));
        } catch {
          // not a rekey / not ours
        }
      }
      const sets = groupRotations(parsed);
      const joinedAt = entry?.added_at ?? 0;

      let nextChannels = heldChannelKeys(entry.current.channels).map((c) => ({ ...c }));
      const cuts: Array<{ id: string; epoch: number }> = [];
      // Claimed handles, released if nothing is written so a failed rotation can retry.
      const marked: string[] = [];
      // Every non-writing exit must release claims: cancellation mid-walk is routine,
      // and a stuck claim would leave the channel on a dead key until restart.
      const releaseClaims = () => {
        for (const handle of marked) handled.current.delete(handle);
      };
      let changed = false;

      for (const ch of community.privateChannels) {
        const chIdHex = bytesToHex(ch.id);

        // Authorized rotators only (CORD-06); key possession is never authority. EVERY
        // rotation past my epoch counts, since a missed one leaves the next address
        // empty forever. Continuity gates ADOPTION below, not this filter.
        const rotations = sets
          .filter(
            (set) =>
              set.scopeIdHex === chIdHex &&
              set.newEpoch > ch.epoch &&
              set.complete && // a missing chunk is never a removal
              !folded.banned.has(set.rotator) &&
              (set.rotator === folded.ownerHex ||
                hasPermission(folded.roster, set.rotator, Permissions.BAN) ||
                hasPermission(folded.roster, set.rotator, Permissions.MANAGE_CHANNELS)) &&
              citationSatisfied(folded, community.id, set.rotator, set.authority),
          )
          .sort((a, b) => (a.newEpoch === b.newEpoch ? 0 : a.newEpoch < b.newEpoch ? -1 : 1));
        if (rotations.length === 0) continue;

        // Keyed on the epoch the walk actually LANDS on, so a walk stalled at a gap
        // isn't retired before the missing link arrives.
        const keyFor = (epoch: bigint) => `${community.idHex}:${chIdHex}:${epoch}`;

        // Walk epoch by epoch, ascending. ADOPTION requires an unbroken `prevcommit`
        // chain from my key (CORD-06 §2); waiving it would let a rotator fork a lagging
        // member undetectably. REMOVAL needs no chain (hiding is local and safe), so a
        // member with an unfetchable gap still learns they were cut.
        const byEpoch = new Map<bigint, typeof rotations>();
        for (const set of rotations) {
          const at = byEpoch.get(set.newEpoch);
          if (at) at.push(set);
          else byEpoch.set(set.newEpoch, [set]);
        }
        const epochsAscending = [...byEpoch.keys()].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));

        let chainEpoch = ch.epoch;
        let chainKey = ch.key;
        let adopted: { key: Uint8Array; epoch: bigint } | undefined;
        let excludedAt: bigint | undefined; // ascending scan → the newest wins
        // Every key the walk steps OFF, newest first, retained as priors (each reads
        // its own history, CORD-03 §3) with the superseding rotation's publish time.
        const steppedOver: Array<{ key: Uint8Array; epoch: bigint; retiredAt?: number }> = [];

        for (const epoch of epochsAscending) {
          const candidates = byEpoch.get(epoch)!;
          let keyHere: Uint8Array | undefined;
          let publishedHereMs: number | undefined;
          let addressedHere = false;

          for (const set of candidates) {
            const blob = findBlob(set, myLocator(set.rotator, user.pubkey, chIdHex, epoch));
            if (!blob) continue;
            addressedHere = true;
            // Only a rotation off the key I hold can hand me the next one.
            if (!checkContinuity(set, chainEpoch, chainKey).ok) continue;
            try {
              const plainB64 = await nip44.decrypt(set.rotator, blob.wrapped);
              // Scope binds INSIDE the ciphertext, so blobs can't be spliced across channels.
              const newKey = decodeWrappedKey(base64ToBytes(plainB64), ch.id, epoch);
              // Two rotators racing to one epoch converge on the lower key.
              keyHere = keyHere ? lowerKeyWins(keyHere, newKey) : newKey;
              // Retirement is the EARLIEST honored rotation at this epoch.
              const at = rotationPublishedAtMs(set);
              publishedHereMs = publishedHereMs === undefined ? at : Math.min(publishedHereMs, at);
            } catch { /* ignore */ }
          }
          if (cancelled) return releaseClaims();

          if (keyHere) {
            steppedOver.unshift({
              key: chainKey,
              epoch: chainEpoch,
              ...(publishedHereMs !== undefined ? { retiredAt: Math.floor(publishedHereMs / 1000) } : {}),
            });
            adopted = { key: keyHere, epoch };
            chainEpoch = epoch;
            chainKey = keyHere;
            continue;
          }
          // Addressed to me but not off a verifiable key: neither adopt nor remove; keep polling.
          if (addressedHere) continue;
          // A rotation that could have carried my blob and didn't is the read-cut
          // (CORD-06 §2) — but only from a rotator who STRICTLY OUTRANKS me (§Authority).
          if (
            candidates.some(
              (set) =>
                rotationExcludesMe(rotationPublishedAtMs(set), joinedAt) &&
                outranksMember(folded.roster, set.rotator, folded.ownerHex, user.pubkey),
            )
          ) {
            excludedAt = epoch;
          }
        }
        if (cancelled) return releaseClaims();

        // A key ABOVE the newest excluding rotation is a re-admission; below it, the
        // exclusion wins.
        if (adopted && (excludedAt === undefined || adopted.epoch > excludedAt)) {
          const handle = keyFor(adopted.epoch);
          if (handled.current.has(handle)) continue;
          handled.current.add(handle);
          marked.push(handle);
          const keyHex = bytesToHex(adopted.key);
          const adoptedEpoch = Number(adopted.epoch);
          nextChannels = nextChannels.map((c) =>
            c.id.toLowerCase() === chIdHex
              ? {
                  ...c,
                  key: keyHex,
                  epoch: adoptedEpoch,
                  // Retain every key the walk stepped off; each reads its own history.
                  priors: [
                    ...steppedOver.map((p) => ({
                      key: bytesToHex(p.key),
                      epoch: Number(p.epoch),
                      ...(p.retiredAt !== undefined ? { retired_at: p.retiredAt } : {}),
                    })),
                    ...(c.priors ?? []),
                  ],
                }
              : c,
          );
          changed = true;
        } else if (excludedAt !== undefined) {
          // Removed: drop from `current` (`seed` keeps the original). The cut is RECORDED
          // at the excluding epoch so a stale bundle can't merge access back (`channel_cuts`).
          const handle = keyFor(excludedAt);
          if (handled.current.has(handle)) continue;
          handled.current.add(handle);
          marked.push(handle);
          nextChannels = nextChannels.filter((c) => c.id.toLowerCase() !== chIdHex);
          cuts.push({ id: chIdHex, epoch: Number(excludedAt) });
          changed = true;
        }
      }

      // Nothing to write (or cancelled): release this pass's claims (see releaseClaims).
      if (!changed || cancelled) return releaseClaims();
      await updateList({
        type: "refresh-channels",
        communityId: community.idHex,
        channels: nextChannels,
        ...(cuts.length > 0 ? { cuts } : {}),
      }).catch(() => {
        // The write failed: un-claim so the next poll retries.
        releaseClaims();
      });
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.idHex, watchKey, user?.pubkey, folded, dissolved, query.data, entry?.added_at]);
}

/**
 * Rotate ONE held Private Channel's key (CORD-06 §3, without a Refounding): mint
 * the next channel epoch for exactly `keepRecipients` (+ the rotator) and adopt
 * it locally. Others see it as their removal (the read-cut behind revoking a
 * role-gated channel; channelAccess.ts). Requires MANAGE_CHANNELS or ownership.
 */
export function useChannelRekey(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold(community);
  const { data: dissolved } = useDissolved(community);
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const queryClient = useQueryClient();

  const rekeyChannel = useMutation<
    void,
    Error,
    {
      channelIdHex: string;
      keepRecipients: string[];
      /**
       * Who this rotation CUTS. Required: CORD-06 §Authority binds the rotator's rank
       * to the removed set, which only the caller knows.
       */
      removedTargets: string[];
      /** Severing a ban's reads, which BAN authorizes too (CORD-06 §3). */
      forBan?: boolean;
    }
  >({
    scope: { id: `concord-chrekey:${community?.idHex}` },
    mutationFn: async ({ channelIdHex, keepRecipients, removedTargets, forBan }) => {
      if (!user || !community) throw new Error(t({ id: "useRekey.notReady", defaultMessage: "Not ready." }));
      if (dissolved) throw new Error(t({ id: "useRekey.dissolved", defaultMessage: "This community was dissolved." }));
      const nip44 = user.signer.nip44;
      if (!nip44) throw new Error(t({ id: "useRekey.signerCantRotate", defaultMessage: "This signer can't rotate keys (NIP-44 unsupported)." }));
      const ch = community.privateChannels.find((c) => bytesToHex(c.id) === channelIdHex);
      if (!ch) throw new Error(t({ id: "useRekey.noChannelKey", defaultMessage: "You don't hold this channel's key." }));
      const ownerHex = folded?.ownerHex ?? community.owner;
      const may = (bit: bigint) => Boolean(folded && hasPermission(folded.roster, user.pubkey, bit));
      if (user.pubkey !== ownerHex && !may(Permissions.MANAGE_CHANNELS) && !(forBan && may(Permissions.BAN))) {
        throw new Error(t({ id: "useRekey.channelRotateNeedsPermission", defaultMessage: "Rotating a channel key needs the Manage-channels permission." }));
      }
      // CORD-06 §Authority: the Rotator must also strictly outrank every removed
      // target; receivers check this, so an un-outranked cut silently fails.
      if (user.pubkey !== ownerHex) {
        const unrankable = removedTargets.filter(
          (pk) => pk !== user.pubkey && !(folded && outranksMember(folded.roster, user.pubkey, ownerHex, pk)),
        );
        if (unrankable.length > 0) {
          throw new Error(
            t(
              {
                id: "useRekey.dontOutrankCut",
                defaultMessage:
                  "{count, plural, one {You don't outrank one of the members this would cut, so they would ignore the rotation.} other {You don't outrank # of the members this would cut, so they would ignore the rotation.}}",
              },
              { count: unrankable.length },
            ),
          );
        }
      }

      // A rotation of mine already out at the next epoch, off the same key (another
      // surface, a duty with an older roster, an earlier try), merges with this one
      // (`groupRotations`): if it handed any of the cut a key, this one can't take it
      // back. Step past it instead: hold its key, and rotate from there.
      let from: PrivateChannelKey = ch;
      const earlier = await myRotationAt(nostr, community, ch, user.pubkey);
      if (earlier && removedTargets.some((pk) => findBlob(earlier, myLocator(user.pubkey, pk, channelIdHex, earlier.newEpoch)))) {
        // Half out, nobody adopts it, so there is nothing to step past yet; adding to it would finish it.
        if (!earlier.complete) throw new Error(t({ id: "useRekey.earlierRotationLanding", defaultMessage: "An earlier rotation of this channel is still landing; try again in a moment." }));
        // Its key from my own blob in it: another device of mine may have minted it.
        const mine = findBlob(earlier, myLocator(user.pubkey, user.pubkey, channelIdHex, earlier.newEpoch));
        const heldKey = mine
          ? decodeWrappedKey(base64ToBytes(await nip44.decrypt(user.pubkey, mine.wrapped)), ch.id, earlier.newEpoch)
          : undefined;
        if (!heldKey) throw new Error(t({ id: "useRekey.earlierRotationLanding", defaultMessage: "An earlier rotation of this channel is still landing; try again in a moment." }));
        from = {
          ...ch,
          key: heldKey,
          epoch: ch.epoch + 1n,
          priors: [{ key: ch.key, epoch: ch.epoch, retiredAt: Math.floor(rotationPublishedAtMs(earlier) / 1000) }, ...(ch.priors ?? [])],
        };
      }

      const chEpoch = from.epoch + 1n;
      const chPrevCommit = bytesToHex(epochKeyCommitment(from.epoch, from.key));
      // Joining an earlier set of mine carries ITS key: one epoch, one key, whichever
      // device minted it.
      const joined = from === ch && earlier
        ? findBlob(earlier, myLocator(user.pubkey, user.pubkey, channelIdHex, earlier.newEpoch))
        : undefined;
      const chKey = joined
        ? decodeWrappedKey(base64ToBytes(await nip44.decrypt(user.pubkey, joined.wrapped)), ch.id, chEpoch)
        : await mintOrReuseRotationKey(
          community.idHex,
          { kind: "channel", channelId: ch.id },
          chEpoch,
          chPrevCommit,
        );
      const chPlain = bytesToBase64(encodeWrappedKey(ch.id, chEpoch, chKey));
      const recipients = [...new Set([user.pubkey, ...keepRecipients])];
      const chBlobs: RekeyBlob[] = [];
      for (const pk of recipients) {
        chBlobs.push({ locator: myLocator(user.pubkey, pk, channelIdHex, chEpoch), wrapped: await nip44.encrypt(pk, chPlain) });
      }
      const chAddress = channelRekeyGroupKey(community.root, ch.id, chEpoch);
      // Doubles as the severed key's `retiredAt`, as every adopter derives it.
      const rotatedAtMs = clockNowMs();
      const chRumors = buildRekeyRumors(
        user.pubkey,
        { scope: { kind: "channel", channelId: ch.id }, newEpoch: chEpoch, prevEpoch: from.epoch, prevCommit: chPrevCommit },
        chBlobs,
        rotatedAtMs,
        // Cite the Grant (CORD-06 §Authority / CORD-04 §5); without it every receiver
        // drops a non-owner's rotation.
        citationFor(community, folded, user.pubkey),
      );
      for (const rumor of chRumors) {
        const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, chAddress, user.signer), chAddress);
        const results = await settleAccepted(
          community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
        );
        if (!results.some((r) => r.status === "fulfilled")) {
          throw new Error(t({ id: "useRekey.noRelayAcceptedChannelRotation", defaultMessage: "No relay accepted the #{channel} channel key rotation." }, { channel: ch.name || channelIdHex.slice(0, 8) }));
        }
      }

      // Adopt immediately: the rotator must never keep writing under the severed key.
      const rotated = community.privateChannels.map((c) =>
        bytesToHex(c.id) === channelIdHex
          ? {
              ...from,
              key: chKey,
              epoch: chEpoch,
              priors: [
                { key: from.key, epoch: from.epoch, retiredAt: Math.floor(rotatedAtMs / 1000) },
                ...(from.priors ?? []),
              ],
            }
          : c,
      );
      // Only the rotated channel, merged at write time: the rest of `community` was read
      // before the signing run and may have gained a key since. A failed write isn't a
      // failed rotation: it is on the wire, and the rotator's own watch adopts it.
      await updateList({
        type: "refresh-channels",
        communityId: community.idHex,
        channels: channelKeysToWire(rotated.filter((c) => bytesToHex(c.id) === channelIdHex)),
        upsert: true,
      }).catch(() => undefined);
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });

      // The rotator's duty: the details sealed again under the key just minted (CORD-03 §2,
      // Vector `reseal_rotated`). Best-effort; the reseal backstop retries.
      // From the store's fold, one write at a time: the rendered fold lags a rename just made.
      await withControlWrite(community.idHex, async () => {
        const now = await foldStoredControl(community).catch(() => folded);
        const def = now?.rankedRoster ? now.channels.get(channelIdHex) : undefined;
        const head = def ? now?.heads.get(channelIdHex) : undefined;
        const fresh = rotated.find((c) => bytesToHex(c.id) === channelIdHex);
        const resealed = def && head && fresh ? resealedChannelContent(def, fresh, bytesToHex(head.hash)) : undefined;
        if (!resealed || !head) return;
        const rumor = buildChannelContentEdition(ch.id, resealed, {
          actorPubkey: user.pubkey,
          version: head.version + 1n,
          prevHash: head.hash,
          authority: citationFor(community, now, user.pubkey),
        });
        await publishEdition(nostr, community, user.signer, rumor);
      }).catch(() => undefined);

      // My links still vend the retired key; re-mint at the fresh keys (CORD-05 §2).
      // Best-effort (`useLinkRefreshWatch` retries).
      await refreshInviteBundlesFor(
        nostr,
        user,
        { ...community, privateChannels: rotated },
        folded?.metadata,
      ).catch(() => undefined);
    },
  });

  return {
    rekeyChannel: rekeyChannel.mutateAsync,
    isRekeyingChannel: rekeyChannel.isPending,
    canRekeyChannel: Boolean(
      user?.signer.nip44 &&
      community &&
      (user.pubkey === (folded?.ownerHex ?? community.owner) ||
        (folded && hasPermission(folded.roster, user.pubkey, Permissions.MANAGE_CHANNELS))),
    ),
    /** {@link canRekeyChannel}, for a ban's cut, which a BAN holder may also make. */
    canSeverChannel: Boolean(
      user?.signer.nip44 &&
      community &&
      (user.pubkey === (folded?.ownerHex ?? community.owner) ||
        (folded && (hasPermission(folded.roster, user.pubkey, Permissions.MANAGE_CHANNELS) || hasPermission(folded.roster, user.pubkey, Permissions.BAN)))),
    ),
  };
}

/**
 * Where a Refounding is, for its dialog. Most steps are a signer round-trip or a relay
 * acceptance each, so a long one (one NIP-44 encryption per member, on a bunker) is
 * counted where its length is known.
 */
export type RefoundStep = "reading" | "encrypting" | "rolling" | "carrying" | "guestbook" | "channels" | "links" | "saving";
export interface RefoundProgress {
  step: RefoundStep;
  done?: number;
  total?: number;
}

interface RefoundCarry {
  /** The community at the epoch the roll left. */
  prior: Community;
  folded: FoldedControl;
  stored: OpenedEvent[];
  newRoot: Uint8Array;
  newEpoch: bigint;
  newControlRoot: Uint8Array;
  newControlPk: string;
  journal: RefoundJournal;
  onProgress?: (progress: RefoundProgress) => void;
}

/** The held roots with the one the roll left given its read cutoff. */
function retirePrior(heldRoots: HeldRoot[], priorEpoch: bigint, rotatedAtMs: number): HeldRoot[] {
  return heldRoots.map((r) =>
    r.epoch === priorEpoch && r.retiredAt === undefined ? { ...r, retiredAt: Math.floor(rotatedAtMs / 1000) } : r,
  );
}

function privateChannelFromWire(c: JoinMaterial["channels"][number]): PrivateChannelKey {
  return {
    id: hexToBytes(c.id),
    key: hexToBytes(c.key),
    epoch: BigInt(c.epoch),
    name: c.name,
    ...(c.priors?.length
      ? { priors: c.priors.map((p) => ({ key: hexToBytes(p.key), epoch: BigInt(p.epoch), ...(p.retired_at !== undefined ? { retiredAt: p.retired_at } : {}) })) }
      : {}),
  };
}

/**
 * A Refounding (CORD-06 §3): roll the community_root to sever the excluded,
 * re-anchor the Control Plane by compaction, and seed the new Guestbook.
 * Requires BAN (or ownership) and a NIP-44 signer (bunkers can rotate too).
 */
export function useRefound(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const control = useControlFold(community);
  const { data: dissolved } = useDissolved(community);
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const entry = useCommunityEntry(community?.idHex);
  const queryClient = useQueryClient();

  /**
   * Everything a Refounding owes after its root roll (CORD-06 §3), each step recorded
   * in the journal as it completes so an interrupted run resumes after it: the Control
   * Plane's heads carried to the new address, the new Guestbook, each held Private
   * Channel rotated under the PRIOR root, invite links, and the list written forward.
   */
  const carry = async (ctx: RefoundCarry) => {
    if (!user || !entry) throw new Error(t({ id: "useRekey.notReady", defaultMessage: "Not ready." }));
    const nip44 = user.signer.nip44;
    if (!nip44) throw new Error(t({ id: "useRekey.signerCantRotate", defaultMessage: "This signer can't rotate keys (NIP-44 unsupported)." }));
    const { prior: community, folded, stored, newRoot, newEpoch, newControlRoot, newControlPk, journal } = ctx;
    const report = ctx.onProgress ?? (() => undefined);
    const { recipients, exclude, rotatedAtMs } = journal;
    const save = () => writeRefoundJournal(user.pubkey, community.idHex, journal);

    // 2. Compaction: re-wrap each current head under the new epoch;
    // plaintext seals keep signatures verifiable. Each head is ack-gated (readers
    // sweep only the current epoch). The new Control address is SPLIT: sign with the
    // control_root-derived signer, encrypt under the community_root-derived read
    // key, and never mirror to the legacy address. A head landed twice is one rumor.
    if (!journal.carried) {
      const newControlRead = controlGroupKey(newRoot, community.id, newEpoch);
      const newControl = {
        sk: controlSignerGroupKey(newControlRoot, community.id, newEpoch).sk,
        pk: newControlPk,
        get convKey() {
          return newControlRead.convKey;
        },
      };
      const heads = compactionEditions(folded, openControlEditions(stored));
      report({ step: "carrying", done: 0, total: heads.length });
      for (const [i, head] of heads.entries()) {
        // Store rows keep seals in KV, so fall back to a keyed read; a missing seal
        // aborts (fold-all-or-abort) rather than dropping the entity.
        const seal =
          head.opened.seal ?? (await readStoredSeal(community.idHex, head.opened.rumorId));
        if (!seal) {
          throw new Error(t({ id: "useRekey.missingHistory", defaultMessage: "Missing the signed history needed to carry this community's state into the new epoch; nothing was lost, try again after a resync." }));
        }
        let rewrapped: NostrEvent;
        try {
          rewrapped = await rewrapSeal(seal, newControl);
        } catch {
          // Defensive only: control heads are plaintext by construction.
          continue;
        }
        const results = await settleAccepted(
          community.relays.map((url) => nostr.relay(url).event(rewrapped, { signal: AbortSignal.timeout(8000) })),
        );
        // The epoch is already announced: a head that fails to land is carried again
        // when the journal resumes.
        if (!results.some((r) => r.status === "fulfilled")) {
          throw new Error(t({ id: "useRekey.noRelayAcceptedState", defaultMessage: "No relay accepted the community's state during rotation; nothing was lost, try again." }));
        }
        report({ step: "carrying", done: i + 1, total: heads.length });
      }
      journal.carried = true;
      save();
    }

    // 3. Guestbook snapshot: best-effort, non-gating (CORD-02 §5). Before the channels,
    // which can throw: an epoch with no snapshot builds its next keep-list from a thin roster.
    if (!journal.guestbook) {
      report({ step: "guestbook" });
      try {
        const newGuestbook = guestbookGroupKey(newRoot, community.id, newEpoch);
        const snapId = bytesToHex(random32());
        for (const rumor of buildSnapshotRumors(user.pubkey, recipients, snapId, clockNowMs())) {
          const wrap = await sealGuestbook(rumor, newGuestbook, user.signer);
          await settleAccepted(
            community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
          );
        }
        // The Refounder's duties to the new Guestbook (CORD-04 §8, §10): each running
        // Timeout and each Nickname set for a re-keyed member, that it could issue itself,
        // re-issued in its own name dated as first issued.
        const reissued = await reissuedGuestbook(community, folded, user.pubkey, recipients, citationFor(community, folded, user.pubkey), exclude);
        for (const rumor of reissued) {
          const wrap = await sealGuestbook(rumor, newGuestbook, user.signer);
          await settleAccepted(
            community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
          );
        }
        journal.guestbook = true;
        save();
      } catch { /* ignore */ }
    }

    // 2b. Rotate every held Private Channel (CORD-06 §3), each with its own fresh
    // key via a channel-scoped rekey under the PRIOR root. Each channel's keep-list
    // is its OWN entitled set (channelAccess.ts): the community-wide list would hand
    // every member every private channel's key. So a Refounding also re-syncs
    // entitlements, and a channel with no scoped Role rotates to the owner alone.
    const done = new Map(journal.channels.map((c) => [c.id.toLowerCase(), c] as const));
    const rotatedChannels: PrivateChannelKey[] = [];
    const channelTotal = community.privateChannels.length;
    for (const [i, ch] of community.privateChannels.entries()) {
      if (channelTotal > 0) report({ step: "channels", done: i, total: channelTotal });
      const chIdHex = bytesToHex(ch.id);
      const finished = done.get(chIdHex);
      if (finished) {
        rotatedChannels.push(privateChannelFromWire(finished));
        continue;
      }
      // Already past its pre-Refounding epoch: its rotation landed and was adopted.
      const base = journal.channelBase[chIdHex];
      if (base === undefined || ch.epoch > BigInt(base)) {
        rotatedChannels.push(ch);
        continue;
      }
      const chEpoch = ch.epoch + 1n;
      const chPrevCommit = bytesToHex(epochKeyCommitment(ch.epoch, ch.key));
      const chKey = await mintOrReuseRotationKey(
        community.idHex,
        { kind: "channel", channelId: ch.id },
        chEpoch,
        chPrevCommit,
      );
      // The rotator keeps every key, or nobody could rotate this channel next time.
      const chRecipients = recipients.filter(
        (pk) => pk === user.pubkey || isEntitled(folded.roster, folded.ownerHex, pk, chIdHex),
      );
      const chPlain = bytesToBase64(encodeWrappedKey(ch.id, chEpoch, chKey));
      const chBlobs: RekeyBlob[] = [];
      for (const pk of chRecipients) {
        chBlobs.push({ locator: myLocator(user.pubkey, pk, chIdHex, chEpoch), wrapped: await nip44.encrypt(pk, chPlain) });
      }
      const chAddress = channelRekeyGroupKey(community.root, ch.id, chEpoch);
      const chRotatedAtMs = clockNowMs();
      const chRumors = buildRekeyRumors(
        user.pubkey,
        {
          scope: { kind: "channel", channelId: ch.id },
          newEpoch: chEpoch,
          prevEpoch: ch.epoch,
          prevCommit: chPrevCommit,
        },
        chBlobs,
        chRotatedAtMs,
        citationFor(community, folded, user.pubkey),
      );
      for (const rumor of chRumors) {
        const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, chAddress, user.signer), chAddress);
        const results = await settleAccepted(
          community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
        );
        if (!results.some((r) => r.status === "fulfilled")) {
          // Gating like the root roll: an unrotated channel leaves the removed member
          // reading it. The journal resumes from here.
          throw new Error(t({ id: "useRekey.noRelayAcceptedChannelRotation", defaultMessage: "No relay accepted the #{channel} channel key rotation." }, { channel: ch.name || chIdHex.slice(0, 8) }));
        }
      }
      // Retain the stepped-off key (CORD-03 §3), or every ban truncates private history.
      const rotated: PrivateChannelKey = {
        ...ch,
        key: chKey,
        epoch: chEpoch,
        priors: [
          { key: ch.key, epoch: ch.epoch, retiredAt: Math.floor(chRotatedAtMs / 1000) },
          ...(ch.priors ?? []),
        ],
      };
      rotatedChannels.push(rotated);
      journal.channels.push(...channelKeysToWire([rotated]));
      save();
    }

    // 3b. Refresh my live invite links to the new epoch (CORD-05 §2), with the
    // post-rotation channel keys; other creators refresh on adoption. Retried
    // (mirrors Vector): a stranded link lands joiners on the dead epoch.
    //
    // NOT when this rotation EXCLUDED somebody: the URL is a bearer credential, so
    // refreshing would hand the excluded member the new keys, indistinguishably
    // from the cut epoch. Per spec a ban-Refounding is Private and has no links;
    // Armada allows the refounder's own links, so leaving them dead is the safe half.
    if (exclude.length > 0) {
      toast({
        title: t({ id: "useRekey.linksDead.title", defaultMessage: "Your invite links no longer work" }),
        description:
          t({ id: "useRekey.linksDead.description", defaultMessage: "The keys rotated to cut off the removed member. Your links stay on the old keys, because refreshing them would give the new keys to anyone holding the URL. Revoke them and make new ones." }),
      });
    } else {
      report({ step: "links" });
      const fresh = {
        ...community,
        root: newRoot,
        rootEpoch: newEpoch,
        controlPk: newControlPk,
        privateChannels: rotatedChannels,
      };

      let refreshed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await refreshInviteBundlesFor(nostr, user, fresh, folded.metadata);
          refreshed = true;
          break;
        } catch {
          // transient — retry
        }
      }
      if (!refreshed) {
        toast({
          title: t({ id: "useRekey.linksStale.title", defaultMessage: "Live invite links may serve the old keys" }),
          description:
            t({ id: "useRekey.linksStale.description", defaultMessage: "Key rotation succeeded, but refreshing your invite links failed. Reopen the community to retry, or new joiners on those links could land on the previous epoch." }),
          variant: "destructive",
        });
      }
    }

    // 4. Follow our own rotation forward.
    report({ step: "saving" });
    const rotated: Community = {
      ...community,
      root: newRoot,
      rootEpoch: newEpoch,
      controlPk: newControlPk,
      controlRoot: newControlRoot,
      heldRoots: [
        { epoch: newEpoch, key: newRoot, refounder: user.pubkey, controlPk: newControlPk },
        ...retirePrior(community.heldRoots.filter((r) => r.epoch !== newEpoch), community.rootEpoch, rotatedAtMs),
      ],
      privateChannels: rotatedChannels,
      refounder: user.pubkey,
    };
    await updateList({
      type: "refresh-current",
      current: toJoinMaterial(rotated, { prior: entry.current, relays: entry.current.relays }),
    });
    clearRefoundJournal(user.pubkey, community.idHex);
    // A ban's read-cut this run performed is owed no longer (`useReadCutRetry` would
    // otherwise rotate again, for nobody).
    await readCutPendingReady();
    const owed = readCutPending(user.pubkey, community.idHex);
    if (owed && owed.targets.every((pk) => exclude.includes(pk))) clearReadCutPending(user.pubkey, community.idHex);
    queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
  };

  /**
   * The state a journaled Refounding resumes from, on a device that already moved to
   * its epoch: the prior epoch as it was, and its Control Plane folded from the store
   * within the prior snapshot, since the new address may hold none of it yet.
   */
  const resumeContext = async (c: Community, journal: RefoundJournal): Promise<RefoundCarry> => {
    const priorEpoch = BigInt(journal.priorEpoch);
    const priorRoot = c.heldRoots.find((r) => r.epoch === priorEpoch)?.key;
    if (!priorRoot || !c.controlRoot || !c.controlPk) {
      throw new Error(t({ id: "useRekey.cantResume", defaultMessage: "This device no longer holds what it needs to finish the earlier key rotation." }));
    }
    const prior: Community = {
      ...c,
      root: priorRoot,
      rootEpoch: priorEpoch,
      ...(journal.priorControlPk ? { controlPk: journal.priorControlPk } : { controlPk: undefined }),
      controlRoot: undefined,
    };
    const stored = await queryPlane(c.idHex, "control");
    const snap = journal.priorSnapPk ? await readControlSnapshot(c.idHex, journal.priorSnapPk) : undefined;
    const folded = foldControlState(openControlEditions(stored), c.id, c.owner, new Map(), snap ? new Set(snap) : undefined, {
      heldChannels: c.privateChannels,
    });
    if (folded.incomplete.length > 0) {
      throw new Error(t({ id: "useRekey.stateUnreachable", defaultMessage: "Part of the community's state isn't reachable right now; rotation aborted so nothing is lost." }));
    }
    return { prior, folded, stored, newRoot: c.root, newEpoch: c.rootEpoch, newControlRoot: c.controlRoot, newControlPk: c.controlPk, journal };
  };

  /** Resolves false when a `resumeOnly` call found nothing to finish. */
  const refound = useMutation<boolean, Error, {
    keep: string[];
    exclude: string[];
    onProgress?: (progress: RefoundProgress) => void;
    /** Only finish a journaled run at the current epoch; never roll a new one. */
    resumeOnly?: boolean;
  }>({
    // Serialize every refound for this community (a ban racing the durable retry
    // must queue, not mint sibling epochs); named for useIsMutating.
    mutationKey: ["concord-refound", community?.idHex],
    scope: { id: `concord-refound:${community?.idHex}` },
    mutationFn: async ({ keep, exclude, onProgress, resumeOnly }) => {
      const report = onProgress ?? (() => undefined);
      if (!user || !community) throw new Error(t({ id: "useRekey.notReady", defaultMessage: "Not ready." }));
      if (dissolved) throw new Error(t({ id: "useRekey.dissolvedNoAdvance", defaultMessage: "This community was dissolved; no epoch advance past the tombstone is honored." }));
      const nip44 = user.signer.nip44;
      if (!nip44) throw new Error(t({ id: "useRekey.signerCantRotate", defaultMessage: "This signer can't rotate keys (NIP-44 unsupported)." }));
      // A Refounding this device committed and didn't finish is finished first, at its
      // own epoch: retrying it as a new one would roll again off a half-carried plane.
      await refoundJournalReady();
      const pending = refoundJournal(user.pubkey, community.idHex);
      if (pending && BigInt(pending.newEpoch) === community.rootEpoch) {
        await carry({ ...(await resumeContext(community, pending)), onProgress });
        if (exclude.every((pk) => pending.exclude.includes(pk))) return true;
        throw new Error(t({ id: "useRekey.finishedEarlier", defaultMessage: "An earlier key rotation was still unfinished, and has now been completed. Try again to remove the rest." }));
      }
      if (pending && BigInt(pending.newEpoch) < community.rootEpoch) clearRefoundJournal(user.pubkey, community.idHex);
      // A queued resume can run after the run it saw journaled finished on its own.
      if (resumeOnly) return false;

      const rendered = control.data;
      // Not `isFetching`: background refetches made that refuse most attempts, and the
      // sweep below reads the plane whole anyway; the last fold is still a valid floor.
      if (!rendered || control.isLoading) {
        throw new Error(t({ id: "useRekey.stillSyncing", defaultMessage: "Still syncing the community's control plane; try again shortly." }));
      }

      report({ step: "reading" });
      // Fold-all-or-abort (CORD-06 §3): one forced whole-plane sweep, then a
      // verification fold floored at every accepted head; any unserved or gapped
      // entity ABORTS. Tallied from this sweep's own callbacks, not the shared
      // verdict map, which a concurrent background sweep can invalidate.
      let reached = 0;
      let short = false;
      try {
        // Exhaustive: plane depth is attacker-controlled, so a cap would let anyone
        // hold rotation hostage.
        await sweepControl(nostr, community, {
          exhaustive: true,
          onReached: () => {
            reached++;
          },
          onTruncated: () => {
            short = true;
          },
        });
      } catch {
        throw new Error(t({ id: "useRekey.refetchFailed", defaultMessage: "Couldn't re-fetch the community's control plane; check your connection and try again." }));
      }
      // A MAJORITY of relays must have answered (all would let a dead relay block
      // rotation forever; too few would drop state for everyone).
      const total = community.relays.length;
      if (reached < Math.floor(total / 2) + 1) {
        throw new Error(
          t(
            {
              id: "useRekey.tooFewRelays",
              defaultMessage:
                "Only {reached} of this community's {total} relays responded; rotation aborted so nothing is lost. Try again, or remove relays that are no longer running.",
            },
            { reached, total },
          ),
        );
      }
      // With no budget this means the plane is stuffed at one timestamp, which a
      // cursor can't page through; compaction would erase what's behind it.
      if (short) {
        throw new Error(t({ id: "useRekey.flooded", defaultMessage: "This community's history is being flooded and couldn't be read in full; rotation aborted so nothing is lost." }));
      }
      const stored = await queryPlane(community.idHex, "control");
      const verifySnap =
        community.rootEpoch > 0n
          ? await readControlSnapshot(community.idHex, currentControlGroup(community).pk)
          : undefined;
      const folded = foldControlState(openControlEditions(stored), community.id, community.owner, rendered.heads, verifySnap, {
        ...storedControlOf(rendered),
        heldChannels: community.privateChannels,
      });
      if (folded.incomplete.length > 0) {
        throw new Error(t({ id: "useRekey.stateUnreachable", defaultMessage: "Part of the community's state isn't reachable right now; rotation aborted so nothing is lost." }));
      }

      const authorized = user.pubkey === folded.ownerHex || hasPermission(folded.roster, user.pubkey, Permissions.BAN);
      if (!authorized) throw new Error(t({ id: "useRekey.noPermission", defaultMessage: "You don't have permission to rotate this community's keys." }));
      // CORD-06 §Authority: BAN alone doesn't suffice — strictly outrank every
      // removed target, judged against the fresh roster.
      if (user.pubkey !== folded.ownerHex) {
        const unrankable = exclude.filter(
          (pk) => pk !== user.pubkey && !outranksMember(folded.roster, user.pubkey, folded.ownerHex, pk),
        );
        if (unrankable.length > 0) {
          throw new Error(
            t({ id: "useRekey.dontOutrankEvery", defaultMessage: "You don't outrank every member this would remove, so they would ignore the rotation." }),
          );
        }
      }

      // Abort if the entry advanced past the captured epoch, rather than mint a
      // sibling epoch off a stale root.
      if (entry && BigInt(entry.current.root_epoch) !== community.rootEpoch) {
        throw new Error(t({ id: "useRekey.rotatedMeanwhile", defaultMessage: "The community rotated since this action began; reopen it and try again." }));
      }

      // The Guestbook as the relays hold it now: a pass that ran out of budget goes on
      // where it stopped (Vector `read_whole`), and a deeper plane rides on what was read.
      let answered = 0;
      for (let pass = 0; pass < 3; pass++) {
        await sweepGuestbook(nostr, community).catch(() => []);
        const reach = guestbookSweepReach(community);
        answered = reach.answered;
        if (answered === 0 || reach.unread === 0) break;
      }
      if (answered === 0) {
        throw new Error(t({ id: "useRekey.memberListUnreachable", defaultMessage: "Couldn't read the community's member list from its relays; rotation aborted so no member is left without the new key. Check your connection and try again." }));
      }
      // Everyone the Guestbook holds beside whom the caller listed: a member a list
      // forgot would be left at this epoch for good, so only `exclude` removes (Vector
      // `refound_community_with`).
      const excluded = new Set(exclude);
      const recipients = [...new Set([user.pubkey, ...keep, ...(await storedMemberlist(community, folded))])].filter((pk) => !excluded.has(pk));

      const newEpoch = community.rootEpoch + 1n;
      const prevCommit = bytesToHex(epochKeyCommitment(community.rootEpoch, community.root));
      // Reserved, not freshly minted: a retry must carry the SAME keys (root and
      // control_root), or two attempts split the community across two roots.
      const newRoot = await mintOrReuseRotationKey(community.idHex, { kind: "root" }, newEpoch, prevCommit);
      // Every compliant base rotation mints the split (CORD-06 §3); legacy communities upgrade here.
      const newControlRoot = await mintOrReuseControlRoot(community.idHex, newEpoch, prevCommit);
      const newControlPk = controlSignerGroupKey(newControlRoot, community.id, newEpoch).pk;

      // Acquire everything BEFORE the first publish. Member blobs carry the new
      // control_pk (104 bytes); staff blobs (CORD-04 §3) append the secret (136).
      const memberPlain = bytesToBase64(
        encodeWrappedBaseKey(newEpoch, newRoot, hexToBytes(newControlPk)),
      );
      const staffPlain = bytesToBase64(
        encodeWrappedBaseKey(newEpoch, newRoot, hexToBytes(newControlPk), newControlRoot),
      );
      const blobs: RekeyBlob[] = [];
      for (const pk of recipients) {
        report({ step: "encrypting", done: blobs.length, total: recipients.length });
        const staff = pk === user.pubkey ? true : isStaff(folded.roster, pk, folded.ownerHex);
        const wrapped = await nip44.encrypt(pk, staff ? staffPlain : memberPlain);
        blobs.push({ locator: myLocator(user.pubkey, pk, "0".repeat(64), newEpoch), wrapped });
      }

      // The retired root's hard read cutoff, as every adopter derives it.
      const rotatedAtMs = clockNowMs();
      // Journaled before the roll: once it lands, the rest is owed at THIS epoch.
      const journal: RefoundJournal = {
        newEpoch: newEpoch.toString(),
        priorEpoch: community.rootEpoch.toString(),
        ...(community.rootEpoch > 0n ? { priorSnapPk: currentControlGroup(community).pk } : {}),
        ...(community.controlPk ? { priorControlPk: community.controlPk } : {}),
        recipients,
        exclude,
        rotatedAtMs,
        channelBase: Object.fromEntries(community.privateChannels.map((c) => [bytesToHex(c.id), c.epoch.toString()])),
        channels: [],
      };
      writeRefoundJournal(user.pubkey, community.idHex, journal);

      // 1. The root roll: rekey blobs at the base address under the PRIOR root, FIRST
      // (CORD-06 §3); compaction republishes only after it's confirmed.
      const address = baseRekeyGroupKey(community.root, community.id, newEpoch);
      const rumors = buildRekeyRumors(
        user.pubkey,
        { scope: { kind: "root" }, newEpoch, prevEpoch: community.rootEpoch, prevCommit },
        blobs,
        rotatedAtMs,
        citationFor(community, folded, user.pubkey),
      );
      for (const [i, rumor] of rumors.entries()) {
        report({ step: "rolling", done: i, total: rumors.length });
        const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, address, user.signer), address);
        const results = await settleAccepted(
          community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
        );
        if (!results.some((r) => r.status === "fulfilled")) {
          throw new Error(t({ id: "useRekey.noRelayAcceptedRotation", defaultMessage: "No relay accepted the key rotation." }));
        }
      }

      // 1a. Record the epoch NOW: the roll is the commit. Otherwise a later failure
      // leaves us at the prior epoch, and a retry at the same (newEpoch, prevCommit)
      // merges with attempt one in `groupRotations`, re-including the removed member.
      // Private channels stay put; §3 addresses their rekeys under the PRIOR root.
      await updateList({
        type: "refresh-current",
        current: toJoinMaterial(
          {
            ...community,
            root: newRoot,
            rootEpoch: newEpoch,
            controlPk: newControlPk,
            controlRoot: newControlRoot,
            heldRoots: [
              { epoch: newEpoch, key: newRoot, refounder: user.pubkey, controlPk: newControlPk },
              ...retirePrior(community.heldRoots, community.rootEpoch, rotatedAtMs),
            ],
            refounder: user.pubkey,
          },
          { prior: entry?.current, relays: entry?.current.relays },
        ),
      });

      await carry({ prior: community, folded, stored, newRoot, newEpoch, newControlRoot, newControlPk, journal, onProgress });
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
      return true;
    },
  });

  return {
    refound: refound.mutateAsync,
    isRefounding: refound.isPending,
    /** Rotations need only a NIP-44 signer (bunker-friendly). */
    canRefound: Boolean(user?.signer.nip44),
  };
}

/**
 * Finish a Refounding this device committed and didn't complete (`refoundJournal.ts`),
 * once per visit. Mount ONCE per community (ConcordPage). Unlike most duties it needs
 * no rendered fold: an interrupted carry is exactly what leaves the new epoch without one.
 */
export function useRefoundResume(community: Community | undefined): void {
  const { user } = useCurrentUser();
  const { refound, canRefound } = useRefound(community);
  // A run in flight journals its epoch before it records it, so its journal is no sign of an interruption.
  const refoundsInFlight = useIsMutating({ mutationKey: ["concord-refound", community?.idHex] });
  const tried = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!user || !community || !canRefound || refoundsInFlight > 0) return;
    const key = `${community.idHex}:${community.rootEpoch}`;
    if (tried.current === key) return;
    let cancelled = false;
    void (async () => {
      await refoundJournalReady();
      if (cancelled || tried.current === key) return;
      const pending = refoundJournal(user.pubkey, community.idHex);
      if (!pending || BigInt(pending.newEpoch) !== community.rootEpoch) return;
      tried.current = key;
      refound({ keep: pending.recipients, exclude: pending.exclude, resumeOnly: true }).then(
        (resumed) => resumed && toast({ title: t({ id: "useRekey.resumed.title", defaultMessage: "Key rotation completed" }), description: t({ id: "useRekey.resumed.description", defaultMessage: "An earlier key rotation that was interrupted has now finished." }) }),
        (e: unknown) => toast({
          title: t({ id: "useRekey.resumeFailed.title", defaultMessage: "An earlier key rotation is still unfinished" }),
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, community?.idHex, community?.rootEpoch, canRefound, refoundsInFlight]);
}
