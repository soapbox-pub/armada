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
    return this.scoped(opts)?.query(filters, opts) ?? Promise.resolve([]);
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

let store: ArmadaEventStore | undefined;

/** The app-wide event store (a Promise because consumers await it). */
export function appEventStore(): Promise<ArmadaEventStore> {
  store ??= new MainEventStore();
  return Promise.resolve(store);
}
