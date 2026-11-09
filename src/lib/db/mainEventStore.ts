/**
 * The app-wide event store: local cache of relay events, routed by scope
 * (see `relayScope.ts`):
 *  - `main`: true whoever served it (profiles, own lists, git, ciphertext).
 *  - `nip29:<relay>`: only true on one relay; group ids and even relay keys can
 *    be shared across servers, so the relay is structural in the tenant id.
 * `event()` takes the source relay and `query()` the target relay; relay-relative
 * events with no known relay are DROPPED.
 *
 * Signatures are dropped (ArmadaDB stores rumors). Verification happens at
 * ingest, but anything re-publishing verbatim must get the event from a relay or
 * the outbox, never here (`useRepublish` refuses unsigned events).
 *
 * The Android service writes through the same tenants by the same rule
 * (`ServiceStore.kt`).
 */
import { NKinds } from "@nostrify/nostrify";

import { isUserBannedNow } from "@/lib/bannedUsers";

import { ARMADA_TENANTS, getArmadaDB } from "./armadaDB";
import { tenantForEvent, nip29Tenant } from "./relayScope";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { ArmadaEventStore, EventScope } from "@/contexts/EventStoreContext";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { NRumorStore } from "./types";

class MainEventStore implements ArmadaEventStore {
  /**
   * Resolved per call: a purge REPLACES the ArmadaDB instance, so a cached
   * handle would outlive its connection.
   */
  private tenant(id: string): NRumorStore {
    return getArmadaDB().tenant(id);
  }

  /**
   * `main`, or one relay's NIP-29 tenant; an unusable relay URL reads empty
   * rather than falling back to `main`.
   */
  private scoped(opts?: EventScope): NRumorStore | undefined {
    if (!opts?.relay) return this.tenant(ARMADA_TENANTS.main);
    const id = nip29Tenant(opts.relay);
    return id ? this.tenant(id) : undefined;
  }

  event(event: NostrEvent, opts?: EventScope): Promise<void> {
    // Ephemeral kinds aren't storable (NIP-01), nor is anything by a banned user.
    if (NKinds.ephemeral(event.kind) || isUserBannedNow(event.pubkey)) return Promise.resolve();
    // No relay for relay-relative data: drop (see `relayScope.ts`).
    const id = tenantForEvent(event, opts?.relay, ARMADA_TENANTS.main);
    if (!id) return Promise.resolve();
    const { sig: _sig, ...rumor } = event;
    return this.tenant(id).event(rumor, opts);
  }

  query(filters: NostrFilter[], opts?: EventScope): Promise<NostrRumor[]> {
    const key = !opts?.relay && filters.length === 1 ? batchKey(filters[0]) : undefined;
    if (key !== undefined) return this.batched(key, filters[0], opts?.signal);
    return this.scoped(opts)?.query(filters, opts) ?? Promise.resolve([]);
  }

  /**
   * Single-author reads of `main` asked within one task, answered by one read naming every
   * author: a screen of avatars, statuses and lists was a store read per person, each a
   * bridge crossing on native. Unlimited, so each caller's share is exactly its own answer.
   */
  private pending = new Map<string, { filter: NostrFilter; waiters: Array<{ author: string; resolve: (rows: NostrRumor[]) => void; reject: (error: unknown) => void }> }>();

  private batched(key: string, filter: NostrFilter, signal?: AbortSignal): Promise<NostrRumor[]> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const author = filter.authors![0];
    const read = new Promise<NostrRumor[]>((resolve, reject) => {
      let batch = this.pending.get(key);
      if (!batch) {
        batch = { filter, waiters: [] };
        this.pending.set(key, batch);
        setTimeout(() => this.flush(key), 0);
      }
      batch.waiters.push({ author, resolve, reject });
    });
    if (!signal) return read;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      read.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  private flush(key: string): void {
    const batch = this.pending.get(key);
    this.pending.delete(key);
    if (!batch) return;
    const authors = [...new Set(batch.waiters.map((w) => w.author))];
    this.tenant(ARMADA_TENANTS.main).query([{ ...batch.filter, authors }]).then(
      (rows) => {
        const byAuthor = new Map<string, NostrRumor[]>();
        for (const row of rows) {
          const list = byAuthor.get(row.pubkey);
          if (list) list.push(row);
          else byAuthor.set(row.pubkey, [row]);
        }
        // Copies: two callers asking after one person each had rows of their own.
        for (const w of batch.waiters) w.resolve((byAuthor.get(w.author) ?? []).map((row) => ({ ...row })));
      },
      (error: unknown) => {
        for (const w of batch.waiters) w.reject(error);
      },
    );
  }

  count(
    filters: NostrFilter[],
    opts?: EventScope,
  ): Promise<{ count: number; approximate?: boolean }> {
    return (
      this.scoped(opts)?.count(filters, opts) ??
      Promise.resolve({ count: 0, approximate: false })
    );
  }

  remove(filters: NostrFilter[], opts?: EventScope): Promise<void> {
    return this.scoped(opts)?.remove(filters, opts) ?? Promise.resolve();
  }

  /** No-op: the shared connection is closed by `purgeArmadaDB`. */
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * The batch a filter joins, or `undefined` for one read as asked: one author, by kind, with
 * nothing that cuts the answer short (a limit, a window) or reads another way (ids, search).
 */
function batchKey(filter: NostrFilter): string | undefined {
  if (filter.authors?.length !== 1 || !filter.kinds?.length) return undefined;
  if (filter.limit !== undefined || filter.since !== undefined || filter.until !== undefined) return undefined;
  if (filter.ids !== undefined || filter.search !== undefined) return undefined;
  const { authors: _authors, ...rest } = filter;
  return JSON.stringify(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1)));
}

let store: ArmadaEventStore | undefined;

/** The app-wide event store (a Promise because consumers await it). */
export function appEventStore(): Promise<ArmadaEventStore> {
  store ??= new MainEventStore();
  return Promise.resolve(store);
}
