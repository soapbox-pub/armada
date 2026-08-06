import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useCommunityEntry2, useUpdateCommunityList2 } from "@/concord-v2/hooks/useCommunityList2";
import { citationFor, useControlFold2, useDissolved2 } from "@/concord-v2/hooks/useControlPlane2";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { channelKeysToWire, heldChannelKeys, toJoinMaterial } from "@/concord-v2/lib/communityList";
import { currentControlGroup, foldControlState, openControlEditions } from "@/concord-v2/lib/control";
import { sweepControl } from "@/concord-v2/lib/planeSync";
import { channelRekeyGroupKey, controlGroupKey, controlSignerGroupKey, guestbookGroupKey } from "@/concord-v2/lib/derive";
import {
  baseRekeyGroupKey,
  bytesToHex,
  epochKeyCommitment,
  hexToBytes,
  random32,
} from "@/concord-v2/lib/derive";
import { buildSnapshotRumors, sealGuestbook } from "@/concord-v2/lib/guestbook";
import { KIND_SEAL_ENCRYPTED, KIND_WRAP } from "@/concord-v2/lib/kinds";
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
  rekeyScopeId,
  rotationExcludesMe,
  rotationPublishedAtMs,
  type ParsedRekey,
  type RekeyBlob,
} from "@/concord-v2/lib/rekey";
import { citationSatisfied } from "@/concord-v2/lib/control";
import { hasPermission, isStaff, outranksMember, Permissions } from "@/concord-v2/lib/roles";
import { queryPlane, queryRekeyRounds, readControlSnapshot, readStoredSeal, readStreamCursor, updateStreamCursor, writeOpened } from "@/concord-v2/lib/rumorStore";
import { openWrap, rewrapSeal, sealRumor, wrapSeal, type OpenedEvent, type OpenedWireEvent } from "@/concord-v2/lib/stream";
import { buildRefreshedBundleEvents, type InviteBundle } from "@/concord-v2/lib/invite";
import { fetchInviteList } from "@/concord-v2/hooks/useInvites2";
import { toast } from "@/hooks/useToast";
import type { CommunityMetadata, CommunityV2, HeldRoot, PrivateChannelKey } from "@/concord-v2/lib/types";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NUser } from "@nostrify/react/login";


/**
 * Re-post this user's live invite bundles for `rotated` at the community's
 * CURRENT keys (CORD-05 §2). `rotated` carries the new `root`/`rootEpoch`; the
 * creator's Invite List (kind 13303, §4) supplies each live link's `token` +
 * `signer_sk` — so a creator refreshes exactly the links they minted, whether
 * they are the Refounder or a member adopting someone else's rotation. The
 * merged list's tombstones exclude revoked links terminally, so a
 * Public→Private conversion never resurrects one. Best-effort: any failure is
 * swallowed by the caller (an unrefreshed link only delays a joiner's
 * catch-up, never breaks a rotation). Exported for tests.
 */
export async function refreshInviteBundlesFor(
  nostr: ReturnType<typeof useNostr>["nostr"],
  user: NUser,
  rotated: Pick<CommunityV2, "id" | "idHex" | "owner" | "ownerSalt" | "root" | "rootEpoch" | "controlPk" | "privateChannels" | "relays" | "name">,
  metadata: Pick<CommunityMetadata, "name" | "icon"> | undefined,
  // Fan-out override for a relay-list change: the refreshed bundle (which
  // VENDS `rotated.relays`) must also overwrite the copy on the OLD relays —
  // that's where existing links' fragment hints send fetchers.
  publishRelays?: string[],
): Promise<void> {
  if (!user.signer.nip44) return;
  const { list } = await fetchInviteList(nostr, user);
  const live = list.entries.filter((e) => e.community_id === rotated.idHex);
  if (live.length === 0) return;

  // A refresh vends exactly what the mint vends, and a link mints no Private
  // Channel keys at all: its audience is whoever the URL reaches (CORD-05 §2)
  // and holds no scoped Role, so it is entitled to none (CORD-03 §1).
  //
  // Carrying them here is worse than at mint time, because this runs right
  // after a rotation that CUT somebody. The cut is recorded at the excluding
  // epoch and the floor admits `epoch >= cut` so a genuine re-admission still
  // lands — but a refreshed bundle carries that same current key at that same
  // epoch, so the floor cannot tell the two apart, and the removed member
  // re-resolving their link undoes the rotation that removed them.
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
    creator_npub: user.pubkey,
  };

  const targets = publishRelays ?? rotated.relays;
  for (const bundleEvent of buildRefreshedBundleEvents(bundle, live)) {
    await Promise.allSettled(
      targets.map((url) => nostr.relay(url).event(bundleEvent, { signal: AbortSignal.timeout(8000) })),
    );
  }
}

/**
 * Watch the NEXT epoch's base-rekey address (CORD-06 §2) and react:
 *
 *   - a complete, authorized, continuity-checked rotation carrying MY blob →
 *     adopt the new root (retaining the prior for history) and record the
 *     refounder as the new epoch's snapshot authority;
 *   - a complete rotation with NO blob for me across ALL chunks, published
 *     at/after I joined → I've been excluded (kicked/banned): the membership is
 *     marked read-only at that epoch but STAYS on the rail. Only the user's own
 *     Leave or the owner's Dissolve ever removes an icon. A missing chunk is
 *     never an exclusion — the watcher just keeps refetching. Neither is a
 *     complete rotation that predates my join: it is community history I was
 *     never part of (a stale public invite drops me ONTO a past Refounding),
 *     so its lack of a blob for me means nothing.
 */
export function useRekeyWatch2(community: CommunityV2 | undefined): { stranded: boolean } {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold2(community);
  const { data: dissolved } = useDissolved2(community);
  const { mutateAsync: updateList } = useUpdateCommunityList2();
  const entry = useCommunityEntry2(community?.idHex);
  const queryClient = useQueryClient();
  // One adoption/removal per (community, epoch) per session — the list update
  // re-renders with the new epoch, which re-arms the watcher naturally.
  const handled = useRef(new Set<string>());
  // STRANDED: a fresh joiner sitting on an epoch the community has already
  // rotated past, whose rotation predates the join and carries no blob for them
  // — a stale public invite dropped them onto a superseded epoch. They can read
  // history but not the current epoch, and (unlike an adoption) have no forward
  // path from the wire: only a REFRESHED link or a Direct Invite heals them.
  // Surfaced so the UI can tell them the link is out of date (CORD-05 §2).
  const [stranded, setStranded] = useState(false);

  // A successful catch-up (useStrandedRecovery2 merging a refreshed bundle, or
  // any adoption) advances the held epoch — reset so the flag never outlives
  // the strand it described. The main effect re-derives it at the new epoch if
  // the member is somehow STILL behind (e.g. the refreshed bundle itself lags).
  const heldEpoch = community?.rootEpoch;
  const heldId = community?.idHex;
  useEffect(() => {
    setStranded(false);
  }, [heldId, heldEpoch]);

  const nextEpoch = community ? community.rootEpoch + 1n : 0n;
  const query = useQuery<OpenedEvent[]>({
    queryKey: ["concord2", "rekey", community?.idHex ?? null, nextEpoch.toString()],
    enabled: Boolean(community),
    staleTime: 30_000,
    // Rekeys are rare, admin-initiated rotations; this watcher only runs for the
    // open community (mounted on ConcordV2Page). Poll at a relaxed cadence and
    // never while the tab is hidden — per-relay cursors below mean a longer gap
    // only delays adoption, never skips a chunk (issue #19 family).
    refetchInterval: 2 * 60_000,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const address = baseRekeyGroupKey(community!.root, community!.id, nextEpoch);
      const base: { kinds: number[]; authors: string[]; limit: number } = {
        kinds: [KIND_WRAP],
        authors: [address.pk],
        limit: 50,
      };

      // PER-RELAY `since` cursors: each relay is re-asked from what IT has
      // delivered, so a fast relay can never advance a shared cursor past a
      // rekey chunk a lagging relay still owes us. A permanently-skipped chunk
      // would leave the rotation `!complete` forever — the member never adopts
      // the new epoch and every message under it stays undecryptable
      // (issue #19 family).
      const results = await Promise.all(
        community!.relays.map(async (url) => {
          const scope = `rekey:${community!.idHex}:${nextEpoch}|${url}`;
          const cursor = await readStreamCursor(scope);
          const filter = cursor?.newest ? { ...base, since: cursor.newest } : base;
          try {
            const events = await nostr
              .relay(url)
              .query([filter], { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
            if (events.length > 0) {
              await updateStreamCursor(scope, {
                newest: Math.max(...events.map((e) => e.created_at)),
              });
            }
            return events;
          } catch {
            // Failed/aborted — the cursor stays put; the next poll re-asks.
            return [] as NostrEvent[];
          }
        }),
      );
      // Decrypt the stream layer once (the inner blob stays pairwise-encrypted);
      // persist the opened events so a seen rekey round is never refetched.
      const fresh: OpenedWireEvent[] = [];
      for (const wrap of results.flat()) {
        try {
          fresh.push(openWrap(wrap, address));
        } catch {
          // not this address / malformed
        }
      }
      if (fresh.length > 0) writeOpened(community!.idHex, fresh, "rekey");
      // The stored rounds for this rotation, named the way the ROUND names
      // itself (`scope` + `newepoch`) rather than by the address it arrived
      // at — which is `f(root, scope, epoch)` and so had to be stored to be
      // matched. Both identify the same rounds; only one costs a stored field.
      const stored = await queryRekeyRounds(community!.idHex, [
        { scopeIdHex: bytesToHex(community!.id), newEpoch: nextEpoch },
      ]);
      const byId = new Map<string, OpenedEvent>();
      for (const e of stored) byId.set(e.rumorId, e);
      for (const e of fresh) byId.set(e.rumorId, e);
      return [...byId.values()];
    },
  });

  useEffect(() => {
    if (!community || !user || !folded || !query.data || query.data.length === 0) return;
    // Without my own list entry we don't know when I joined, and the removal
    // decision compares each rotation's publish time against that join time —
    // so wait for it rather than risk a stale-epoch false removal.
    if (!entry) return;
    // Death wins every race (CORD-02 §9): a Refounding never crosses the
    // owner's tombstone — no epoch advance past it is honored.
    if (dissolved) return;
    const key = `${community.idHex}:${nextEpoch}`;
    if (handled.current.has(key)) return;
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

      // Authorized rotators only: a removed member still holding the prior
      // root can CONSTRUCT a perfect rotation; authority is the roster, never
      // key possession (CORD-06). A banned rotator is dropped outright —
      // every event from a banned npub is, authority actions included
      // (CORD-04 §4).
      const rotations = groupRotations(parsed).filter(
        (set) =>
          set.scopeIdHex === "0".repeat(64) &&
          !folded.banned.has(set.rotator) &&
          (set.rotator === folded.ownerHex || hasPermission(folded.roster, set.rotator, Permissions.BAN)) &&
          // CORD-04 §5 / CORD-06 §Authority: a rotation cites the Grant it acts
          // under, so a lagging client never honors a just-demoted admin's
          // Refounding — the whole community's keys turn on this one.
          citationSatisfied(folded, community.id, set.rotator, set.authority) &&
          checkContinuity(set, community.rootEpoch, community.root).ok,
      );
      if (rotations.length === 0) return;

      // My join time (wall-clock ms). A rotation that entirely predates it
      // happened before I was a member, so its lack of a blob for me is NOT an
      // exclusion — see the removal guard below.
      const joinedAt = entry?.added_at ?? 0;

      // Try to adopt: my blob, decrypted under the rotator↔me pairwise key.
      // `publishedAtMs` is the adopted rotation's publish time — recorded on
      // the superseded root as its hard read cutoff (`retiredAt`).
      // `controlPk`/`controlRoot` are the next epoch's Control Plane pair
      // riding the blob (CORD-06 §1): the pk in every 104/136-byte blob, the
      // secret only in a staff recipient's 136. A legacy 72-byte blob carries
      // neither — that epoch's Control folds at the legacy address.
      let adopted:
        | { key: Uint8Array; rotator: string; publishedAtMs: number; controlPk?: string; controlRoot?: Uint8Array }
        | undefined;
      // A complete rotation counts toward removal only if it could have carried
      // a blob for me — i.e. it was published at/after I joined.
      let sawExcludingRotation = false;
      // A complete rotation PAST my epoch that predates my join and holds no
      // blob for me: I was dropped onto a superseded epoch by a stale invite.
      let sawStrandingRotation = false;
      for (const set of rotations) {
        if (!set.complete) continue;
        // A member who joined via a stale public invite (bundle epoch N) lands
        // ON a historical `N→N+1` Refounding they were never part of; it carries
        // no blob at their locator, but it predates their join, so it must not be
        // read as a removal (else the rail icon vanishes seconds after every
        // join/rejoin while the community stays fully interactable — exposing it
        // as a liveness-only bug). Only a rotation at/after the join can exclude.
        // A rotation is my removal only if it could have carried my blob AND
        // its Rotator strictly outranks me — CORD-06 §Authority: "the Rotator
        // must strictly outrank every removed target". The other targets'
        // locators are opaque to me; my own removal is the one I can judge.
        const postDatesMyJoin = rotationExcludesMe(rotationPublishedAtMs(set), joinedAt);
        const couldExcludeMe =
          postDatesMyJoin && outranksMember(folded.roster, set.rotator, folded.ownerHex, user.pubkey);
        const locator = myLocator(set.rotator, user.pubkey, set.scopeIdHex, set.newEpoch);
        const blob = findBlob(set, locator);
        if (!blob) {
          if (couldExcludeMe) sawExcludingRotation = true;
          // Predates my join AND advances past the epoch I hold → I'm stranded
          // on a stale invite's dead epoch, with no wire path forward.
          //
          // Tested on the JOIN TIME, not on `!couldExcludeMe`: a rotation from
          // a rotator who does not outrank me is not my removal AND not my
          // strand — it is simply not about me, and both flags must stay off.
          // Negating the conjunction would route every peer-rank rotation here
          // (this watcher only ever queries `rootEpoch + 1`, so the epoch test
          // is always true) and tell the user their invite link is stale.
          else if (!postDatesMyJoin && set.newEpoch > community.rootEpoch) sawStrandingRotation = true;
          continue;
        }
        try {
          const plainB64 = await nip44.decrypt(set.rotator, blob.wrapped);
          const wrapped = decodeWrappedBaseKey(base64ToBytes(plainB64), community.id, set.newEpoch);
          // Racing rotations converge on the lexicographically lowest new BASE
          // key; the control pair rides the winner's blobs, never compared
          // (CORD-06 §3).
          if (!adopted || lowerKeyWins(adopted.key, wrapped.newRoot) === wrapped.newRoot) {
            adopted = {
              key: wrapped.newRoot,
              rotator: set.rotator,
              publishedAtMs: rotationPublishedAtMs(set),
              ...(wrapped.controlPk ? { controlPk: wrapped.controlPk } : {}),
              ...(wrapped.controlRoot ? { controlRoot: wrapped.controlRoot } : {}),
            };
          }
        } catch {
          // undecryptable blob at my locator — treat as absent
          if (couldExcludeMe) sawExcludingRotation = true;
        }
      }
      if (cancelled) return;

      if (adopted) {
        handled.current.add(key);
        setStranded(false);
        // The root this rotation steps off is RETIRED at the rotation's own
        // publish time: that timestamp is the hard cutoff past which nothing
        // sealed under it is ever read again (see `HeldRoot.retiredAt`).
        const retiredAt = Math.floor(adopted.publishedAtMs / 1000);
        const heldRoots: HeldRoot[] = [
          // The rotator is this epoch's snapshot authority (CORD-02 §5),
          // recorded per root so it survives later rotations.
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
        // The control pair is the BLOB's, never inherited: the secret rolls
        // with the root at every Refounding (CORD-02 §2), so a stale pair
        // carried forward would sign (or subscribe) at a dead address. A
        // member blob leaves `controlRoot` unset — staff-only material — and a
        // legacy 72-byte blob leaves both unset (legacy epoch).
        const rotated: CommunityV2 = {
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
        queryClient.invalidateQueries({ queryKey: ["concord2", "list"] });
        // Any links I minted must also vend the fresh epoch (CORD-05 §2), and
        // only I hold their signer_sk — the Refounder can refresh only their
        // own. Best-effort, fire-and-forget: a no-op for the linkless majority.
        refreshInviteBundlesFor(nostr, user, rotated, folded.metadata).catch(() => undefined);
        return;
      }

      // Every chunk of at least one complete rotation held, none carries my
      // locator, AND that rotation was published at/after I joined → I've been
      // excluded (kicked/banned). Being excluded is NOT leaving: mark the entry
      // read-only at this epoch but KEEP it on the rail. It disappears only if
      // the user chooses to leave or the owner dissolves. A later Refounding
      // that re-includes me (adoption above) clears the marker. A rotation that
      // entirely predates my join is community history, not an exclusion.
      if (sawExcludingRotation) {
        handled.current.add(key);
        await updateList({
          type: "exclude",
          communityId: community.idHex,
          epoch: Number(nextEpoch),
        }).catch(() => handled.current.delete(key));
        queryClient.invalidateQueries({ queryKey: ["concord2", "list"] });
      }

      // A complete rotation that PREDATES my join and carries no blob for me
      // is community history I was never part of (a stale public invite
      // dropped me onto a past Refounding): neither an adoption nor an
      // exclusion. There is no forward path on the wire — the rekey for the
      // epoch I hold was minted before my pubkey existed, so it can't carry my
      // blob. The recovery is a REFRESHED link (CORD-05 §2) or a Direct Invite
      // from an online member; surface `stranded` so the UI can say so instead
      // of silently leaving them unable to read the current epoch.
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
 * §2: "the creator re-posting under it refreshes the bundle … so a link shared
 * once survives every rotation").
 *
 * The gap this closes: a link's bundle only ever advanced when the creator's
 * client happened to (a) be the Refounder, or (b) adopt someone else's rotation
 * via {@link useRekeyWatch2}. A creator who rotated on another device, or whose
 * community was Refounded by a different admin while they were offline, left
 * their links vending the DEAD pre-rotation epoch indefinitely — stranding
 * every fresh joiner on a superseded epoch with no wire path forward. Only the
 * creator holds each link's `signer_sk`, so no one else can heal it.
 *
 * On every open of a community the creator holds live links for, reconcile:
 * re-mint every live link at the current epoch. `refreshInviteBundlesFor` is
 * idempotent (re-posting an already-fresh bundle is a harmless same-epoch
 * rewrite), and this runs at most once per (community, epoch) per session, so a
 * fresh community costs one Invite-List fetch and nothing more.
 */
export function useLinkRefreshWatch2(community: CommunityV2 | undefined): void {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold2(community);
  // At most one refresh per (community, epoch, relay set) per session — a later
  // adoption re-renders with a higher epoch, and a relay-list change (followed
  // via useRelayFollow2) changes the set, either of which re-arms this
  // naturally. Relays are in the key because the bundle VENDS them: a link
  // fetched after a relay move must hand joiners the new set.
  const refreshed = useRef(new Set<string>());

  useEffect(() => {
    if (!community || !user?.signer.nip44 || !folded) return;
    // Only an authorized creator may re-post bundles: a stripped creator's
    // refresh would resurrect a link the authority watcher is retiring (the
    // registry already ignores them, but the bundle coordinate is theirs
    // alone). Skipping on a partial fold is safe — a refresh is never owed.
    if (user.pubkey !== folded.ownerHex && !hasPermission(folded.roster, user.pubkey, Permissions.CREATE_INVITE)) return;
    const key = `${community.idHex}:${community.rootEpoch}:${community.relays.join(",")}`;
    if (refreshed.current.has(key)) return;

    let cancelled = false;
    void (async () => {
      // Do I hold any live links for THIS community? (fetchInviteList already
      // drops tombstoned/revoked entries.) If not, there is nothing to refresh.
      let hasLinks = false;
      try {
        const { list } = await fetchInviteList(nostr, user);
        hasLinks = list.entries.some((e) => e.community_id === community.idHex);
      } catch {
        // Transient fetch failure — leave the key unmarked so a later open (or
        // the useRekeyWatch2/refound refresh paths) retries.
        return;
      }
      if (cancelled || !hasLinks) return;
      // Mark BEFORE the refresh so a re-render mid-flight doesn't double-fire;
      // a genuine failure re-arms via the epoch changing or an app restart.
      refreshed.current.add(key);
      // Idempotent and best-effort: an unrefreshed link only delays a joiner's
      // catch-up, and useRekeyWatch2 / useRefound2 also drive this on their own
      // triggers. Mints from the current community snapshot (the open community
      // is already on its adopted epoch).
      await refreshInviteBundlesFor(nostr, user, community, folded.metadata).catch(() => {
        // Persistent failure: unmark so the next open retries.
        refreshed.current.delete(key);
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.idHex, community?.rootEpoch, community?.relays.join(","), user?.pubkey, folded]);
}

/**
 * Watch each held Private Channel's NEXT-epoch rekey address (CORD-06 §2:
 * "per PRIVATE Channel you hold; the NEXT channel-epoch's rekey address") and
 * react per channel, mirroring {@link useRekeyWatch2}'s base logic:
 *
 *   - a complete, authorized, continuity-checked rotation carrying MY blob →
 *     adopt the channel's new key/epoch (scope-bound inside the ciphertext,
 *     so a blob minted for one channel can never splice into another);
 *   - a complete rotation with NO blob for me, published at/after I joined →
 *     I've been removed from the channel: it is dropped from `current` so it
 *     visibly disappears (§2 "the client then either visibly removes them or
 *     switches to the new keys"); the original key survives in `seed`.
 *
 * Addresses derive from the community_root, and a Refounding seals its
 * channel rekeys under the PRIOR root (§3) — so a member who adopted the base
 * rotation first would derive the wrong address from their fresh root alone.
 * Every held root is therefore watched, and adoption chains: each adopted
 * channel epoch re-keys the query at `epoch + 2`, walking forward across any
 * number of missed rotations.
 *
 * Authority follows CORD-06: a single-channel Rekey requires MANAGE_CHANNELS,
 * a Refounding's channel rotations act under BAN, and the owner outranks all —
 * any of the three is honored; a banned rotator never is.
 */
export function useChannelRekeyWatch2(community: CommunityV2 | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold2(community);
  const { data: dissolved } = useDissolved2(community);
  const { mutateAsync: updateList } = useUpdateCommunityList2();
  const entry = useCommunityEntry2(community?.idHex);
  const queryClient = useQueryClient();
  const handled = useRef(new Set<string>());

  // The watched (channel, next-epoch) set — the query re-keys when an adoption
  // moves any channel forward, chaining across missed rotations.
  const watchKey = (community?.privateChannels ?? [])
    .map((ch) => `${bytesToHex(ch.id)}:${(ch.epoch + 1n).toString()}`)
    .sort()
    .join(",");

  const query = useQuery<OpenedEvent[]>({
    queryKey: ["concord2", "chrekey", community?.idHex ?? null, watchKey],
    enabled: Boolean(community && community.privateChannels.length > 0),
    staleTime: 15_000,
    // A rotation is how a member learns they were cut from (or re-keyed into)
    // a channel — a 2-minute lag reads as "revoking did nothing" to the
    // moderator watching the other screen. The REQ is cheap (author-filtered,
    // per-relay since-cursor), so poll at 45s while visible.
    refetchInterval: 45_000,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      // Per held channel, the next channel-epoch's address under EVERY held
      // root: a refound-driven channel rekey is sealed under the root that was
      // current when it was minted (the then-prior root, §3), which a member
      // catching up may have already rotated past.
      const roots = community!.heldRoots.length > 0 ? community!.heldRoots : [{ epoch: community!.rootEpoch, key: community!.root }];
      const byPk = new Map<string, ReturnType<typeof channelRekeyGroupKey>>();
      for (const ch of community!.privateChannels) {
        for (const r of roots) {
          // A WINDOW of epochs, not just the next one: a member who missed a
          // rotation must still be able to catch up (or learn they're out).
          for (let ahead = 1n; ahead <= BigInt(CHANNEL_REKEY_LOOKAHEAD); ahead++) {
            const address = channelRekeyGroupKey(r.key, ch.id, ch.epoch + ahead);
            byPk.set(address.pk, address);
          }
        }
      }
      const authors = [...byPk.keys()];
      const base: { kinds: number[]; authors: string[]; limit: number } = {
        kinds: [KIND_WRAP],
        authors,
        limit: 50,
      };

      // PER-RELAY `since` cursors, exactly as the base watcher (issue #19
      // family): a fast relay must never advance a cursor past a chunk a
      // lagging relay still owes us.
      const results = await Promise.all(
        community!.relays.map(async (url) => {
          const scope = `chrekey:${community!.idHex}:${watchKey}|${url}`;
          const cursor = await readStreamCursor(scope);
          const filter = cursor?.newest ? { ...base, since: cursor.newest } : base;
          try {
            const events = await nostr
              .relay(url)
              .query([filter], { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
            if (events.length > 0) {
              await updateStreamCursor(scope, { newest: Math.max(...events.map((e) => e.created_at)) });
            }
            return events;
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
      // Per watched (channel, epoch) across the SAME window the REQ above
      // covers. Reading back only `held + 1` would make the window a
      // single-poll affair: the wire hands a rotation over once, `since`
      // advances past it, and the walk it was meant to complete then sees a
      // chain truncated at the first link on every later poll and every
      // restart — which is precisely the stranded member the window exists
      // for. The held-root dimension that multiplies the ADDRESSES collapses
      // here, because a round's rumor names its scope and epoch but not the
      // root it was sealed under.
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

      // Walk each held channel independently; accumulate one channels update.
      let nextChannels = heldChannelKeys(entry.current.channels).map((c) => ({ ...c }));
      const cuts: Array<{ id: string; epoch: number }> = [];
      // What this pass claimed as handled, so a failed write can release it —
      // the guard exists to stop the same list update being re-issued while it
      // is in flight, not to retire a rotation that never landed anywhere.
      const marked: string[] = [];
      // Every exit that does NOT write must release what it claimed. The
      // handles are claimed inside the per-channel loop, but the loop awaits
      // (decrypt, store reads) and the effect's deps change identity on every
      // refetch, so a cancellation mid-walk is routine. A handle left claimed
      // is never re-armed: `watchKey` still names the epoch the channel is
      // stuck at, so every later pass re-derives the same handle and
      // `continue`s past it, and the channel sits on a dead key until restart.
      const releaseClaims = () => {
        for (const handle of marked) handled.current.delete(handle);
      };
      let changed = false;

      for (const ch of community.privateChannels) {
        const chIdHex = bytesToHex(ch.id);

        // Authorized rotators only (CORD-06): MANAGE_CHANNELS mints a
        // single-channel Rekey, BAN mints a Refounding's channel rotations,
        // the owner outranks all. Key possession is never authority.
        //
        // EVERY rotation past my epoch counts, not just `held + 1`: if I
        // missed one, the channel moved on without me and that next-epoch
        // address will never carry anything again — leaving me holding a key
        // that decrypts nothing, with the channel still in my sidebar and no
        // way to learn I was removed. Continuity is deliberately NOT filtered
        // here — it gates ADOPTION epoch by epoch as the chain is walked below.
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

        // The de-dupe key names the epoch the walk actually LANDS on, so it is
        // computed after the walk, not from the window's ceiling. Keying it on
        // the highest rotation in sight would retire a walk that only got part
        // way: a chain that stalled at a gap would be skipped from the next
        // poll onward, and the missing link it is waiting for could never be
        // picked up when it finally arrives.
        const keyFor = (epoch: bigint) => `${community.idHex}:${chIdHex}:${epoch}`;

        // Walk the rotations epoch by epoch, ascending, carrying the key each
        // step leaves me holding.
        //
        // ADOPTION requires an unbroken chain from the key I already have.
        // CORD-06 §2 makes `prevcommit` the proof that a rotation extends MY
        // key, and answers a gap by fetching the missing link (which the
        // lookahead window has already tried) — never by waiving the check.
        // Waiving it lets one authorized rotator fork a lagging member onto a
        // branch neither of them can detect, which is exactly what the
        // commitment exists to prevent.
        //
        // REMOVAL is judged separately and needs no chain: hiding a channel is
        // local, and errs in the safe direction. So a member whose gap can no
        // longer be fetched still learns the room moved on without them,
        // rather than sitting forever on a key that decrypts nothing — the
        // stranding this watcher's epoch window was widened to fix.
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
        // Every key the walk steps OFF, newest first. Catching up across a gap
        // opens each intermediate epoch's key on the way past, and each one
        // reads the history written under it — so they are retained as priors
        // rather than thrown away with the step (CORD-03 §3). Each carries the
        // superseding rotation's publish time as its hard read cutoff.
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
            // Only a rotation off the key I actually hold can hand me the next
            // one; a fork, or a gap I could not fetch, is not mine to adopt.
            if (!checkContinuity(set, chainEpoch, chainKey).ok) continue;
            try {
              const plainB64 = await nip44.decrypt(set.rotator, blob.wrapped);
              // Scope binds INSIDE the ciphertext: a blob minted for another
              // channel (or the base) can never be spliced onto this one.
              const newKey = decodeWrappedKey(base64ToBytes(plainB64), ch.id, epoch);
              // Two rotators racing to one epoch converge on the lower key.
              keyHere = keyHere ? lowerKeyWins(keyHere, newKey) : newKey;
              // Retirement is the EARLIEST honored rotation at this epoch —
              // the moment the channel verifiably moved on.
              const at = rotationPublishedAtMs(set);
              publishedHereMs = publishedHereMs === undefined ? at : Math.min(publishedHereMs, at);
            } catch {
              // Undecryptable at my locator — not a key I can carry forward.
            }
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
          // Addressed to me, but not off a key I can verify: neither adopt nor
          // remove. The window keeps polling, so if the missing link shows up
          // the chain completes; acting either way on an unproven rotation is
          // how a member ends up on a fork or loses a room they still hold.
          if (addressedHere) continue;
          // Nothing here for me at all. If a rotation at this epoch could have
          // carried my blob and did not, that is the read-cut (CORD-06 §2) —
          // but only from a rotator who STRICTLY OUTRANKS me. CORD-06
          // §Authority: "the Rotator must strictly outrank every removed
          // target"; a receiver cannot see who else a rotation kept or cut
          // (locators are opaque), but its own removal it can always judge.
          // A peer's rotation is no more my removal than a forged one.
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

        // A key addressed to me ABOVE the newest rotation that skipped me is a
        // re-admission; below it, the exclusion is the later word.
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
                  // Retain every key the walk stepped off — the one I held
                  // plus each intermediate epoch a catch-up passed through.
                  // Each reads what was written under it (CORD.md history
                  // rule), so dropping them would trade a rotation for a hole
                  // in the conversation.
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
          // Removed from this channel: drop it so it visibly disappears
          // (CORD-06 §2). `seed` retains the original key; only `current`
          // forgets it. The cut is RECORDED at the epoch that excluded me, so
          // a stale invite bundle carrying the pre-rotation key can never
          // merge the access back (see `channel_cuts`).
          const handle = keyFor(excludedAt);
          if (handled.current.has(handle)) continue;
          handled.current.add(handle);
          marked.push(handle);
          nextChannels = nextChannels.filter((c) => c.id.toLowerCase() !== chIdHex);
          cuts.push({ id: chIdHex, epoch: Number(excludedAt) });
          changed = true;
        }
      }

      // Nothing is going to be written, so release every claim this pass made
      // — including on the CANCELLED path. The handles are claimed inside the
      // per-channel loop, but the loop awaits (decrypt, store reads), and the
      // effect's deps change identity on every refetch, so cancellation
      // mid-walk is routine. A handle left claimed here is never re-armed:
      // `watchKey` still names the epoch the channel is stuck at, so every
      // later pass re-derives the same handle and `continue`s past it, and the
      // channel sits on a dead key until the app restarts.
      if (!changed || cancelled) return releaseClaims();
      await updateList({
        type: "refresh-channels",
        communityId: community.idHex,
        channels: nextChannels,
        ...(cuts.length > 0 ? { cuts } : {}),
      }).catch(() => {
        // The adoption/removal never reached the list, so un-claim it and let
        // the next poll try again (the base watcher does the same). Leaving it
        // claimed would retire a rotation this client only ever held in a
        // local variable.
        releaseClaims();
      });
      queryClient.invalidateQueries({ queryKey: ["concord2", "list"] });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.idHex, watchKey, user?.pubkey, folded, dissolved, query.data, entry?.added_at]);
}

/**
 * A Refounding (CORD-06 §3): roll the community_root to sever the excluded,
 * re-anchor the Control Plane by compaction, and seed the new Guestbook.
 * Requires BAN (or ownership) and a NIP-44 signer — pairwise blob wrapping is
 * one ECDH either side can compute, so bunkers rotate too.
 */
/**
 * Rotate ONE held Private Channel's key (CORD-06 §3 channel rotation, without
 * a Refounding): mint the next channel epoch, deliver it to exactly
 * `keepRecipients` (+ the rotator), and adopt it locally. Members not handed
 * a blob see the complete rotation as their removal (useChannelRekeyWatch2)
 * and the channel disappears from their view — the read-cut behind revoking a
 * role-gated channel's entitlement (channelAccess.ts). Requires MANAGE_CHANNELS
 * (or ownership): a verifier honors a single-channel rekey under exactly that
 * authority, so publishing without it would be dropped network-wide.
 */
export function useChannelRekey2(community: CommunityV2 | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold2(community);
  const { data: dissolved } = useDissolved2(community);
  const { mutateAsync: updateList } = useUpdateCommunityList2();
  const queryClient = useQueryClient();

  const rekeyChannel = useMutation<
    void,
    Error,
    {
      channelIdHex: string;
      keepRecipients: string[];
      /**
       * Who this rotation CUTS. Required, not derived from `keepRecipients`,
       * because CORD-06 §Authority binds the rotator's rank to the removed
       * set and only the caller knows the membership it filtered.
       */
      removedTargets: string[];
    }
  >({
    scope: { id: `concord2-chrekey:${community?.idHex}` },
    mutationFn: async ({ channelIdHex, keepRecipients, removedTargets }) => {
      if (!user || !community) throw new Error("Not ready.");
      if (dissolved) throw new Error("This community was dissolved.");
      const nip44 = user.signer.nip44;
      if (!nip44) throw new Error("This signer can't rotate keys (NIP-44 unsupported).");
      const ch = community.privateChannels.find((c) => bytesToHex(c.id) === channelIdHex);
      if (!ch) throw new Error("You don't hold this channel's key.");
      const ownerHex = folded?.ownerHex ?? community.owner;
      if (user.pubkey !== ownerHex && !(folded && hasPermission(folded.roster, user.pubkey, Permissions.MANAGE_CHANNELS))) {
        throw new Error("Rotating a channel key needs the Manage-channels permission.");
      }
      // CORD-06 §Authority: holding MANAGE_CHANNELS is only half — "the
      // Rotator must strictly outrank every removed target". Checked before
      // publishing, because every receiver checks it too: a peer's rotation
      // is refused as a removal by its target, who then sits holding a key
      // that decrypts nothing while this client reports the cut succeeded.
      if (user.pubkey !== ownerHex) {
        const unrankable = removedTargets.filter(
          (pk) => pk !== user.pubkey && !(folded && outranksMember(folded.roster, user.pubkey, ownerHex, pk)),
        );
        if (unrankable.length > 0) {
          throw new Error(
            unrankable.length === 1
              ? "You don't outrank one of the members this would cut, so they would ignore the rotation."
              : `You don't outrank ${unrankable.length} of the members this would cut, so they would ignore the rotation.`,
          );
        }
      }

      const chEpoch = ch.epoch + 1n;
      const chPrevCommit = bytesToHex(epochKeyCommitment(ch.epoch, ch.key));
      const chKey = await mintOrReuseRotationKey(
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
      // The rotation's publish time doubles as the severed key's hard read
      // cutoff (`retiredAt`) — the same value every adopter derives from the
      // rumors' own timestamps.
      const rotatedAtMs = Date.now();
      const chRumors = buildRekeyRumors(
        user.pubkey,
        { scope: { kind: "channel", channelId: ch.id }, newEpoch: chEpoch, prevEpoch: ch.epoch, prevCommit: chPrevCommit },
        chBlobs,
        rotatedAtMs,
        // A rotation is an authority action, so it cites the Grant it acts
        // under (CORD-06 §Authority / CORD-04 §5). Without it every receiver's
        // `citationSatisfied` fails closed for a non-owner rotator: the
        // rotation is dropped network-wide, so nobody adopts the new key and
        // the member being revoked is never actually cut.
        citationFor(community, folded, user.pubkey),
      );
      for (const rumor of chRumors) {
        const wrap = wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, chAddress, user.signer), chAddress);
        const results = await Promise.allSettled(
          community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
        );
        if (!results.some((r) => r.status === "fulfilled")) {
          throw new Error(`No relay accepted the #${ch.name} channel key rotation.`);
        }
      }

      // Adopt my own rotation immediately (the watcher would also pick it up,
      // but the rotator must never keep writing under the severed key).
      const rotated = community.privateChannels.map((c) =>
        bytesToHex(c.id) === channelIdHex
          ? {
              ...c,
              key: chKey,
              epoch: chEpoch,
              priors: [
                { key: c.key, epoch: c.epoch, retiredAt: Math.floor(rotatedAtMs / 1000) },
                ...(c.priors ?? []),
              ],
            }
          : c,
      );
      await updateList({
        type: "refresh-channels",
        communityId: community.idHex,
        channels: channelKeysToWire(rotated),
      });
      queryClient.invalidateQueries({ queryKey: ["concord2", "list"] });

      // Any link I minted still vends the key this rotation just retired, so a
      // joiner would land on a dead epoch and then read the blobless rotation
      // as their own removal. Re-mint at the fresh keys, exactly as a
      // Refounding does (CORD-05 §2) — only I hold these links' `signer_sk`.
      // Best-effort: the rotation itself has already landed, and
      // `useLinkRefreshWatch2` retries.
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
  };
}

export function useRefound2(community: CommunityV2 | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const control = useControlFold2(community);
  const { data: dissolved } = useDissolved2(community);
  const { mutateAsync: updateList } = useUpdateCommunityList2();
  const entry = useCommunityEntry2(community?.idHex);
  const queryClient = useQueryClient();

  const refound = useMutation<void, Error, { keep: string[]; exclude: string[] }>({
    // A rotation is community-global: serialize every refound for this
    // community (a user-initiated ban racing the durable retry must queue,
    // not mint sibling epochs), and give the key a name the retry hook can
    // watch via useIsMutating.
    mutationKey: ["concord2-refound", community?.idHex],
    scope: { id: `concord2-refound:${community?.idHex}` },
    mutationFn: async ({ keep, exclude }) => {
      if (!user || !community) throw new Error("Not ready.");
      if (dissolved) throw new Error("This community was dissolved; no epoch advance past the tombstone is honored.");
      const nip44 = user.signer.nip44;
      if (!nip44) throw new Error("This signer can't rotate keys (NIP-44 unsupported).");
      const rendered = control.data;
      if (!rendered || control.isLoading || control.isFetching) {
        throw new Error("Still syncing the community's control plane; try again shortly.");
      }

      // Fold-all-or-abort (CORD-06 §3): the Refounder must compact a COMPLETE
      // picture — one forced whole-plane sweep, then a verification fold
      // floored at every head this client has accepted. An entity the relays
      // no longer serve (or serve gapped) ABORTS the Refounding; otherwise it
      // would be silently dropped from, or compacted stale into, the new epoch
      // — for every member, forever.
      // Tallied from THIS sweep's own callbacks, not the shared verdict map:
      // a background sweep of another relay can invalidate an entry in the gap
      // between our sweep resolving and us reading it, aborting a rotation for
      // no reason during exactly the raid it is needed for.
      let reached = 0;
      let short = false;
      try {
        // Exhaustive: a rotation may only compact a plane it has read WHOLE,
        // and plane depth is attacker-controlled. Capping here would let any
        // member hold rotation hostage by flooding past the event budget.
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
        throw new Error("Couldn't re-fetch the community's control plane; check your connection and try again.");
      }
      // A MAJORITY of relays must have answered. Not "must have been
      // exhausted" — no client can establish that — but compaction rewrites
      // the whole community, so reading too few sources drops state for
      // everyone. Majority rather than all: relays die, and demanding every
      // one would let a stale list entry block rotation forever.
      const total = community.relays.length;
      if (reached < Math.floor(total / 2) + 1) {
        throw new Error(
          `Only ${reached} of this community's ${total} relays responded; rotation aborted so nothing is lost. Try again, or remove relays that are no longer running.`,
        );
      }
      // An exhaustive read has no budget, so this can only mean the plane is
      // being stuffed at one timestamp — the one shape of flood a cursor
      // cannot page through. Compaction would erase whatever is behind it.
      if (short) {
        throw new Error("This community's history is being flooded and couldn't be read in full; rotation aborted so nothing is lost.");
      }
      const stored = await queryPlane(community.idHex, "control");
      const verifySnap =
        community.rootEpoch > 0n
          ? await readControlSnapshot(community.idHex, currentControlGroup(community).pk)
          : undefined;
      const folded = foldControlState(openControlEditions(stored), community.id, community.owner, rendered.heads, verifySnap);
      if (folded.incomplete.length > 0) {
        throw new Error("Part of the community's state isn't reachable right now; rotation aborted so nothing is lost.");
      }

      const authorized = user.pubkey === folded.ownerHex || hasPermission(folded.roster, user.pubkey, Permissions.BAN);
      if (!authorized) throw new Error("You don't have permission to rotate this community's keys.");
      // CORD-06 §Authority, the other half: BAN alone does not authorize a
      // Refounding — "the Rotator must strictly outrank every removed
      // target". Judged against the freshly-folded roster above, so a
      // just-landed promotion of the target counts.
      if (user.pubkey !== folded.ownerHex) {
        const unrankable = exclude.filter(
          (pk) => pk !== user.pubkey && !outranksMember(folded.roster, user.pubkey, folded.ownerHex, pk),
        );
        if (unrankable.length > 0) {
          throw new Error(
            "You don't outrank every member this would remove, so they would ignore the rotation.",
          );
        }
      }

      // Freshness guard: if the list entry has advanced past the epoch this
      // call captured (a prior rotation landed first), abort rather than mint a
      // sibling epoch off a stale root — the caller re-issues from the current
      // community. Serialization makes this the only residual concurrent case.
      if (entry && BigInt(entry.current.root_epoch) !== community.rootEpoch) {
        throw new Error("The community rotated since this action began; reopen it and try again.");
      }

      const excluded = new Set(exclude);
      const recipients = [...new Set([user.pubkey, ...keep])].filter((pk) => !excluded.has(pk));

      const newEpoch = community.rootEpoch + 1n;
      const prevCommit = bytesToHex(epochKeyCommitment(community.rootEpoch, community.root));
      // Reserved, not freshly minted: a rotation retried after a relay refusal
      // must carry the SAME keys, or the two attempts merge into one rotation
      // set and split the community across two roots at one epoch. The
      // control_root is reserved under the same inputs — the pair rides the
      // same blobs, so a retry must re-deliver the identical pair.
      const newRoot = await mintOrReuseRotationKey(community.idHex, { kind: "root" }, newEpoch, prevCommit);
      // Every compliant base rotation mints the split (CORD-06 §3) — a legacy
      // community upgrades as a side effect of this Refounding.
      const newControlRoot = await mintOrReuseControlRoot(community.idHex, newEpoch, prevCommit);
      const newControlPk = controlSignerGroupKey(newControlRoot, community.id, newEpoch).pk;

      // Acquire everything BEFORE the first publish (resumable, never half-lost).
      // Every member's blob carries the new control_pk (104 bytes); a staff
      // recipient's (CORD-04 §3) appends the secret itself (136 bytes).
      const memberPlain = bytesToBase64(
        encodeWrappedBaseKey(newEpoch, newRoot, hexToBytes(newControlPk)),
      );
      const staffPlain = bytesToBase64(
        encodeWrappedBaseKey(newEpoch, newRoot, hexToBytes(newControlPk), newControlRoot),
      );
      const blobs: RekeyBlob[] = [];
      for (const pk of recipients) {
        const staff = pk === user.pubkey ? true : isStaff(folded.roster, pk, folded.ownerHex);
        const wrapped = await nip44.encrypt(pk, staff ? staffPlain : memberPlain);
        blobs.push({ locator: myLocator(user.pubkey, pk, "0".repeat(64), newEpoch), wrapped });
      }

      // 1. The root roll: rekey blobs at the base address under the PRIOR root.
      // CORD-06 §3 orders this FIRST and republishes the compaction "only after
      // confirmed publication of the root roll". The gap it leaves is the one
      // the spec chose: existing members already hold the new root and keep
      // their old Control fold, so only a fresh joiner waits on the re-anchor.
      const address = baseRekeyGroupKey(community.root, community.id, newEpoch);
      // The roll's publish time is the retired root's hard read cutoff — the
      // same value every adopter derives from the rekey rumors' timestamps.
      const rotatedAtMs = Date.now();
      const rumors = buildRekeyRumors(
        user.pubkey,
        { scope: { kind: "root" }, newEpoch, prevEpoch: community.rootEpoch, prevCommit },
        blobs,
        rotatedAtMs,
        citationFor(community, folded, user.pubkey),
      );
      for (const rumor of rumors) {
        const wrap = wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, address, user.signer), address);
        const results = await Promise.allSettled(
          community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
        );
        if (!results.some((r) => r.status === "fulfilled")) {
          throw new Error("No relay accepted the key rotation.");
        }
      }

      // 1a. Record the epoch NOW, not at the end. The roll is the commit: every
      // keeper can already see and adopt it. Leaving the local entry behind
      // until the whole mutation finishes means a later step throwing (a
      // channel the relays refuse) leaves this client believing it is still at
      // the prior epoch — and the retry then rotates to the SAME (newEpoch,
      // prevCommit) with a different exclusion set. `groupRotations` correlates
      // rotations by exactly that tuple, so both attempts merge into one set
      // and the member this retry exists to remove finds their blob from
      // attempt one. Advancing here makes the retry a genuine next rotation.
      // Private channels stay as they are: they have not rotated yet, and
      // §3 addresses their rekeys under the PRIOR root, which is captured.
      const retiredPriorRoots: HeldRoot[] = community.heldRoots.map((r) =>
        r.epoch === community.rootEpoch && r.retiredAt === undefined
          ? { ...r, retiredAt: Math.floor(rotatedAtMs / 1000) }
          : r,
      );
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
              ...retiredPriorRoots,
            ],
            refounder: user.pubkey,
          },
          { prior: entry?.current, relays: entry?.current.relays },
        ),
      });

      // 2. Compaction, only after the roll published (CORD-06 §3): re-wrap
      // each entity's current head under the new epoch. Plaintext seals keep
      // the original signatures verifiable, so a fresh joiner can check them.
      //
      // Each head is ack-gated. Readers sweep the current epoch only, so a head
      // that never lands is gone for every later joiner, and the reserved root
      // means a resumed rotation re-publishes these same wraps rather than
      // orphaning them under a sibling key (§3 idempotency).
      // The new epoch's Control address is SPLIT (CORD-06 §3): the wrap signs
      // with the fresh control_root-derived signer and encrypts under the new
      // community_root-derived read key. A Rotator MUST NOT also mirror
      // editions to the legacy-derived address — that would re-open exactly
      // the member-writable surface the split closes.
      const newControlRead = controlGroupKey(newRoot, community.id, newEpoch);
      const newControl = {
        sk: controlSignerGroupKey(newControlRoot, community.id, newEpoch).sk,
        pk: newControlPk,
        get convKey() {
          return newControlRead.convKey;
        },
      };
      for (const head of folded.headEditions.values()) {
        // A head folded from the opened-event store carries no seal on the
        // event itself (the store keeps seals in KV, not in the rumor), so
        // fall back to a keyed read. A head we cannot re-wrap is a head that
        // vanishes from the new epoch, which §3's fold-all-or-abort forbids —
        // so a missing seal aborts rather than skipping the entity.
        const seal =
          head.opened.seal ?? (await readStoredSeal(community.idHex, head.opened.rumorId));
        if (!seal) {
          throw new Error("Missing the signed history needed to carry this community's state into the new epoch; nothing was lost, try again after a resync.");
        }
        let rewrapped: NostrEvent;
        try {
          rewrapped = rewrapSeal(seal, newControl);
        } catch {
          // An encrypted-seal head can't re-wrap; control heads are plaintext
          // by construction, so this is defensive only.
          continue;
        }
        const results = await Promise.allSettled(
          community.relays.map((url) => nostr.relay(url).event(rewrapped, { signal: AbortSignal.timeout(8000) })),
        );
        // Gate on an ack: a head that fails to land is not recoverable later,
        // so abort while the epoch is still unannounced.
        if (!results.some((r) => r.status === "fulfilled")) {
          throw new Error("No relay accepted the community's state during rotation; nothing was lost, try again.");
        }
      }

      // 2b. Rotate every held Private Channel (CORD-06 §3: "all Private
      // Channels relevant to the removed user(s) are rekeyed"). This client
      // grants every private channel to every member (the invite bundle
      // carries them all), so every held channel is relevant to any removed
      // member — rotate them all. Each channel is independently keyed
      // (CORD-03), so each gets its own fresh key delivered by a
      // channel-scoped rekey, sealed and addressed under the PRIOR
      // community_root — never the freshly minted one — so a base-race loser
      // can still open it (§3). Public channels rotate with the base for free.
      const rotatedChannels: PrivateChannelKey[] = [];
      for (const ch of community.privateChannels) {
        const chEpoch = ch.epoch + 1n;
        const chPrevCommit = bytesToHex(epochKeyCommitment(ch.epoch, ch.key));
        const chKey = await mintOrReuseRotationKey(
          community.idHex,
          { kind: "channel", channelId: ch.id },
          chEpoch,
          chPrevCommit,
        );
        const chIdHex = bytesToHex(ch.id);
        const chPlain = bytesToBase64(encodeWrappedKey(ch.id, chEpoch, chKey));
        const chBlobs: RekeyBlob[] = [];
        for (const pk of recipients) {
          chBlobs.push({ locator: myLocator(user.pubkey, pk, chIdHex, chEpoch), wrapped: await nip44.encrypt(pk, chPlain) });
        }
        const chAddress = channelRekeyGroupKey(community.root, ch.id, chEpoch);
        const chRotatedAtMs = Date.now();
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
          const wrap = wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, chAddress, user.signer), chAddress);
          const results = await Promise.allSettled(
            community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
          );
          if (!results.some((r) => r.status === "fulfilled")) {
            // Gating like the root roll: an unrotated channel leaves the
            // removed member reading it — the severance this Refounding
            // exists for. Resumable (CORD-06 §3), not atomic.
            throw new Error(`No relay accepted the #${ch.name} channel key rotation.`);
          }
        }
        // The key this rotation steps off still reads everything written under
        // it (CORD-03 §3), so it is retained rather than overwritten — the
        // same continuity a single-channel rotation keeps. Dropping it here
        // would make every ban silently truncate every private channel's
        // history, for the members who stayed.
        rotatedChannels.push({
          ...ch,
          key: chKey,
          epoch: chEpoch,
          priors: [
            { key: ch.key, epoch: ch.epoch, retiredAt: Math.floor(chRotatedAtMs / 1000) },
            ...(ch.priors ?? []),
          ],
        });
      }

      // 3. Guestbook snapshot: best-effort, non-gating (CORD-02 §5).
      try {
        const newGuestbook = guestbookGroupKey(newRoot, community.id, newEpoch);
        const snapId = bytesToHex(random32());
        for (const rumor of buildSnapshotRumors(user.pubkey, recipients, snapId, Date.now())) {
          const wrap = await sealGuestbook(rumor, newGuestbook, user.signer);
          await Promise.allSettled(
            community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
          );
        }
      } catch {
        // A Refounding succeeds with or without the snapshot.
      }

      // 3b. Refresh every live invite link's bundle to the new epoch (CORD-05
      // §2: "the creator re-posting under it refreshes the bundle — fresh keys
      // behind the same URL, e.g. after a Rekey — so a link shared once survives
      // every rotation"). Without this, a link minted at the old epoch keeps
      // vending stale keys and a fresh joiner lands on the superseded epoch.
      // The `signer_sk` for each link lives in the refounder's own Invite List
      // (§4), so a refounder refreshes exactly the links they created; other
      // creators' links refresh when they adopt this rotation (useRekeyWatch2).
      // Revoked links are tombstoned there and skipped, so a Public→Private
      // conversion (which retires the last link) never resurrects one.
      // Carries the POST-rotation channel keys (step 2b), never the severed ones.
      //
      // DURABLE (mirrors Vector): idempotent, so retry a transient failure —
      // a stranded link lands every new joiner on the DEAD pre-rotation epoch,
      // and there is no other trigger to heal it before the next Refounding. A
      // persistent failure warns the refounder (the rotation itself already
      // succeeded) so they can reopen the community to retry.
      {
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
            title: "Live invite links may serve the old keys",
            description:
              "Key rotation succeeded, but refreshing your invite links failed. Reopen the community to retry, or new joiners on those links could land on the previous epoch.",
            variant: "destructive",
          });
        }
      }

      // 4. Follow our own rotation forward.
      const rotated: CommunityV2 = {
        ...community,
        root: newRoot,
        rootEpoch: newEpoch,
        controlPk: newControlPk,
        controlRoot: newControlRoot,
        heldRoots: [
          { epoch: newEpoch, key: newRoot, refounder: user.pubkey, controlPk: newControlPk },
          ...retiredPriorRoots,
        ],
        privateChannels: rotatedChannels,
        refounder: user.pubkey,
      };
      await updateList({
        type: "refresh-current",
        current: toJoinMaterial(rotated, { prior: entry?.current, relays: entry?.current.relays }),
      });
      queryClient.invalidateQueries({ queryKey: ["concord2", "list"] });
    },
  });

  return {
    refound: refound.mutateAsync,
    isRefounding: refound.isPending,
    /** V2 rotations need only a NIP-44 signer (bunker-friendly), unlike V1's raw-nsec rule. */
    canRefound: Boolean(user?.signer.nip44),
  };
}

// Re-exported for the moderation hook's scope math.
export { rekeyScopeId };
