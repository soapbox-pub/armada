import { nip19 } from "nostr-tools";

import { t } from "@/i18n";
import { config } from "@/lib/env";
import { isNostrId } from "@/lib/nostrId";
import { normalizeRelayUrl } from "@/lib/platform";
import { isLocalNetworkUrl } from "@/lib/sanitizeUrl";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Discover's curators and relays. Feeds are gated on an author allow-list: the
 * curators' members plus the viewer's network. Curators are comma-separated: an
 * `naddr` (any `p`-tagged list), an `npub`/`nprofile`/hex seed (that account and
 * its follows), or {@link ARMADA_DEVELOPERS_ENTRY}; `none` means none.
 *
 * Unfiltered (`AppConfig.discoverUnfiltered`) applies only with `none`, and only
 * where {@link discoverEveryoneAllowed}.
 */

/** The curators the default names, as one entry. */
export const ARMADA_DEVELOPERS_ENTRY = "armada-developers";
export const ARMADA_DEVELOPERS: readonly string[] = [
  // Team Soapbox (soapbox.pub's `_`)
  "781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5",
  // Armada (armada.buzz's `_`)
  "0ddf6c35f61eb040316d01f68ded4d38b579c17423d26715fd489105a981910a",
  // Alex Gleason (alex@soapbox.pub)
  "0461fcbecc4c3374439932d6b8f11269ccdb7cc973ad7a50ae362db135a474dd",
  // Chad Curtis (chad@chadwick.site)
  "86184109eae937d8d6f980b4a0b46da4ef0d983eade403ee1b4c0b6bde238b47",
];

export const DISCOVER_CURATION_NONE = "none";

/** This build's curators via `DISCOVER_CURATION` (empty = none). */
export const BUILD_DISCOVER_CURATION: string =
  (config("DISCOVER_CURATION") ?? ARMADA_DEVELOPERS_ENTRY).trim() || DISCOVER_CURATION_NONE;

export type DiscoverCuration =
  | {
      type: "list";
      kind: number;
      pubkey: string;
      identifier: string;
      /** Relay hints carried by the naddr, read alongside the Discover relays. */
      relays: string[];
    }
  | { type: "follows"; pubkey: string; relays: string[] }
  | { type: "none" };

/** A curation source proper: a list or someone's follows. */
export type DiscoverSource = Exclude<DiscoverCuration, { type: "none" }>;

/** The curation in effect: its sources, or everyone (the `none` switch, where allowed). */
export interface DiscoverCurationSet {
  sources: DiscoverSource[];
  everyone: boolean;
}

export type ParsedCurations =
  | { ok: true; sources: DiscoverSource[]; none: boolean }
  | { ok: false; error: string };

export type ParsedCuration =
  | { ok: true; curation: DiscoverCuration }
  | { ok: false; error: string };

const NONE: DiscoverCuration = { type: "none" };

/**
 * Relay hints narrowed to public `wss:` (`publicRelayHints`): the source syncs
 * across devices, so LAN hints would be dialed from each.
 */
function hints(relays: string[] | undefined): string[] {
  return (relays ?? [])
    .map(normalizeRelayUrl)
    .filter((url): url is string => !!url && url.startsWith("wss://") && !isLocalNetworkUrl(url));
}

/** Parse a curation source (`none`, naddr, npub/nprofile/hex, optional `nostr:`); errors are UI-worded. */
export function parseDiscoverCuration(input: string): ParsedCuration {
  const value = input.trim().replace(/^nostr:/i, "");
  if (!value) return { ok: false, error: t({ id: "discoverSource.empty", defaultMessage: "Enter an naddr, npub, or hex pubkey." }) };
  if (value.toLowerCase() === DISCOVER_CURATION_NONE) return { ok: true, curation: NONE };
  if (isNostrId(value.toLowerCase())) {
    return { ok: true, curation: { type: "follows", pubkey: value.toLowerCase(), relays: [] } };
  }
  let decoded: ReturnType<typeof nip19.decode>;
  try {
    decoded = nip19.decode(value);
  } catch {
    return { ok: false, error: t({ id: "discoverSource.invalid", defaultMessage: "Not a valid naddr, npub, or hex pubkey." }) };
  }
  switch (decoded.type) {
    case "naddr": {
      const { kind, pubkey, identifier, relays } = decoded.data;
      if (kind < 30000 || kind >= 40000 || !isNostrId(pubkey)) {
        return { ok: false, error: t({ id: "discoverSource.notList", defaultMessage: "That naddr doesn't point to an addressable list." }) };
      }
      return { ok: true, curation: { type: "list", kind, pubkey, identifier, relays: hints(relays) } };
    }
    case "npub":
      return { ok: true, curation: { type: "follows", pubkey: decoded.data, relays: [] } };
    case "nprofile":
      return {
        ok: true,
        curation: { type: "follows", pubkey: decoded.data.pubkey, relays: hints(decoded.data.relays) },
      };
    default:
      return { ok: false, error: t({ id: "discoverSource.unsupported", defaultMessage: "Use an naddr (a list), an npub, or a hex pubkey." }) };
  }
}

/** The entries of a curator list, as stored or typed: separated by commas or spaces. */
export function curationEntries(input: string): string[] {
  return input.split(/[\s,]+/).map((e) => e.trim()).filter(Boolean);
}

export const isDevelopersEntry = (entry: string) => entry.toLowerCase() === ARMADA_DEVELOPERS_ENTRY;

/** A curator list as stored: its entries, or `none` for no curators at all. */
export function storeCurationEntries(entries: readonly string[]): string {
  return entries.length > 0 ? entries.join(", ") : DISCOVER_CURATION_NONE;
}

/** Parse the field: `none` alone, or one or more curators separated by commas or spaces. */
export function parseDiscoverCurations(input: string): ParsedCurations {
  const entries = curationEntries(input);
  if (entries.length === 0) return { ok: false, error: t({ id: "discoverSource.empty", defaultMessage: "Enter an naddr, npub, or hex pubkey." }) };
  const isNone = (e: string) => e.replace(/^nostr:/i, "").toLowerCase() === DISCOVER_CURATION_NONE;
  if (entries.length === 1 && isNone(entries[0])) return { ok: true, sources: [], none: true };
  if (entries.some(isNone)) {
    return { ok: false, error: t({ id: "discoverSource.noneAlone", defaultMessage: "“none” can't be combined with lists." }) };
  }
  const sources = new Map<string, DiscoverSource>();
  for (const entry of entries) {
    if (isDevelopersEntry(entry)) {
      for (const pubkey of ARMADA_DEVELOPERS) sources.set(`3:${pubkey}`, { type: "follows", pubkey, relays: [] });
      continue;
    }
    const parsed = parseDiscoverCuration(entry);
    if (!parsed.ok) return parsed;
    if (parsed.curation.type !== "none") sources.set(curationKey(parsed.curation), parsed.curation);
  }
  return { ok: true, sources: [...sources.values()], none: false };
}

/**
 * The curation in effect: the override, else the build default. Everyone is the step
 * below no curators: only a user's own `none`, with this device's switch on
 * (`unfiltered`, already gated on {@link discoverEveryoneAllowed}). An unparseable
 * override resolves to no sources, never silently back to the default.
 */
export function resolveDiscoverCurations(
  override: string,
  unfiltered: boolean,
  buildDefault: string = BUILD_DISCOVER_CURATION,
): DiscoverCurationSet {
  if (override.trim()) {
    const parsed = parseDiscoverCurations(override);
    if (!parsed.ok) return { sources: [], everyone: false };
    return { sources: parsed.sources, everyone: parsed.none && unfiltered };
  }
  const parsed = parseDiscoverCurations(buildDefault);
  return { sources: parsed.ok ? parsed.sources : [], everyone: false };
}

/**
 * Whether this install may read Discover unvetted: never in an app-store install
 * (`storeInstall`), nor where the deployment sets `DISCOVER_UNFILTERED` to `off`.
 */
export function discoverEveryoneAllowed(storeInstall: boolean): boolean {
  return !storeInstall && config("DISCOVER_UNFILTERED")?.trim().toLowerCase() !== "off";
}

/** Discover relays: app relays then the user's NIP-65 relays, normalized and deduped. */
export function resolveDiscoverRelays(appRelays: string[], ownRelays: string[] = []): string[] {
  return [
    ...new Set([...appRelays, ...ownRelays].map(normalizeRelayUrl).filter((url): url is string => !!url)),
  ];
}

export function curationKey(curation: DiscoverCuration): string {
  switch (curation.type) {
    case "list":
      return `${curation.kind}:${curation.pubkey}:${curation.identifier}`;
    case "follows":
      return `3:${curation.pubkey}`;
    case "none":
      return DISCOVER_CURATION_NONE;
  }
}

export function curationFilter(curation: DiscoverCuration): NostrFilter | null {
  switch (curation.type) {
    case "list":
      return { kinds: [curation.kind], authors: [curation.pubkey], "#d": [curation.identifier], limit: 1 };
    case "follows":
      return { kinds: [3], authors: [curation.pubkey], limit: 1 };
    case "none":
      return null;
  }
}

export function isCurationEvent(curation: DiscoverCuration, event: NostrRumor): boolean {
  switch (curation.type) {
    case "list":
      return (
        event.kind === curation.kind
        && event.pubkey === curation.pubkey
        && (event.tags.find(([n]) => n === "d")?.[1] ?? "") === curation.identifier
      );
    case "follows":
      return event.kind === 3 && event.pubkey === curation.pubkey;
    case "none":
      return false;
  }
}

export function curatedPubkeys(event: NostrRumor | null | undefined): string[] {
  if (!event) return [];
  return event.tags
    .filter(([name]) => name === "p")
    .map(([, pk]) => pk)
    .filter(isNostrId);
}
