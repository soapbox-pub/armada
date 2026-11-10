/**
 * Which settings root this device holds, and how a device gets one. The root
 * secret is decrypted ONCE per edition and kept in ArmadaDB KV, so later boots
 * re-derive every document key without asking the user's signer anything.
 * See `docs/settings-documents.md`.
 */

import type { NostrEvent, NostrFilter, NostrSigner } from "@nostrify/nostrify";

import type { ArmadaEventStore } from "@/contexts/EventStoreContext";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { queryExplicitRelaysWithStatus, type RelayQueryClient } from "@/lib/nip65";
import type { NostrRumor } from "@/lib/nostrRumor";
import { publishSelfStateEvent } from "@/lib/selfStatePublish";
import { SETTINGS_DTAGS, SETTINGS_KIND } from "@/lib/settingsDocs";
import { clearSettingsKeyringMemo, generateSettingsRoot, settingsKeyring, type SettingsKeyring } from "@/lib/settingsKeys";
import {
  decodeSettingsRoot,
  encodeSettingsRoot,
  newestSettingsRoot,
  settingsRootDTag,
  settingsRootTags,
  SETTINGS_ROOT_KIND,
} from "@/lib/settingsRoot";
import { nowSecs } from "@/lib/relayClock";

const HELD_PREFIX = "nip78root:";
const PREVIOUS_PREFIX = "nip78root-prev:";
/** Roots that lost a creation race; their documents are folded like legacy ones. */
const MAX_PREVIOUS_ROOTS = 4;

interface HeldRoot {
  root: string;
  eventId?: string;
  createdAt?: number;
}

export interface SettingsKeys {
  keyring: SettingsKeyring | null;
  /** Keyrings of roots this device held before the current one won. */
  previous: SettingsKeyring[];
}

const heldMemo = new Map<string, HeldRoot | null>();
const previousMemo = new Map<string, string[]>();
const inflight = new Map<string, Promise<SettingsKeys>>();

export function settingsRootFilter(pubkey: string): NostrFilter {
  return { kinds: [SETTINGS_ROOT_KIND], authors: [pubkey], "#d": [settingsRootDTag()] };
}

async function loadHeld(pubkey: string): Promise<HeldRoot | null> {
  if (heldMemo.has(pubkey)) return heldMemo.get(pubkey)!;
  const value = await getArmadaDB().kv.get<HeldRoot>(HELD_PREFIX + pubkey).catch(() => undefined);
  const held = value && typeof value.root === "string" ? value : null;
  heldMemo.set(pubkey, held);
  return held;
}

async function loadPrevious(pubkey: string): Promise<string[]> {
  const held = previousMemo.get(pubkey);
  if (held) return held;
  const value = await getArmadaDB().kv.get<string[]>(PREVIOUS_PREFIX + pubkey).catch(() => undefined);
  const roots = Array.isArray(value) ? value.filter((root) => typeof root === "string") : [];
  previousMemo.set(pubkey, roots);
  return roots;
}

async function saveHeld(pubkey: string, held: HeldRoot): Promise<void> {
  const previous = heldMemo.get(pubkey);
  if (previous && previous.root !== held.root) {
    const roots = [previous.root, ...(await loadPrevious(pubkey)).filter((root) => root !== previous.root && root !== held.root)]
      .slice(0, MAX_PREVIOUS_ROOTS);
    previousMemo.set(pubkey, roots);
    await getArmadaDB().kv.set(PREVIOUS_PREFIX + pubkey, roots).catch(() => undefined);
  }
  heldMemo.set(pubkey, held);
  await getArmadaDB().kv.set(HELD_PREFIX + pubkey, held).catch(() => undefined);
}

async function keysFor(pubkey: string, root: string | undefined): Promise<SettingsKeys> {
  const previous = (await loadPrevious(pubkey)).filter((candidate) => candidate !== root);
  return {
    keyring: root ? settingsKeyring(root) : null,
    previous: previous.map(settingsKeyring),
  };
}

function isOlder(event: NostrRumor, held: HeldRoot): boolean {
  if (held.createdAt === undefined || held.eventId === undefined) return false;
  return event.created_at < held.createdAt
    || (event.created_at === held.createdAt && event.id > held.eventId);
}

/**
 * The root this device should use: the NIP-01 winner on disk, decrypted only
 * when it is an edition this device has not decrypted before. A root that loses
 * to another device's becomes a "previous" root rather than being forgotten.
 */
export async function resolveSettingsKeys(
  store: ArmadaEventStore,
  signer: NostrSigner,
  pubkey: string,
): Promise<SettingsKeys> {
  const held = await loadHeld(pubkey);
  let events: NostrRumor[] = [];
  try {
    events = await store.query([settingsRootFilter(pubkey)]);
  } catch {
    // Store unavailable: the held root is still the best answer.
  }
  const newest = newestSettingsRoot(events, pubkey);
  if (!newest || newest.id === held?.eventId || (held && isOlder(newest, held))) {
    return keysFor(pubkey, held?.root);
  }
  if (!signer.nip44) return keysFor(pubkey, held?.root);
  let root: string | undefined;
  try {
    root = decodeSettingsRoot(await signer.nip44.decrypt(pubkey, newest.content))?.root;
  } catch (error) {
    console.warn("Failed to decrypt the settings root:", error);
  }
  if (!root) return keysFor(pubkey, held?.root);
  await saveHeld(pubkey, { root, eventId: newest.id, createdAt: newest.created_at });
  return keysFor(pubkey, root);
}

/** Whether this account already keeps Armada settings anywhere this device can see. */
async function syncEstablished(store: ArmadaEventStore, pubkey: string): Promise<boolean> {
  try {
    const legacy = await store.query([
      { kinds: [SETTINGS_KIND], authors: [pubkey], "#d": SETTINGS_DTAGS, limit: 1 },
    ]);
    return legacy.length > 0;
  } catch {
    return false;
  }
}

/** A relay pool that can both read and publish (NPool, or a test double). */
export interface SelfStateClient extends RelayQueryClient {
  relay(url: string): ReturnType<RelayQueryClient["relay"]> & {
    event(event: NostrEvent, opts: { signal: AbortSignal }): Promise<unknown>;
  };
}

export interface EnsureSettingsRootOptions {
  nostr: SelfStateClient;
  store: ArmadaEventStore;
  signer: NostrSigner;
  pubkey: string;
  /** The account's self-state relays: where the root is looked for and published. */
  relays: string[];
  /**
   * An explicit "Sync now". Otherwise a root is created only for an account
   * that already keeps Armada settings (see AGENTS.md on unsolicited publishes).
   */
  explicit?: boolean;
  /** Runs once, right after a NEW root is published (the eager copy). */
  onCreated?: (keys: SettingsKeys) => Promise<void>;
}

/**
 * The account's keys, creating its root if it has none. A root is minted only
 * after the account relays CONFIRM they hold none: replaceable, so a second
 * root would orphan every document under the first.
 */
export function ensureSettingsKeys(opts: EnsureSettingsRootOptions): Promise<SettingsKeys> {
  const running = inflight.get(opts.pubkey);
  if (running) return running;
  const run = ensure(opts).finally(() => inflight.delete(opts.pubkey));
  inflight.set(opts.pubkey, run);
  return run;
}

async function ensure(opts: EnsureSettingsRootOptions): Promise<SettingsKeys> {
  const { nostr, store, signer, pubkey, relays } = opts;
  const resolved = await resolveSettingsKeys(store, signer, pubkey);
  if (resolved.keyring) return resolved;
  if (!signer.nip44) throw new Error("Your signer cannot encrypt private settings");
  if (relays.length === 0) throw new Error("Add an account write relay before synchronizing private settings");
  if (!opts.explicit && !(await syncEstablished(store, pubkey))) {
    throw new Error("Settings sync has not been set up for this account");
  }

  const read = await queryExplicitRelaysWithStatus(
    nostr,
    relays,
    [settingsRootFilter(pubkey)],
    AbortSignal.timeout(8000),
  );
  if (read.answered.length === 0) throw new Error("No account relay answered the settings root read");
  const found = newestSettingsRoot(read.events.filter((event) => event.pubkey === pubkey), pubkey);
  if (found) {
    await store.event(found);
    const adopted = await resolveSettingsKeys(store, signer, pubkey);
    if (adopted.keyring) return adopted;
    throw new Error("The account's settings root could not be decrypted");
  }

  const root = generateSettingsRoot();
  const event = await signer.signEvent({
    kind: SETTINGS_ROOT_KIND,
    content: await signer.nip44.encrypt(pubkey, encodeSettingsRoot({ v: 1, root })),
    tags: settingsRootTags(),
    created_at: nowSecs(),
  });
  if (event.pubkey !== pubkey) throw new Error("The signer returned a different account");
  // Held before publishing: a partial fan-out must not let this device mint a second root.
  await saveHeld(pubkey, { root, eventId: event.id, createdAt: event.created_at });
  const keys = await keysFor(pubkey, root);
  try {
    await publishSelfStateEvent(nostr, store, event, relays, { label: "settings root" });
  } catch (error) {
    // Queued or not, the root is held; the outbox (or the next Sync now) delivers it.
    console.warn("Settings root delivery incomplete:", error);
  }
  await opts.onCreated?.(keys).catch((error) => console.warn("Settings migration incomplete:", error));
  return keys;
}

/** The decrypted root, for diagnostics and tests only. */
export async function heldSettingsRoot(pubkey: string): Promise<string | undefined> {
  return (await loadHeld(pubkey))?.root;
}

/** Logout: the KV copies go with ArmadaDB; these are the in-memory ones. */
export function clearSettingsRootMemory(): void {
  heldMemo.clear();
  previousMemo.clear();
  inflight.clear();
  clearSettingsKeyringMemo();
}
