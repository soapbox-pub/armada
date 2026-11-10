import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";

import { MutedPubkeysContext, type MutedPubkeysResult } from "@/contexts/MutedPubkeysContext";
import { selfStateRelays, type AppConfig } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { toast } from "@/hooks/useToast";
import {
  newestCanonicalSelfList,
  replaceableVersionIsNewer,
  type ReplaceableVersion,
} from "@/lib/canonicalSelfList";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import { queryExplicitRelaysWithStatus, uniqueRelayUrls } from "@/lib/nip65";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NUser } from "@nostrify/react/login";
import { t, useIntl } from "@/i18n";
import { nowSecs } from "@/lib/relayClock";

/**
 * NIP-51 mute list. Items may be public (`tags`) and/or private (NIP-44 to self in `.content`).
 * New mutes are always written to the private portion.
 */
export const KIND_MUTE_LIST = 10000;

/**
 * Decrypt results are memoized per event id (see `muteListDecryptMemo`) so remote signers
 * aren't asked repeatedly (cf. the kind-10009 memo in useUserGroupList).
 */
interface MutedPubkeyRead {
  pubkeys: Set<string>;
  decryptFailed: boolean;
}

interface MuteListQueryData {
  pubkeys: string[];
  wireReady: boolean;
  /** A trusted versioned local snapshot is sufficient for sealed config. */
  configReady: boolean;
}

/**
 * Legacy seeds were a bare string array. The version prevents a stale relay cohort from
 * rolling a last-good private list backwards.
 */
interface MuteListSeed {
  pubkeys: string[];
  version?: ReplaceableVersion;
}

/** Per author, the newest list version only: a superseded one is never read again. */
const muteListDecryptMemo = new Map<string, { id: string; createdAt: number; work: Promise<MutedPubkeyRead> }>();

function collectMutedPubkeys(tags: string[][], out: Set<string>): void {
  for (const [name, value] of tags) {
    if (name === "p" && value) out.add(value);
  }
}

/**
 * Public `p` tags plus NIP-44-decrypted private ones; public-only when there's no signer or
 * decryption fails. Memoized by event id.
 */
async function readMutedPubkeys(
  event: NostrEvent | null,
  signer: NUser["signer"] | undefined,
): Promise<MutedPubkeyRead> {
  if (!event) return { pubkeys: new Set(), decryptFailed: false };

  const publicPubkeys = new Set<string>();
  collectMutedPubkeys(event.tags, publicPubkeys);

  if (!event.content) return { pubkeys: publicPubkeys, decryptFailed: false };
  // Missing the private half can never authorize a persisted/background replacement.
  if (!signer?.nip44) return { pubkeys: publicPubkeys, decryptFailed: true };

  const cached = muteListDecryptMemo.get(event.pubkey);
  if (cached?.id === event.id) return cached.work;

  const nip44 = signer.nip44;
  const work = (async (): Promise<MutedPubkeyRead> => {
    const result = new Set(publicPubkeys);
    try {
      const decrypted = await nip44.decrypt(event.pubkey, event.content);
      const privateTags = JSON.parse(decrypted);
      if (Array.isArray(privateTags)) {
        collectMutedPubkeys(
          privateTags.filter((t): t is string[] => Array.isArray(t)),
          result,
        );
      }
      return { pubkeys: result, decryptFailed: false };
    } catch (err) {
      console.warn("Failed to decrypt mute list private items:", err);
      // Don't memoize a transient failure.
      if (muteListDecryptMemo.get(event.pubkey)?.id === event.id) muteListDecryptMemo.delete(event.pubkey);
      return { pubkeys: result, decryptFailed: true };
    }
  })();
  if (!cached || event.created_at >= cached.createdAt) {
    muteListDecryptMemo.set(event.pubkey, { id: event.id, createdAt: event.created_at, work });
  }
  return work;
}

function muteFoldKey(pubkey: string): string {
  return `mute-pubkeys:${pubkey}`;
}

/**
 * One seed read per pubkey: nearly every person-rendering component calls `useMutedPubkeys`.
 * The mutations below keep it in step rather than invalidating it.
 */
const muteSeedMemo = new Map<string, Promise<MuteListSeed>>();

function parseMuteSeed(stored: unknown): MuteListSeed {
  if (Array.isArray(stored)) {
    return { pubkeys: stored.filter((value): value is string => typeof value === "string") };
  }
  if (!stored || typeof stored !== "object") return { pubkeys: [] };
  const candidate = stored as { pubkeys?: unknown; version?: Partial<ReplaceableVersion> };
  const pubkeys = Array.isArray(candidate.pubkeys)
    ? candidate.pubkeys.filter((value): value is string => typeof value === "string")
    : [];
  const version = candidate.version;
  return {
    pubkeys,
    ...(typeof version?.id === "string" && typeof version.created_at === "number"
      ? { version: { id: version.id, created_at: version.created_at } }
      : {}),
  };
}

function readMuteSeed(pubkey: string): Promise<MuteListSeed> {
  const cached = muteSeedMemo.get(pubkey);
  if (cached) return cached;
  const work = readFolded<unknown>(muteFoldKey(pubkey))
    .then(parseMuteSeed)
    .catch(() => {
      muteSeedMemo.delete(pubkey); // a transient read failure shouldn't stick
      return { pubkeys: [] };
    });
  muteSeedMemo.set(pubkey, work);
  return work;
}

/** Drops decrypted mute lists and seeds held in memory; for logout's purge. */
export function clearMuteListMemos(): void {
  muteListDecryptMemo.clear();
  muteSeedMemo.clear();
}

async function persistMuteList(
  pubkey: string,
  pubkeys: string[],
  event?: Pick<NostrEvent, "id" | "created_at">,
): Promise<void> {
  const seed: MuteListSeed = {
    pubkeys: [...pubkeys],
    ...(event ? { version: { id: event.id, created_at: event.created_at } } : {}),
  };
  muteSeedMemo.set(pubkey, Promise.resolve(seed));
  await writeFolded(muteFoldKey(pubkey), seed).catch(() => undefined);
}

/**
 * Muted pubkeys (NIP-51 kind 10000), public + NIP-44-private. Called ONCE by
 * `MutedPubkeysProvider`; consumers use {@link useMutedPubkeys}. Persisted and seeded on the next
 * mount to avoid a flash of muted content; `ready` is false only on a true cold start.
 */
export function useMutedPubkeysSource(): MutedPubkeysResult {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const queryClient = useQueryClient();
  const relays = useMemo(
    () => uniqueRelayUrls(selfStateRelays(config, user?.pubkey)).sort(),
    [config, user?.pubkey],
  );
  const relayKey = relays.join(",");
  const queryKey = useMemo(
    () => ["mute-list", user?.pubkey, relayKey],
    [user?.pubkey, relayKey],
  );

  // `null` = cache not read yet, `[]` = no cache.
  const [cachedSeed, setCachedSeed] = useState<MuteListSeed | null>(null);
  useEffect(() => {
    if (!user?.pubkey) {
      setCachedSeed(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const stored = await readMuteSeed(user.pubkey);
      if (cancelled) return;
      setCachedSeed(stored);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.pubkey]);

  const query = useQuery<MuteListQueryData>({
    queryKey,
    enabled: !!user?.pubkey,
    staleTime: 5 * 60 * 1000,
    queryFn: async ({ signal }) => {
      const pubkey = user!.pubkey;
      const [wire, seed] = await Promise.all([
        queryExplicitRelaysWithStatus(
          nostr,
          relays,
          [{ kinds: [KIND_MUTE_LIST], authors: [pubkey], limit: 1 }],
          AbortSignal.any([signal, AbortSignal.timeout(6000)]),
        ),
        readMuteSeed(pubkey),
      ]);
      const event = newestCanonicalSelfList(
        wire.events,
        pubkey,
        KIND_MUTE_LIST,
      ) as NostrEvent | undefined;
      const decoded = await readMutedPubkeys(event ?? null, user!.signer);
      const livePubkeys = [...decoded.pubkeys];
      const answered = new Set(wire.answered);
      const allAnswered = relays.length > 0
        && relays.every((relay) => answered.has(relay));

      // Partial cohorts or unopenable ciphertext are additive only; never overwrite the last-good list.
      if (!allAnswered || decoded.decryptFailed) {
        return {
          pubkeys: [...new Set([...seed.pubkeys, ...livePubkeys])],
          wireReady: false,
          configReady: seed.version !== undefined,
        };
      }

      // Keep a last-good list on an all-relay miss: extra mutes only suppress, never expose.
      if (!event) return { pubkeys: seed.pubkeys, wireReady: true, configReady: true };

      // A signed local publish may be newer than every relay answer; never roll it back.
      if (seed.version && replaceableVersionIsNewer(seed.version, event)) {
        return { pubkeys: seed.pubkeys, wireReady: true, configReady: true };
      }

      // Legacy (unversioned) seeds: accept a complete relay winner only if it contains the seed;
      // else keep the union. The union is still trusted config (`configReady`), otherwise DM push would stop
      // indefinitely; only PRUNE authority waits.
      if (!seed.version
        && seed.pubkeys.some((muted) => !decoded.pubkeys.has(muted))) {
        return {
          pubkeys: [...new Set([...seed.pubkeys, ...livePubkeys])],
          wireReady: false,
          configReady: true,
        };
      }

      void persistMuteList(pubkey, livePubkeys, event);
      return { pubkeys: livePubkeys, wireReady: true, configReady: true };
    },
  });

  // A complete network result replaces the seed; a decrypt-failed one is additive.
  const mutedPubkeys = useMemo(
    () => new Set(query.data?.wireReady
      ? query.data.pubkeys
      : [...new Set([...(cachedSeed?.pubkeys ?? []), ...(query.data?.pubkeys ?? [])])]),
    [query.data, cachedSeed],
  );

  // Not ready only on a true cold start with the network still in flight.
  const ready = !user?.pubkey || query.data !== undefined || cachedSeed !== null;
  const wireReady = !user?.pubkey || query.data?.wireReady === true;
  const configReady = !user?.pubkey
    || query.data?.configReady === true
    || cachedSeed?.version !== undefined;

  useEffect(() => {
    if (query.data) queryClient.setQueryData(queryKey, query.data);
  }, [query.data, queryClient, queryKey]);

  return useMemo(
    () => ({ mutedPubkeys, ready, wireReady, configReady }),
    [mutedPubkeys, ready, wireReady, configReady],
  );
}

/**
 * The single source of truth for "should this person be rendered". A context read, so it works
 * without a relay pool (see `MutedPubkeysContext`).
 */
export function useMutedPubkeys(): MutedPubkeysResult {
  return useContext(MutedPubkeysContext);
}

/**
 * Public and private items separately (all types) for editing. Empty on a missing event or
 * unreadable private content, so callers never destroy items they couldn't read.
 */
async function readMuteTags(
  event: NostrEvent | null,
  signer: NUser["signer"] | undefined,
): Promise<{ publicTags: string[][]; privateTags: string[][]; privateReadable: boolean }> {
  const publicTags = event ? event.tags.map((t) => [...t]) : [];
  if (!event?.content || !signer?.nip44) {
    // Readable-but-empty so a fresh mute starts a private list.
    return { publicTags, privateTags: [], privateReadable: true };
  }
  try {
    const decrypted = await signer.nip44.decrypt(event.pubkey, event.content);
    const parsed = JSON.parse(decrypted);
    const privateTags = Array.isArray(parsed)
      ? parsed.filter((t): t is string[] => Array.isArray(t)).map((t) => [...t])
      : [];
    return { publicTags, privateTags, privateReadable: true };
  } catch (err) {
    console.warn("Failed to decrypt mute list private items:", err);
    // Can't read the private portion — signal that so we don't clobber it.
    return { publicTags, privateTags: [], privateReadable: false };
  }
}

/**
 * All kind-10000 writes run one at a time, process-wide: concurrent read-modify-writes would
 * read the same list and the last publish would drop the others (cf. useUserGroupList).
 */
let muteListWriteChain: Promise<unknown> = Promise.resolve();

function serializeMuteListWrite<T>(write: () => Promise<T>): Promise<T> {
  const run = muteListWriteChain.then(write, write);
  // Swallow on the chain so one failure doesn't wedge the queue; the caller still gets it.
  muteListWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Replaceable events order by second and break ties by lowest id, so force strictly
 * increasing created_at for rapid consecutive edits.
 */
function nextCreatedAt(prev: NostrEvent | null): number {
  const now = nowSecs();
  return prev ? Math.max(now, prev.created_at + 1) : now;
}

interface MuteEditContext {
  user: NonNullable<ReturnType<typeof useCurrentUser>["user"]>;
  nostr: ReturnType<typeof useNostr>["nostr"];
  relays: string[];
  publish: ReturnType<typeof useNostrPublish>["mutateAsync"];
}

/** `edit` returns the next private items, or `null` to skip the publish. */
async function editMuteList(
  ctx: MuteEditContext,
  edit: (tags: { publicTags: string[][]; privateTags: string[][] }) =>
    | { publicTags: string[][]; privateTags: string[][] }
    | null,
): Promise<{ pubkeys: string[]; event: NostrEvent } | null> {
  const { user, nostr, relays, publish } = ctx;

  // Pooled read: waiting on every self-state relay would block mutes whenever one is down.
  const events = await nostr.group(relays).query(
    [{ kinds: [KIND_MUTE_LIST], authors: [user.pubkey], limit: 1 }],
    { signal: AbortSignal.timeout(6000) },
  );
  const prev = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;

  // An empty read may be a failure; if a non-empty list was seen before, refuse to rebuild from
  // nothing (10000 is replaceable).
  if (!prev) {
    // Read persisted state directly: the memo may be stale from another tab's write.
    const cached = parseMuteSeed(await readFolded<unknown>(muteFoldKey(user.pubkey)));
    if (cached.pubkeys.length > 0) {
      throw new Error(t({ id: "useMuteList.loadFailed", defaultMessage: "Couldn't load your existing block list. Not saving, to avoid losing it." }));
    }
  }

  const { publicTags, privateTags, privateReadable } = await readMuteTags(prev, user.signer);
  if (!privateReadable) {
    throw new Error(t({ id: "useMuteList.readFailed", defaultMessage: "Couldn't read your existing block list. Not saving, to avoid losing it." }));
  }

  const next = edit({ publicTags, privateTags });
  if (!next) return null; // already in the requested state

  // Encrypt an empty private list only if the previous event had one.
  let content = "";
  if (next.privateTags.length > 0 || prev?.content) {
    if (!user.signer.nip44) {
      throw new Error(t({ id: "useMuteList.noNip44", defaultMessage: "Your signer can't encrypt the block list (NIP-44 required)." }));
    }
    content = await user.signer.nip44.encrypt(
      user.pubkey,
      JSON.stringify(next.privateTags),
    );
  }

  const published = await publish({
    kind: KIND_MUTE_LIST,
    content,
    tags: next.publicTags,
    created_at: nextCreatedAt(prev),
    prev: prev ?? undefined,
  });

  const muted = new Set<string>();
  collectMutedPubkeys([...next.publicTags, ...next.privateTags], muted);
  return { pubkeys: [...muted], event: published };
}

/** Memoized: every message row mounts both mutation hooks, and deriving normalizes every URL. */
function useMuteRelayKey(config: AppConfig, pubkey: string | undefined): string {
  return useMemo(() => muteRelayKey(config, pubkey), [config, pubkey]);
}

const muteRelayKeys = new WeakMap<AppConfig, Map<string, string>>();

function muteRelayKey(config: AppConfig, pubkey: string | undefined): string {
  let byPubkey = muteRelayKeys.get(config);
  if (!byPubkey) muteRelayKeys.set(config, (byPubkey = new Map()));
  let key = byPubkey.get(pubkey ?? "");
  if (key === undefined) {
    key = uniqueRelayUrls(selfStateRelays(config, pubkey)).sort().join(",");
    byPubkey.set(pubkey ?? "", key);
  }
  return key;
}

/** Appends to the *private* (NIP-44) portion, preserving existing items. Requires NIP-44. */
export function useMuteUser(): UseMutationResult<void, Error, string> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const queryClient = useQueryClient();
  const publish = useNostrPublish();
  const relayKey = useMuteRelayKey(config, user?.pubkey);
  const queryKey = ["mute-list", user?.pubkey, relayKey] as const;

  return useMutation({
    onMutate: async (pubkey: string) => {
      if (!user) return;

      // Cancel in-flight reads so they can't undo the optimistic mute.
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<MuteListQueryData>(queryKey);
      queryClient.setQueryData<MuteListQueryData>(queryKey, (current = {
        pubkeys: [],
        wireReady: false,
        configReady: false,
      }) => ({
        ...current,
        pubkeys: current.pubkeys.includes(pubkey)
          ? current.pubkeys
          : [...current.pubkeys, pubkey],
      }));
      return { previous };
    },
    mutationFn: (pubkey: string) => serializeMuteListWrite(async () => {
      if (!user) throw new Error(t({ id: "useMuteList.loginToBlock", defaultMessage: "You must be logged in to block someone." }));
      if (!user.signer.nip44) {
        throw new Error(t({ id: "useMuteList.noNip44", defaultMessage: "Your signer can't encrypt the block list (NIP-44 required)." }));
      }

      const next = await editMuteList(
        { user, nostr, relays: config.appRelays, publish: publish.mutateAsync },
        ({ publicTags, privateTags }) => {
          const alreadyMuted = [...publicTags, ...privateTags].some(
            ([name, value]) => name === "p" && value === pubkey,
          );
          if (alreadyMuted) return null;
          return { publicTags, privateTags: [...privateTags, ["p", pubkey]] };
        },
      );

      // Don't refetch: a relay may still echo the superseded event and undo the mute.
      if (next) {
        queryClient.setQueryData<MuteListQueryData>(queryKey, {
          pubkeys: next.pubkeys,
          wireReady: false,
          configReady: true,
        });
        await persistMuteList(user.pubkey, next.pubkeys, next.event);
      }
    }),
    onError: (_error, _pubkey, context) => {
      if (!user) return;
      if (context?.previous === undefined) {
        queryClient.removeQueries({ queryKey, exact: true });
      } else {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
  });
}

/**
 * Removes the `p` tag from whichever portion holds it, preserving everything else. Same
 * read-modify-write refusals as {@link useMuteUser}.
 */
export function useUnmuteUser(): UseMutationResult<void, Error, string> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const queryClient = useQueryClient();
  const publish = useNostrPublish();
  const relayKey = useMuteRelayKey(config, user?.pubkey);
  const queryKey = ["mute-list", user?.pubkey, relayKey] as const;

  return useMutation({
    onMutate: async (pubkey: string) => {
      if (!user) return;
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<MuteListQueryData>(queryKey);
      queryClient.setQueryData<MuteListQueryData>(queryKey, (current = {
        pubkeys: [],
        wireReady: false,
        configReady: false,
      }) => ({
        ...current,
        pubkeys: current.pubkeys.filter((p) => p !== pubkey),
      }));
      return { previous };
    },
    mutationFn: (pubkey: string) => serializeMuteListWrite(async () => {
      if (!user) throw new Error(t({ id: "useMuteList.loginToUnblock", defaultMessage: "You must be logged in to unblock someone." }));

      const isTarget = ([name, value]: string[]) => name === "p" && value === pubkey;
      const next = await editMuteList(
        { user, nostr, relays: config.appRelays, publish: publish.mutateAsync },
        ({ publicTags, privateTags }) => {
          if (![...publicTags, ...privateTags].some(isTarget)) return null;
          return {
            publicTags: publicTags.filter((t) => !isTarget(t)),
            privateTags: privateTags.filter((t) => !isTarget(t)),
          };
        },
      );

      if (next) {
        queryClient.setQueryData<MuteListQueryData>(queryKey, {
          pubkeys: next.pubkeys,
          wireReady: false,
          configReady: true,
        });
        await persistMuteList(user.pubkey, next.pubkeys, next.event);
      }
    }),
    onError: (_error, _pubkey, context) => {
      if (!user) return;
      if (context?.previous === undefined) {
        queryClient.removeQueries({ queryKey, exact: true });
      } else {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
  });
}

export interface MuteToggle {
  muted: boolean;
  /** Logged in, a target, and not the user themselves. */
  canMute: boolean;
  pending: boolean;
  label: string;
  /** Reports the outcome with a toast. Never throws. */
  toggle: () => Promise<void>;
}

/** Everything a menu needs to offer mute/unmute for one person. */
export function useMuteToggle(pubkey: string | undefined): MuteToggle {
  const { user } = useCurrentUser();
  const { mutedPubkeys } = useMutedPubkeys();
  const muteUser = useMuteUser();
  const unmuteUser = useUnmuteUser();

  const intl = useIntl();
  const muted = !!pubkey && mutedPubkeys.has(pubkey);
  const canMute = !!pubkey && !!user && pubkey !== user.pubkey;
  const pending = muteUser.isPending || unmuteUser.isPending;
  // `useMutation`'s result is a fresh object per render; its `mutateAsync` is stable.
  const mute = muteUser.mutateAsync;
  const unmute = unmuteUser.mutateAsync;

  const toggle = useCallback(async () => {
    if (!pubkey || !canMute) return;
    try {
      if (muted) {
        await unmute(pubkey);
        toast({
          title: t({ id: "useMuteList.unblocked.title", defaultMessage: "Unblocked" }),
          description: t({ id: "useMuteList.unblocked.description", defaultMessage: "You'll see this person again." }),
        });
      } else {
        await mute(pubkey);
        toast({
          title: t({ id: "useMuteList.blocked.title", defaultMessage: "Blocked" }),
          description: t({ id: "useMuteList.blocked.description", defaultMessage: "You won't see this person anymore." }),
        });
      }
    } catch (e) {
      toast({
        title: muted
          ? t({ id: "useMuteList.unblockFailed", defaultMessage: "Couldn't unblock" })
          : t({ id: "useMuteList.blockFailed", defaultMessage: "Couldn't block" }),
        description: e instanceof Error
          ? e.message
          : t({ id: "useMuteList.updateFailed", defaultMessage: "Failed to update your block list." }),
        variant: "destructive",
      });
    }
  }, [pubkey, canMute, muted, mute, unmute]);

  const label = muted
    ? intl.formatMessage({ id: "useMuteList.unblock", defaultMessage: "Unblock" })
    : intl.formatMessage({ id: "useMuteList.block", defaultMessage: "Block" });
  return { muted, canMute, pending, label, toggle };
}
