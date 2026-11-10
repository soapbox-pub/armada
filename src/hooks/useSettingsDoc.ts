import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type { NostrFilter, NostrSigner } from "@nostrify/nostrify";
import type { z } from "zod";

import { selfStateRelays } from "@/contexts/AppContext";
import type { ArmadaEventStore } from "@/contexts/EventStoreContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useSettingsKeys } from "@/hooks/useSettingsKeys";
import { t } from "@/i18n";
import type { NostrRumor } from "@/lib/nostrRumor";
import { publishSelfStateEvent } from "@/lib/selfStatePublish";
import {
  SETTINGS_DOC_NAMES,
  SETTINGS_DOC_SCHEMAS,
  SETTINGS_KIND,
  parseSettingsDoc,
  resolveLegacy,
  settingsDTag,
  stripMigratedKeys,
  type SettingsDocName,
} from "@/lib/settingsDocs";
import type { DerivedDoc } from "@/lib/settingsKeys";
import type { SelfStateClient, SettingsKeys } from "@/lib/settingsRootStore";

import type { MetadataDoc } from "@/lib/schemas";
import { nowSecs } from "@/lib/relayClock";

/**
 * Read/write one encrypted NIP-78 settings document; see `lib/settingsDocs.ts` and
 * `docs/settings-documents.md`. A document is written under its key derived from the
 * settings root, and read from up to three sources: that derived document, the same
 * document under a root this device held before, and the legacy `${APP_ID}/<name>`
 * document the account key signed. The newest wins; this build never writes a legacy one.
 * ARMADADB IS THE MODEL: this hook never reads a relay.
 * Callers must check `doc` is non-null before publishing on their own schedule: `update` merges over
 * `{}` when nothing is stored, which would REPLACE the user's real document everywhere.
 */

type DocSchemas = typeof SETTINGS_DOC_SCHEMAS;

export type SettingsDocOf<N extends SettingsDocName> = z.infer<DocSchemas[N]>;

export interface StoredSettingsDoc<N extends SettingsDocName> {
  event: NostrRumor;
  doc: SettingsDocOf<N>;
}

/** What a settings read needs: the account, its signer (for legacy) and its derived keys. */
export interface SettingsReadContext {
  store: ArmadaEventStore;
  signer: NostrSigner;
  pubkey: string;
  keys: SettingsKeys;
}

/** The legacy, account-signed document. Read-only: kept for the migration window. */
export function legacySettingsDocFilter(pubkey: string, name: SettingsDocName): NostrFilter {
  return {
    kinds: [SETTINGS_KIND],
    authors: [pubkey],
    "#d": [settingsDTag(name)],
    limit: 1,
  };
}

export function derivedDocFilter(doc: DerivedDoc): NostrFilter {
  return { kinds: [SETTINGS_KIND], authors: [doc.pubkey], "#d": [doc.d], limit: 1 };
}

export function settingsDocQueryKey(name: SettingsDocName, pubkey: string | undefined) {
  return ["settings-doc", name, pubkey];
}

interface Source {
  filter: NostrFilter;
  signer: NostrSigner;
  author: string;
  /** Breaks a `created_at` tie: the current root's copy first. */
  rank: number;
}

function sourcesOf(ctx: SettingsReadContext, name: SettingsDocName): Source[] {
  const sources: Source[] = [];
  const current = ctx.keys.keyring?.settings[name];
  if (current) sources.push({ filter: derivedDocFilter(current), signer: current.signer, author: current.pubkey, rank: 2 });
  for (const keyring of ctx.keys.previous) {
    const doc = keyring.settings[name];
    sources.push({ filter: derivedDocFilter(doc), signer: doc.signer, author: doc.pubkey, rank: 1 });
  }
  sources.push({ filter: legacySettingsDocFilter(ctx.pubkey, name), signer: ctx.signer, author: ctx.pubkey, rank: 0 });
  return sources;
}

async function newestOf(store: ArmadaEventStore, filter: NostrFilter): Promise<NostrRumor | undefined> {
  let event: NostrRumor | undefined;
  for (const rumor of await store.query([filter])) {
    // NIP-01: the lower id wins an equal-second tie.
    if (!event || rumor.created_at > event.created_at
      || (rumor.created_at === event.created_at && rumor.id < event.id)) event = rumor;
  }
  return event?.content ? event : undefined;
}

/** Whether `event` is a copy of `name` from any source `ctx` reads. */
export function isSettingsDocEvent(
  keys: SettingsKeys,
  pubkey: string,
  name: SettingsDocName,
  event: Pick<NostrRumor, "kind" | "pubkey" | "tags">,
): boolean {
  if (event.kind !== SETTINGS_KIND) return false;
  const d = event.tags.find(([tag]) => tag === "d")?.[1];
  if (event.pubkey === pubkey) return d === settingsDTag(name);
  return [keys.keyring, ...keys.previous].some((keyring) => {
    const doc = keyring?.settings[name];
    return doc?.pubkey === event.pubkey && doc.d === d;
  });
}

async function newestSources(ctx: SettingsReadContext, name: SettingsDocName) {
  const found: { event: NostrRumor; source: Source }[] = [];
  for (const source of sourcesOf(ctx, name)) {
    const event = await newestOf(ctx.store, source.filter);
    if (event) found.push({ event, source });
  }
  found.sort((a, b) => b.event.created_at - a.event.created_at || b.source.rank - a.source.rank);
  return found;
}

/**
 * The newest copy, and whether it could not be read. A writer that rebuilds a
 * document must refuse an unreadable newest copy rather than build over an older one.
 */
export async function readSettingsDocChecked<N extends SettingsDocName>(
  ctx: SettingsReadContext,
  name: N,
): Promise<{ stored: StoredSettingsDoc<N> | null; unreadable: boolean }> {
  const newest = (await newestSources(ctx, name).catch(() => []))[0];
  if (!newest) return { stored: null, unreadable: false };
  const stored = await decodeSettingsDoc(newest.event, newest.source.signer, newest.source.author, name);
  return { stored, unreadable: !stored };
}

/** Every readable source of `name`, best first (newest, then the current root's). */
export async function readSettingsDocSources<N extends SettingsDocName>(
  ctx: SettingsReadContext,
  name: N,
): Promise<StoredSettingsDoc<N>[]> {
  let found: { event: NostrRumor; source: Source }[];
  try {
    found = await newestSources(ctx, name);
  } catch {
    return []; // Store unavailable; treat as "nothing on disk".
  }
  const decoded: StoredSettingsDoc<N>[] = [];
  for (const { event, source } of found) {
    const doc = await decodeSettingsDoc(event, source.signer, source.author, name);
    if (doc) decoded.push(doc);
  }
  return decoded;
}

/** Whether any copy of `name` is on disk, readable or not. */
export async function settingsDocExists(ctx: SettingsReadContext, name: SettingsDocName): Promise<boolean> {
  try {
    for (const source of sourcesOf(ctx, name)) {
      if (await newestOf(ctx.store, source.filter)) return true;
    }
  } catch { /* store unavailable */ }
  return false;
}

/** Newest stored version across every source, decrypted; null if none or undecryptable. */
export async function readSettingsDoc<N extends SettingsDocName>(
  ctx: SettingsReadContext,
  name: N,
): Promise<StoredSettingsDoc<N> | null> {
  return (await readSettingsDocSources(ctx, name))[0] ?? null;
}

/** Decrypt with the key the document is encrypted to: the derived doc's own, or the account's. */
export async function decodeSettingsDoc<N extends SettingsDocName>(
  event: NostrRumor,
  signer: NostrSigner,
  pubkey: string,
  name: N,
): Promise<StoredSettingsDoc<N> | null> {
  if (!signer.nip44) return null;
  try {
    const plaintext = await signer.nip44.decrypt(pubkey, event.content);
    const parsed = parseSettingsDoc(name, JSON.parse(plaintext));
    if (parsed && parsed.dropped.length > 0) {
      console.warn(`Ignoring invalid ${name} settings field(s): ${parsed.dropped.join(", ")}`);
    }
    return parsed ? { event, doc: parsed.doc as SettingsDocOf<N> } : null;
  } catch (err) {
    console.warn(`Failed to decrypt ${name} settings:`, err);
    return null;
  }
}

/** Previous doc + patch, applying the `metadata`-specific rules. */
export function nextSettingsDoc<N extends SettingsDocName>(
  name: N,
  previous: SettingsDocOf<N> | undefined,
  patch: Partial<SettingsDocOf<N>>,
): SettingsDocOf<N> {
  const merged = { ...(previous ?? {}), ...patch } as SettingsDocOf<N>;
  if (name !== "metadata") return merged;
  return {
    // Fields that moved into their own documents are dropped — see `stripMigratedKeys`.
    ...stripMigratedKeys(merged as MetadataDoc),
    // For older builds that order versions by this rather than `created_at`. Metadata only.
    lastSync: Date.now(),
  } as SettingsDocOf<N>;
}

/** Sign `doc` under its derived key, strictly newer than `previousCreatedAt`. */
export async function signDerivedSettingsDoc(
  derived: DerivedDoc,
  doc: unknown,
  previousCreatedAt: number | undefined,
) {
  return derived.signer.signEvent({
    kind: SETTINGS_KIND,
    content: await derived.signer.nip44!.encrypt(derived.pubkey, JSON.stringify(doc)),
    // Only the opaque `d`: a title or client tag would name what this is.
    tags: [["d", derived.d]],
    // Strictly newer than what we merged over, or the store (and relays) would discard it.
    created_at: Math.max(nowSecs(), (previousCreatedAt ?? 0) + 1),
  });
}

/**
 * Writes to one document run one at a time: concurrent read-modify-writes would read the same
 * version and collide on `created_at`. Distinct documents may write concurrently (cf.
 * `serializeGroupListWrite`).
 */
const settingsWriteChains = new Map<SettingsDocName, Promise<unknown>>();

export function serializeSettingsWrite<T>(name: SettingsDocName, write: () => Promise<T>): Promise<T> {
  const chain = settingsWriteChains.get(name) ?? Promise.resolve();
  const run = chain.then(write, write);
  // Swallow on the chain so one failure doesn't wedge the queue; the caller still gets it.
  settingsWriteChains.set(name, run.then(() => undefined, () => undefined));
  return run;
}

export interface SettingsWriteContext extends SettingsReadContext {
  nostr: SelfStateClient;
  relays: string[];
}

/**
 * Right after this device minted the root, write every document that so far
 * exists only in its legacy form under its derived key, so a document nobody
 * touches again does not stay readable only through the legacy path. Only the
 * minting device may: it alone knows no derived copy exists yet.
 */
export async function copyLegacySettingsDocs(ctx: SettingsWriteContext): Promise<void> {
  const keyring = ctx.keys.keyring;
  if (!keyring) return;
  const legacyCtx: SettingsReadContext = { ...ctx, keys: { keyring: null, previous: [] } };
  const legacyMetadata = await readSettingsDoc(legacyCtx, "metadata");
  for (const name of SETTINGS_DOC_NAMES) {
    await serializeSettingsWrite(name, async () => {
      const current = await readSettingsDoc(ctx, name);
      if (current && current.event.pubkey !== ctx.pubkey) return; // already derived
      const source = name === "metadata"
        ? current
        : resolveLegacy(name, current, legacyMetadata);
      if (!source) return;
      const doc = nextSettingsDoc(name, source.doc as SettingsDocOf<typeof name>, {});
      const event = await signDerivedSettingsDoc(keyring.settings[name], doc, current?.event.created_at);
      await publishSelfStateEvent(ctx.nostr, ctx.store, event, ctx.relays, { label: `${name} settings` })
        .catch((error) => console.warn(`Copying ${name} settings incomplete:`, error));
    });
  }
}

export interface UseSettingsDocReturn<N extends SettingsDocName> {
  /** The decrypted document, or null when none is on disk. */
  doc: SettingsDocOf<N> | null;
  /** Identity, for "have I applied this?". */
  event: NostrRumor | null;
  /**
   * Every readable copy, best first (may be empty when `doc` was seeded directly).
   * Documents with commutative merges (read-state, reactions) fold all of them.
   */
  sources: StoredSettingsDoc<N>[];
  isLoading: boolean;
  isFetched: boolean;
  update: (patch: Partial<SettingsDocOf<N>>) => Promise<SettingsDocOf<N>>;
  hasNip44Support: boolean;
}

export interface SettingsDocQueryData<N extends SettingsDocName> extends StoredSettingsDoc<N> {
  sources?: StoredSettingsDoc<N>[];
}

const NO_SOURCES: never[] = [];

export function useSettingsDoc<N extends SettingsDocName>(name: N): UseSettingsDocReturn<N> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const { keys, isFetched: keysFetched, ensure } = useSettingsKeys();

  const queryKey = settingsDocQueryKey(name, user?.pubkey);

  const query = useQuery<SettingsDocQueryData<N> | null>({
    queryKey,
    enabled: !!user?.pubkey && !!user.signer.nip44 && keysFetched,
    queryFn: async () => {
      if (!user) return null;
      const sources = await readSettingsDocSources(
        { store: await eventStore, signer: user.signer, pubkey: user.pubkey, keys },
        name,
      );
      return sources[0] ? { ...sources[0], sources } : null;
    },
  });

  const mutation = useMutation({
    mutationFn: (patch: Partial<SettingsDocOf<N>>) => serializeSettingsWrite(name, async () => {
      if (!user?.signer.nip44) throw new Error(t({ id: "useSettingsDoc.noNip44", defaultMessage: "NIP-44 encryption not supported by signer" }));
      const relays = selfStateRelays(config, user.pubkey);
      if (relays.length === 0) {
        throw new Error(t({ id: "useSettingsDoc.noWriteRelay", defaultMessage: "Add an account write relay before synchronizing private settings" }));
      }
      const writeKeys = await ensure();
      const keyring = writeKeys.keyring;
      if (!keyring) throw new Error("No settings root");
      const store = await eventStore;

      // Merge over the STORE, not the query cache: the store may hold a newer version (wire, Android
      // service), and merging over a stale cache reverts other devices' changes.
      const previous = await readSettingsDoc(
        { store, signer: user.signer, pubkey: user.pubkey, keys: writeKeys },
        name,
      );
      const next = nextSettingsDoc(name, previous?.doc, patch);
      const event = await signDerivedSettingsDoc(keyring.settings[name], next, previous?.event.created_at);

      await publishSelfStateEvent(nostr, store, event, relays, {
        label: `${name} settings`,
        beforePublish: async () => {
          // Cancel in-flight refetches that could regress the cache to the previous version.
          await queryClient.cancelQueries({ queryKey });
          queryClient.setQueryData<SettingsDocQueryData<N>>(queryKey, { event, doc: next });
        },
      });
      return next;
    }),
  });

  const { mutateAsync } = mutation;
  const update = useCallback(
    (patch: Partial<SettingsDocOf<N>>) => mutateAsync(patch),
    [mutateAsync],
  );

  return {
    doc: query.data?.doc ?? null,
    event: query.data?.event ?? null,
    sources: query.data?.sources ?? NO_SOURCES,
    isLoading: query.isLoading,
    isFetched: query.isFetched,
    update,
    hasNip44Support: !!user?.signer.nip44,
  };
}
