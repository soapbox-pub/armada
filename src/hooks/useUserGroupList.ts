import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { selfStateRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { useRemoveRailKey } from "@/hooks/useRemoveRailKey";
import { t } from "@/i18n";
import {
  buildGroupListSections,
  KIND_USER_GROUPS,
  parseGroupListTags,
  type GroupRef,
  type UserGroupList,
} from "@/lib/nip29";
import { normalizeRelayUrl } from "@/lib/platform";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import { groupListFoldKey, type PersistedGroupList } from "@/lib/nip29ServerCache";
import { queryExplicitRelaysWithStatus } from "@/lib/nip65";

import type { NUser } from "@nostrify/react/login";
import type { NostrRumor } from "@/lib/nostrRumor";
import { nowSecs } from "@/lib/relayClock";

/** Empty list, used before any 10009 event exists. */
const EMPTY_LIST: UserGroupList = { groups: [], servers: [] };

/** Result of reading a 10009 event, with a flag for a failed private-item decrypt. */
export interface ReadGroupListResult extends UserGroupList {
  /** Encrypted private items failed to decrypt; empty `servers`/`groups` are NOT authoritative. */
  decryptFailed: boolean;
}

export interface UserGroupListQuery extends ReadGroupListResult {
  event: NostrRumor | null;
  /** True only when every current self-state relay completed the wire read. */
  wireReady?: boolean;
}

function eventWins(candidate: NostrRumor, held: NostrRumor): boolean {
  return candidate.created_at > held.created_at
    || (candidate.created_at === held.created_at && candidate.id < held.id);
}

/** NIP-01 replaceable winner: newest timestamp, then lexicographically lowest id. */
export function newestGroupListEvent(events: NostrRumor[]): NostrRumor | null {
  return events
    .filter((event) => event.kind === KIND_USER_GROUPS)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0] ?? null;
}

/**
 * Resolve a relay refresh without regressing a previously decrypted list.
 * Empty/stale reads and an undecryptable candidate are "no news", not an
 * authoritative empty list. A genuinely newer, successfully decoded empty
 * event still wins, so an intentional clear propagates normally.
 */
export async function resolveGroupListRead(
  events: NostrRumor[],
  signer: NUser["signer"] | undefined,
  previous?: UserGroupListQuery,
  persisted?: PersistedGroupList,
): Promise<UserGroupListQuery> {
  let lastGood: UserGroupListQuery | undefined =
    previous?.event && !previous.decryptFailed ? previous : undefined;
  if (persisted?.event && (!lastGood?.event || eventWins(persisted.event, lastGood.event))) {
    lastGood = {
      event: persisted.event,
      groups: persisted.groups,
      servers: persisted.servers,
      decryptFailed: false,
    };
  }

  const latest = newestGroupListEvent(events);
  if (!latest) return lastGood ?? { event: null, ...EMPTY_LIST, decryptFailed: false };
  if (lastGood?.event && latest.id !== lastGood.event.id && !eventWins(latest, lastGood.event)) {
    return lastGood;
  }
  if (lastGood?.event?.id === latest.id) return lastGood;

  const decoded = await readGroupListEvent(latest, signer);
  if (decoded.decryptFailed && lastGood) return lastGood;
  return { event: latest, ...decoded };
}

/** A kind 10009's decrypted private items, or `undefined` if they couldn't be read. */
type PrivateItems = string[][] | undefined;

/**
 * Decode-once cache for the 10009 private-items decrypt, holding each author's newest
 * version only. Several always-on surfaces mount this hook, and a remote signer decrypt
 * costs seconds.
 */
const groupListDecryptMemo = new Map<string, { id: string; createdAt: number; work: Promise<PrivateItems> }>();

/** Drops decrypted 10009 private items held in memory; for logout's purge. */
export function clearGroupListMemo(): void {
  groupListDecryptMemo.clear();
}

/** The NIP-44 private items of a kind 10009 (NIP-51); `[]` when it has none. */
async function readGroupListPrivate(
  event: NostrRumor,
  signer: NUser["signer"] | undefined,
): Promise<PrivateItems> {
  if (!event.content) return [];
  if (!signer?.nip44) return undefined;

  const cached = groupListDecryptMemo.get(event.pubkey);
  if (cached?.id === event.id) return cached.work;

  const nip44 = signer.nip44;
  const work = (async (): Promise<PrivateItems> => {
    try {
      const decrypted = JSON.parse(await nip44.decrypt(event.pubkey, event.content));
      return Array.isArray(decrypted)
        ? decrypted.filter((tag): tag is string[] => Array.isArray(tag))
        : [];
    } catch (err) {
      console.warn("Failed to decrypt group list private items:", err);
      // Don't memoize a transient failure.
      if (groupListDecryptMemo.get(event.pubkey)?.id === event.id) groupListDecryptMemo.delete(event.pubkey);
      return undefined;
    }
  })();
  if (!cached || event.created_at >= cached.createdAt) {
    groupListDecryptMemo.set(event.pubkey, { id: event.id, createdAt: event.created_at, work });
  }
  return work;
}

/**
 * Decrypt the NIP-44 private items of a kind 10009 event (NIP-51) and merge
 * them with the public tags. Falls back to public-only when decryption fails.
 */
export async function readGroupListEvent(
  event: NostrRumor | null,
  signer: NUser["signer"] | undefined,
): Promise<ReadGroupListResult> {
  if (!event) return { ...EMPTY_LIST, decryptFailed: false };
  const privateItems = await readGroupListPrivate(event, signer);
  return {
    ...parseGroupListTags([...event.tags, ...(privateItems ?? [])]),
    decryptFailed: privateItems === undefined,
  };
}

/**
 * The user's kind 10009 group list (NIP-51 "Simple groups"): joined channels
 * (`group` tags) and added servers (`r` tags), private items NIP-44 encrypted to self.
 */
export function useUserGroupList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const queryKey = ["nip29", "user-groups", user?.pubkey];
  const foldKey = user ? groupListFoldKey(user.pubkey) : null;

  // Plaintext-first: remote-signer decrypt is slow and gates the NIP-29 UI, so
  // decrypt once and persist the decrypted list locally for later boots.
  useEffect(() => {
    if (!user || !foldKey) return;
    let cancelled = false;
    void (async () => {
      if (queryClient.getQueryData(queryKey)) return;

      const persisted = await readFolded<PersistedGroupList>(foldKey);
      if (cancelled) return;
      if (persisted) {
        queryClient.setQueryData(queryKey, {
          event: persisted.event ?? null,
          groups: persisted.groups,
          servers: persisted.servers,
          decryptFailed: false,
        });
        return;
      }

      const store = await eventStore;
      const cached = newestGroupListEvent(
        await store.query([{ kinds: [KIND_USER_GROUPS], authors: [user.pubkey] }]),
      );
      if (cancelled || !cached) return;
      const list = await readGroupListEvent(cached, user.signer);
      if (cancelled || queryClient.getQueryData(queryKey)) return;
      queryClient.setQueryData(queryKey, {
        event: cached,
        groups: list.groups,
        servers: list.servers,
        decryptFailed: list.decryptFailed,
      });
      if (!list.decryptFailed) {
        void writeFolded(foldKey, {
          event: cached,
          groups: list.groups,
          servers: list.servers,
        } satisfies PersistedGroupList);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.pubkey, eventStore, queryClient]);

  return useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
      const selfRelays = [
        ...new Set(selfStateRelays(config, user!.pubkey)
          .map(normalizeRelayUrl)
          .filter((url): url is string => Boolean(url))),
      ].sort();
      const [wireRead, storedEvents] = await Promise.all([
        queryExplicitRelaysWithStatus(
          nostr,
          selfRelays,
          [{ kinds: [KIND_USER_GROUPS], authors: [user!.pubkey], limit: 1 }],
          deadline,
        ),
        eventStore
          .then((store) => store.query(
            [{ kinds: [KIND_USER_GROUPS], authors: [user!.pubkey] }],
            { signal: deadline },
          ))
          .catch(() => [] as NostrRumor[]),
      ]);
      const prev = queryClient.getQueryData<UserGroupListQuery>(queryKey);
      const persisted = foldKey
        ? await readFolded<PersistedGroupList>(foldKey)
        : undefined;
      const newestWire = newestGroupListEvent(
        wireRead.events.filter((event) => event.pubkey === user!.pubkey),
      );
      const wireDecryptReady = newestWire
        ? !(await readGroupListEvent(newestWire, user!.signer)).decryptFailed
        : true;
      const result = await resolveGroupListRead(
        [...wireRead.events, ...storedEvents].filter((event) => event.pubkey === user!.pubkey),
        user!.signer,
        prev,
        persisted,
      );
      if (foldKey && result.event && !result.decryptFailed) {
        void writeFolded(foldKey, {
          event: result.event,
          groups: result.groups,
          servers: result.servers,
        } satisfies PersistedGroupList);
      }
      const answered = new Set(wireRead.answered);
      return {
        ...result,
        // The pool-wide fallback can't prove which source failed; never prune proof.
        wireReady: selfRelays.length > 0
          && selfRelays.every((relay) => answered.has(relay))
          && wireDecryptReady,
      };
    },
    enabled: Boolean(user),
    staleTime: 30_000,
  });
}

/** A single mutation against the user's kind 10009 list (read-modify-write). */
type GroupListAction =
  | { type: "add-group"; ref: GroupRef }
  | { type: "remove-group"; ref: GroupRef }
  | { type: "add-server"; url: string }
  | { type: "remove-server"; url: string }
  | { type: "reorder-servers"; urls: string[] };

function applyAction(list: UserGroupList, action: GroupListAction): UserGroupList {
  switch (action.type) {
    case "add-group": {
      const without = list.groups.filter(
        (g) => !(g.id === action.ref.id && g.relay === action.ref.relay),
      );
      // Joining a channel also adds its server (no passive-visit server sync).
      const relay = normalizeRelayUrl(action.ref.relay) ?? action.ref.relay;
      const servers = list.servers.some((s) => (normalizeRelayUrl(s) ?? s) === relay)
        ? list.servers
        : [...list.servers, relay];
      return { ...list, groups: [...without, action.ref], servers };
    }
    case "remove-group":
      return {
        ...list,
        groups: list.groups.filter(
          (g) => !(g.id === action.ref.id && g.relay === action.ref.relay),
        ),
      };
    case "add-server": {
      const url = normalizeRelayUrl(action.url) ?? action.url;
      if (list.servers.includes(url)) return list;
      return { ...list, servers: [...list.servers, url] };
    }
    case "remove-server": {
      const url = normalizeRelayUrl(action.url) ?? action.url;
      // Compare normalized (stored `r` tags keep raw form). Also drop joined
      // groups on this server, or they'd re-hydrate on other devices.
      return {
        ...list,
        servers: list.servers.filter((s) => (normalizeRelayUrl(s) ?? s) !== url),
        groups: list.groups.filter((g) => (normalizeRelayUrl(g.relay) ?? g.relay) !== url),
      };
    }
    case "reorder-servers": {
      // Keep only known servers (a stale reorder can't add/drop entries), then
      // append any the caller omitted.
      const known = new Set(list.servers);
      const desired: string[] = [];
      const seen = new Set<string>();
      for (const raw of action.urls) {
        const url = normalizeRelayUrl(raw) ?? raw;
        if (known.has(url) && !seen.has(url)) {
          seen.add(url);
          desired.push(url);
        }
      }
      for (const url of list.servers) {
        if (!seen.has(url)) desired.push(url);
      }
      return { ...list, servers: desired };
    }
  }
}

/**
 * All 10009 writes run one at a time: concurrent read-modify-writes would all
 * read the same pre-edit list and the last publish would overwrite the rest.
 */
let groupListWriteChain: Promise<unknown> = Promise.resolve();

function serializeGroupListWrite<T>(write: () => Promise<T>): Promise<T> {
  const run = groupListWriteChain.then(write, write);
  // Swallow on the chain so one failure doesn't wedge the queue; caller still gets it.
  groupListWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Strictly monotonic created_at: replaceable events tie-break same-second
 * writes by lowest id (NIP-01), so a later edit could otherwise lose.
 */
function nextCreatedAt(prev: NostrRumor | null): number {
  const now = nowSecs();
  return prev ? Math.max(now, prev.created_at + 1) : now;
}

/**
 * Read-modify-write the user's kind 10009 list against fresh relay state.
 * An existing list keeps its format (public tags vs encrypted content).
 */
export function useUpdateUserGroupList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const removeRailKey = useRemoveRailKey();

  return useMutation({
    mutationFn: (action: GroupListAction) => serializeGroupListWrite(async () => {
      if (!user) throw new Error(t({ id: "useUserGroupList.notLoggedIn", defaultMessage: "User is not logged in" }));

      const relays = selfStateRelays(config, user.pubkey);
      if (relays.length === 0) {
        throw new Error(t({ id: "useUserGroupList.noRelay", defaultMessage: "No account-state relay is available for your server list" }));
      }
      const deadline = AbortSignal.timeout(8000);
      const [response, storedEvents] = await Promise.all([
        queryExplicitRelaysWithStatus(
          nostr,
          relays,
          [{ kinds: [KIND_USER_GROUPS], authors: [user.pubkey], limit: 1 }],
          deadline,
        ),
        eventStore
          .then((store) => store.query(
            [{ kinds: [KIND_USER_GROUPS], authors: [user.pubkey] }],
            { signal: deadline },
          ))
          .catch(() => [] as NostrRumor[]),
      ]);
      if (response.answered.length === 0) {
throw new Error(t({ id: "useUserGroupList.unconfirmed", defaultMessage: "Couldn't confirm your current server list on an account-state relay; not saving to avoid wiping it." }));
      }
      const events = [...response.events, ...storedEvents];
      const fetched = newestGroupListEvent(events);

      // Persisted decrypted list guards against (1) an empty read on a device
      // that has seen a list (would wipe it — refuse) and (2) a stale older event.
      const persisted = await readFolded<PersistedGroupList>(groupListFoldKey(user.pubkey));
      if (!fetched && persisted?.event) {
        throw new Error(t({ id: "useUserGroupList.loadFailed", defaultMessage: "Couldn't load your current server list from the network; not saving to avoid wiping it." }));
      }

      let prev: NostrRumor | null = fetched;
      let current: UserGroupList;
      // Pick the NIP-01 replaceable winner (newest, then lowest id).
      if (persisted?.event && fetched && (
        persisted.event.id === fetched.id || eventWins(persisted.event, fetched)
      )) {
        prev = persisted.event;
        current = { groups: persisted.groups, servers: persisted.servers };
      } else {
        const read = await readGroupListEvent(fetched, user.signer);
        // Never write on top of an undecryptable list — it would wipe private items.
        if (read.decryptFailed) {
          throw new Error(t({ id: "useUserGroupList.decryptFailed", defaultMessage: "Couldn't read your existing list (decryption failed); not saving to avoid data loss." }));
        }
        current = read;
      }
      const next = applyAction(current, action);

      // Each item keeps its section (a public list from Flotilla/Coracle must stay
      // readable to them; a private item must not leak), and so does every other tag.
      const prevPrivate = prev ? await readGroupListPrivate(prev, user.signer) : [];
      if (prevPrivate === undefined) {
        throw new Error(t({ id: "useUserGroupList.decryptFailed", defaultMessage: "Couldn't read your existing list (decryption failed); not saving to avoid data loss." }));
      }
      // New lists encrypt; an existing one adds new items in the form it already uses.
      const newItemsPrivate = prev ? Boolean(prev.content) : true;
      const { publicTags, privateTags } = buildGroupListSections(
        prev?.tags ?? [],
        prevPrivate,
        next,
        newItemsPrivate,
      );
      let content = "";
      if (privateTags.length > 0 || prev?.content) {
        if (!user.signer.nip44) {
          throw new Error(t({ id: "useUserGroupList.noNip44", defaultMessage: "NIP-44 encryption not supported by this signer" }));
        }
        content = await user.signer.nip44.encrypt(user.pubkey, JSON.stringify(privateTags));
      }

      const published = await publishEvent({
        kind: KIND_USER_GROUPS,
        content,
        tags: publicTags,
        created_at: nextCreatedAt(prev),
        prev: prev ?? undefined,
        relays: response.answered,
        inheritPendingTargets: false,
      });
      // Awaited: the next queued write reads this back as its base.
      if (published) {
        await writeFolded(groupListFoldKey(user.pubkey), {
          event: published,
          groups: next.groups,
          servers: next.servers,
        } satisfies PersistedGroupList).catch(() => undefined);
      }
      return published;
    }),
    onSuccess: (_published, action) => {
      // Purge the server's rail-arrangement key only once the write landed.
      if (action.type === "remove-server") {
        removeRailKey(normalizeRelayUrl(action.url) ?? action.url);
      }
      queryClient.invalidateQueries({ queryKey: ["nip29", "user-groups"] });
    },
  });
}
