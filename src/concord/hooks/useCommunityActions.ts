import { isRootKeyed } from "@/concord/lib/directInvite";
import { useNostr } from "@nostrify/react";
import { clockNowMs, nowSecs } from "@/lib/relayClock";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { removeCommunityLocally, useCommunityEntry, useUpdateCommunityList } from "@/concord/hooks/useCommunityList";
import { useControlFold, citationFor, foldStoredControl, invalidateControl, markDissolvedLocally, probeCommunityDissolved, publishEdition, withControlWrite } from "@/concord/hooks/useControlPlane";
import type { FoldedControl } from "@/concord/lib/control";
import { publishActivation, publishPendingActivation } from "@/concord/hooks/useRankedRoles";
import { useGuestbookPublisher } from "@/concord/hooks/useGuestbook";
import { attemptGuestbookJoin, forgetGuestbookJoin, queueGuestbookJoin } from "@/concord/lib/pendingGuestbookJoin";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useRemoveRailKey } from "@/hooks/useRemoveRailKey";
import { isBlockedNow, refreshBlocklist } from "@/lib/blocklistStore";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { RESCUE_RELAYS } from "@/lib/platform";
import { verifyEventOnce } from "@/lib/verifyCache";
import { preferPortableRelays, unusableRelaysReason } from "@/lib/relayUsability";
import { channelKeysToWire, isLive, nextChannelEpoch, toJoinMaterial, rehydrateCommunity, type CommunityListEntry, type JoinMaterial } from "@/concord/lib/communityList";
import { channelsView, mintCommunity, visibleChannels } from "@/concord/lib/community";
import { openChannelSeal, sealChannelMetadata } from "@/concord/lib/channelSeal";
import { rekeyOrder } from "@/concord/lib/rankKey";
import { planCreateCategory, planRenameCategory, planSync } from "@/concord/lib/rankedWrites";
import { maySwapOverwrites } from "@/concord/lib/roster";
import { publishChannelRotation } from "@/concord/lib/channelRotation";
import { DEFAULT_MESSAGE_EXPIRATION_SECS } from "@/concord/lib/disappearing";
import { accessRolePosition, channelPermissions, isAuthorized, MAX_ROLES_PER_COMMUNITY, Permissions } from "@/concord/lib/roles";
import { channelEpochFloor, channelRekeyAddressWindow } from "@/concord/lib/rekey";
import {
  buildChannelContentEdition,
  buildChannelEdition,
  buildMetadataEdition,
  buildRoleEdition,
  sealDissolved,
} from "@/concord/lib/control";
import { bytesToHex, epochKeyCommitment, hex32, random32 } from "@/concord/lib/derive";
import {
  encodeFragment,
  InviteError,
  parseBundleEvent,
  parseInviteLink,
  type InviteBundle,
  type ParsedInviteLink,
} from "@/concord/lib/invite";
import { KIND_INVITE_BUNDLE, VSK_INVITE_REVOKED } from "@/concord/lib/kinds";
import {
  claimPendingJoinRun,
  releasePendingJoinRun,
  forgetPendingJoin,
  hasPendingJoin,
  hydratePendingJoins,
  pendingJoinEntriesFor,
  pendingJoinEntry,
  persistPendingJoin,
  recordPendingJoinFailure,
  takeExpiredPendingJoins,
} from "@/concord/lib/pendingJoins";
import { toast } from "@/hooks/useToast";
import { t } from "@/i18n";
import { logSync } from "@/lib/syncLog";
import { ownAvServers } from "@/concord/hooks/useVoice";
import { canonicalOrigin } from "@/concord/lib/voice";
import {
  capRelays,
  channelGitRepositoryAttachments,
  MAX_COMMUNITY_AV_BROKERS,
  NAME_MAX_BYTES,
  utf8Len,
  withChannelGitRepositoryAttachments,
  type ChannelMetadata,
  type ChannelView,
  type Community,
  type ImagePointer,
  type PrivateChannelKey,
} from "@/concord/lib/types";
import { withChannelCategory } from "@/concord/lib/channelCategory";
import { channelPosition, compareChannelOrder, reorderPositions, withChannelPosition } from "@/concord/lib/channelOrder";
import { withChannelView } from "@/concord/lib/channelView";
import { controlGroups, foldControlState, openControlWraps } from "@/concord/lib/control";
import { registerStreamKeys } from "@/concord/lib/streamAuth";

/** Bound on the speculative rekey-address scan when privatising (one REQ per held root). */
const MAX_PROBED_CHANNEL_EPOCH = 64;
import { KIND_WRAP } from "@/concord/lib/kinds";
import { attachGitRepository, detachGitRepository, parseGitRepositoryAddress } from "@/lib/gitActivity";

import type { NostrEvent } from "@nostrify/nostrify";

export class BannedFromCommunityError extends Error {
  constructor() {
    super(t({ id: "useCommunityActions.banned", defaultMessage: "You're banned from this community and can't rejoin." }));
    this.name = "BannedFromCommunityError";
  }
}

export class DissolvedCommunityError extends Error {
  constructor() {
    super(t({ id: "useCommunityActions.dissolved", defaultMessage: "This community was dissolved by its owner and can no longer be joined." }));
    this.name = "DissolvedCommunityError";
  }
}

/**
 * Refuse an invite to a dissolved community (CORD-02 §9): bundles keep
 * resolving after dissolution. Applies to direct invites too. The probe
 * caches recent "not found", so preview + join pay once.
 */
export async function assertNotDissolved(
  nostr: Parameters<typeof probeCommunityDissolved>[0],
  bundle: Pick<InviteBundle, "community_id" | "owner" | "relays">,
): Promise<void> {
  const grave = await probeCommunityDissolved(nostr, {
    communityId: bundle.community_id,
    owner: bundle.owner,
    relays: Array.isArray(bundle.relays) ? bundle.relays : [],
  });
  if (grave !== undefined) throw new DissolvedCommunityError();
}

export class BlockedCommunityError extends Error {
  constructor() {
    super(t({ id: "useCommunityActions.blocked", defaultMessage: "This community is unavailable in Armada." }));
    this.name = "BlockedCommunityError";
  }
}

/**
 * Refuse a community on the blocklist (`blocklistStore.ts`), before any side
 * effect. Refreshes first so a block published minutes ago counts; a relay
 * that can't be reached leaves what is already held.
 */
export async function assertNotBlocked(
  nostr: Parameters<typeof refreshBlocklist>[0],
  communityId: string,
): Promise<void> {
  await refreshBlocklist(nostr);
  if (isBlockedNow(communityId)) throw new BlockedCommunityError();
}

/** Thrown when none of a community's relays is usable on this platform. */
export class UnusableRelaysError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnusableRelaysError";
  }
}

/**
 * Whether a join failure is a VERDICT (asking again gives the same answer)
 * rather than a network failure. Only verdicts drop a pending join; others
 * retry until `PENDING_JOIN_MAX_AGE_MS` / `PENDING_JOIN_MAX_ATTEMPTS`.
 */
export function isJoinRejected(error: unknown): boolean {
  return (
    error instanceof BannedFromCommunityError ||
    error instanceof BlockedCommunityError ||
    error instanceof DissolvedCommunityError ||
    error instanceof UnusableRelaysError ||
    error instanceof InviteError
  );
}

function toastJoinAbandoned(name: string): void {
  toast({
    title: t({ id: "useCommunityActions.joinAbandoned.title", defaultMessage: "Couldn't join {name}" }, { name }),
    description: t({
      id: "useCommunityActions.joinAbandoned.description",
      defaultMessage: "Armada stopped retrying. Ask for a new invite to try again.",
    }),
    variant: "destructive",
  });
}

/** Thrown when the control plane can't be read to verify access (retryable). */
export class ControlUnreadableError extends Error {
  constructor() {
    super(t({ id: "useCommunityActions.controlUnreadable", defaultMessage: "Couldn't verify your access to this community. Please try again." }));
    this.name = "ControlUnreadableError";
  }
}

/**
 * Refuse to join when the CURRENT Banlist names me (CORD-04 §4), before any
 * side effect. Fail CLOSED: a real community always has control editions, so
 * an empty read means withheld/unreachable, not "no ban". NIP-42 authenticated
 * with the control-group keys.
 *
 * ORDERING INVARIANT: fold the FRESH single-epoch bundle entry, before any
 * merge with a held entry (a merged entry would need cross-epoch snapshot
 * attribution; see headCandidates).
 */
export async function assertNotBanned(
  nostr: ReturnType<typeof useNostr>["nostr"],
  community: Community,
  pubkey: string,
): Promise<void> {
  // Enforce the single-epoch invariant: a multi-epoch entry could anchor on a
  // stale fragment and let a banned rejoiner through.
  if (community.heldRoots.length !== 1) throw new ControlUnreadableError();
  const groups = controlGroups(community);
  // Otherwise a gated relay serves nothing and the ban goes unseen.
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

export interface InvitePreview {
  communityId: string;
  name: string;
  channelCount: number;
  relays: string[];
  bundle: InviteBundle;
}

/**
 * Newest bundle event per link coordinate, persisted in KV so a laggard relay's
 * older copy can't regress a later resolve (newest-wins; tombstones stay
 * terminal). Only signature-verified events enter, so forgeries can't pin it.
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
  // Best-effort: losing the floor only re-exposes the relay race.
  getArmadaDB().kv.set(BUNDLE_FLOOR_KV + linkSigner, event).catch(() => undefined);
}

/**
 * Wait for remaining relays after the first valid bundle arrives; a dead relay
 * mustn't hold previews hostage. Stale risk is covered by the floor and the
 * home-relay second hop.
 */
const BUNDLE_GRACE_MS = 250;
const BUNDLE_RELAY_TIMEOUT_MS = 8000;

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
          // Only link-signer-authored, signature-valid events, or a forged far-future
          // event would poison the floor before parseBundleEvent rejects it.
          for (const e of events) {
            if (
              e.kind === KIND_INVITE_BUNDLE &&
              e.pubkey === invite.linkSigner &&
              verifyEventOnce(e)
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

/** Result of resolveBundle's non-blocking home-relay second hop. */
export interface SecondHopResult {
  bundle?: InviteBundle;
  revoked?: boolean;
}

export async function resolveBundle(
  nostr: ReturnType<typeof useNostr>["nostr"],
  invite: ParsedInviteLink,
  fallbackRelays: string[],
  opts?: {
    /**
     * Run the home-relay second hop in the BACKGROUND and report here (for
     * previews; a join re-resolves blocking). The floor is written either way.
     */
    onSecondHop?: (result: SecondHopResult) => void;
  },
): Promise<InviteBundle> {
  const pool = invite.bootstrapRelays.length ? invite.bootstrapRelays : fallbackRelays;
  const flat = await queryBundleCoordinate(nostr, invite, pool);
  // The persisted floor keeps a flaky read from un-replacing what a better read saw.
  const remembered = await readBundleFloor(invite.linkSigner);
  let best = flat[0] as NostrEvent | undefined;
  if (remembered && (!best || remembered.created_at > best.created_at)) best = remembered;
  if (!best) throw new Error(t({ id: "useCommunityActions.inviteNotFound", defaultMessage: "Couldn't find that invite on its relays." }));

  let bundle = parseBundleEvent(best, invite.linkSigner, invite.token, Date.now());

  // Second hop: refreshes always land on the community's HOME relays, even if a
  // bootstrap relay missed it; otherwise stale previews (and keys) could persist.
  const covered = new Set(pool);
  const home = (Array.isArray(bundle.relays) ? bundle.relays : []).filter((r) => !covered.has(r));

  if (home.length > 0 && opts?.onSecondHop) {
    const onSecondHop = opts.onSecondHop;
    // Write the first-hop floor NOW; the background hop only overwrites with strictly newer.
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
        // A newer tombstone terminates; other malformed events keep the first-hop
        // bundle and floor (a floor that doesn't parse would poison later reads).
        if (newer.tags.some((t) => t[0] === "vsk" && t[1] === VSK_INVITE_REVOKED)) {
          writeBundleFloor(invite.linkSigner, newer);
          onSecondHop({ revoked: true });
        }
      }
    })().catch(() => undefined); // the refinement is best-effort
    return bundle;
  }

  if (home.length > 0) {
    const [newer] = await queryBundleCoordinate(nostr, invite, home).catch(() => [] as NostrEvent[]);
    if (newer && newer.created_at > best.created_at) {
      try {
        bundle = parseBundleEvent(newer, invite.linkSigner, invite.token, Date.now());
        best = newer;
      } catch {
        // A newer tombstone terminates; other malformed events keep the first-hop bundle.
        if (newer.tags.some((t) => t[0] === "vsk" && t[1] === VSK_INVITE_REVOKED)) throw new InviteError("revoked", "this invite link has been revoked");
      }
    }
  }

  if (best !== remembered) writeBundleFloor(invite.linkSigner, best);
  return bundle;
}

/**
 * The bundle from the persisted floor, no network. `null` means "ask the
 * network", never "not revoked". Used for instant previews.
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
      ? bundle.channels
          .filter((ch) => !isRootKeyed(ch, bundle))
          .map((ch) => ({ id: ch.id, key: ch.key, epoch: ch.epoch, name: ch.name }))
      : [],
    relays: capRelays(bundle.relays),
    name: bundle.name,
  };
  return {
    community_id: jm.community_id,
    seed: jm,
    current: jm,
    added_at: Date.now(),
    // Lets a member stranded on a superseded epoch re-resolve the SAME link (CORD-05 §2, useStrandedRecovery).
    ...(opts?.inviteRef ? { invite_ref: opts.inviteRef } : {}),
  };
}

/** The domain-agnostic bare form of a parsed invite link: `<naddr>#<fragment>`. */
export function inviteRefOf(invite: ParsedInviteLink): string {
  return `${invite.naddr}#${encodeFragment(invite.token, invite.bootstrapRelays)}`;
}

/**
 * Home relays for a NEW community: the configured community relays, else the
 * CORD stock set. Portable-filtered, deduped, capped. App and DM relays
 * are deliberately not included.
 */
export function defaultCreateRelays(communityRelays: string[]): string[] {
  return capRelays(preferPortableRelays(communityRelays.length > 0 ? communityRelays : RESCUE_RELAYS));
}

/** The create dialog's preselected relays; synchronous so the list paints on first render. */
export function useCreateRelayCandidates(): string[] {
  const { config } = useAppContext();
  return useMemo(() => defaultCreateRelays(config.communityRelays), [config.communityRelays]);
}

/**
 * Create / preview / join. Genesis is EXACTLY two owner-signed editions
 * (metadata + public `#general`, CORD-02 §1), keys recorded in the Community
 * List, the creator's Guestbook Join, then a private `#private` starter.
 */
export function useCommunityActions() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const queryClient = useQueryClient();

  // For fragments with no bootstrap relays: the user's app relays, else the stock interop set.
  const bootstrapRelays = config.appRelays.length > 0 ? config.appRelays : RESCUE_RELAYS;

  const create = useMutation<
    { communityId: string; name: string },
    Error,
    {
      name: string;
      relays?: string[];
      /** The community's voice servers (CORD-02 §6); omitted = the creator's own. */
      avBrokers?: string[];
      messageExpirationSecs?: number;
      /** Optional genesis presentation (CORD-02 §6), from the creation wizard. */
      description?: string;
      icon?: ImagePointer;
      banner?: ImagePointer;
    }
  >({
    mutationFn: async ({ name, relays: chosen, avBrokers: chosenBrokers, messageExpirationSecs, description, icon, banner }) => {
      if (!user) throw new Error(t({ id: "useCommunityActions.signInToCreate", defaultMessage: "Sign in to start an encrypted community." }));
      if (!user.signer.nip44) throw new Error(t({ id: "useCommunityActions.signerNoEncryptedCommunities", defaultMessage: "This signer can't hold encrypted communities (NIP-44 unsupported)." }));
      const trimmed = name.trim();
      if (!trimmed) throw new Error(t({ id: "useCommunityActions.nameRequired", defaultMessage: "Name your community first." }));

      // Prefer wss://: a ws:// relay sealed into the bundle is unreachable from secure origins.
      const relays = chosen && chosen.length > 0
        ? preferPortableRelays(chosen)
        : defaultCreateRelays(config.communityRelays);
      const { community, generalChannelId } = mintCommunity(trimmed, user.pubkey, relays);

      // CORD-08: default 30 days; 0 (off) writes no field.
      const timerSecs = Math.floor(messageExpirationSecs ?? DEFAULT_MESSAGE_EXPIRATION_SECS);

      // In the genesis edition so first-time folders see the face, and an abandoned
      // follow-up can't leave version 1 wrong.
      const trimmedDescription = description?.trim();

      // Members resolve calls from this list (CORD-07 §5), so an explicit EMPTY list is meaningful.
      const avBrokers = (chosenBrokers ?? ownAvServers())
        .map(canonicalOrigin)
        .filter((origin): origin is string => Boolean(origin))
        .slice(0, MAX_COMMUNITY_AV_BROKERS);

      // Genesis: two owner-signed editions, nothing more (CORD-02 §1).
      await publishEdition(
        nostr,
        community,
        user.signer,
        buildMetadataEdition(
          community.id,
          {
            name: trimmed,
            relays: community.relays,
            ...(avBrokers.length > 0 ? { av_brokers: avBrokers } : {}),
            ...(trimmedDescription ? { description: trimmedDescription } : {}),
            ...(icon ? { icon } : {}),
            ...(banner ? { banner } : {}),
            ...(timerSecs > 0 ? { message_expiration: timerSecs } : {}),
          },
          { actorPubkey: user.pubkey, version: 1n },
        ),
      );
      await publishEdition(
        nostr,
        community,
        user.signer,
        buildChannelEdition(
          generalChannelId,
          { name: "general", private: false },
          { actorPubkey: user.pubkey, version: 1n },
        ),
      );

      // On the vsk-13 Roster from the start (CORD-04 §2, Vector `create_community_on_roles_v2`);
      // a switch that can't land leaves it legacy, for the owner to move later.
      let ranked = false;
      for (let attempt = 0; attempt < 2 && !ranked; attempt++) {
        try {
          const stored = await foldStoredControl(community);
          if (!stored.rankedRoster) await publishActivation(nostr, community, user, stored);
          else await publishPendingActivation(nostr, community, user);
          ranked = true;
        } catch (e) {
          logSync("control", `${community.idHex.slice(0, 8)}: the new community's switch to ranked roles failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Private channel key goes into the vault BEFORE its edition publishes, or a
      // lost list write orphans the only copy of the key. On the vsk-13 Roster it is born at epoch 1 (CORD-03 §2).
      const privateStarter: PrivateChannelKey = { id: random32(), key: random32(), epoch: ranked ? 1n : 0n, name: "private" };
      community.privateChannels = [privateStarter];

      // Record membership FIRST (the vault), then announce presence.
      const jm = toJoinMaterial(community, { relays: community.relays });
      await updateList({
        type: "add",
        entry: { community_id: community.idHex, seed: jm, current: jm, added_at: Date.now() },
      });

      // Ranked: key then sealed channel; legacy: role then channel (createChannel ordering). Best-effort past here: genesis
      // landed, so failing would strand a working community and invite a duplicate;
      // roll the key back and ship #general alone.
      try {
        if (ranked) {
          // Its key as a Channel rotation to the owner, then the sealed first edition; closed to everyone but the owner.
          await publishChannelRotation(nostr, community, user, {
            channelId: privateStarter.id,
            epoch: 1n,
            key: privateStarter.key,
            prevEpoch: 0n,
            prevCommit: bytesToHex(epochKeyCommitment(0n, community.root)),
            recipients: [community.owner],
          });
          await publishEdition(
            nostr,
            community,
            user.signer,
            buildChannelContentEdition(
              privateStarter.id,
              sealChannelMetadata({ name: "private", private: true }, privateStarter.key, privateStarter.id, 1n, undefined, { creator: user.pubkey }),
              { actorPubkey: user.pubkey, version: 1n },
            ),
          );
        } else {
          // The owner's rank needs no fold (community_id commitment), so this can't throw for the creator.
          const position = accessRolePosition(undefined, user.pubkey, community.owner);
          if (position === undefined) throw new Error("No resolvable rank for the access role.");
          await publishEdition(
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
          await publishEdition(
            nostr,
            community,
            user.signer,
            buildChannelEdition(
              privateStarter.id,
              { name: "private", private: true },
              { actorPubkey: user.pubkey, version: 1n },
            ),
          );
        }
      } catch {
        community.privateChannels = [];
        await updateList({
          type: "refresh-channels",
          communityId: community.idHex,
          channels: channelKeysToWire([]),
        }).catch(() => undefined);
      }

      queueGuestbookJoin({ viewer: user.pubkey, communityIdHex: community.idHex, ms: clockNowMs() });
      void attemptGuestbookJoin(nostr, community, user.signer, user.pubkey);

      return { communityId: community.idHex, name: trimmed };
    },
  });

  const preview = useMutation<InvitePreview, Error, { invite: ParsedInviteLink }>({
    mutationFn: async ({ invite }) => {
      const bundle = await resolveBundle(nostr, invite, bootstrapRelays);
      await assertNotBlocked(nostr, bundle.community_id);
      // Fail loudly if no relay is reachable here, e.g. ws:// under mixed-content blocking.
      const unusable = unusableRelaysReason(bundle.relays);
      if (unusable) throw new Error(unusable);
      await assertNotDissolved(nostr, bundle);
      return {
        communityId: bundle.community_id,
        name: bundle.name,
        channelCount: Array.isArray(bundle.channels) ? bundle.channels.length : 0,
        relays: bundle.relays,
        bundle,
      };
    },
  });

  // Durable join chain, in order: fresh resolve (catches revocations), reachability,
  // ban check BEFORE any record/publish, vault write, best-effort Guestbook Join.
  // `pendingId` names the pending join; one walked away from isn't written.
  const completeJoin = async (
    invite: ParsedInviteLink,
    pendingId?: string,
  ): Promise<{ communityId: string; name: string }> => {
      if (!user) throw new Error(t({ id: "useCommunityActions.signInToJoin", defaultMessage: "Sign in to join an encrypted community." }));
      const bundle = await resolveBundle(nostr, invite, bootstrapRelays);
      await assertNotBlocked(nostr, bundle.community_id);
      const unusable = unusableRelaysReason(bundle.relays);
      if (unusable) throw new UnusableRelaysError(unusable);
      // Also here: the optimistic path may join from a pre-grave preview bundle.
      await assertNotDissolved(nostr, bundle);
      const entry = bundleToEntry(bundle, { inviteRef: inviteRefOf(invite) });
      // CORD-04 §4: check before recording or publishing anything.
      const community = rehydrateCommunity(entry);
      if (community) await assertNotBanned(nostr, community, user.pubkey);
      const walkedAway = () => pendingId !== undefined && !hasPendingJoin(user.pubkey, pendingId);
      if (walkedAway()) return { communityId: bundle.community_id, name: bundle.name };
      // Date by the CLICK, not this (possibly resumed) run, so a replay can't
      // outrank a later Leave or kick.
      const clicked = pendingId !== undefined ? pendingJoinEntry(user.pubkey, pendingId)?.added_at : undefined;
      if (clicked !== undefined) entry.added_at = clicked;
      const list = await updateList({ type: "add", entry, replay: pendingId !== undefined });
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
      if (!isLive(list, bundle.community_id)) return { communityId: bundle.community_id, name: bundle.name };

      // Guestbook Join (CORD-02 §5 / CORD-05 §1), recorded before the signer is
      // asked so a signer or relay that fails it is retried (`pendingGuestbookJoin`),
      // not dropped. A Leave forgets the record, so it never goes out after one.
      if (community && !walkedAway()) {
        const attribution = bundle.creator_npub
          ? { creator: bundle.creator_npub, label: bundle.label }
          : undefined;
        queueGuestbookJoin({ viewer: user.pubkey, communityIdHex: community.idHex, ms: entry.added_at, attribution });
        void attemptGuestbookJoin(nostr, community, user.signer, user.pubkey);
      }

      return { communityId: bundle.community_id, name: bundle.name };
  };

  /**
   * Run a pending join's chain and settle the record: forgotten on success or
   * refusal, KEPT (and counted) on transient failure. `resumed` retries stay quiet.
   */
  const settleJoin = (
    invite: ParsedInviteLink,
    communityId: string,
    name: string,
    resumed = false,
  ): void => {
    if (!user) return;
    const pubkey = user.pubkey;
    claimPendingJoinRun(pubkey, communityId);
    void completeJoin(invite, communityId)
      .then(() => forgetPendingJoin(pubkey, communityId))
      .catch(async (e) => {
        const rejected = isJoinRejected(e);
        const gaveUp = !rejected && (await recordPendingJoinFailure(pubkey, communityId));
        // Transient (a signer still awaiting approval, slow relays): this session may retry.
        if (!rejected && !gaveUp) releasePendingJoinRun(pubkey, communityId);
        logSync(
          "list2",
          `pending join ${communityId.slice(0, 8)} ${rejected ? "refused" : gaveUp ? "failed, given up on" : "failed, kept for retry"}: ${e instanceof Error ? e.message : String(e)}`,
        );
        if (gaveUp) return toastJoinAbandoned(name);
        if (rejected) void forgetPendingJoin(pubkey, communityId);
        else if (resumed) return;
        toast({
          title:
            e instanceof BannedFromCommunityError
              ? t({ id: "useCommunityActions.joinFailed.banned", defaultMessage: "You're banned" })
              : e instanceof DissolvedCommunityError
                ? t({ id: "useCommunityActions.joinFailed.dissolved", defaultMessage: "{name} was dissolved" }, { name })
                : rejected
                  ? t({ id: "useCommunityActions.joinAbandoned.title", defaultMessage: "Couldn't join {name}" }, { name })
                  : t({ id: "useCommunityActions.joinFailed.unfinished", defaultMessage: "Couldn't finish joining {name}" }, { name }),
          description: rejected
            ? (e instanceof Error ? e.message : t({ id: "useCommunityActions.inviteDidntWork", defaultMessage: "The invite didn't work." }))
            : t({ id: "useCommunityActions.willRetry", defaultMessage: "Armada will try again the next time it starts." }),
          ...(rejected ? { variant: "destructive" as const } : {}),
        });
      });
  };

  const join = useMutation<
    { communityId: string; name: string },
    Error,
    { invite: ParsedInviteLink; bundle?: InviteBundle }
  >({
    mutationFn: async ({ invite, bundle: resolved }) => {
      if (!user) throw new Error(t({ id: "useCommunityActions.signInToJoin", defaultMessage: "Sign in to join an encrypted community." }));
      if (!resolved) return completeJoin(invite);

      // Optimistic path: record a pending entry on disk and answer NOW; the durable
      // chain (with the ban check before any publish) runs behind it.
      if (isBlockedNow(resolved.community_id)) throw new BlockedCommunityError();
      const unusable = unusableRelaysReason(resolved.relays);
      if (unusable) throw new UnusableRelaysError(unusable);
      await persistPendingJoin(user.pubkey, bundleToEntry(resolved, { inviteRef: inviteRefOf(invite) }));
      const { community_id: communityId, name } = resolved;
      settleJoin(invite, communityId, name);
      return { communityId, name };
    },
  });

  return {
    settleJoin,
    create: create.mutateAsync,
    isCreating: create.isPending,
    preview: preview.mutateAsync,
    isPreviewing: preview.isPending,
    join: join.mutateAsync,
    isJoining: join.isPending,
  };
}

/** How often an in-session failed pending join is tried again. */
const PENDING_JOIN_RETRY_MS = 2 * 60_000;

/** Resume pending joins from a previous launch (pendingJoins.ts), and retry this session's failed ones. */
export function useResumePendingJoins(): void {
  const { user } = useCurrentUser();
  const { settleJoin } = useCommunityActions();
  const settleRef = useRef(settleJoin);
  settleRef.current = settleJoin;
  const pubkey = user?.pubkey;
  const canWrite = Boolean(user?.signer.nip44);

  useEffect(() => {
    if (!pubkey || !canWrite) return;
    let cancelled = false;
    const resume = () =>
      void hydratePendingJoins(pubkey).then(() => {
        if (cancelled) return;
        for (const entry of takeExpiredPendingJoins(pubkey)) {
          logSync("list2", `pending join ${entry.community_id.slice(0, 8)} past its retry bound, given up on`);
          toastJoinAbandoned(entry.current.name);
        }
        for (const entry of pendingJoinEntriesFor(pubkey)) {
          if (!claimPendingJoinRun(pubkey, entry.community_id)) continue;
          const invite = typeof entry.invite_ref === "string" ? parseInviteLink(entry.invite_ref) : undefined;
          if (!invite) {
            void forgetPendingJoin(pubkey, entry.community_id);
            continue;
          }
          settleRef.current(invite, entry.community_id, entry.current.name, true);
        }
      });
    resume();
    // A chain that failed this session (a signer awaiting approval) is retried
    // when the user comes back — likely from approving it — and on a slow timer.
    const onVisible = () => {
      if (document.visibilityState === "visible") resume();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(resume, PENDING_JOIN_RETRY_MS);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [pubkey, canWrite]);
}

export function useCommunityManagement(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const { data: folded } = useControlFold(community);
  const publisher = useGuestbookPublisher(community);
  const entry = useCommunityEntry(community?.idHex);
  const queryClient = useQueryClient();
  const removeRailKey = useRemoveRailKey();
  const ranked = folded?.rankedRoster === true;

  /**
   * Publish a Channel's next edition from its details as this member reads them
   * (CORD-03 §2): a sealed head is opened with the held key, edited, and sealed
   * again naming its predecessor; one this member can't open is refused, since a
   * writer MUST NOT seal what it couldn't read. A deletion of a sealed head carries
   * its seal verbatim, so it takes only the bit. `publicise` writes the plain form.
   */
  const writeChannel = async (
    channelIdHex: string,
    edit: (meta: ChannelMetadata) => ChannelMetadata,
    opts: { deleted?: boolean; publicise?: boolean; createdAtSecs?: number } = {},
  ) => {
    if (!community) throw new Error(t({ id: "useCommunityActions.notReady", defaultMessage: "Not ready." }));
    const c = community;
    // One write at a time, from the store's fold: the rendered one lags this device's last write.
    await withControlWrite(c.idHex, async () => {
      const now: FoldedControl | undefined = await foldStoredControl(c).catch(() => folded);
      if (!user || !community) throw new Error(t({ id: "useCommunityActions.notReady", defaultMessage: "Not ready." }));
      requireChannelManager();
      const def = now?.channels.get(channelIdHex);
      const head = now?.heads.get(channelIdHex);
      const common = {
        actorPubkey: user.pubkey,
        version: head ? head.version + 1n : 1n,
        prevHash: head?.hash,
        ...(opts.createdAtSecs !== undefined ? { createdAtSecs: opts.createdAtSecs } : {}),
        authority: citationFor(community, now, user.pubkey),
      };
      let rumor;
      if (def?.sealed && opts.deleted) {
        // The head's own object with `deleted` added, so fields this client doesn't know ride along (Vector `sealed_tombstone`).
        let raw: Record<string, unknown> | undefined;
        try {
          const parsed: unknown = JSON.parse(now?.headEditions.get(channelIdHex)?.content ?? "");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
        } catch {
          // rebuilt below
        }
        const content = JSON.stringify({ ...(raw ?? { private: true, epoch: def.sealed.epoch.toString(), sealed: def.sealed.sealed }), deleted: true });
        rumor = buildChannelContentEdition(hex32(channelIdHex), content, common);
      } else if (def?.sealed) {
        const held = community.privateChannels.find((c) => bytesToHex(c.id) === channelIdHex);
        const opened = held ? openChannelSeal(def.sealed, held) : undefined;
        if (!held || !opened) {
          throw new Error(t({ id: "useCommunityActions.sealedUnreadable", defaultMessage: "You can't read this private channel's details, so you can't change them." }));
        }
        const meta = edit(opened.metadata);
        rumor = opts.publicise
          ? buildChannelEdition(hex32(channelIdHex), { ...meta, private: false }, common)
          : buildChannelContentEdition(
              hex32(channelIdHex),
              sealChannelMetadata(meta, held.key, held.id, held.epoch, head ? bytesToHex(head.hash) : undefined, {
                ...(opened.creator ? { creator: opened.creator } : {}),
                ...(opened.publicUntil !== undefined ? { publicUntil: opened.publicUntil } : {}),
              }),
              common,
            );
      } else {
        const meta = edit(def?.metadata ?? { name: "deleted", private: false });
        const next = opts.deleted ? { ...meta, deleted: true } : opts.publicise ? { ...meta, private: false } : meta;
        // On Roles v2 a Private Channel's details are always sealed (CORD-03 §2, Vector `channel_edition_content`).
        if (now?.rankedRoster && next.private && !opts.deleted) {
          const held = community.privateChannels.find((c) => bytesToHex(c.id) === channelIdHex);
          if (!held) throw new Error(t({ id: "useCommunityActions.privateKeyMissing", defaultMessage: "You don't hold this private channel's key, so you can't change it." }));
          rumor = buildChannelContentEdition(
            hex32(channelIdHex),
            sealChannelMetadata(next, held.key, held.id, held.epoch, head ? bytesToHex(head.hash) : undefined),
            common,
          );
        } else {
          rumor = buildChannelEdition(hex32(channelIdHex), next, common);
        }
      }
      await publishEdition(nostr, community, user.signer, rumor);
    });
  };

  /** Refuse before publishing what every reader drops, which would wedge this member's later edits (Vector `ensure_channel_manager`). */
  const requireChannelManager = () => {
    if (!user || !community) throw new Error(t({ id: "useCommunityActions.notReady", defaultMessage: "Not ready." }));
    const ownerHex = folded?.ownerHex ?? community.owner;
    if (user.pubkey === ownerHex) return;
    if (folded?.banned.has(user.pubkey)) throw new Error(t({ id: "rankedWrites.banned", defaultMessage: "You are banned from this community." }));
    if (!folded || !isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_CHANNELS)) {
      throw new Error(t({ id: "useCommunityActions.noManageChannelsPermission", defaultMessage: "You don't have permission to manage channels." }));
    }
  };

  /** A Channel's details as this member reads them: a sealed head opened with the held key. */
  const readableChannelMetadata = (channelIdHex: string): ChannelMetadata => {
    const def = folded?.channels.get(channelIdHex);
    if (!def) throw new Error(t({ id: "useCommunityActions.channelNotFound", defaultMessage: "Channel not found." }));
    if (!def.sealed) return def.metadata;
    const held = community?.privateChannels.find((c) => bytesToHex(c.id) === channelIdHex);
    const opened = held ? openChannelSeal(def.sealed, held) : undefined;
    if (!opened) throw new Error(t({ id: "useCommunityActions.sealedUnreadable", defaultMessage: "You can't read this private channel's details, so you can't change them." }));
    return opened.metadata;
  };

  /** A Category named by id or name (CORD-03 §4); a ranked Channel files under the id. */
  const categoryIdFor = (category: string | undefined): string | undefined => {
    if (!category) return undefined;
    const cats = [...(folded?.categories?.values() ?? [])].filter((c) => !c.deleted);
    return (cats.find((c) => c.idHex === category.toLowerCase()) ?? cats.find((c) => c.name === category.trim()))?.idHex;
  };

  /** Members a Private Channel lets in once private, its creator counted (CORD-03 §2, CORD-04 §8). */
  const privateAudience = (channelIdHex: string, creator: string): string[] => {
    if (!folded || !community) return [];
    const roster = { ...folded.roster, creators: { ...folded.roster.creators, [channelIdHex]: creator } };
    const candidates = new Set([folded.ownerHex, creator, ...roster.grants.map((g) => g.member)]);
    for (const o of roster.overwrites ?? []) if (o.target.kind === "member") candidates.add(o.target.id);
    return [...candidates].filter((pk) => (channelPermissions(roster, folded.ownerHex, pk, channelIdHex, true) & Permissions.VIEW_CHANNEL) !== 0n);
  };

  const leave = useMutation<void, Error, void>({
    // Local-only; `navigator.onLine` is unreliable in the Android WebView.
    networkMode: "always",
    mutationFn: async () => {
      if (!user || !community) throw new Error(t({ id: "useCommunityActions.notReady", defaultMessage: "Not ready." }));
      const communityId = community.idHex;
      const removedAt = Date.now();
      // The local tombstone is authoritative and on disk now. Walk away from any
      // pending join too, or its chain would re-add membership.
      await forgetPendingJoin(user.pubkey, communityId);
      forgetGuestbookJoin(user.pubkey, communityId);
      await removeCommunityLocally(queryClient, user.pubkey, communityId, removedAt);
      // Follows the local leave so a rejoin doesn't land back in the old folder.
      removeRailKey(`c2:${communityId}`);
      // Guestbook Leave and vault write run in the background (either can take a
      // long time); the outbox and next sync's reconcile retry them.
      void publisher.mutateAsync({ type: "leave" }).catch(() => undefined);
      void updateList({ type: "remove", communityId, removedAt }).catch((e) => {
        logSync(
          "list2",
          `leave ${communityId.slice(0, 8)}: vault write failed (${e instanceof Error ? e.message : String(e)}) — left locally, the next sync republishes it`,
        );
      });
    },
  });

  const dissolve = useMutation<void, Error, { retire?: () => Promise<void> } | void>({
    mutationFn: async (opts) => {
      if (!user || !community) throw new Error(t({ id: "useCommunityActions.notReady", defaultMessage: "Not ready." }));
      if (user.pubkey !== community.owner) throw new Error(t({ id: "useCommunityActions.onlyOwnerDissolves", defaultMessage: "Only the owner can dissolve the community." }));
      const wrap = await sealDissolved(community.id, user.pubkey, user.signer);
      const results = await Promise.allSettled(
        community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
      );
      if (!results.some((r) => r.status === "fulfilled")) {
        throw new Error(t({ id: "useCommunityActions.noRelayAcceptedDissolution", defaultMessage: "No relay accepted the dissolution." }));
      }
      // Mark dissolved BEFORE dropping the vault entry: `useCallSync` treats a gone
      // entry as removal, but a known grave keeps the call connected.
      await markDissolvedLocally(queryClient, community.idHex, Date.now());
      // Retire links/listings only after the grave is accepted. Tombstones and
      // NIP-09 only: nothing may follow the grave on the control plane. Misses are offered as Retry.
      await opts?.retire?.().catch(() => undefined);
      await updateList({ type: "remove", communityId: community.idHex });
    },
  });

  /**
   * Mint a Role scoped to a Private Channel (CORD-04 §2 `scope`); the name is
   * display only. NO permission bits (access is key possession, §1), and minted
   * at the BOTTOM so grantees aren't promoted (see `accessRolePosition`).
   */
  const mintChannelRole = async (channelId: Uint8Array, roleName: string): Promise<string | undefined> => {
    if (!user || !community) return undefined;
    const ownerHex = folded?.ownerHex ?? community.owner;
    // A signer with no resolvable rank may mint no Role (verifiers would drop it as self-promotion).
    const position = accessRolePosition(folded?.roster, user.pubkey, ownerHex);
    if (position === undefined) {
      throw new Error(t({ id: "useCommunityActions.noRankForAccessRole", defaultMessage: "You don't hold a rank that can create this channel's access role." }));
    }
    // At the 100-role cap the fold keeps the lowest role_ids (CORD-04 §2), so a
    // new id could fold out or evict another; refuse.
    if ((folded?.roster.roles.length ?? 0) >= MAX_ROLES_PER_COMMUNITY) {
      throw new Error(t({ id: "useCommunityActions.roleLimit", defaultMessage: "This community is at its 100-role limit; delete a role first." }));
    }
    const roleId = bytesToHex(random32());
    await publishEdition(
      nostr,
      community,
      user.signer,
      buildRoleEdition(
        {
          roleId,
          name: roleName.slice(0, 64),
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

  /** Mint an ADDITIONAL access Role for a Private Channel (entitlement is any-of); held by nobody until granted. */
  const mintAccessRole = useMutation<string | undefined, Error, { channelIdHex: string; name: string }>({
    mutationFn: async ({ channelIdHex, name }) => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error(t({ id: "useCommunityActions.roleNameRequired", defaultMessage: "Role name is required." }));
      const roleId = await mintChannelRole(hex32(channelIdHex), trimmed);
      if (community) invalidateControl(queryClient, community.idHex);
      return roleId;
    },
  });

  const createChannel = useMutation<
    { channelIdHex: string; minted?: PrivateChannelKey },
    Error,
    { name: string; repository?: { address: string; relayHints: string[] }; isPrivate?: boolean; accessRoleName?: string; view?: ChannelView; category?: string }
  >({
    mutationFn: async ({ name, repository, isPrivate, accessRoleName, view, category }) => {
      if (!user || !community) throw new Error(t({ id: "useCommunityActions.notReady", defaultMessage: "Not ready." }));
      const trimmed = name.trim();
      if (!trimmed) throw new Error(t({ id: "useCommunityActions.channelNameRequired", defaultMessage: "Channel name is required." }));
      requireChannelManager();
      const channelId = random32();
      // In the FIRST edition: attachRepository resolves from the fold, which won't
      // have the new channel yet.
      let metadata: ChannelMetadata = { name: trimmed, private: Boolean(isPrivate) };
      // Same: a forum or voice channel opens as one from the start.
      if (view) metadata = withChannelView(metadata, view);
      // Inside a vsk-13 Category (CORD-03 §4); a keyless Channel sorts last in it (Vector `create_channel_in`).
      const cat = ranked && category ? folded?.categories?.get(category.toLowerCase()) : undefined;
      if (category && ranked && (!cat || cat.deleted)) throw new Error(t({ id: "rankedWrites.noSuchCategory", defaultMessage: "No such category." }));
      if (cat) {
        metadata = { ...metadata, category: cat.idHex };
        // Unsynced, a public Channel in a Category with its own rules would sit open to everyone.
        const ownerHex = folded!.ownerHex;
        if (!isPrivate && (folded!.roster.overwrites ?? []).some((o) => o.scope === cat.idHex) && !maySwapOverwrites(folded!.roster, ownerHex, user.pubkey, [cat.idHex], () => 0n)) {
          throw new Error(t({ id: "useCommunityActions.categoryRulesNeedRoles", defaultMessage: "This category sets its own permissions, so a channel in it needs the Manage roles permission over them." }));
        }
      }
      if (repository) {
        const address = parseGitRepositoryAddress(repository.address);
        if (!address) throw new Error(t({ id: "useCommunityActions.repositoryAddressInvalid", defaultMessage: "Repository address must be a canonical 30617 coordinate." }));
        metadata = withChannelGitRepositoryAttachments(
          metadata,
          attachGitRepository([], address, repository.relayHints, nowSecs()),
        );
      }

      // CORD-03: an independent key at epoch 0, stored BEFORE the edition
      // publishes (else the only key copy is orphaned); failures roll back below.
      let minted: PrivateChannelKey | undefined;
      const priorChannels = community.privateChannels;
      if (isPrivate) {
        // On the vsk-13 Roster a Private Channel is born at channel epoch 1 (CORD-03 §2).
        minted = { id: channelId, key: random32(), epoch: ranked ? 1n : 0n, name: trimmed };
        await updateList({
          type: "refresh-channels",
          communityId: community.idHex,
          channels: channelKeysToWire([...priorChannels, minted]),
        });
      }

      try {
        const common = { actorPubkey: user.pubkey, version: 1n, authority: citationFor(community, folded, user.pubkey) };
        if (minted && ranked) {
          // Its key first, as a Channel rotation to its creator and the owner committing
          // to (0, community_root), then the sealed first edition naming its creator.
          await publishChannelRotation(nostr, community, user, {
            channelId,
            epoch: 1n,
            key: minted.key,
            prevEpoch: 0n,
            prevCommit: bytesToHex(epochKeyCommitment(0n, community.root)),
            recipients: [community.owner],
            authority: common.authority,
          });
          await publishEdition(nostr, community, user.signer, buildChannelContentEdition(channelId, sealChannelMetadata(metadata, minted.key, channelId, 1n, undefined, { creator: user.pubkey }), common));
        } else {
          // Role BEFORE the channel edition: an orphan role is inert, while an
          // access-less live channel invites a duplicate retry.
          if (isPrivate) await mintChannelRole(channelId, accessRoleName?.trim() || trimmed);
          await publishEdition(nostr, community, user.signer, buildChannelEdition(channelId, metadata, common));
        }
      } catch (e) {
        if (minted) {
          // Best-effort: remove the unannounced key so it doesn't ghost in the sidebar.
          await updateList({ type: "refresh-channels", communityId: community.idHex, channels: channelKeysToWire(priorChannels) }).catch(() => undefined);
        }
        throw e;
      }
      // A public Channel made inside a Category takes its rules; a private one keeps its own.
      if (cat && !isPrivate) {
        const c = community;
        const u = user;
        await withControlWrite(c.idHex, async () => {
          const now = await foldStoredControl(c);
          const held = new Set(c.privateChannels.map((k) => bytesToHex(k.id)));
          await publishEdition(nostr, c, u.signer, planSync(now, c.id, u.pubkey, held, bytesToHex(channelId), cat.idHex, citationFor(c, now, u.pubkey)));
        }).catch((e: unknown) => logSync("control", `new channel keeps its own rules: ${e instanceof Error ? e.message : String(e)}`));
      }
      invalidateControl(queryClient, community.idHex);
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
      return { channelIdHex: bytesToHex(channelId), minted };
    },
  });

  const renameChannel = useMutation<void, Error, { channelIdHex: string; name: string }>({
    mutationFn: async ({ channelIdHex, name }) => {
      if (!user || !community) throw new Error(t({ id: "useCommunityActions.notReady", defaultMessage: "Not ready." }));
      const trimmed = name.trim();
      if (!trimmed) throw new Error(t({ id: "useCommunityActions.channelNameRequired", defaultMessage: "Channel name is required." }));
      // Round-trip untouched metadata (CORD-02 §6).
      await writeChannel(channelIdHex, (meta) => ({ ...meta, name: trimmed }));
      invalidateControl(queryClient, community.idHex);
    },
  });

  /**
   * Convert Public → Private on ranked roles (CORD-03 §2): mint a key at the next
   * channel epoch (stored before the edition), deliver it, and seal the details.
   * Protects the future only: prior history stays readable to all members.
   */
  const privatiseChannel = useMutation<
    { minted?: PrivateChannelKey },
    Error,
    { channelIdHex: string }
  >({
    mutationFn: ({ channelIdHex }) => withControlWrite(community?.idHex ?? "", async () => {
      if (!user || !community) throw new Error(t({ id: "useCommunityActions.notReady", defaultMessage: "Not ready." }));
      // From the store's fold: the rendered one lags this device's last write (a rename just made).
      const now = await foldStoredControl(community).catch(() => folded);
      const def = now?.channels.get(channelIdHex);
      if (!def) throw new Error(t({ id: "useCommunityActions.channelNotInFold", defaultMessage: "Channel not found in the control fold yet; try again shortly." }));
      if (def.isPrivate) throw new Error(t({ id: "useCommunityActions.alreadyPrivate", defaultMessage: "This channel is already private." }));
      requireChannelManager();
      // A plain edition never makes a Channel private for Vector's readers: that takes the sealed form (CORD-03 §2).
      if (!ranked) throw new Error(t({ id: "useCommunityActions.privatiseNeedsRanked", defaultMessage: "Making a channel private needs the community on ranked roles. Switch to ranked roles first." }));
      const head = now?.heads.get(channelIdHex);

      // CORD-03 §2: mint at the NEXT channel_epoch (never reset, or two keys share
      // an epoch). The floor is read off the wire (CORD-06 §2 addresses are
      // derivable), so unheld generations still count.
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
        // Unreachable relays: the local floor stands alone.
      }
      // A saturated probe THROWS: hitting the window edge proves only the edge, and
      // minting on that guess could collide.
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

      try {
        // A key rotation at epoch n committing to (n − 1, community_root), to everyone
        // the Channel lets in once private, then its first sealed edition naming the
        // converter as creator and when it went private (CORD-03 §2).
        await publishChannelRotation(nostr, community, user, {
          channelId,
          epoch: minted.epoch,
          key: minted.key,
          prevEpoch: minted.epoch - 1n,
          prevCommit: bytesToHex(epochKeyCommitment(minted.epoch - 1n, community.root)),
          recipients: privateAudience(channelIdHex, user.pubkey),
          authority: citationFor(community, now, user.pubkey),
        });
        await publishEdition(
          nostr,
          community,
          user.signer,
          buildChannelContentEdition(
            channelId,
            sealChannelMetadata(def.metadata, minted.key, channelId, minted.epoch, head ? bytesToHex(head.hash) : undefined, { creator: user.pubkey, publicUntil: clockNowMs() }),
            { actorPubkey: user.pubkey, version: head ? head.version + 1n : 1n, prevHash: head?.hash, authority: citationFor(community, now, user.pubkey) },
          ),
        );
        invalidateControl(queryClient, community.idHex);
        queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
        return { minted };
      } catch (e) {
        await updateList({ type: "refresh-channels", communityId: community.idHex, channels: channelKeysToWire(priorChannels) }).catch(() => undefined);
        throw e;
      }
    }),
  });

  /**
   * Convert Private → Public (CORD-03 §2): flip the flag only. The held key
   * stays so the private era remains readable to its holders; the scoped Role
   * is left (inert).
   */
  const publiciseChannel = useMutation<void, Error, { channelIdHex: string }>({
    mutationFn: async ({ channelIdHex }) => {
      if (!user || !community) throw new Error(t({ id: "useCommunityActions.notReady", defaultMessage: "Not ready." }));
      const def = folded?.channels.get(channelIdHex);
      if (!def) throw new Error(t({ id: "useCommunityActions.channelNotInFold", defaultMessage: "Channel not found in the control fold yet; try again shortly." }));
      if (!def.isPrivate) throw new Error(t({ id: "useCommunityActions.alreadyPublic", defaultMessage: "This channel is already public." }));
      if (def.deleted) throw new Error(t({ id: "useCommunityActions.channelDeleted", defaultMessage: "This channel was deleted." }));
      const ownerHex = folded?.ownerHex ?? community.owner;
      if (!isAuthorized(folded?.roster ?? { roles: [], grants: [] }, user.pubkey, ownerHex, Permissions.MANAGE_CHANNELS)) {
        throw new Error(t({ id: "useCommunityActions.makePublicNeedsPermission", defaultMessage: "Making a channel public needs the Manage-channels permission." }));
      }
      // The plain form, from the details as read (CORD-03 §2).
      await writeChannel(channelIdHex, (meta) => meta, { publicise: true });
      invalidateControl(queryClient, community.idHex);
    },
  });

  /** The sidebar's channel order: the shared index space for every reorder. */
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
   * A drag on the vsk-13 Roster (CORD-03 §2, §4): each moved Channel files under its
   * Category's id and takes a rank key between its new neighbours, a neighbour with
   * no key or out of order keyed first. `position` is the index within its group.
   */
  const arrangeRanked = async (changes: Array<{ idHex: string; position: number; category: string | undefined; keepCategory?: boolean }>) => {
    if (!community) return;
    const view = channelsView(community, folded);
    const groupOf = new Map(view.map((c) => [c.idHex, c.categoryId]));
    const moved = new Map(changes.map((c) => [c.idHex, c]));
    for (const c of changes) if (!c.keepCategory) groupOf.set(c.idHex, categoryIdFor(c.category));
    const groups = new Map<string | undefined, Array<{ id: string; key?: string }>>();
    for (const c of view) {
      if (moved.has(c.idHex)) continue;
      const g = groupOf.get(c.idHex);
      groups.set(g, [...(groups.get(g) ?? []), { id: c.idHex, key: c.positionKey }]);
    }
    for (const c of [...changes].sort((a, b) => a.position - b.position)) {
      const g = groupOf.get(c.idHex);
      const list = groups.get(g) ?? [];
      list.splice(Math.min(Math.max(0, c.position), list.length), 0, { id: c.idHex, key: view.find((v) => v.idHex === c.idHex)?.positionKey });
      groups.set(g, list);
    }
    // Only the groups a Channel lands in are keyed: the rest keep their order (Vector `move_channel`).
    const landed = new Set(changes.map((c) => groupOf.get(c.idHex)));
    const filed = new Map<string, string[]>();
    for (const [g, list] of groups) {
      if (!landed.has(g)) continue;
      const keys = rekeyOrder(list, new Set(changes.map((c) => c.idHex)));
      for (const item of list) {
        const key = keys.get(item.id);
        const refile = moved.has(item.id) && !moved.get(item.id)!.keepCategory && view.find((v) => v.idHex === item.id)?.categoryId !== g;
        if (refile && g) filed.set(g, [...(filed.get(g) ?? []), item.id]);
        if (key === undefined && !refile) continue;
        await writeChannel(item.id, (meta) => {
          const { category: _category, ...rest } = meta;
          const next: ChannelMetadata = moved.has(item.id) && !moved.get(item.id)!.keepCategory ? (g ? { ...rest, category: g } : rest) : meta;
          return key !== undefined ? { ...next, position: key } : next;
        });
      }
    }
    for (const [g, ids] of filed) await followCategory(ids, g);
  };

  /**
   * A public Channel filed into a Category follows its rules, as one made there does
   * (CORD-04 §8), unless it has rules of its own: those it keeps, and the mover is told.
   */
  const followCategory = async (channelIds: readonly string[], categoryId: string | undefined) => {
    if (!ranked || !categoryId || !community || !user) return;
    const c = community;
    const u = user;
    const kept: string[] = [];
    await withControlWrite(c.idHex, async () => {
      const now = await foldStoredControl(c).catch(() => folded);
      if (!now) return;
      const held = new Set(c.privateChannels.map((k) => bytesToHex(k.id)));
      const ruled = new Set((now.roster.overwrites ?? []).map((o) => o.scope));
      for (const id of channelIds) {
        const def = now.channels.get(id);
        if (!def || def.deleted || def.isPrivate || now.roster.syncs?.[id] === categoryId) continue;
        if (ruled.has(id)) {
          kept.push(def.name);
          continue;
        }
        try {
          await publishEdition(nostr, c, u.signer, planSync(now, c.id, u.pubkey, held, id, categoryId, citationFor(c, now, u.pubkey)));
        } catch (e) {
          logSync("control", `#${id.slice(0, 8)} keeps its own rules: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    });
    if (kept.length > 0) {
      toast({
        title: t(
          { id: "useCommunityActions.keptOwnRules", defaultMessage: "{count, plural, one {{names} keeps its own permissions} other {{names} keep their own permissions}}" },
          { count: kept.length, names: kept.map((n) => `#${n}`).join(", ") },
        ),
        description: t({ id: "useCommunityActions.keptOwnRulesHint", defaultMessage: "To follow the category's rules instead, sync from the category's permissions." }),
      });
    }
  };

  /**
   * One Channel edition per changed position. The first reorder in a
   * never-ordered community stamps every channel. Partial failures stay coherent.
   */
  const publishPositions = useCallback(
    async (moves: Array<{ idHex: string; position: number }>) => {
      if (!user || !community) throw new Error(t({ id: "useCommunityActions.notReady", defaultMessage: "Not ready." }));
      if (ranked) {
        await arrangeRanked(moves.map((m) => ({ ...m, category: undefined, keepCategory: true })));
      } else {
        for (const { idHex, position } of moves) {
          if (!folded?.channels.get(idHex)) continue;
          // Round-trip untouched metadata (CORD-02 §6).
          await writeChannel(idHex, (meta) => withChannelPosition(meta, position));
        }
      }
      invalidateControl(queryClient, community.idHex);
    },
    [user, community, folded, nostr, queryClient],
  );

  /**
   * A drag's positions index the sidebar as the viewer sees it, the whole list across
   * Categories; on the vsk-13 Roster each moved Channel takes its index within the
   * group it lands in, counted among every Channel there, hidden ones included.
   */
  const withinGroups = (changes: Array<{ idHex: string; position: number; category: string | undefined }>) => {
    if (!community) return changes;
    const view = channelsView(community, folded);
    const groupOf = new Map<string, string | undefined>(view.map((c) => [c.idHex, c.categoryId]));
    for (const c of changes) groupOf.set(c.idHex, categoryIdFor(c.category));
    const moved = new Set(changes.map((c) => c.idHex));
    // The sidebar's order after the drop, as the viewer sees it.
    const shown = visibleChannels(view, folded, user?.pubkey).map((c) => c.idHex).filter((id) => !moved.has(id));
    for (const c of [...changes].sort((a, b) => a.position - b.position)) shown.splice(Math.min(Math.max(0, c.position), shown.length), 0, c.idHex);
    const at = new Map<string, number>();
    const groups = new Set(changes.map((c) => groupOf.get(c.idHex)));
    for (const g of groups) {
      // A Channel the viewer can't see keeps its place after the one it followed.
      const all = view.filter((c) => groupOf.get(c.idHex) === g && !moved.has(c.idHex)).map((c) => c.idHex);
      const visible = new Set(shown);
      const order = shown.filter((id) => groupOf.get(id) === g);
      for (let i = 0; i < all.length; i++) {
        if (visible.has(all[i])) continue;
        const prev = all.slice(0, i).reverse().find((id) => order.includes(id));
        order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, all[i]);
      }
      order.forEach((id, i) => at.set(id, i));
    }
    return changes.map((c) => ({ ...c, position: at.get(c.idHex) ?? c.position }));
  };

  /** Apply a drag's arrangement: ONE edition per channel carrying both position and category. */
  const arrangeChannels = useMutation<
    void,
    Error,
    Array<{ idHex: string; position: number; category: string | undefined }>
  >({
    mutationFn: async (changes) => {
      if (!user || !community) throw new Error(t({ id: "useCommunityActions.notReady", defaultMessage: "Not ready." }));
      const ownerHex = folded?.ownerHex ?? community.owner;
      if (!isAuthorized(folded?.roster ?? { roles: [], grants: [] }, user.pubkey, ownerHex, Permissions.MANAGE_CHANNELS)) {
        throw new Error(t({ id: "useCommunityActions.rearrangeNeedsPermission", defaultMessage: "Rearranging channels needs the Manage-channels permission." }));
      }
      if (ranked) {
        await arrangeRanked(withinGroups(changes));
      } else {
        for (const { idHex, position, category } of changes) {
          if (!folded?.channels.get(idHex)) continue;
          // Round-trip untouched metadata (CORD-02 §6).
          await writeChannel(idHex, (meta) => withChannelPosition(withChannelCategory(meta, category), position));
        }
      }
      invalidateControl(queryClient, community.idHex);
    },
  });

  /** On the vsk-13 Roster a Channel moves among its own Category's, as the sidebar lists them. */
  const groupOrder = (channelIdHex: string): string[] | undefined => {
    if (!community) return undefined;
    const view = channelsView(community, folded);
    const group = view.find((c) => c.idHex === channelIdHex)?.categoryId;
    if (!view.some((c) => c.idHex === channelIdHex)) return undefined;
    return view.filter((c) => c.categoryId === group).map((c) => c.idHex);
  };
  const moveRanked = async (channelIdHex: string, to: (from: number, length: number) => number) => {
    const order = groupOrder(channelIdHex);
    const from = order?.indexOf(channelIdHex) ?? -1;
    if (!order || from === -1) throw new Error(t({ id: "useCommunityActions.channelNotInFold", defaultMessage: "Channel not found in the control fold yet; try again shortly." }));
    const index = to(from, order.length);
    if (index === from || index < 0 || index >= order.length) return;
    await arrangeRanked([{ idHex: channelIdHex, position: index, category: undefined, keepCategory: true }]);
    if (community) invalidateControl(queryClient, community.idHex);
  };

  const moveChannel = useMutation<void, Error, { channelIdHex: string; direction: -1 | 1 }>({
    mutationFn: async ({ channelIdHex, direction }) => {
      if (ranked) return moveRanked(channelIdHex, (from) => from + direction);
      const ordered = orderedForMove();
      const from = ordered.findIndex((c) => c.idHex === channelIdHex);
      if (from === -1) throw new Error(t({ id: "useCommunityActions.channelNotInFold", defaultMessage: "Channel not found in the control fold yet; try again shortly." }));
      const to = from + direction;
      if (to < 0 || to >= ordered.length) return;
      await publishPositions(reorderPositions(ordered, from, to));
    },
  });

  /** Move a channel to an ABSOLUTE slot (drag drop index). */
  const reorderChannel = useMutation<void, Error, { channelIdHex: string; toIndex: number }>({
    mutationFn: async ({ channelIdHex, toIndex }) => {
      if (ranked) return moveRanked(channelIdHex, (_from, length) => Math.max(0, Math.min(toIndex, length - 1)));
      const ordered = orderedForMove();
      const from = ordered.findIndex((c) => c.idHex === channelIdHex);
      if (from === -1) throw new Error(t({ id: "useCommunityActions.channelNotInFold", defaultMessage: "Channel not found in the control fold yet; try again shortly." }));
      await publishPositions(reorderPositions(ordered, from, Math.max(0, Math.min(toIndex, ordered.length - 1))));
    },
  });

  /**
   * File a channel into a category (or out with `undefined`); categories are
   * just the channels naming them. Refuses channels not yet in the fold, since
   * editing a default metadata would blank the name and make a private channel public.
   */
  const setChannelCategory = useMutation<void, Error, { channelIdHex: string; category: string | undefined }>({
    mutationFn: async ({ channelIdHex, category }) => {
      if (!user || !community) throw new Error(t({ id: "useCommunityActions.notReady", defaultMessage: "Not ready." }));
      const trimmed = category?.trim();
      if (trimmed && utf8Len(trimmed) > NAME_MAX_BYTES) {
        throw new Error(t({ id: "useCommunityActions.categoryNameTooLong", defaultMessage: "Category names are limited to {max} bytes." }, { max: NAME_MAX_BYTES }));
      }
      const def = folded?.channels.get(channelIdHex);
      if (!def) throw new Error(t({ id: "useCommunityActions.channelNotInFold", defaultMessage: "Channel not found in the control fold yet; try again shortly." }));
      if (def.deleted) throw new Error(t({ id: "useCommunityActions.channelDeleted", defaultMessage: "This channel was deleted." }));
      const ownerHex = folded?.ownerHex ?? community.owner;
      if (!isAuthorized(folded?.roster ?? { roles: [], grants: [] }, user.pubkey, ownerHex, Permissions.MANAGE_CHANNELS)) {
        throw new Error(t({ id: "useCommunityActions.fileNeedsPermission", defaultMessage: "Filing a channel needs the Manage-channels permission." }));
      }
      // A ranked Channel files under a Category's id (CORD-03 §4); Armada's name otherwise.
      const catId = ranked ? categoryIdFor(trimmed) : undefined;
      if (ranked && trimmed && !catId) {
        throw new Error(t({ id: "useCommunityActions.noSuchCategory", defaultMessage: "There's no category by that name." }));
      }
      await writeChannel(channelIdHex, (meta) => {
        if (!ranked) return withChannelCategory(meta, trimmed);
        const { category: _category, ...rest } = meta;
        return catId ? { ...rest, category: catId } : rest;
      });
      await followCategory([channelIdHex], catId);
      invalidateControl(queryClient, community.idHex);
    },
  });

  /**
   * Name a category for `channelIds`: on the vsk-13 Roster a new Category entity
   * (CORD-03 §4) the Channels file under, or a rename of `categoryId` in place;
   * otherwise every Channel re-filed under the name.
   */
  const nameCategory = useMutation<void, Error, { channelIds: readonly string[]; categoryId?: string; name: string }>({
    mutationFn: async ({ channelIds, categoryId, name }) => {
      if (!user || !community) throw new Error(t({ id: "useCommunityActions.notReady", defaultMessage: "Not ready." }));
      if (!ranked || !folded) {
        for (const channelIdHex of channelIds) await setChannelCategory.mutateAsync({ channelIdHex, category: name });
        return;
      }
      const c = community;
      // One write at a time, from the store's fold: the rendered one lags this device's last write.
      const created = await withControlWrite(c.idHex, async () => {
        const now = await foldStoredControl(c).catch(() => folded);
        const authority = citationFor(c, now, user.pubkey);
        if (categoryId) {
          await publishEdition(nostr, c, user.signer, planRenameCategory(now, c.id, user.pubkey, categoryId, name, authority));
          return undefined;
        }
        const { idHex, rumor } = planCreateCategory(now, c.id, user.pubkey, name, authority);
        await publishEdition(nostr, c, user.signer, rumor);
        return idHex;
      });
      // Each Channel edition takes the lock itself.
      if (created) {
        for (const channelIdHex of channelIds) {
          await writeChannel(channelIdHex, (meta) => {
            const { category: _category, ...rest } = meta;
            return { ...rest, category: created };
          });
        }
        await followCategory(channelIds, created);
      }
      invalidateControl(queryClient, community.idHex);
    },
  });

  /** Set what a channel opens to (CORD-03 §2 `view`); same id, chat plane untouched. Same not-yet-folded refusal. */
  const setChannelView = useMutation<void, Error, { channelIdHex: string; view: ChannelView }>({
    mutationFn: async ({ channelIdHex, view }) => {
      if (!user || !community) throw new Error(t({ id: "useCommunityActions.notReady", defaultMessage: "Not ready." }));
      const def = folded?.channels.get(channelIdHex);
      if (!def) throw new Error(t({ id: "useCommunityActions.channelNotInFold", defaultMessage: "Channel not found in the control fold yet; try again shortly." }));
      if (def.deleted) throw new Error(t({ id: "useCommunityActions.channelDeleted", defaultMessage: "This channel was deleted." }));
      const ownerHex = folded?.ownerHex ?? community.owner;
      if (!isAuthorized(folded?.roster ?? { roles: [], grants: [] }, user.pubkey, ownerHex, Permissions.MANAGE_CHANNELS)) {
        throw new Error(t({ id: "useCommunityActions.changeViewNeedsPermission", defaultMessage: "Changing how a channel opens needs the Manage-channels permission." }));
      }
      // Round-trip untouched metadata (CORD-02 §6).
      await writeChannel(channelIdHex, (meta) => withChannelView(meta, view));
      invalidateControl(queryClient, community.idHex);
    },
  });

  const deleteChannel = useMutation<void, Error, { channelIdHex: string }>({
    mutationFn: async ({ channelIdHex }) => {
      if (!user || !community) throw new Error(t({ id: "useCommunityActions.notReady", defaultMessage: "Not ready." }));
      await writeChannel(channelIdHex, (meta) => meta, { deleted: true });
      invalidateControl(queryClient, community.idHex);
    },
  });

  const attachRepository = useMutation<void, Error, { channelIdHex: string; address: string; relayHints: string[] }>({
    mutationFn: async ({ channelIdHex, address: rawAddress, relayHints }) => {
      if (!user || !community) throw new Error(t({ id: "useCommunityActions.notReady", defaultMessage: "Not ready." }));
      if (!folded || !isAuthorized(folded.roster, user.pubkey, community.owner, Permissions.MANAGE_CHANNELS)) {
        throw new Error(t({ id: "useCommunityActions.noManageChannelsPermission", defaultMessage: "You don't have permission to manage channels." }));
      }
      const address = parseGitRepositoryAddress(rawAddress);
      if (!address) throw new Error(t({ id: "useCommunityActions.repositoryAddressInvalid", defaultMessage: "Repository address must be a canonical 30617 coordinate." }));
      const current = readableChannelMetadata(channelIdHex);
      const createdAtSecs = nowSecs();
      // Preserve the original active interval (and its hints) on repeat requests.
      const attachments = channelGitRepositoryAttachments(current);
      if (attachments.some((attachment) => attachment.address.coordinate === address.coordinate && attachment.detachedAt === undefined)) return;
      await writeChannel(
        channelIdHex,
        (meta) => withChannelGitRepositoryAttachments(meta, attachGitRepository(channelGitRepositoryAttachments(meta), address, relayHints, createdAtSecs)),
        { createdAtSecs },
      );
      invalidateControl(queryClient, community.idHex);
    },
  });

  const detachRepository = useMutation<void, Error, { channelIdHex: string; address: string }>({
    mutationFn: async ({ channelIdHex, address: rawAddress }) => {
      if (!user || !community) throw new Error(t({ id: "useCommunityActions.notReady", defaultMessage: "Not ready." }));
      if (!folded || !isAuthorized(folded.roster, user.pubkey, community.owner, Permissions.MANAGE_CHANNELS)) {
        throw new Error(t({ id: "useCommunityActions.noManageChannelsPermission", defaultMessage: "You don't have permission to manage channels." }));
      }
      const address = parseGitRepositoryAddress(rawAddress);
      if (!address) throw new Error(t({ id: "useCommunityActions.repositoryAddressInvalid", defaultMessage: "Repository address must be a canonical 30617 coordinate." }));
      readableChannelMetadata(channelIdHex);
      const createdAtSecs = nowSecs();
      await writeChannel(
        channelIdHex,
        (meta) => withChannelGitRepositoryAttachments(meta, detachGitRepository(channelGitRepositoryAttachments(meta), address, createdAtSecs)),
        { createdAtSecs },
      );
      invalidateControl(queryClient, community.idHex);
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
    nameCategory: nameCategory.mutateAsync,
    setChannelView: setChannelView.mutateAsync,
    isSettingView: setChannelView.isPending,
    moveChannel: moveChannel.mutateAsync,
    isMovingChannel: moveChannel.isPending,
    reorderChannel: reorderChannel.mutateAsync,
    arrangeChannels: arrangeChannels.mutateAsync,
    isArranging: arrangeChannels.isPending,
    isRenaming: renameChannel.isPending,
    privatiseChannel: privatiseChannel.mutateAsync,
    publiciseChannel: publiciseChannel.mutateAsync,
    mintAccessRole: mintAccessRole.mutateAsync,
    isMintingAccessRole: mintAccessRole.isPending,
    deleteChannel: deleteChannel.mutateAsync,
    attachRepository: attachRepository.mutateAsync,
    detachRepository: detachRepository.mutateAsync,
    entry,
  };
}

/**
 * Self-heal a STRANDED member (see useRekeyWatch): re-resolve the joined link
 * (`entry.invite_ref`) and merge a refreshed higher-epoch bundle forward via
 * the epoch-monotonic `add`, then announce a Join on the new Guestbook.
 * Polls while stranded; inert without a link ref.
 */
export function useStrandedRecovery(
  community: Community | undefined,
  stranded: boolean,
): { canRecover: boolean; checking: boolean; checkNow: () => Promise<boolean> } {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const entry = useCommunityEntry(community?.idHex);
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const inFlight = useRef(false);

  const inviteRef = typeof entry?.invite_ref === "string" ? entry.invite_ref : undefined;
  const canRecover = Boolean(stranded && inviteRef && user && community);
  const bootstrapRelays = config.appRelays.length > 0 ? config.appRelays : RESCUE_RELAYS;

  /** True when a fresher epoch was merged in. */
  const checkNow = useCallback(async (): Promise<boolean> => {
    if (!community || !user || !inviteRef || inFlight.current) return false;
    const invite = parseInviteLink(inviteRef);
    if (!invite) return false;
    inFlight.current = true;
    setChecking(true);
    try {
      const bundle = await resolveBundle(nostr, invite, bootstrapRelays);
      // The creator hasn't refreshed yet.
      if (BigInt(bundle.root_epoch) <= community.rootEpoch) return false;

      const fresh = bundleToEntry(bundle, { inviteRef });
      await updateList({ type: "add", entry: fresh });
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });

      // A Join on the new epoch is restored once its Guestbook is read and holds no state
      // of ours, dated by the plane (`useRestoreJoin`, CORD-02 §5): a snapshot may already seed us.
      return true;
    } catch {
      // A revoked link can never heal this; only a fresh invite can.
      return false;
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.idHex, community?.rootEpoch, user?.pubkey, inviteRef]);

  // Never poll a closed banner.
  useEffect(() => {
    if (!canRecover) return;
    const timer = setInterval(() => void checkNow(), 60_000);
    return () => clearInterval(timer);
  }, [canRecover, checkNow]);

  return { canRecover, checking, checkNow };
}
