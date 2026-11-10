import { APP_BLOSSOM_SERVERS, normalizeBlossomServerUrl } from "@/lib/blossom";
import { KIND_RELAY_LIST, uniqueRelayUrls } from "@/lib/nip65";
import { APP_RELAYS, DM_INBOX_RELAYS, RELAY_LIST_DISCOVERY_RELAYS, SEARCH_RELAYS } from "@/lib/platform";
import { finalizePowEvent } from "@/lib/pow";
import { KIND_BLOSSOM_SERVERS, KIND_DM_RELAYS, KIND_SEARCH_RELAYS } from "@/lib/selfSyncKinds";

import type { NostrEvent } from "@nostrify/nostrify";
import type { AppConfig } from "@/contexts/AppContext";
import { nowSecs } from "@/lib/relayClock";

/** One signed list and the relays it is published to. */
export interface SignupListEvent {
  event: NostrEvent;
  relays: string[];
}

export interface SignupLists {
  events: SignupListEvent[];
  /** The new account's config, mirroring the lists so they apply before any relay read. */
  configSeed: Record<string, unknown>;
  /** Home relays plus the indexers: where another client looks the account up. */
  discoverable: string[];
}

/** Every relay and server list a new account starts with, as the signup step edits them. */
export interface SignupSetup {
  /** NIP-65 (10002) and app relays: account data. */
  home: string[];
  /** NIP-17 DM inbox (10050). */
  dm: string[];
  /** NIP-50 search (10007). */
  search: string[];
  /** BUD-03 Blossom servers (10063), primary first. */
  blossom: string[];
  /** Defaults for communities the account creates (synced setting, no list event). */
  community: string[];
  /** Write-only public reach (synced setting, no list event). */
  broadcast: string[];
}

/** The setup a new account gets when nothing is changed. `home` is the join link's or app relays. */
export function defaultSignupSetup(
  home: string[],
  config: Pick<AppConfig, "searchRelays" | "communityRelays" | "broadcastRelays">,
): SignupSetup {
  const homeRelays = uniqueRelayUrls(home.length > 0 ? home : APP_RELAYS);
  return {
    home: homeRelays,
    dm: uniqueRelayUrls([...homeRelays, ...DM_INBOX_RELAYS]),
    search: uniqueRelayUrls(config.searchRelays.length > 0 ? config.searchRelays : SEARCH_RELAYS),
    blossom: [...APP_BLOSSOM_SERVERS],
    community: uniqueRelayUrls(config.communityRelays),
    broadcast: uniqueRelayUrls(config.broadcastRelays),
  };
}

function uniqueServers(servers: string[]): string[] {
  const out: string[] = [];
  for (const raw of servers) {
    const url = normalizeBlossomServerUrl(raw);
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/**
 * Signs the new account's lists — NIP-65 (10002), DM inbox (10050), search
 * (10007), Blossom (10063) — and seeds every list into its config. Only for a
 * key the signup flow generated itself: such a key provably has no list
 * anywhere to overwrite, which is the whole of why publishing is allowed. An
 * emptied list is honoured (nothing published) except `home`, which falls back
 * to the app relays since an account must live somewhere.
 */
export async function buildSignupLists(sk: Uint8Array, setup: SignupSetup): Promise<SignupLists> {
  const chosenHome = uniqueRelayUrls(setup.home);
  const home = chosenHome.length > 0 ? chosenHome : uniqueRelayUrls(APP_RELAYS);
  const dm = uniqueRelayUrls(setup.dm);
  const search = uniqueRelayUrls(setup.search);
  const blossom = uniqueServers(setup.blossom);
  const created_at = nowSecs();
  const sign = (kind: number, tags: string[][]) =>
    finalizePowEvent({ kind, created_at, tags, content: "" }, sk);

  // Indexers too, for the two lists another client must find to reach us.
  const discoverable = uniqueRelayUrls([...home, ...RELAY_LIST_DISCOVERY_RELAYS]);

  const events: SignupListEvent[] = [];
  const configSeed: Record<string, unknown> = {
    appRelays: home,
    dmRelays: dm,
    searchRelays: search,
    communityRelays: uniqueRelayUrls(setup.community),
    broadcastRelays: uniqueRelayUrls(setup.broadcast),
  };

  if (home.length > 0) {
    const relayList = await sign(KIND_RELAY_LIST, home.map((url) => ["r", url]));
    events.push({ event: relayList, relays: discoverable });
    configSeed.relayMetadata = {
      relays: home.map((url) => ({ url, read: true, write: true })),
      updatedAt: created_at,
      eventId: relayList.id,
      pubkey: relayList.pubkey,
    };
  }
  if (dm.length > 0) {
    events.push({ event: await sign(KIND_DM_RELAYS, dm.map((url) => ["relay", url])), relays: discoverable });
  }
  if (search.length > 0) {
    events.push({ event: await sign(KIND_SEARCH_RELAYS, search.map((url) => ["relay", url])), relays: home });
  }
  if (blossom.length > 0) {
    const blossomList = await sign(KIND_BLOSSOM_SERVERS, blossom.map((url) => ["server", url]));
    events.push({ event: blossomList, relays: home });
    configSeed.blossomServerMetadata = {
      servers: blossom,
      updatedAt: created_at,
      eventId: blossomList.id,
    };
  }
  return { events, configSeed, discoverable };
}
