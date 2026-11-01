import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useControlFold, citationFor, invalidateControl, publishEdition, useDissolved } from "@/concord/hooks/useControlPlane";
import { useCommunity } from "@/concord/hooks/useCommunityList";
import { resolveBundle } from "@/concord/hooks/useCommunityActions";
import { useUnlistAnnouncements } from "@/concord/hooks/useDiscoverListings";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAppContext } from "@/hooks/useAppContext";
import { selfStateRelays } from "@/contexts/AppContext";
import { buildRegistryEdition } from "@/concord/lib/control";
import { vendableChannels, type VendAudience } from "@/concord/lib/channelAccess";
import { isAuthorized, Permissions } from "@/concord/lib/roles";
import { bytesToHex, grantLocator, hexToBytes, inviteLinksLocator, hex32 } from "@/concord/lib/derive";
import {
  buildDirectInviteRumor,
  sealDirectInvite,
  wrapDirectInvite,
} from "@/concord/lib/directInvite";
import {
  buildBundleEvent,
  buildInviteUrl,
  buildRefreshedBundleEvents,
  buildRevocationEvent,
  capBundleDescription,
  EMPTY_INVITE_LIST,
  InviteError,
  inviteTombstoneFor,
  mergeInviteLists,
  pruneExpiredInvites,
  mintLinkSigner,
  mintToken,
  parseInviteLink,
  shareableInviteUrl,
  type InviteBundle,
  type InviteList,
} from "@/concord/lib/invite";
import { KIND_INVITE_LIST } from "@/concord/lib/kinds";
import { buildCommunityAnnouncement } from "@/concord/lib/inviteDiscovery";
import { inviteDeliveryRelays, recipientInboxRelays } from "@/concord/lib/inviteRelays";
import { publishToAnyRelay } from "@/concord/lib/relayPublish";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { toast } from "@/hooks/useToast";
import { RESCUE_RELAYS } from "@/lib/platform";
import { linkStoreBase, shareOrigin } from "@/lib/shareOrigin";
import {
  publishSignedEventToRelays,
  queryExplicitRelaysWithStatus,
  uniqueRelayUrls,
} from "@/lib/nip65";
import {
  queueSignedEvent,
  recordQueuedPublishAttempt,
} from "@/lib/publishOutbox";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import { isSigned, type NostrRumor } from "@/lib/nostrRumor";
import type { Community } from "@/concord/lib/types";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NUser } from "@nostrify/react/login";
import { t } from "@/i18n";

/**
 * The creator's Invite List (kind 13303, CORD-05 §4): private bookkeeping for
 * minted links (unlock token AND link-signer secret), NIP-44-encrypted to self.
 */
export const inviteListKey = (pubkey: string | undefined) => ["concord", "invite-list", pubkey] as const;
export const inviteListFoldKey = (pubkey: string) => `concord2-invite-list:${pubkey}`;

export interface PersistedInviteList {
  list: InviteList;
  newestCreatedAt: number;
  /** A merge-only local patch still needs a signed relay reconciliation. */
  needsPublish?: boolean;
}

export function readPersistedInviteList(pubkey: string): Promise<PersistedInviteList | undefined> {
  return readFolded<PersistedInviteList>(inviteListFoldKey(pubkey));
}

/** Explicit NIP-65/account destinations plus the fixed CORD rescue floor. */
export function inviteListRelays(selfRelays: Iterable<string>): string[] {
  return uniqueRelayUrls([...selfRelays, ...RESCUE_RELAYS]);
}

/** Queue exact signed bytes, fan every target independently, retain misses. */
export async function publishInviteListEvent(
  nostr: Pick<ReturnType<typeof useNostr>["nostr"], "relay">,
  event: NostrEvent,
  relayUrls: Iterable<string>,
): Promise<{ accepted: string[]; rejected: string[] }> {
  const targets = uniqueRelayUrls(relayUrls);
  if (targets.length === 0) throw new Error(t({ id: "useInvites.noRelayForRecovery", defaultMessage: "No relay is available for creator invite recovery" }));
  // This changes revocation authority: never start a partial fan-out before the
  // exact event and every target are durable.
  await queueSignedEvent(event, undefined, targets, { inheritPendingTargets: false });
  const result = await publishSignedEventToRelays(nostr, event, targets, 8_000);
  await recordQueuedPublishAttempt(event.id, targets, result.rejected).catch(() => undefined);
  if (result.accepted.length === 0) {
    throw new Error(t({ id: "useInvites.noRelayAcceptedList", defaultMessage: "No relay accepted your creator invite list update" }));
  }
  return result;
}

export async function readInviteList(
  event: NostrRumor | null,
  signer: NUser["signer"],
  selfPubkey: string,
): Promise<InviteList | null> {
  if (!event?.content || !signer.nip44) return null;
  try {
    const decrypted = await signer.nip44.decrypt(selfPubkey, event.content);
    const parsed = JSON.parse(decrypted) as Partial<InviteList>;
    return {
      ...parsed,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : [],
    } as InviteList;
  } catch {
    return null;
  }
}

export interface DecodedInviteLists {
  list: InviteList;
  newestCreatedAt: number;
  newestEvent: NostrRumor | null;
  /** The NIP-01 head could not be decrypted/parsed; writes must fail closed. */
  unreadable: boolean;
  /** The newest exact wire event already contains the full semantic union. */
  exactEvent: NostrEvent | null;
}

/** Fold all currently visible relay copies while retaining an exact mirror when safe. */
export async function decodeInviteListEvents(
  sourceEvents: Iterable<NostrRumor>,
  user: NUser,
): Promise<DecodedInviteLists> {
  const events = [...new Map([...sourceEvents].map((event) => [event.id, event])).values()]
    .filter((event) => event.kind === KIND_INVITE_LIST && event.pubkey === user.pubkey)
    // Oldest first; on a timestamp tie the NIP-01 winner (lowest id) is last.
    .sort((a, b) => a.created_at - b.created_at || b.id.localeCompare(a.id));
  let list = EMPTY_INVITE_LIST;
  const decoded = new Map<string, InviteList>();
  for (const event of events) {
    const copy = await readInviteList(event, user.signer, user.pubkey);
    if (!copy) continue;
    decoded.set(event.id, copy);
    list = mergeInviteLists(list, copy);
  }
  const newestEvent = [...events]
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0] ?? null;
  const newestCopy = newestEvent ? decoded.get(newestEvent.id) : undefined;
  const unreadable = Boolean(newestEvent && !newestCopy);
  const exactEvent = newestEvent && isSigned(newestEvent)
    && newestCopy && JSON.stringify(newestCopy) === JSON.stringify(list)
    ? newestEvent
    : null;
  return {
    list,
    newestCreatedAt: newestEvent?.created_at ?? 0,
    newestEvent,
    unreadable,
    exactEvent,
  };
}

/**
 * Fetch and decrypt the Invite List, merging every copy received: tombstones
 * union and win terminally (CORD-05 §4). Also returns the newest `created_at`
 * for replaceable monotonicity. `NPool.query` returns at most ONE 13303, which
 * may be BEHIND, so callers must merge this into what they hold, never assign it.
 */
export async function fetchInviteList(
  nostr: ReturnType<typeof useNostr>["nostr"],
  user: NUser,
  signal?: AbortSignal,
  relayUrls?: Iterable<string>,
): Promise<{
  list: InviteList;
  newestCreatedAt: number;
  unreadable: boolean;
  answered: string[];
  failed: string[];
  targets: string[];
}> {
  const filter = [{ kinds: [KIND_INVITE_LIST], authors: [user.pubkey], limit: 1 }];
  const deadline = signal ?? AbortSignal.timeout(8000);
  const targets = relayUrls ? uniqueRelayUrls(relayUrls) : [];
  const response = relayUrls
    ? await queryExplicitRelaysWithStatus(nostr, targets, filter, deadline)
    : {
        events: await nostr.query(filter, { signal: deadline }),
        answered: [] as string[],
        failed: [] as string[],
      };
  const events = response.events;
  const decoded = await decodeInviteListEvents(events, user);
  return {
    list: decoded.list,
    newestCreatedAt: decoded.newestCreatedAt,
    unreadable: decoded.unreadable,
    answered: response.answered,
    failed: response.failed,
    targets,
  };
}

export function useInviteList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { config } = useAppContext();

  return useQuery<InviteList>({
    queryKey: inviteListKey(user?.pubkey),
    enabled: Boolean(user?.signer.nip44),
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const persisted = await readPersistedInviteList(user!.pubkey);
      const { list, newestCreatedAt, unreadable, answered } = await fetchInviteList(
        nostr,
        user!,
        AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        inviteListRelays(selfStateRelays(config, user!.pubkey)),
      );
      // A network read may only WIDEN this device's list: a revoke's refetch can race
      // relay indexing and return the pre-revocation copy (the revoked link would
      // reappear). Merging is sound: entries are immutable and tombstones terminal.
      const cached = queryClient.getQueryData<InviteList>(inviteListKey(user!.pubkey));
      const local = cached && persisted
        ? mergeInviteLists(persisted.list, cached)
        : (cached ?? persisted?.list);
      const merged = local ? mergeInviteLists(local, list) : list;
      const foldKey = inviteListFoldKey(user!.pubkey);
      const newestFoldAt = Math.max(newestCreatedAt, persisted?.newestCreatedAt ?? 0);
      await writeFolded(foldKey, {
        list: merged,
        newestCreatedAt: newestFoldAt,
        ...(persisted?.needsPublish ? { needsPublish: true } : {}),
      } satisfies PersistedInviteList);

      // An offline mint/revoke leaves `needsPublish`; the next full read merges it
      // with relay copies and reconciles to the answered cohort.
      if (persisted?.needsPublish) {
        const wireAlreadyContainsFold = JSON.stringify(merged) === JSON.stringify(list);
        if (wireAlreadyContainsFold) {
          await writeFolded(foldKey, {
            list: merged,
            newestCreatedAt: newestFoldAt,
          } satisfies PersistedInviteList);
        } else {
          const canonical = uniqueRelayUrls(selfStateRelays(config, user!.pubkey));
          const requiredFloor = canonical.length > 0 ? canonical : uniqueRelayUrls(RESCUE_RELAYS);
          const canReconcile = !unreadable
            && answered.some((url) => requiredFloor.includes(url));
          if (canReconcile) {
            const createdAt = Math.max(
              Math.floor(Date.now() / 1000),
              newestCreatedAt + 1,
              (persisted.newestCreatedAt ?? 0) + 1,
            );
            try {
              const content = await user!.signer.nip44!.encrypt(
                user!.pubkey,
                JSON.stringify(pruneExpiredInvites(merged, Math.floor(Date.now() / 1000))),
              );
              const event = await user!.signer.signEvent({
                kind: KIND_INVITE_LIST,
                content,
                tags: [],
                created_at: createdAt,
              });
              await writeFolded(foldKey, {
                list: merged,
                newestCreatedAt: createdAt,
                needsPublish: true,
              } satisfies PersistedInviteList);
              await publishInviteListEvent(nostr, event, answered);
              await writeFolded(foldKey, {
                list: merged,
                newestCreatedAt: createdAt,
              } satisfies PersistedInviteList);
            } catch (error) {
              // Keep the dirty marker; a later refetch retries (outbox entries retry exact bytes).
              console.warn("Failed to reconcile creator invite recovery state:", error);
            }
          }
        }
      }
      return merged;
    },
  });
}

/**
 * The epoch each of my live links CURRENTLY vends, by token (CORD-05 §2), so the
 * UI can flag links that lag the community's `rootEpoch`. Unresolvable links
 * are simply absent.
 */
export function useMyLinkEpochs(community: Community | undefined) {
  const { nostr } = useNostr();
  const inviteList = useInviteList();

  const links = (inviteList.data?.entries ?? []).filter((e) => e.community_id === community?.idHex);

  return useQuery<Record<string, number>>({
    queryKey: ["concord", "invite-epochs", community?.idHex, links.map((e) => e.token).sort()],
    enabled: Boolean(community && links.length > 0),
    staleTime: 60_000,
    queryFn: async () => {
      const out: Record<string, number> = {};
      await Promise.all(
        links.map(async (e) => {
          const parsed = parseInviteLink(e.url);
          if (!parsed) return;
          try {
            const bundle = await resolveBundle(nostr, parsed, community!.relays);
            if (typeof bundle.root_epoch === "number") out[e.token] = bundle.root_epoch;
          } catch { /* ignore */ }
        }),
      );
      return out;
    },
  });
}

/** Read-merge-write the Invite List (serialized on one scope). */
export async function updateInviteList(
  nostr: ReturnType<typeof useNostr>["nostr"],
  user: NUser,
  queryClient: QueryClient,
  canonicalRelays: string[],
  patch: InviteList,
): Promise<InviteList> {
  if (!user.signer.nip44) throw new Error(t({ id: "useInvites.nip44Unsupported", defaultMessage: "NIP-44 unsupported." }));
  const canonical = uniqueRelayUrls(canonicalRelays);
  const relays = inviteListRelays(canonical);
  const persisted = await readPersistedInviteList(user.pubkey);
  const cached = queryClient.getQueryData<InviteList>(inviteListKey(user.pubkey)) ?? EMPTY_INVITE_LIST;
  const durable = persisted?.list ?? EMPTY_INVITE_LIST;
  const optimistic = mergeInviteLists(mergeInviteLists(durable, cached), patch);

  // A mint patch holds the only copy of signer_sk: persist and verify it before
  // any network await, or a shared link could become irrevocable.
  await writeFolded(inviteListFoldKey(user.pubkey), {
    list: optimistic,
    newestCreatedAt: persisted?.newestCreatedAt ?? 0,
    needsPublish: true,
  } satisfies PersistedInviteList);
  const verified = await readPersistedInviteList(user.pubkey);
  if (!verified || JSON.stringify(verified.list) !== JSON.stringify(optimistic)) {
    throw new Error(t({ id: "useInvites.recoveryNotSaved", defaultMessage: "Creator invite recovery state could not be saved locally" }));
  }
  queryClient.setQueryData(inviteListKey(user.pubkey), optimistic);

  const read = await fetchInviteList(nostr, user, undefined, relays);
  if (read.unreadable) {
    throw new Error(
      t({ id: "useInvites.listUndecryptable", defaultMessage: "Couldn't decrypt the current creator invite list; not saving to avoid losing revocation secrets." }),
    );
  }
  const requiredFloor = canonical.length > 0 ? canonical : uniqueRelayUrls(RESCUE_RELAYS);
  if (!read.answered.some((url) => requiredFloor.includes(url))) {
    throw new Error(
      t({ id: "useInvites.listUnconfirmed", defaultMessage: "Couldn't confirm your creator invite list on an account-state relay; not saving to avoid overwriting it." }),
    );
  }
  const next = pruneExpiredInvites(
    mergeInviteLists(mergeInviteLists(read.list, optimistic), patch),
    Math.floor(Date.now() / 1000),
  );

  const createdAt = Math.max(
    Math.floor(Date.now() / 1000),
    read.newestCreatedAt + 1,
    (persisted?.newestCreatedAt ?? 0) + 1,
  );
  const content = await user.signer.nip44.encrypt(user.pubkey, JSON.stringify(next));
  const event = await user.signer.signEvent({
    kind: KIND_INVITE_LIST,
    content,
    tags: [],
    created_at: createdAt,
  });
  queryClient.setQueryData(inviteListKey(user.pubkey), next);
  await writeFolded(inviteListFoldKey(user.pubkey), {
    list: next,
    newestCreatedAt: createdAt,
    needsPublish: true,
  } satisfies PersistedInviteList);
  await publishInviteListEvent(nostr, event, read.answered);
  await writeFolded(inviteListFoldKey(user.pubkey), {
    list: next,
    newestCreatedAt: createdAt,
  } satisfies PersistedInviteList);
  return next;
}

function useUpdateInviteList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { config } = useAppContext();

  return useMutation({
    scope: { id: "concord-invite-list" },
    mutationFn: async (patch: InviteList) => {
      if (!user?.signer.nip44) throw new Error(t({ id: "useInvites.nip44Unsupported", defaultMessage: "NIP-44 unsupported." }));
      // Fold into the local cache before anything can fail: for a mint it holds the
      // ONLY copy of `signer_sk`. Merge is idempotent by token.
      return updateInviteList(
        nostr,
        user,
        queryClient,
        selfStateRelays(config, user.pubkey),
        patch,
      );
    },
  });
}


/**
 * Invite actions for one community (CORD-05):
 *
 *   - MINT: fresh 16-byte token + link-signer keypair; the encrypted bundle posts
 *     at `(33301, link_signer, d="")`; link is `<base>/invite/<naddr>#<fragment>`;
 *     the Invite List records the secrets; the Registry (vsk 8) lists the coordinate.
 *   - REVOKE: re-post the coordinate as a tombstone (needs the signer secret),
 *     drop it from the Registry and Invite List. Retiring the last live link
 *     flips the Community back to Private.
 *   - DIRECT: giftwrap the bundle to an npub (CORD-05 §6) — no link, no Registry
 *     entry, unrevocable, never flips Public.
 */
export function useInviteActions(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold(community);
  const inviteList = useInviteList();
  const { mutateAsync: updateInviteList } = useUpdateInviteList();
  const { mutateAsync: publishEvent } = useNostrPublish();
  // The `community` prop can lag a just-adopted rekey; minting from it would embed
  // an OLD epoch and strand joiners (CORD-05 §2). Reconcile against the live list.
  const fresh = useCommunity(community?.idHex);

  /** Whichever snapshot holds the HIGHER epoch, so a lagging one can't mint a stale bundle. */
  const bundleSource = (): Community | undefined => {
    if (!community) return fresh;
    if (!fresh) return community;
    return fresh.rootEpoch > community.rootEpoch ? fresh : community;
  };

  /**
   * The §1 CommunityInvite bundle. `audience` is required: a default would hand
   * every Private Channel key to whoever opens it (CORD-03 §1). A link is entitled
   * to nothing; a member to what their Roles scope them to (CORD-04 §2).
   */
  const buildBundle = (
    audience: VendAudience,
    opts?: {
      expiresAtMs?: number;
      label?: string;
      /** Narrow further (a role-grant vend hands over just that role's channels). */
      onlyChannelIdHexes?: ReadonlySet<string>;
    },
  ): InviteBundle => {
    if (!user) throw new Error(t({ id: "useInvites.notReady", defaultMessage: "Not ready." }));
    const src = bundleSource();
    if (!src) throw new Error(t({ id: "useInvites.notReady", defaultMessage: "Not ready." }));
    const vendable = vendableChannels(src.privateChannels, audience, {
      only: opts?.onlyChannelIdHexes,
    });
    return {
      community_id: src.idHex,
      owner: src.owner,
      owner_salt: bytesToHex(src.ownerSalt),
      community_root: bytesToHex(src.root),
      root_epoch: Number(src.rootEpoch),
      // Control Plane read access only (CORD-02 §7); absent on legacy pre-split epochs.
      ...(src.controlPk ? { control_pk: src.controlPk } : {}),
      channels: vendable.map((ch) => ({
        id: bytesToHex(ch.id),
        key: bytesToHex(ch.key),
        epoch: Number(ch.epoch),
        name: ch.name,
      })),
      relays: src.relays,
      name: folded?.metadata?.name ?? src.name,
      ...(folded?.metadata?.icon ? { icon: folded.metadata.icon } : {}),
      ...(folded?.metadata?.banner ? { banner: folded.metadata.banner } : {}),
      ...(folded?.metadata?.description?.trim()
        ? { description: capBundleDescription(folded.metadata.description.trim()) }
        : {}),
      ...(opts?.expiresAtMs ? { expires_at: opts.expiresAtMs } : {}),
      creator_npub: user.pubkey,
      ...(opts?.label ? { label: opts.label } : {}),
    };
  };

  /** Link-signer pubkeys of MY expired links for this community. */
  const myExpiredSigners = (): Set<string> => {
    const out = new Set<string>();
    const now = Math.floor(Date.now() / 1000);
    for (const e of inviteList.data?.entries ?? []) {
      if (e.community_id !== community?.idHex || !e.expires_at || e.expires_at > now) continue;
      const p = parseInviteLink(e.url);
      if (p) out.add(p.linkSigner);
    }
    return out;
  };

  /**
   * Publish my registry (vsk 8) with these live links, pruning expired ones so
   * they don't keep the community Public (CORD-05 §5).
   */
  const publishRegistry = async (linkSigners: string[]) => {
    if (!user || !community) return;
    const expired = myExpiredSigners();
    const live = linkSigners.filter((s) => !expired.has(s));
    const eid = bytesToHex(inviteLinksLocator(community.id, hex32(user.pubkey)));
    const head = folded?.heads.get(eid);
    await publishEdition(
      nostr,
      community,
      user.signer,
      buildRegistryEdition(community.id, user.pubkey, live, {
        actorPubkey: user.pubkey,
        version: head ? head.version + 1n : 1n,
        prevHash: head?.hash,
        authority: citationFor(community, folded, user.pubkey),
      }),
    ).catch(() => undefined);
    invalidateControl(queryClient, community.idHex);
  };

  const createLink = useMutation<
    string,
    Error,
    {
      expiresAtMs?: number;
      label?: string;
      /**
       * Opt-in: also publish a PUBLIC kind-3314 announcement with the full link for
       * Discover, trading its secrecy. Only from an explicit user action.
       */
      listPublicly?: boolean;
    }
  >({
    mutationFn: async ({ expiresAtMs, label, listPublicly }) => {
      if (!user || !community) throw new Error(t({ id: "useInvites.notReady", defaultMessage: "Not ready." }));
      if (!user.signer.nip44) throw new Error(t({ id: "useInvites.signerCantMint", defaultMessage: "This signer can't mint invite links (NIP-44 unsupported)." }));

      // Warn (not refuse; LAN quickstarts are supported): Android/desktop run on a
      // secure origin where ws:// is blocked as mixed content.
      const insecure = community.relays.filter((url) => !/^wss:\/\//i.test(url));
      if (insecure.length > 0) {
        const fatal = insecure.length === community.relays.length;
        toast({
          title: fatal
            ? t({ id: "useInvites.insecure.fatalTitle", defaultMessage: "This invite won't work on mobile" })
            : t({ id: "useInvites.insecure.partialTitle", defaultMessage: "Some relays won't work on mobile" }),
          description: fatal
            ? t(
                {
                  id: "useInvites.insecure.fatalDescription",
                  defaultMessage:
                    "{relays} {count, plural, one {is} other {are}} not wss:// — mobile and desktop apps can't connect to insecure relays, so members joining from them won't be able to participate at all.",
                },
                { relays: insecure.join(", "), count: insecure.length },
              )
            : t(
                {
                  id: "useInvites.insecure.partialDescription",
                  defaultMessage:
                    "{relays} {count, plural, one {is} other {are}} not wss:// — mobile and desktop apps can't connect to insecure relays.",
                },
                { relays: insecure.join(", "), count: insecure.length },
              ),
          variant: fatal ? "destructive" : undefined,
        });
      }

      const token = mintToken();
      const link = mintLinkSigner();
      // A link's audience holds no Role, so it gets no Private Channel (CORD-05 §2);
      // those keys are vended by Direct Invite on role grant.
      const bundle = buildBundle({ kind: "link" }, { expiresAtMs, label });
      const bundleEvent = await buildBundleEvent(bundle, token, link.sk);
      // The URL is decided LOCALLY, so the writes below can run concurrently. Store
      // the re-basable base (a sentinel on native/desktop) and hand out the URL
      // re-based onto today's share origin, as `myLinks` does for synced entries.
      const storedUrl = buildInviteUrl(linkStoreBase(), link.pk, token, community.relays);
      const url = shareableInviteUrl(shareOrigin(), storedUrl);

      const mine = new Set(folded?.registriesByCreator.get(user.pubkey) ?? []);
      mine.add(link.pk);

      // Best-effort: a failed announcement must not fail the mint.
      const announcement = listPublicly ? buildCommunityAnnouncement({ inviteUrl: url }) : null;

      // The bundle is the only write that makes the link joinable, so the only one awaited.
      await publishToAnyRelay(nostr, community.relays, bundleEvent, t({ id: "useInvites.noRelayAcceptedBundle", defaultMessage: "No relay accepted the invite bundle." }));

      // Not awaited: `signer_sk` is optimistically cached before publishing, and
      // reporting a failure here for an already-live link invites a duplicate mint.
      void updateInviteList({
        entries: [
          {
            token: bytesToHex(token),
            signer_sk: bytesToHex(link.sk),
            community_id: community.idHex,
            // The re-basable form: synced entries are re-based onto each reader's origin.
            url: storedUrl,
            ...(label ? { label } : {}),
            created_at: Math.floor(Date.now() / 1000),
            ...(expiresAtMs ? { expires_at: Math.floor(expiresAtMs / 1000) } : {}),
            epoch: bundle.root_epoch,
          },
        ],
        tombstones: [],
      }).catch(() => {
        toast({
          title: t({ id: "useInvites.notSynced.title", defaultMessage: "Invite link created, but not synced" }),
          description:
            t({ id: "useInvites.notSynced.description", defaultMessage: "Its revocation secret didn't reach your relays, so your other devices won't be able to revoke this link." }),
          variant: "destructive",
        });
      });

      // Neither gates the link working.
      void publishRegistry([...mine]).catch(() => undefined);
      if (announcement) void publishEvent(announcement).catch(() => undefined);

      return url;
    },
  });

  const revokeLink = useMutation<void, Error, { url: string }>({
    mutationFn: async ({ url }) => {
      if (!user || !community) throw new Error(t({ id: "useInvites.notReady", defaultMessage: "Not ready." }));
      const parsed = parseInviteLink(url);
      if (!parsed) throw new Error(t({ id: "useInvites.notInviteLink", defaultMessage: "Not a recognizable invite link." }));

      // Only the creator holds the signer secret (Invite List).
      const entry = inviteList.data?.entries.find(
        (e) => e.community_id === community.idHex && parseInviteLink(e.url)?.linkSigner === parsed.linkSigner,
      );
      if (!entry) throw new Error(t({ id: "useInvites.noSigningSecret", defaultMessage: "This device doesn't hold that link's signing secret." }));

      const tomb = await buildRevocationEvent(hexToBytes(entry.signer_sk));
      await publishToAnyRelay(nostr, community.relays, tomb, t({ id: "useInvites.noRelayAcceptedRevocation", defaultMessage: "No relay accepted the revocation." }));

      await updateInviteList({
        entries: [],
        tombstones: [inviteTombstoneFor(entry)],
      });

      const mine = new Set(folded?.registriesByCreator.get(user.pubkey) ?? []);
      mine.delete(parsed.linkSigner);
      await publishRegistry([...mine]);
    },
  });

  /**
   * Revoke EVERY link of mine for this community (CORD-05 §5):
   *
   *   - with a held `signer_sk`: tombstone its bundle coordinate (dead for everyone);
   *   - registry coordinates WITHOUT a held secret can never be tombstoned; the best
   *     remedy is delisting them from my registry (vsk 8) so they stop counting
   *     toward Public, though the URL keeps working until the next rekey.
   *
   * A tombstone no relay accepts keeps its Invite List and registry entries (so
   * it can be retried). `skipRegistry` is for a DISSOLVED community (nothing may
   * follow the grave).
   */
  const revokeAllMyLinks = useMutation<
    { revoked: number; delisted: number; failed: number; failedSignerSks: string[] },
    Error,
    { skipRegistry?: boolean } | void
  >({
    mutationFn: async (opts) => {
      if (!user || !community) throw new Error(t({ id: "useInvites.notReady", defaultMessage: "Not ready." }));
      const entries = (inviteList.data?.entries ?? []).filter(
        (e) => e.community_id === community.idHex,
      );

      const results = await Promise.allSettled(
        entries.map(async (entry) =>
          publishToAnyRelay(
            nostr,
            community.relays,
            await buildRevocationEvent(hexToBytes(entry.signer_sk)),
            t({ id: "useInvites.noRelayAcceptedRevocation", defaultMessage: "No relay accepted the revocation." }),
          ),
        ),
      );
      const revoked = entries.filter((_, i) => results[i].status === "fulfilled");
      const kept = entries.filter((_, i) => results[i].status === "rejected");

      if (revoked.length > 0) {
        await updateInviteList({
          entries: [],
          tombstones: revoked.map(inviteTombstoneFor),
        });
      }

      const failedSignerSks = kept.map((e) => e.signer_sk);
      if (opts?.skipRegistry) {
        return { revoked: revoked.length, delisted: 0, failed: kept.length, failedSignerSks };
      }

      // Keep only links whose tombstone didn't land; delist the rest.
      const mine = new Set(folded?.registriesByCreator.get(user.pubkey) ?? []);
      const keptSigners = new Set(
        kept.map((e) => parseInviteLink(e.url)?.linkSigner).filter((s): s is string => !!s),
      );
      const delisted = [...mine].filter((s) => !keptSigners.has(s)).length;
      await publishRegistry([...mine].filter((s) => keptSigners.has(s)));

      return { revoked: revoked.length, delisted, failed: kept.length, failedSignerSks };
    },
  });

  /** Whether revoking ALL my links would flip the community Private (see {@link revokeWouldPrivatize}). */
  const revokeAllWouldPrivatize = (): boolean => {
    if (!user || !folded || folded.liveInviteLinks.size === 0) return false;
    const mine = new Set(folded.registriesByCreator.get(user.pubkey) ?? []);
    return [...folded.liveInviteLinks].every((s) => mine.has(s));
  };

  /**
   * Hand the keys straight to an npub (CORD-05 §6): the §1 bundle sealed by the
   * sender's REAL key inside an ephemeral, `k`-tagged giftwrap. No coordinate or
   * Registry entry, so it never flips Public. Unrevocable once landed.
   */
  const sendDirectInvite = useMutation<
    void,
    Error,
    {
      recipientPubkey: string;
      expiresAtMs?: number;
      onlyChannelIdHexes?: ReadonlySet<string>;
      /**
       * Overlay a Grant just published by this client; the fold lags, so a
       * grant-driven vend would otherwise find the recipient unentitled.
       */
      entitlementOverlay?: { withRoleIds?: string[]; withoutRoleIds?: string[] };
    }
  >({
    mutationFn: async ({ recipientPubkey, expiresAtMs, onlyChannelIdHexes, entitlementOverlay }) => {
      if (!user || !community) throw new Error(t({ id: "useInvites.notReady", defaultMessage: "Not ready." }));
      if (!user.signer.nip44) throw new Error(t({ id: "useInvites.signerCantSendDirect", defaultMessage: "This signer can't send direct invites (NIP-44 unsupported)." }));

      // Exactly the Private Channels the recipient's roles grant (CORD-03 §1).
      const bundle = buildBundle(
        {
          kind: "member",
          roster: folded?.roster,
          ownerHex: folded?.ownerHex ?? community.owner,
          memberHex: recipientPubkey,
          overlay: entitlementOverlay,
        },
        { expiresAtMs, onlyChannelIdHexes },
      );
      const rumor = buildDirectInviteRumor(bundle, user.pubkey);
      const seal = await sealDirectInvite(rumor, recipientPubkey, user.signer);
      const wrap = await wrapDirectInvite(seal, recipientPubkey, { expiresAtMs });

      // Their 10050 DM relays, else NIP-65 reads, else stock — the set their own
      // scanner resolves (CORD-05 §6).
      const inbox = await recipientInboxRelays(nostr, recipientPubkey);
      // A FAILED lookup isn't "no list"; falling back to stock could misdeliver.
      if (inbox === null) throw new Error(t({ id: "useInvites.networkUnreachable", defaultMessage: "Couldn't reach the network to send the invite. Please try again." }));
      const relays = inviteDeliveryRelays(inbox);
      await publishToAnyRelay(nostr, relays, wrap, t({ id: "useInvites.noRelayAcceptedInvite", defaultMessage: "No relay accepted the invite." }));
    },
  });

  /**
   * My live links for THIS community from the private list, re-based onto this
   * build's share origin (entries may have been minted elsewhere, e.g. `app://armada`).
   */
  const myLinks = (inviteList.data?.entries ?? [])
    .filter((e) => e.community_id === community?.idHex)
    .map((e) => {
      const url = shareableInviteUrl(shareOrigin(), e.url);
      return url === e.url ? e : { ...e, url };
    });

  /**
   * Re-post the CURRENT bundle at every live link coordinate I hold (CORD-05 §2),
   * so links minted before a metadata/key change stop serving stale previews.
   *
   * VERSION-FENCED: an incremental fold may hold OLDER metadata than a coordinate
   * already vends, so each bundle records `meta_v` and a refresh skips links
   * vending a newer one. Targets community relays ∪ the link's bootstrap relays.
   * Best-effort per relay.
   */
  const refreshMyLinks = async (): Promise<void> => {
    if (!community || myLinks.length === 0) return;
    const metaV = Number(folded?.heads.get(community.idHex)?.version ?? 0n);
    const bundle: InviteBundle = { ...buildBundle({ kind: "link" }), meta_v: metaV };
    const now = Math.floor(Date.now() / 1000);
    let accepted = 0;
    let attempted = 0;
    await Promise.allSettled(
      myLinks.map(async (entry) => {
        if (entry.expires_at && entry.expires_at <= now) return; // can't be joined; don't touch
        const parsed = parseInviteLink(entry.url);
        if (!parsed) return;
        // Unreachable → refresh anyway; revoked → never resurrect.
        try {
          const current = await resolveBundle(nostr, parsed, community.relays);
          const currentMetaV = typeof current.meta_v === "number" ? current.meta_v : 0;
          if (currentMetaV > metaV) return; // our fold is behind — refusing to downgrade
        } catch (e) {
          if (e instanceof InviteError && e.code === "revoked") return;
        }
        const [event] = await buildRefreshedBundleEvents(bundle, [entry]);
        if (!event) return;
        attempted++;
        const targets = new Set<string>([...community.relays, ...parsed.bootstrapRelays]);
        const results = await Promise.allSettled(
          [...targets].map((url) => nostr.relay(url).event(event, { signal: AbortSignal.timeout(8000) })),
        );
        accepted += results.filter((r) => r.status === "fulfilled").length;
      }),
    );
    // Total rejection must surface, or coordinates vend stale bundles forever.
    if (attempted > 0 && accepted === 0) throw new Error(t({ id: "useInvites.noRelayAcceptedRefresh", defaultMessage: "No relay accepted the refreshed invite bundle." }));
  };

  /**
   * Whether revoking this link would flip the community Private (CORD-05 §2);
   * callers should warn, since bans start rotating keys past it.
   */
  const revokeWouldPrivatize = (url: string): boolean => {
    const parsed = parseInviteLink(url);
    if (!parsed || !folded || folded.liveInviteLinks.size === 0) return false;
    const remaining = new Set(folded.liveInviteLinks);
    remaining.delete(parsed.linkSigner);
    return remaining.size === 0;
  };

  return {
    createLink: createLink.mutateAsync,
    isCreatingLink: createLink.isPending,
    revokeLink: revokeLink.mutateAsync,
    isRevoking: revokeLink.isPending,
    revokeAllMyLinks: revokeAllMyLinks.mutateAsync,
    isRevokingAll: revokeAllMyLinks.isPending,
    revokeAllWouldPrivatize,
    sendDirectInvite: sendDirectInvite.mutateAsync,
    isSendingInvite: sendDirectInvite.isPending,
    myLinks,
    /** True until the Invite List has loaded — `myLinks` is blind before then. */
    linksLoading: inviteList.isLoading,
    refreshMyLinks,
    /** Whether ANY live public link exists — the community's Public/Private flag. */
    isPublic: (folded?.liveInviteLinks.size ?? 0) > 0,
    revokeWouldPrivatize,
  };
}

/**
 * Self-healing link freshness: on their community page, a link creator
 * re-posts the CURRENT bundle at each live link coordinate (once per community
 * per session). Unconditional: resolveBundle's persisted newest-copy floor
 * hides relay staleness, and the re-post is cheap and self-replacing.
 */
export function useLinkFreshnessWatch(community: Community | undefined): void {
  const { user } = useCurrentUser();
  const control = useControlFold(community);
  const folded = control.data;
  const { myLinks, refreshMyLinks } = useInviteActions(community);
  const { data: dissolved } = useDissolved(community);
  const attempted = useRef(new Set<string>());

  useEffect(() => {
    if (!user || !community || !folded || myLinks.length === 0) return;
    // Only once KNOWN alive (`null`; `undefined` is still asking): re-posting a
    // dissolved community's bundles would keep dead links resolving.
    if (dissolved !== null) return;
    if (control.isLoading || control.isFetching) return; // don't publish from a partial fold
    // Only a creator still authorized to maintain links should re-post them.
    if (
      user.pubkey !== folded.ownerHex &&
      !isAuthorized(folded.roster, user.pubkey, folded.ownerHex, Permissions.CREATE_INVITE)
    ) {
      return;
    }
    if (attempted.current.has(community.idHex)) return;
    attempted.current.add(community.idHex);
    refreshMyLinks().catch(() => {
      attempted.current.delete(community.idHex); // retry on a later mount
    });
  }, [user, community, folded, dissolved, control.isLoading, control.isFetching, myLinks, refreshMyLinks]);
}

/** What a dissolve's retirement of the owner's links took down. */
export interface RetirementOutcome {
  revokeFailed: boolean;
  unlistFailed: boolean;
  unlisted: number;
  /** Try only what missed again. Present while anything is still up. */
  retry?: () => Promise<RetirementOutcome>;
}

/**
 * Retire everything of mine advertising this community: revoke all my invite
 * links and delete my Discover listings, independently. Run by dissolve AFTER
 * the grave, so no registry edition is published; misses come back as `retry`,
 * which doesn't need the community to still exist.
 */
export function useRetireCommunityLinks(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold(community);
  const { myLinks, revokeAllMyLinks } = useInviteActions(community);
  const { unlistLinks } = useUnlistAnnouncements();

  return async (): Promise<RetirementOutcome> => {
    const signers = new Set<string>(user ? folded?.registriesByCreator.get(user.pubkey) ?? [] : []);
    for (const e of myLinks) {
      const signer = parseInviteLink(e.url)?.linkSigner;
      if (signer) signers.add(signer);
    }
    const relays = community?.relays ?? [];
    const [revoke, unlist] = await Promise.allSettled([
      revokeAllMyLinks({ skipRegistry: true }),
      signers.size > 0 ? unlistLinks(signers) : Promise.resolve(0),
    ]);
    // A wholesale rejection ("Not ready.") revoked nothing: owe every link.
    const unrevoked = revoke.status === "fulfilled" ? revoke.value.failedSignerSks : myLinks.map((e) => e.signer_sk);
    const unlistFailed = unlist.status === "rejected";

    // Retries publish from what they hold; the community and this hook are gone by then.
    const outcome = (sks: string[], unlistOwed: string[], unlisted: number): RetirementOutcome => ({
      revokeFailed: sks.length > 0,
      unlistFailed: unlistOwed.length > 0,
      unlisted,
      retry:
        sks.length > 0 || unlistOwed.length > 0
          ? async () => {
              const [revocations, unlistAgain] = await Promise.all([
                Promise.allSettled(
                  sks.map(async (sk) =>
                    publishToAnyRelay(nostr, relays, await buildRevocationEvent(hexToBytes(sk)), t({ id: "useInvites.noRelayAcceptedRevocation", defaultMessage: "No relay accepted the revocation." })),
                  ),
                ),
                unlistOwed.length > 0 ? unlistLinks(unlistOwed).then((n) => n, () => undefined) : Promise.resolve(0),
              ]);
              return outcome(
                sks.filter((_, i) => revocations[i].status === "rejected"),
                unlistAgain === undefined ? unlistOwed : [],
                unlisted + (unlistAgain ?? 0),
              );
            }
          : undefined,
    });
    return outcome(unrevoked, unlistFailed ? [...signers] : [], unlist.status === "fulfilled" ? unlist.value : 0);
  };
}

/**
 * Honest-client compliance: revoke MY OWN live links once I no longer hold
 * CREATE_INVITE — the Registry fold stops honoring them, but only my
 * `signer_sk` can tombstone the bundle. Destructive, so it fires only on
 * POSITIVE evidence of a strip (a revoke edition at my grant head), never on
 * authority absence (a cold device or relay gap).
 */
export function useLinkAuthorityWatch(community: Community | undefined): void {
  const { user } = useCurrentUser();
  const control = useControlFold(community);
  const folded = control.data;
  const { myLinks, revokeLink } = useInviteActions(community);
  // Guards only the in-flight revoke per link; failures retry on the next change.
  const handled = useRef(new Set<string>());

  useEffect(() => {
    if (!user || !community || !folded || myLinks.length === 0) return;
    if (control.isLoading || control.isFetching) return; // an in-flight fold under-authorizes
    if (user.pubkey === folded.ownerHex) return; // the owner is always authorized
    if (isAuthorized(folded.roster, user.pubkey, folded.ownerHex, Permissions.CREATE_INVITE)) return;
    // Positive-evidence gate: my grant head must be in the fold (a strip folds a
    // revoke edition; a sync gap folds nothing).
    if (!folded.heads.has(bytesToHex(grantLocator(community.id, hex32(user.pubkey))))) return;
    for (const entry of myLinks) {
      if (handled.current.has(entry.token)) continue;
      handled.current.add(entry.token);
      revokeLink({ url: entry.url }).catch(() => {
        handled.current.delete(entry.token);
      });
    }
  }, [user, community, folded, control.isLoading, control.isFetching, myLinks, revokeLink]);
}
