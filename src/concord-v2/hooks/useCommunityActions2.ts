import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { verifyEvent } from "nostr-tools/pure";
import { useCallback, useEffect, useRef, useState } from "react";

import { useCommunityEntry2, useUpdateCommunityList2 } from "@/concord-v2/hooks/useCommunityList2";
import { useControlFold2, citationFor, invalidateControl2, publishEdition2 } from "@/concord-v2/hooks/useControlPlane2";
import { useGuestbookPublisher2 } from "@/concord-v2/hooks/useGuestbook2";
import { buildJoinRumor, currentGuestbookGroup, sealGuestbook } from "@/concord-v2/lib/guestbook";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { fetchCreatorDmRelays } from "@/lib/creatorRelays";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { APP_RELAYS } from "@/lib/platform";
import { preferPortableRelays, unusableRelaysReason } from "@/lib/relayUsability";
import { channelKeysToWire, nextChannelEpoch, toJoinMaterial, rehydrateCommunity, type CommunityListEntry, type JoinMaterial } from "@/concord-v2/lib/communityList";
import { mintCommunity } from "@/concord-v2/lib/community";
import { DEFAULT_MESSAGE_EXPIRATION_SECS } from "@/concord-v2/lib/disappearing";
import { accessRolePosition, isAuthorized, MAX_ROLES_PER_COMMUNITY, Permissions } from "@/concord-v2/lib/roles";
import { channelEpochFloor, channelRekeyAddressWindow } from "@/concord-v2/lib/rekey";
import {
  buildChannelEdition,
  buildMetadataEdition,
  buildRoleEdition,
  sealDissolved,
} from "@/concord-v2/lib/control";
import { bytesToHex, hex32, random32 } from "@/concord-v2/lib/derive";
import {
  encodeFragment,
  InviteError,
  parseBundleEvent,
  parseInviteLink,
  STOCK_RELAYS,
  type InviteBundle,
  type ParsedInviteLink,
} from "@/concord-v2/lib/invite";
import { KIND_INVITE_BUNDLE, VSK_INVITE_REVOKED } from "@/concord-v2/lib/kinds";
import {
  capRelays,
  channelGitRepositoryAttachments,
  NAME_MAX_BYTES,
  utf8Len,
  withChannelGitRepositoryAttachments,
  type ChannelMetadata,
  type CommunityV2,
  type PrivateChannelKey,
} from "@/concord-v2/lib/types";
import { withChannelCategory } from "@/concord-v2/lib/channelCategory";
import { channelPosition, compareChannelOrder, reorderPositions, withChannelPosition } from "@/concord-v2/lib/channelOrder";
import { controlGroups, foldControlState, openControlWraps } from "@/concord-v2/lib/control";
import { registerStreamKeys } from "@/concord-v2/lib/streamAuth";

/**
 * How far up a channel's rekey addresses to look when finding the epoch floor
 * for a privatisation. Bounded because the scan is speculative — one REQ of
 * this many authors per held root — and a channel that has genuinely rotated
 * past it is far outside anything a UI flow produces.
 */
const MAX_PROBED_CHANNEL_EPOCH = 64;
import { KIND_WRAP } from "@/concord-v2/lib/kinds";
import { attachGitRepository, detachGitRepository, parseGitRepositoryAddress } from "@/lib/gitActivity";

import type { NostrEvent } from "@nostrify/nostrify";

/** Thrown when the joiner is on the community's folded Banlist (CORD-04 §4). */
export class BannedFromCommunityError extends Error {
  constructor() {
    super("You're banned from this community and can't rejoin.");
    this.name = "BannedFromCommunityError";
  }
}

/** Thrown when the control plane can't be read to verify access (retryable). */
export class ControlUnreadableError extends Error {
  constructor() {
    super("Couldn't verify your access to this community. Please try again.");
    this.name = "ControlUnreadableError";
  }
}

/**
 * Refuse to join a community whose CURRENT Banlist names me (CORD-04 §4). An
 * honest client MUST NOT publish a Join, record the entry, or emit anything
 * while banlisted — presence on the folded head is disqualifying regardless of
 * edition timestamps (the self-removal watcher's timestamp guard is for the
 * post-join replay race, NOT for entry). Fetch + fold the control plane and
 * throw before any side effect.
 *
 * Fail CLOSED: a real community always carries control editions (genesis
 * metadata + channel), so an empty read means the plane was withheld or
 * unreachable, NOT "no ban" — refuse-and-retry rather than wave a banned user
 * through. The read is NIP-42 authenticated (the stock relays gate stream
 * reads), scoped to the community's control-group keys.
 *
 * ORDERING INVARIANT: this must fold the FRESH bundle entry, before any merge
 * with a previously-held list entry. The fresh entry spans only the invite's
 * epoch, so the fold is single-epoch and needs no snapshot attribution; a
 * merged rejoin entry restores older roots and would need the full
 * cross-epoch fold semantics (see headCandidates' `snapshot`).
 */
export async function assertNotBanned(
  nostr: ReturnType<typeof useNostr>["nostr"],
  community: CommunityV2,
  pubkey: string,
): Promise<void> {
  // Enforce the single-epoch invariant in code, not just prose: this fold omits
  // snapshot attribution, so a merged multi-epoch entry could anchor on a stale
  // old-epoch fragment and wave a banned rejoiner through. Fail closed.
  if (community.heldRoots.length !== 1) throw new ControlUnreadableError();
  const groups = controlGroups(community);
  // Answer the relays' NIP-42 challenge with the control-group keys, else a
  // gated relay serves nothing and the ban goes unseen.
  registerStreamKeys(groups, community.relays);
  const authors = groups.map((g) => g.pk);
  const results = await Promise.all(
    community.relays.map((url) =>
      nostr
        .relay(url)
        .query([{ kinds: [KIND_WRAP], authors }], { signal: AbortSignal.timeout(12_000) })
        .catch(() => [] as NostrEvent[]),
    ),
  );
  const seen = new Set<string>();
  const wraps = results.flat().filter((e) => (seen.has(e.id) ? false : seen.add(e.id)));
  if (wraps.length === 0) throw new ControlUnreadableError();
  const folded = foldControlState(openControlWraps(wraps, groups), community.id, community.owner);
  if (folded.banned.has(pubkey)) throw new BannedFromCommunityError();
}

/** A preview of where a V2 invite leads, resolved before joining. */
export interface InvitePreview2 {
  communityId: string;
  name: string;
  channelCount: number;
  relays: string[];
  bundle: InviteBundle;
}

/**
 * The newest bundle event seen at each link coordinate, memory-cached and
 * persisted in KV. Any one fetch races per-relay timeouts, and a relay that
 * missed a refresh (or a revocation) happily vends its older copy — so
 * without a memory, a repeat resolve can REGRESS to a bundle an earlier
 * resolve already superseded (previews flickering between fresh and stale
 * metadata, joins landing on an old epoch). Addressable-event semantics make
 * newest-wins the truth, so remember the newest raw event per coordinate and
 * never accept an older one — across reloads, hence KV, not a session map.
 * Tombstones are events too and sort the same way, so a seen revocation stays
 * terminal. Only signature-verified events enter (see the filter below), so a
 * hostile relay can't pin a forgery here.
 */
const BUNDLE_FLOOR_KV = "c2bundlehead:";
const newestBundleEvents = new Map<string, NostrEvent>();

async function readBundleFloor(linkSigner: string): Promise<NostrEvent | undefined> {
  const mem = newestBundleEvents.get(linkSigner);
  if (mem) return mem;
  try {
    const stored = await getArmadaDB().kv.get<NostrEvent>(BUNDLE_FLOOR_KV + linkSigner);
    if (stored) newestBundleEvents.set(linkSigner, stored);
    return stored;
  } catch {
    return undefined;
  }
}

function writeBundleFloor(linkSigner: string, event: NostrEvent): void {
  newestBundleEvents.set(linkSigner, event);
  // Best-effort: losing the persisted floor only re-exposes the relay race.
  getArmadaDB().kv.set(BUNDLE_FLOOR_KV + linkSigner, event).catch(() => undefined);
}

/**
 * How long a coordinate query keeps waiting for the REMAINING relays once one
 * of them has already produced a valid bundle event. The full per-relay
 * timeout below exists for the nothing-yet case; once a copy is in hand, the
 * other live relays (dialed in parallel) answer within moments, and only a
 * dead relay is still pending — which must not hold every invite preview
 * hostage for the whole timeout. Stale-copy risk from cutting a laggard off
 * is already covered twice over: the persisted newest-copy floor never
 * regresses, and resolveBundle's second hop re-asks the community's home
 * relays for a newer copy.
 */
const BUNDLE_GRACE_MS = 250;
const BUNDLE_RELAY_TIMEOUT_MS = 8000;

/** Query one relay set for a link's bundle coordinate, verified events only. */
async function queryBundleCoordinate(
  nostr: ReturnType<typeof useNostr>["nostr"],
  invite: ParsedInviteLink,
  relays: string[],
): Promise<NostrEvent[]> {
  const valid: NostrEvent[] = [];
  await new Promise<void>((resolve) => {
    if (relays.length === 0) return resolve();
    let settled = 0;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(graceTimer);
      resolve();
    };
    for (const url of relays) {
      nostr
        .relay(url)
        .query(
          [{ kinds: [KIND_INVITE_BUNDLE], authors: [invite.linkSigner], "#d": [""], limit: 1 }],
          { signal: AbortSignal.timeout(BUNDLE_RELAY_TIMEOUT_MS) },
        )
        .then((events) => {
          // Only link-signer-authored, signature-valid events count: a hostile
          // relay answering with a forged far-future event must not pin the
          // coordinate (parseBundleEvent re-checks, but by then the floor
          // would be poisoned).
          for (const e of events) {
            if (
              e.kind === KIND_INVITE_BUNDLE &&
              e.pubkey === invite.linkSigner &&
              verifyEvent(e as Parameters<typeof verifyEvent>[0])
            ) {
              valid.push(e);
            }
          }
        })
        .catch(() => undefined)
        .finally(() => {
          settled += 1;
          if (settled === relays.length) finish();
          else if (valid.length > 0 && graceTimer === undefined) {
            graceTimer = setTimeout(finish, BUNDLE_GRACE_MS);
          }
        });
    }
  });
  return valid.sort((a, b) => b.created_at - a.created_at);
}

/**
 * What resolveBundle's home-relay second hop found, delivered asynchronously
 * when the caller opted into a non-blocking second hop.
 */
export interface SecondHopResult {
  /** A newer, valid bundle the home relays vended. */
  bundle?: InviteBundle;
  /** The home relays vended a newer revocation tombstone. */
  revoked?: boolean;
}

/** Fetch + verify a V2 invite bundle from its bootstrap relays. */
export async function resolveBundle(
  nostr: ReturnType<typeof useNostr>["nostr"],
  invite: ParsedInviteLink,
  fallbackRelays: string[],
  opts?: {
    /**
     * When set, the home-relay second hop below runs in the BACKGROUND and
     * reports through this callback instead of blocking the return. Meant for
     * previews (the Discover cards), where painting the first-hop bundle now
     * beats waiting a further round trip for a copy that is almost always
     * identical — and where a join that follows re-resolves with full
     * (blocking) semantics anyway. The floor is still written either way, so
     * whatever the background hop learns outlives this call.
     */
    onSecondHop?: (result: SecondHopResult) => void;
  },
): Promise<InviteBundle> {
  const pool = invite.bootstrapRelays.length ? invite.bootstrapRelays : fallbackRelays;
  const flat = await queryBundleCoordinate(nostr, invite, pool);
  // The newest event at the coordinate wins: a refresh replaces the bundle, a
  // revocation tombstone replaces it terminally. The persisted floor keeps a
  // flaky read (relays timing out, a laggard vending its stale copy) from
  // un-replacing what a better read already saw, on this or any earlier load.
  const remembered = await readBundleFloor(invite.linkSigner);
  let best = flat[0] as NostrEvent | undefined;
  if (remembered && (!best || remembered.created_at > best.created_at)) best = remembered;
  if (!best) throw new Error("Couldn't find that invite on its relays.");

  let bundle = parseBundleEvent(best, invite.linkSigner, invite.token, Date.now());

  // Second hop: the decrypted bundle names the community's HOME relays, and a
  // refresh always lands there even when a frozen bootstrap relay rejected or
  // missed it — so a reader stuck on a stale bootstrap copy would otherwise
  // serve stale previews (and stale keys!) forever. Ask the home relays the
  // pool didn't cover and adopt a newer copy if one exists. Best-effort: the
  // first-hop bundle already in hand is the floor, never the ceiling.
  const covered = new Set(pool);
  const home = (Array.isArray(bundle.relays) ? bundle.relays : []).filter((r) => !covered.has(r));

  if (home.length > 0 && opts?.onSecondHop) {
    const onSecondHop = opts.onSecondHop;
    // Non-blocking mode: the first-hop bundle is the answer; the home-relay
    // check refines it out-of-band. Write the first-hop floor NOW so an
    // interrupted session still remembers it; the background hop only ever
    // overwrites it with a strictly newer event.
    if (best !== remembered) writeBundleFloor(invite.linkSigner, best);
    const first = best;
    void (async () => {
      const [newer] = await queryBundleCoordinate(nostr, invite, home).catch(() => [] as NostrEvent[]);
      if (!newer || newer.created_at <= first.created_at) return;
      try {
        const fresher = parseBundleEvent(newer, invite.linkSigner, invite.token, Date.now());
        writeBundleFloor(invite.linkSigner, newer);
        onSecondHop({ bundle: fresher });
      } catch {
        // A newer tombstone still terminates the link honestly; anything else
        // malformed keeps the first-hop bundle (and the first-hop floor — a
        // floor that doesn't parse would poison every later read).
        if (newer.tags.some((t) => t[0] === "vsk" && t[1] === VSK_INVITE_REVOKED)) {
          writeBundleFloor(invite.linkSigner, newer);
          onSecondHop({ revoked: true });
        }
      }
    })().catch(() => undefined); // the caller has its answer; the refinement is best-effort
    return bundle;
  }

  if (home.length > 0) {
    const [newer] = await queryBundleCoordinate(nostr, invite, home).catch(() => [] as NostrEvent[]);
    if (newer && newer.created_at > best.created_at) {
      try {
        bundle = parseBundleEvent(newer, invite.linkSigner, invite.token, Date.now());
        best = newer;
      } catch {
        // A newer tombstone still terminates the link honestly; anything else
        // malformed keeps the first-hop bundle.
        if (newer.tags.some((t) => t[0] === "vsk" && t[1] === VSK_INVITE_REVOKED)) throw new InviteError("revoked", "this invite link has been revoked");
      }
    }
  }

  if (best !== remembered) writeBundleFloor(invite.linkSigner, best);
  return bundle;
}

/**
 * The invite bundle as remembered locally — the persisted newest-copy floor
 * (see {@link resolveBundle}) parsed with the link's own secret, no relay
 * round trip. `null` when nothing usable is remembered: no floor yet, or a
 * floor that no longer parses (revoked tombstone, expired link, wrong token),
 * which the caller must treat as "ask the network", never as "not revoked".
 * Used to paint invite previews (the Discover cards) instantly from local
 * data while a live resolve refreshes them.
 */
export async function readCachedBundle(invite: ParsedInviteLink): Promise<InviteBundle | null> {
  const remembered = await readBundleFloor(invite.linkSigner);
  if (!remembered) return null;
  try {
    return parseBundleEvent(remembered, invite.linkSigner, invite.token, Date.now());
  } catch {
    return null;
  }
}

/** Turn a verified bundle into the membership-list join material + entry. */
export function bundleToEntry(bundle: InviteBundle, opts?: { inviteRef?: string }): CommunityListEntry {
  const jm: JoinMaterial = {
    community_id: bundle.community_id,
    owner: bundle.owner,
    owner_salt: bundle.owner_salt,
    community_root: bundle.community_root,
    root_epoch: bundle.root_epoch,
    // The split epoch's Control address (CORD-02 §7); absent = legacy.
    ...(typeof bundle.control_pk === "string" && /^[0-9a-f]{64}$/i.test(bundle.control_pk)
      ? { control_pk: bundle.control_pk.toLowerCase() }
      : {}),
    channels: Array.isArray(bundle.channels)
      ? bundle.channels.map((ch) => ({ id: ch.id, key: ch.key, epoch: ch.epoch, name: ch.name }))
      : [],
    relays: capRelays(bundle.relays),
    name: bundle.name,
  };
  return {
    community_id: jm.community_id,
    seed: jm,
    current: jm,
    added_at: Date.now(),
    // Remember the link joined through (bare `naddr#fragment`), so a member
    // stranded on a superseded epoch can re-resolve the SAME link once its
    // creator refreshes the bundle (CORD-05 §2) — see useStrandedRecovery2.
    ...(opts?.inviteRef ? { invite_ref: opts.inviteRef } : {}),
  };
}

/** The domain-agnostic bare form of a parsed invite link: `<naddr>#<fragment>`. */
export function inviteRefOf(invite: ParsedInviteLink): string {
  return `${invite.naddr}#${encodeFragment(invite.token, invite.bootstrapRelays)}`;
}

/**
 * The default home-relay set for a NEW community: the app relays and the CORD
 * stock set (the wss:// interop relays every CORD client shares — jskitty,
 * asia.vectorapp, ditto, dreamith) as the reliable base, then the creator's
 * NIP-17 DM relays. A creator's inbox relays alone can be a poor community
 * home: an auth-gated or DM-only relay rejects the genesis gift wrap (kind
 * 1059), and if that's the whole set the create strands with "No relay accepted
 * the change." Leading with known write-open CORD relays guarantees the genesis
 * lands. Portable-filtered so a stray `ws://` dev relay can't lock https members
 * out (#47), deduped, and capped to the recommended community relay count.
 */
export function defaultCreateRelays(appRelays: string[], dmRelays: string[]): string[] {
  return capRelays(preferPortableRelays([...appRelays, ...STOCK_RELAYS, ...dmRelays]));
}

/**
 * The candidate relays the advanced create menu pre-selects: the same set
 * {@link defaultCreateRelays} the create path would pick on its own, resolved
 * for display so the user can pare it down or add to it before minting. Gated
 * behind `enabled` so a user who never opens the advanced menu pays no DM-relay
 * lookup.
 */
export function useCreateRelayCandidates2(enabled = true) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const appRelays = config.appRelays.length > 0 ? config.appRelays : APP_RELAYS;
  return useQuery<string[]>({
    queryKey: ["concord2", "create-relays", user?.pubkey ?? null, appRelays],
    enabled: enabled && Boolean(user),
    staleTime: 60_000,
    queryFn: async () => {
      const dm = user ? await fetchCreatorDmRelays(nostr, user.pubkey).catch(() => []) : [];
      return defaultCreateRelays(appRelays, dm);
    },
  });
}

/**
 * Create / preview / join for Concord V2 communities. Creating publishes the
 * genesis Control Plane — EXACTLY two owner-signed editions, the metadata and
 * one public `#general` (CORD-02 §1) — records the keys in the Community List
 * (the only durable record), announces the creator's own Guestbook Join, and
 * follows up with one private `#private` starter room so a fresh community
 * shows both channel shapes.
 */
export function useCommunityActions2() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { mutateAsync: updateList } = useUpdateCommunityList2();
  const queryClient = useQueryClient();

  // Fallback relays for resolving an invite bundle when the fragment carries no
  // bootstrap relays of its own. Prefer the user's configured app relays (so a
  // removed relay isn't silently reused) and fall back to the stock interop set
  // (not the app defaults) when the user has emptied their list — a relayless
  // link must still resolve against the relays every CORD client shares.
  const bootstrapRelays = config.appRelays.length > 0 ? config.appRelays : STOCK_RELAYS;

  const create = useMutation<
    { communityId: string; name: string },
    Error,
    { name: string; relays?: string[]; messageExpirationSecs?: number }
  >({
    mutationFn: async ({ name, relays: chosen, messageExpirationSecs }) => {
      if (!user) throw new Error("Sign in to start an encrypted community.");
      if (!user.signer.nip44) throw new Error("This signer can't hold encrypted communities (NIP-44 unsupported).");
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Name your community first.");

      // The community's home relays. When the advanced menu supplied an
      // explicit set, honor it (portable-filtered all the same). Otherwise seed
      // the app relays UNIONED with the creator's NIP-17 DM relays: inbox
      // relays are curated for sealed, privacy-expecting traffic like Concord's,
      // but a creator whose only DM relays are auth-gated or DM-only will have
      // the genesis gift wrap rejected everywhere, so always including the app
      // relays guarantees a write-open home. Prefer the wss:// subset: a stray
      // ws:// dev relay sealed into the bundle is permanently unreachable for
      // every member on a secure origin, however reachable it is for the
      // creator (#47).
      const appRelays = config.appRelays.length > 0 ? config.appRelays : APP_RELAYS;
      const relays = chosen && chosen.length > 0
        ? preferPortableRelays(chosen)
        : defaultCreateRelays(appRelays, await fetchCreatorDmRelays(nostr, user.pubkey));
      const { community, generalChannelId } = mintCommunity(trimmed, user.pubkey, relays);

      // Disappearing messages (CORD-08): default 30 days unless the creation
      // screen chose otherwise; 0 (off) writes no field at all.
      const timerSecs = Math.floor(messageExpirationSecs ?? DEFAULT_MESSAGE_EXPIRATION_SECS);

      // Genesis: two owner-signed editions, nothing more (CORD-02 §1).
      await publishEdition2(
        nostr,
        community,
        user.signer,
        buildMetadataEdition(
          community.id,
          {
            name: trimmed,
            relays: community.relays,
            ...(timerSecs > 0 ? { message_expiration: timerSecs } : {}),
          },
          { actorPubkey: user.pubkey, version: 1n },
        ),
      );
      await publishEdition2(
        nostr,
        community,
        user.signer,
        buildChannelEdition(
          generalChannelId,
          { name: "general", private: false },
          { actorPubkey: user.pubkey, version: 1n },
        ),
      );

      // The second starter room: a private #private, born the way any private
      // channel is (see createChannel): its key goes into the vault entry
      // below BEFORE its edition publishes — a lost list write would
      // otherwise orphan the only copy of the key behind a live channel
      // definition, unreadable forever.
      const privateStarter: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "private" };
      community.privateChannels = [privateStarter];

      // Record membership FIRST (the vault), then announce presence.
      const jm = toJoinMaterial(community, { relays: community.relays });
      await updateList({
        type: "add",
        entry: { community_id: community.idHex, seed: jm, current: jm, added_at: Date.now() },
      });

      // The private starter room's access role, then its channel edition (the
      // createChannel ordering: a role scoped to a channel that never
      // appeared is inert, a channel whose role mint failed is a visible
      // room with no access list). Best-effort past this point: genesis
      // landed and membership is recorded, so failing the create here would
      // strand a working community behind an error and invite a duplicate
      // retry — roll the unused key back out and ship #general alone.
      try {
        // The owner's rank needs no fold (supremacy comes from the
        // community_id commitment), so this resolves before anything is
        // readable back; the throw is unreachable for the creator.
        const position = accessRolePosition(undefined, user.pubkey, community.owner);
        if (position === undefined) throw new Error("No resolvable rank for the access role.");
        await publishEdition2(
          nostr,
          community,
          user.signer,
          buildRoleEdition(
            {
              roleId: bytesToHex(random32()),
              name: "private",
              position,
              permissions: 0n,
              scope: { kind: "channel", channelId: bytesToHex(privateStarter.id) },
              color: 0,
            },
            { actorPubkey: user.pubkey, version: 1n },
          ),
        );
        await publishEdition2(
          nostr,
          community,
          user.signer,
          buildChannelEdition(
            privateStarter.id,
            { name: "private", private: true },
            { actorPubkey: user.pubkey, version: 1n },
          ),
        );
      } catch {
        community.privateChannels = [];
        await updateList({
          type: "refresh-channels",
          communityId: community.idHex,
          channels: channelKeysToWire([]),
        }).catch(() => undefined);
      }

      // Best-effort founder Join, so the member list has a firsthand entry.
      void (async () => {
        const rumor = buildJoinRumor(user.pubkey, Date.now());
        const wrap = await sealGuestbook(rumor, currentGuestbookGroup(community), user.signer);
        await Promise.allSettled(
          community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
        );
      })().catch(() => undefined);

      return { communityId: community.idHex, name: trimmed };
    },
  });

  const preview = useMutation<InvitePreview2, Error, { invite: ParsedInviteLink }>({
    mutationFn: async ({ invite }) => {
      const bundle = await resolveBundle(nostr, invite, bootstrapRelays);
      // Fail loudly when this platform can't reach ANY of the community's
      // relays (#47) — e.g. a ws://-only dev community opened on the APK,
      // where mixed content silently blocks every connection.
      const unusable = unusableRelaysReason(bundle.relays);
      if (unusable) throw new Error(unusable);
      return {
        communityId: bundle.community_id,
        name: bundle.name,
        channelCount: Array.isArray(bundle.channels) ? bundle.channels.length : 0,
        relays: bundle.relays,
        bundle,
      };
    },
  });

  const join = useMutation<{ communityId: string; name: string }, Error, { invite: ParsedInviteLink }>({
    mutationFn: async ({ invite }) => {
      if (!user) throw new Error("Sign in to join an encrypted community.");
      const bundle = await resolveBundle(nostr, invite, bootstrapRelays);
      const unusable = unusableRelaysReason(bundle.relays);
      if (unusable) throw new Error(unusable);
      const entry = bundleToEntry(bundle, { inviteRef: inviteRefOf(invite) });
      // A banned npub must not join (CORD-04 §4): check BEFORE recording the
      // entry or publishing anything.
      const community = rehydrateCommunity(entry);
      if (community) await assertNotBanned(nostr, community, user.pubkey);
      await updateList({ type: "add", entry });
      queryClient.invalidateQueries({ queryKey: ["concord2", "list"] });

      // Best-effort self-signed Guestbook Join, echoing the link's attribution
      // (CORD-02 §5 / CORD-05 §1) — the coalesce self-heals if it never lands.
      if (community) {
        void (async () => {
          const attribution = bundle.creator_npub
            ? { creator: bundle.creator_npub, label: bundle.label }
            : undefined;
          const rumor = buildJoinRumor(user.pubkey, Date.now(), attribution);
          const wrap = await sealGuestbook(rumor, currentGuestbookGroup(community), user.signer);
          await Promise.allSettled(
            community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
          );
        })().catch(() => undefined);
      }

      return { communityId: bundle.community_id, name: bundle.name };
    },
  });

  return {
    create: create.mutateAsync,
    isCreating: create.isPending,
    preview: preview.mutateAsync,
    isPreviewing: preview.isPending,
    join: join.mutateAsync,
    isJoining: join.isPending,
  };
}

/** Per-community actions: leave, dissolve, and channel management. */
export function useCommunityManagement2(community: CommunityV2 | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateCommunityList2();
  const { data: folded } = useControlFold2(community);
  const publisher = useGuestbookPublisher2(community);
  const entry = useCommunityEntry2(community?.idHex);
  const queryClient = useQueryClient();

  const leave = useMutation<void, Error, void>({
    mutationFn: async () => {
      if (!user || !community) throw new Error("Not ready.");
      // Best-effort Leave (the tombstone is the authoritative local act).
      await publisher.mutateAsync({ type: "leave" }).catch(() => undefined);
      await updateList({ type: "remove", communityId: community.idHex });
    },
  });

  const dissolve = useMutation<void, Error, void>({
    mutationFn: async () => {
      if (!user || !community) throw new Error("Not ready.");
      if (user.pubkey !== community.owner) throw new Error("Only the owner can dissolve the community.");
      const wrap = await sealDissolved(community.id, user.pubkey, user.signer);
      const results = await Promise.allSettled(
        community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
      );
      if (!results.some((r) => r.status === "fulfilled")) {
        throw new Error("No relay accepted the dissolution.");
      }
      await updateList({ type: "remove", communityId: community.idHex });
    },
  });

  /**
   * Mint the Role that confers read access to a Private Channel (CORD-04 §2
   * `scope`), named after the channel.
   *
   * It carries NO permission bits: read access is key possession (CORD-04 §1)
   * and a Role "mints no key, so granting it hands a member rank, never a
   * secret" (§2) — the scope is what routes the key, the bits would only hand
   * out authority nobody asked for.
   *
   * It is minted at the BOTTOM of the hierarchy for the same reason. Rank is
   * the lowest position among a member's Roles and is independent of the
   * bits, so an access Role placed at the signer's ceiling would promote
   * every grantee to the signer's own rank (see `accessRolePosition`).
   */
  const mintChannelRole = async (channelId: Uint8Array, channelName: string): Promise<string | undefined> => {
    if (!user || !community) return undefined;
    const ownerHex = folded?.ownerHex ?? community.owner;
    // Below every existing Role and strictly below the signer, or nothing at
    // all. A signer with no resolvable rank (roleless, or a roster that has
    // not folded) may mint no Role: treating them as rank 0 would publish an
    // edition every verifier drops for self-promotion while this client
    // reported success.
    const position = accessRolePosition(folded?.roster, user.pubkey, ownerHex);
    if (position === undefined) {
      throw new Error("You don't hold a rank that can create this channel's access role.");
    }
    // At the 100-role cap the fold keeps the 100 LOWEST role_ids (CORD-04
    // §2), so a fresh random id may silently fold out — or evict one that
    // gates another channel. Refuse rather than gamble with the access list.
    if ((folded?.roster.roles.length ?? 0) >= MAX_ROLES_PER_COMMUNITY) {
      throw new Error("This community is at its 100-role limit; delete a role first.");
    }
    const roleId = bytesToHex(random32());
    await publishEdition2(
      nostr,
      community,
      user.signer,
      buildRoleEdition(
        {
          roleId,
          name: channelName.slice(0, 64),
          position,
          permissions: 0n,
          scope: { kind: "channel", channelId: bytesToHex(channelId) },
          color: 0,
        },
        { actorPubkey: user.pubkey, version: 1n, authority: citationFor(community, folded, user.pubkey) },
      ),
    );
    return roleId;
  };

  const createChannel = useMutation<
    { channelIdHex: string; minted?: PrivateChannelKey },
    Error,
    { name: string; repository?: { address: string; relayHints: string[] }; isPrivate?: boolean }
  >({
    mutationFn: async ({ name, repository, isPrivate }) => {
      if (!user || !community) throw new Error("Not ready.");
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Channel name is required.");
      const channelId = random32();
      // A repository rides the channel's FIRST edition rather than a follow-up
      // attachRepository: that path resolves the channel out of the control
      // fold, which this mutation only invalidates in the background, so a
      // just-created channel is absent from it and the attach throws. Building
      // one edition leaves the channel born attached instead.
      let metadata: ChannelMetadata = { name: trimmed, private: Boolean(isPrivate) };
      if (repository) {
        const address = parseGitRepositoryAddress(repository.address);
        if (!address) throw new Error("Repository address must be a canonical 30617 coordinate.");
        metadata = withChannelGitRepositoryAttachments(
          metadata,
          attachGitRepository([], address, repository.relayHints, Math.floor(Date.now() / 1000)),
        );
      }

      // A Private Channel is born with its own independent key (CORD-03),
      // epoch 0. The key lands in the creator's own list BEFORE the edition
      // publishes: a lost list write would otherwise orphan the only copy of
      // the key behind a live channel definition — unreadable forever. The
      // reverse failure (edition never lands) is rolled back below.
      let minted: PrivateChannelKey | undefined;
      const priorChannels = community.privateChannels;
      if (isPrivate) {
        minted = { id: channelId, key: random32(), epoch: 0n, name: trimmed };
        await updateList({
          type: "refresh-channels",
          communityId: community.idHex,
          channels: channelKeysToWire([...priorChannels, minted]),
        });
      }

      try {
        // The Role publishes BEFORE the channel edition. The pair is born
        // together, and a partial failure has to leave the less harmful
        // orphan: a role scoped to a channel that never appeared is inert
        // (it confers no key and grants nothing), while a channel whose role
        // mint then failed is a live room the whole community can see — and
        // the retry that follows the error would mint a SECOND one.
        if (isPrivate) await mintChannelRole(channelId, trimmed);
        await publishEdition2(
          nostr,
          community,
          user.signer,
          buildChannelEdition(
            channelId,
            metadata,
            { actorPubkey: user.pubkey, version: 1n, authority: citationFor(community, folded, user.pubkey) },
          ),
        );
      } catch (e) {
        if (minted) {
          // Best-effort: pull the never-announced key back out so it doesn't
          // linger as a ghost channel in the creator's sidebar.
          await updateList({ type: "refresh-channels", communityId: community.idHex, channels: channelKeysToWire(priorChannels) }).catch(() => undefined);
        }
        throw e;
      }
      invalidateControl2(queryClient, community.idHex);
      queryClient.invalidateQueries({ queryKey: ["concord2", "list"] });
      return { channelIdHex: bytesToHex(channelId), minted };
    },
  });

  const renameChannel = useMutation<void, Error, { channelIdHex: string; name: string }>({
    mutationFn: async ({ channelIdHex, name }) => {
      if (!user || !community) throw new Error("Not ready.");
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Channel name is required.");
      const def = folded?.channels.get(channelIdHex);
      const head = folded?.heads.get(channelIdHex);
      await publishEdition2(
        nostr,
        community,
        user.signer,
        buildChannelEdition(
          hex32(channelIdHex),
          // Round-trip all metadata a rename doesn't touch (CORD-02 §6 discipline).
          { ...(def?.metadata ?? { private: false }), name: trimmed },
          {
            actorPubkey: user.pubkey,
            version: head ? head.version + 1n : 1n,
            prevHash: head?.hash,
            authority: citationFor(community, folded, user.pubkey),
          },
        ),
      );
      invalidateControl2(queryClient, community.idHex);
    },
  });

  /**
   * Convert a Public Channel to Private (CORD-03 §2): mint its independent
   * key at the next channel epoch, flip the metadata flag, and mint the Role
   * scoped to it that names who may read it.
   *
   * A public channel's stream derives from the `community_root` that every
   * member holds, so restriction is impossible without an independent key.
   * The mint lands in the caller's own list before the edition publishes (a
   * lost list write would orphan the only copy of the key), and `minted` is
   * returned so the caller can vend it to the entitled.
   *
   * Conversion moves the channel to a NEW stream: "Privatising protects the
   * future only" (§2) — pre-conversion history was written under
   * root-derived keys every member holds and stays readable to all of them.
   * Callers must say so before doing it.
   */
  const privatiseChannel = useMutation<
    { minted?: PrivateChannelKey; roleId?: string },
    Error,
    { channelIdHex: string }
  >({
    mutationFn: async ({ channelIdHex }) => {
      if (!user || !community) throw new Error("Not ready.");
      const def = folded?.channels.get(channelIdHex);
      if (!def) throw new Error("Channel not found in the control fold yet; try again shortly.");
      if (def.isPrivate) throw new Error("This channel is already private.");
      const head = folded?.heads.get(channelIdHex);

      // CORD-03 §2: a conversion mints at the NEXT channel_epoch, monotonic
      // and never resetting. Resetting to 0 would put two different keys at
      // one epoch across a privatise -> publish -> privatise cycle, where the
      // list merge (epoch-max) and a `channel_cuts` floor (epoch-min) both
      // stop being able to tell the generations apart.
      //
      // The floor is read off the wire, not out of this client's keyring: a
      // channel's rotations publish to addresses derived from the
      // `community_root` and `channel_id` alone (CORD-06 §2), so generations
      // this client never held are still countable by it.
      const channelId = hex32(channelIdHex);
      const roots = community.heldRoots.length > 0 ? community.heldRoots : [{ key: community.root }];
      const window = channelRekeyAddressWindow(roots, channelId, MAX_PROBED_CHANNEL_EPOCH);
      let seenPubkeys: string[] | undefined;
      try {
        const seen = await Promise.all(
          community.relays.map((url) =>
            nostr
              .relay(url)
              .query([{ kinds: [KIND_WRAP], authors: [...window.keys()] }], {
                signal: AbortSignal.timeout(8000),
              })
              .catch(() => []),
          ),
        );
        seenPubkeys = seen.flat().map((e) => e.pubkey);
      } catch {
        // Unreachable relays leave the local floor to stand on its own.
      }
      // A saturated probe THROWS rather than returning its ceiling: a rotation
      // found at the edge of the window proves only that the channel reached
      // the edge, and minting on top of that guess collides with a generation
      // that already exists (CORD-03 §2's counter is what tells them apart).
      const observedFloor =
        seenPubkeys === undefined ? 0n : channelEpochFloor(window, seenPubkeys, MAX_PROBED_CHANNEL_EPOCH);

      const priorChannels = community.privateChannels;
      const minted: PrivateChannelKey = {
        id: channelId,
        key: random32(),
        epoch: nextChannelEpoch(priorChannels, channelIdHex, observedFloor),
        name: def.name,
      };
      await updateList({
        type: "refresh-channels",
        communityId: community.idHex,
        channels: channelKeysToWire([...priorChannels, minted]),
      });

      let roleId: string | undefined;
      try {
        // Role first, flag second — same partial-failure ordering as
        // createChannel: an orphan role scoped to a still-public channel is
        // inert, while a privatised channel whose role mint then failed is a
        // room whose access list nobody can ever be added to, and a retry
        // would re-run the whole conversion against a now-private channel.
        roleId = await mintChannelRole(channelId, def.name);
        await publishEdition2(
          nostr,
          community,
          user.signer,
          buildChannelEdition(
            channelId,
            // Round-trip everything the conversion doesn't touch (CORD-02 §6).
            { ...def.metadata, private: true },
            {
              actorPubkey: user.pubkey,
              version: head ? head.version + 1n : 1n,
              prevHash: head?.hash,
              authority: citationFor(community, folded, user.pubkey),
            },
          ),
        );
      } catch (e) {
        await updateList({ type: "refresh-channels", communityId: community.idHex, channels: channelKeysToWire(priorChannels) }).catch(() => undefined);
        throw e;
      }
      invalidateControl2(queryClient, community.idHex);
      queryClient.invalidateQueries({ queryKey: ["concord2", "list"] });
      return { minted, roleId };
    },
  });

  /**
   * Convert a Private Channel back to Public (CORD-03 §2): flip the metadata
   * flag and nothing else. "The Channel begins deriving from the
   * `community_root` going forward, and a member joining after the switch
   * reads only the now-public history, never the prior private messages (they
   * never held that key)."
   *
   * No key is minted or destroyed. The held channel key STAYS in the caller's
   * list: `channelsView` keeps querying it alongside the root-derived stream,
   * so the private era remains readable to whoever held it — a conversion is
   * never retroactive in either direction. The Role scoped to the channel is
   * left alone too; it now confers nothing (a public channel's key derives
   * from the root every member holds) and is inert rather than wrong, and
   * deleting it is a separate authority action the user can take.
   */
  const publiciseChannel = useMutation<void, Error, { channelIdHex: string }>({
    mutationFn: async ({ channelIdHex }) => {
      if (!user || !community) throw new Error("Not ready.");
      const def = folded?.channels.get(channelIdHex);
      if (!def) throw new Error("Channel not found in the control fold yet; try again shortly.");
      if (!def.isPrivate) throw new Error("This channel is already public.");
      if (def.deleted) throw new Error("This channel was deleted.");
      const ownerHex = folded?.ownerHex ?? community.owner;
      if (!isAuthorized(folded?.roster ?? { roles: [], grants: [] }, user.pubkey, ownerHex, Permissions.MANAGE_CHANNELS)) {
        throw new Error("Making a channel public needs the Manage-channels permission.");
      }
      const head = folded?.heads.get(channelIdHex);
      await publishEdition2(
        nostr,
        community,
        user.signer,
        buildChannelEdition(
          hex32(channelIdHex),
          // Round-trip everything the conversion doesn't touch (CORD-02 §6).
          { ...def.metadata, private: false },
          {
            actorPubkey: user.pubkey,
            version: head ? head.version + 1n : 1n,
            prevHash: head?.hash,
            authority: citationFor(community, folded, user.pubkey),
          },
        ),
      );
      invalidateControl2(queryClient, community.idHex);
    },
  });

  /**
   * The channels the sidebar shows, in the order it shows them — the shared
   * input for every reorder, so a move computed here and a move computed by
   * the drag both index into the same list.
   */
  const orderedForMove = useCallback(
    () =>
      [...(folded?.channels.values() ?? [])]
        .filter((c) => !c.deleted)
        .map((c) => ({
          idHex: c.channelIdHex,
          name: c.name,
          position: channelPosition(c.metadata),
        }))
        .sort(compareChannelOrder),
    [folded],
  );

  /**
   * Publish the position changes a move implies. One version-chained Channel
   * edition per channel whose position actually changes — two for an ordinary
   * swap; the first reorder in a never-ordered community stamps every channel,
   * since an arrangement isn't expressible until each carries a position.
   * Editions are independent entities, so a partial failure leaves a coherent
   * (if partly-applied) order that the next move repairs.
   */
  const publishPositions = useCallback(
    async (moves: Array<{ idHex: string; position: number }>) => {
      if (!user || !community) throw new Error("Not ready.");
      for (const { idHex, position } of moves) {
        const def = folded?.channels.get(idHex);
        if (!def) continue;
        const head = folded?.heads.get(idHex);
        await publishEdition2(
          nostr,
          community,
          user.signer,
          buildChannelEdition(
            hex32(idHex),
            // Round-trip everything a reorder doesn't touch (CORD-02 §6).
            withChannelPosition(def.metadata, position),
            {
              actorPubkey: user.pubkey,
              version: head ? head.version + 1n : 1n,
              prevHash: head?.hash,
              authority: citationFor(community, folded, user.pubkey),
            },
          ),
        );
      }
      invalidateControl2(queryClient, community.idHex);
    },
    [user, community, folded, nostr, queryClient],
  );

  /**
   * Apply a whole planned arrangement — what a drag commits.
   *
   * A drop sets a channel's slot AND the heading it landed under, so each
   * changed channel gets ONE edition carrying both. Publishing position and
   * category separately would be two editions on one entity for one gesture,
   * and a failure between them would leave a channel filed where it isn't
   * positioned.
   */
  const arrangeChannels = useMutation<
    void,
    Error,
    Array<{ idHex: string; position: number; category: string | undefined }>
  >({
    mutationFn: async (changes) => {
      if (!user || !community) throw new Error("Not ready.");
      const ownerHex = folded?.ownerHex ?? community.owner;
      if (!isAuthorized(folded?.roster ?? { roles: [], grants: [] }, user.pubkey, ownerHex, Permissions.MANAGE_CHANNELS)) {
        throw new Error("Rearranging channels needs the Manage-channels permission.");
      }
      for (const { idHex, position, category } of changes) {
        const def = folded?.channels.get(idHex);
        if (!def) continue;
        const head = folded?.heads.get(idHex);
        await publishEdition2(
          nostr,
          community,
          user.signer,
          buildChannelEdition(
            hex32(idHex),
            // Round-trip everything the drop doesn't touch (CORD-02 §6).
            withChannelPosition(withChannelCategory(def.metadata, category), position),
            {
              actorPubkey: user.pubkey,
              version: head ? head.version + 1n : 1n,
              prevHash: head?.hash,
              authority: citationFor(community, folded, user.pubkey),
            },
          ),
        );
      }
      invalidateControl2(queryClient, community.idHex);
    },
  });

  /** Move a channel one slot up or down the sidebar (the settings buttons). */
  const moveChannel = useMutation<void, Error, { channelIdHex: string; direction: -1 | 1 }>({
    mutationFn: async ({ channelIdHex, direction }) => {
      const ordered = orderedForMove();
      const from = ordered.findIndex((c) => c.idHex === channelIdHex);
      if (from === -1) throw new Error("Channel not found in the control fold yet; try again shortly.");
      const to = from + direction;
      if (to < 0 || to >= ordered.length) return;
      await publishPositions(reorderPositions(ordered, from, to));
    },
  });

  /**
   * Move a channel to an ABSOLUTE slot — what a drag lands on, where the drop
   * index is read off the pointer rather than accumulated one step at a time.
   */
  const reorderChannel = useMutation<void, Error, { channelIdHex: string; toIndex: number }>({
    mutationFn: async ({ channelIdHex, toIndex }) => {
      const ordered = orderedForMove();
      const from = ordered.findIndex((c) => c.idHex === channelIdHex);
      if (from === -1) throw new Error("Channel not found in the control fold yet; try again shortly.");
      await publishPositions(reorderPositions(ordered, from, Math.max(0, Math.min(toIndex, ordered.length - 1))));
    },
  });

  /**
   * File a channel into a category (or out of one with `undefined`).
   *
   * A category is only ever the set of channels naming it, so there is nothing
   * else to publish: this one edition both creates a category and, when it was
   * the last member, removes it.
   *
   * Refuses a channel the Control fold hasn't produced yet. `channelsView`
   * renders bundle-held private channels ahead of their fold (a fresh join),
   * and filing one of those against a default `{name:"", private:false}` would
   * publish an edition that blanks the name and turns a Private Channel public.
   * Every other metadata edit here (`publiciseChannel`, `attachRepository`)
   * takes the same refusal.
   */
  const setChannelCategory = useMutation<void, Error, { channelIdHex: string; category: string | undefined }>({
    mutationFn: async ({ channelIdHex, category }) => {
      if (!user || !community) throw new Error("Not ready.");
      const trimmed = category?.trim();
      if (trimmed && utf8Len(trimmed) > NAME_MAX_BYTES) {
        throw new Error(`Category names are limited to ${NAME_MAX_BYTES} bytes.`);
      }
      const def = folded?.channels.get(channelIdHex);
      if (!def) throw new Error("Channel not found in the control fold yet; try again shortly.");
      if (def.deleted) throw new Error("This channel was deleted.");
      const ownerHex = folded?.ownerHex ?? community.owner;
      if (!isAuthorized(folded?.roster ?? { roles: [], grants: [] }, user.pubkey, ownerHex, Permissions.MANAGE_CHANNELS)) {
        throw new Error("Filing a channel needs the Manage-channels permission.");
      }
      const head = folded?.heads.get(channelIdHex);
      await publishEdition2(
        nostr,
        community,
        user.signer,
        buildChannelEdition(
          hex32(channelIdHex),
          // Round-trips everything the category doesn't touch — the `private`
          // flag and any sibling extension (CORD-02 §6).
          withChannelCategory(def.metadata, trimmed),
          {
            actorPubkey: user.pubkey,
            version: head ? head.version + 1n : 1n,
            prevHash: head?.hash,
            authority: citationFor(community, folded, user.pubkey),
          },
        ),
      );
      invalidateControl2(queryClient, community.idHex);
    },
  });

  const deleteChannel = useMutation<void, Error, { channelIdHex: string }>({
    mutationFn: async ({ channelIdHex }) => {
      if (!user || !community) throw new Error("Not ready.");
      const def = folded?.channels.get(channelIdHex);
      const head = folded?.heads.get(channelIdHex);
      await publishEdition2(
        nostr,
        community,
        user.signer,
        buildChannelEdition(
          hex32(channelIdHex),
          { ...(def?.metadata ?? { name: "deleted", private: false }), deleted: true },
          {
            actorPubkey: user.pubkey,
            version: head ? head.version + 1n : 1n,
            prevHash: head?.hash,
            authority: citationFor(community, folded, user.pubkey),
          },
        ),
      );
      invalidateControl2(queryClient, community.idHex);
    },
  });

  const attachRepository = useMutation<void, Error, { channelIdHex: string; address: string; relayHints: string[] }>({
    mutationFn: async ({ channelIdHex, address: rawAddress, relayHints }) => {
      if (!user || !community) throw new Error("Not ready.");
      if (!folded || !isAuthorized(folded.roster, user.pubkey, community.owner, Permissions.MANAGE_CHANNELS)) {
        throw new Error("You don't have permission to manage channels.");
      }
      const address = parseGitRepositoryAddress(rawAddress);
      if (!address) throw new Error("Repository address must be a canonical 30617 coordinate.");
      const def = folded?.channels.get(channelIdHex);
      if (!def) throw new Error("Channel not found.");
      const head = folded?.heads.get(channelIdHex);
      const createdAtSecs = Math.floor(Date.now() / 1000);
      const attachments = channelGitRepositoryAttachments(def.metadata);
      // Preserve the original active interval (and its hints) on repeat requests.
      if (attachments.some((attachment) => attachment.address.coordinate === address.coordinate && attachment.detachedAt === undefined)) return;
      const next = attachGitRepository(attachments, address, relayHints, createdAtSecs);
      await publishEdition2(
        nostr,
        community,
        user.signer,
        buildChannelEdition(hex32(channelIdHex), withChannelGitRepositoryAttachments(def.metadata, next), {
          actorPubkey: user.pubkey,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          createdAtSecs,
          authority: citationFor(community, folded, user.pubkey),
        }),
      );
      invalidateControl2(queryClient, community.idHex);
    },
  });

  const detachRepository = useMutation<void, Error, { channelIdHex: string; address: string }>({
    mutationFn: async ({ channelIdHex, address: rawAddress }) => {
      if (!user || !community) throw new Error("Not ready.");
      if (!folded || !isAuthorized(folded.roster, user.pubkey, community.owner, Permissions.MANAGE_CHANNELS)) {
        throw new Error("You don't have permission to manage channels.");
      }
      const address = parseGitRepositoryAddress(rawAddress);
      if (!address) throw new Error("Repository address must be a canonical 30617 coordinate.");
      const def = folded?.channels.get(channelIdHex);
      if (!def) throw new Error("Channel not found.");
      const head = folded?.heads.get(channelIdHex);
      const createdAtSecs = Math.floor(Date.now() / 1000);
      await publishEdition2(
        nostr,
        community,
        user.signer,
        buildChannelEdition(
          hex32(channelIdHex),
          withChannelGitRepositoryAttachments(def.metadata, detachGitRepository(channelGitRepositoryAttachments(def.metadata), address, createdAtSecs)),
          {
            actorPubkey: user.pubkey,
            version: head ? head.version + 1n : 1n,
            prevHash: head?.hash,
            createdAtSecs,
            authority: citationFor(community, folded, user.pubkey),
          },
        ),
      );
      invalidateControl2(queryClient, community.idHex);
    },
  });

  return {
    leave: leave.mutateAsync,
    isLeaving: leave.isPending,
    dissolve: dissolve.mutateAsync,
    isDissolving: dissolve.isPending,
    createChannel: createChannel.mutateAsync,
    isAddingChannel: createChannel.isPending,
    renameChannel: renameChannel.mutateAsync,
    setChannelCategory: setChannelCategory.mutateAsync,
    isFiling: setChannelCategory.isPending,
    moveChannel: moveChannel.mutateAsync,
    isMovingChannel: moveChannel.isPending,
    reorderChannel: reorderChannel.mutateAsync,
    arrangeChannels: arrangeChannels.mutateAsync,
    isArranging: arrangeChannels.isPending,
    isRenaming: renameChannel.isPending,
    privatiseChannel: privatiseChannel.mutateAsync,
    publiciseChannel: publiciseChannel.mutateAsync,
    deleteChannel: deleteChannel.mutateAsync,
    attachRepository: attachRepository.mutateAsync,
    detachRepository: detachRepository.mutateAsync,
    entry,
  };
}

/**
 * Self-heal for a STRANDED member (a stale invite dropped them onto an epoch a
 * pre-join Refounding already superseded — see useRekeyWatch2): re-resolve the
 * SAME link they joined through (`entry.invite_ref`), and when its creator has
 * refreshed the bundle to a higher epoch (CORD-05 §2, now guaranteed on the
 * creator's next community open by useLinkRefreshWatch2), merge it forward.
 *
 * The merge rides the ordinary `add` (epoch-monotonic: `freshest` keeps the
 * higher epoch, `seed` keeps the earliest root), so a still-stale bundle is a
 * no-op and nothing can move backward. After a successful catch-up, a fresh
 * Join is announced on the NEW epoch's Guestbook — the stranded Join landed on
 * the superseded epoch's plane, invisible to current members, and re-following
 * a link announces exactly like a first join (CORD-05 §1).
 *
 * Polls at a relaxed cadence while stranded (the banner also exposes a manual
 * "Check again"). Inert unless `stranded` and the entry carries a link ref.
 */
export function useStrandedRecovery2(
  community: CommunityV2 | undefined,
  stranded: boolean,
): { canRecover: boolean; checking: boolean; checkNow: () => Promise<boolean> } {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { mutateAsync: updateList } = useUpdateCommunityList2();
  const entry = useCommunityEntry2(community?.idHex);
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const inFlight = useRef(false);

  const inviteRef = typeof entry?.invite_ref === "string" ? entry.invite_ref : undefined;
  const canRecover = Boolean(stranded && inviteRef && user && community);
  const bootstrapRelays = config.appRelays.length > 0 ? config.appRelays : STOCK_RELAYS;

  /** One recovery attempt. Resolves true when a fresher epoch was merged in. */
  const checkNow = useCallback(async (): Promise<boolean> => {
    if (!community || !user || !inviteRef || inFlight.current) return false;
    const invite = parseInviteLink(inviteRef);
    if (!invite) return false;
    inFlight.current = true;
    setChecking(true);
    try {
      const bundle = await resolveBundle(nostr, invite, bootstrapRelays);
      // Still vending the epoch we hold (or older): the creator hasn't
      // refreshed yet. Nothing to do — the next poll re-asks.
      if (BigInt(bundle.root_epoch) <= community.rootEpoch) return false;

      const fresh = bundleToEntry(bundle, { inviteRef });
      await updateList({ type: "add", entry: fresh });
      queryClient.invalidateQueries({ queryKey: ["concord2", "list"] });

      // Announce on the epoch we can now read: the stranded Join went to the
      // superseded epoch's Guestbook, which current members never watch.
      void (async () => {
        const rehydrated = rehydrateCommunity(fresh);
        if (!rehydrated) return;
        const attribution = bundle.creator_npub
          ? { creator: bundle.creator_npub, label: bundle.label }
          : undefined;
        const rumor = buildJoinRumor(user.pubkey, Date.now(), attribution);
        const wrap = await sealGuestbook(rumor, currentGuestbookGroup(rehydrated), user.signer);
        await Promise.allSettled(
          rehydrated.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
        );
      })().catch(() => undefined);
      return true;
    } catch {
      // Unreachable relays / revoked / expired: leave the banner up — a revoked
      // link can never heal this member, only a fresh invite can.
      return false;
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.idHex, community?.rootEpoch, user?.pubkey, inviteRef]);

  // Relaxed poll while stranded: the heal depends on the link's creator coming
  // online, which can happen any time — but never poll a closed banner.
  useEffect(() => {
    if (!canRecover) return;
    const timer = setInterval(() => void checkNow(), 60_000);
    return () => clearInterval(timer);
  }, [canRecover, checkNow]);

  return { canRecover, checking, checkNow };
}
