/**
 * Concord voice — CORD-07.
 *
 * Every Channel is callable. Two sub-keys derive from its secret (§1, derive.ts):
 * `voice_key` (pk = SFU room name, sk signs token grants) and `voice_media_key`
 * (root of per-sender E2EE). Members fetch a short-lived token from a **blind
 * broker**; broker and SFU only see ciphertext.
 *
 * Presence (§4) is ephemeral kind-23313 rumors in 21059 wraps at the Channel's
 * address. It carries the §5 `broker` tag, but this client doesn't ROUTE on it:
 * the broker comes from config (`rendezvousCandidates`).
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { finalizeEvent } from "nostr-tools/pure";

import { bytesToHex, hexToBytes, random32, type GroupKey } from "@/concord/lib/derive";
import { KIND_VOICE_PRESENCE } from "@/concord/lib/kinds";
import type { OpenedEvent } from "@/concord/lib/stream";
import { MAX_COMMUNITY_AV_BROKERS, type CommunityMetadata } from "@/concord/lib/types";
import { t } from "@/i18n/intl";

// Protocol constants (CORD-07)
/** NIP-98-style HTTP-auth event kind — the token grant's carrier (§2). */
export const KIND_HTTP_AUTH = 27235;
/** Publish a `joined` on join and every 30 seconds thereafter (§4). */
export const VOICE_HEARTBEAT_MS = 30_000;
/** A `joined` older than 90s (three missed heartbeats) counts as absent (§4). */
export const VOICE_STALE_MS = 90_000;

/**
 * Delay until the next heartbeat: 80–100% of §4's 30s. Jittered to avoid
 * phase-locked bursts, and only DOWNWARD so three missed beats still fit in 90s.
 */
export function heartbeatDelayMs(random: () => number = Math.random): number {
  return VOICE_HEARTBEAT_MS * (0.8 + random() * 0.2);
}
const ASCII = new TextEncoder();

// Origins (§5)
/**
 * RFC 6454 serialization of an https origin (lowercase, no default port, no
 * path) — one byte-form so the §5 tie-break agrees across clients. null for
 * anything not a clean https origin.
 */
export function canonicalOrigin(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host) return null;
  const port = url.port && url.port !== "443" ? `:${url.port}` : "";
  return `https://${host}${port}`;
}

/**
 * §5 tie-break rank: `sha256(voice_room[32] || utf8(origin))` as hex, smallest
 * wins. Grindable, but that grants no more than the untrusted hint does.
 */
export function brokerRank(roomHex: string, origin: string): string {
  const originBytes = ASCII.encode(origin);
  const pre = new Uint8Array(32 + originBytes.length);
  pre.set(hexToBytes(roomHex), 0);
  pre.set(originBytes, 32);
  return bytesToHex(sha256(pre));
}

/** Order candidate origins by the §5 tie-break (canonicalized, deduped). */
export function orderBrokers(roomHex: string, origins: string[]): string[] {
  const canonical = [...new Set(origins.map(canonicalOrigin).filter((o): o is string => Boolean(o)))];
  return canonical.sort((a, b) => (brokerRank(roomHex, a) < brokerRank(roomHex, b) ? -1 : 1));
}

/**
 * The Community's own brokers from folded metadata (CORD-02 §6). Unreadable
 * entries are skipped and don't count against the cap.
 */
export function communityAvBrokers(metadata: CommunityMetadata | undefined): string[] {
  const raw = metadata?.av_brokers;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_COMMUNITY_AV_BROKERS) break;
    const origin = typeof entry === "string" ? canonicalOrigin(entry) : null;
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}

// The broker (§2)
/** The broker's capability probe: `GET <origin>/.well-known/concord/av` → 204. */
export function avCapabilityUrl(origin: string): string {
  return `${origin}/.well-known/concord/av`;
}

/** The broker's token endpoint for a room. */
export function avTokenUrl(origin: string, roomHex: string): string {
  return `${origin}/.well-known/concord/av/${roomHex}`;
}

/** A minted SFU token: the JWT, the SFU ws url, and the assigned identity. */
export interface AvToken {
  token: string;
  url: string;
  /** The broker-assigned random SFU identity — announced in presence (§4). */
  identity: string;
  /**
   * The origin that actually minted this token (may be a fall-through candidate);
   * this is what presence must announce as the §5 hint.
   */
  origin: string;
}

/**
 * Sign the token grant (§2): kind-27235 self-signed with `voice_key.sk` (so
 * pubkey = room name), sent only in the Authorization header. The REQUIRED
 * random `nonce` tag keeps two members' same-second grants from sharing an id
 * and tripping the broker's anti-replay set.
 */
export function signAvGrant(voice: GroupKey, url: string): string {
  const event = finalizeEvent(
    {
      kind: KIND_HTTP_AUTH,
      content: "",
      tags: [
        ["u", url],
        ["method", "GET"],
        ["nonce", bytesToHex(random32())],
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    voice.sk,
  );
  return btoa(JSON.stringify(event));
}

/**
 * Probe a broker's capability endpoint. Strictly 204, not `res.ok`: SPA origins
 * answer unknown paths 200.
 */
export async function probeAvBroker(origin: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(avCapabilityUrl(origin), {
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)]),
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

/**
 * Fetch an SFU token from a blind broker (§2); validates the shape and requires
 * a `wss://` SFU url.
 */
export async function fetchAvToken(origin: string, voice: GroupKey): Promise<AvToken> {
  const url = avTokenUrl(origin, voice.pk);
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Concord ${signAvGrant(voice, url)}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(t({ id: "concordVoice.tokenRequestFailed", defaultMessage: "Voice token request failed: HTTP {status}" }, { status: res.status }));
  const data = (await res.json()) as Record<string, unknown>;
  const token = typeof data.token === "string" ? data.token : "";
  const sfuUrl = typeof data.url === "string" ? data.url : "";
  const identity = typeof data.identity === "string" ? data.identity : "";
  if (!token || !sfuUrl || !identity) throw new Error(t({ id: "concordVoice.tokenResponseIncomplete", defaultMessage: "Voice token response missing token, url, or identity" }));
  if (!/^wss:\/\//i.test(sfuUrl)) throw new Error(t({ id: "concordVoice.nonWssUrl", defaultMessage: "Broker returned a non-wss SFU url" }));
  return { token, url: sfuUrl, identity, origin };
}

/**
 * Mint from the first candidate that answers, in §5 order. A probe success
 * doesn't guarantee minting, and brokers may shed load at the token endpoint.
 * Every failure falls through (a 503 shouldn't cost the call).
 */
export async function fetchAvTokenFromAny(origins: string[], voice: GroupKey): Promise<AvToken> {
  const candidates = [...new Set(origins.filter(Boolean))];
  if (candidates.length === 0) throw new Error(t({ id: "concordVoice.noServer", defaultMessage: "No voice server to request a token from" }));
  let lastError: unknown;
  for (const origin of candidates) {
    try {
      return await fetchAvToken(origin, voice);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(t({ id: "concordVoice.noReachableServer", defaultMessage: "No reachable voice server" }));
}

// Presence (§4)
/** One member's latest presence, as opened from the Channel's stream. */
export interface VoicePresenceEntry {
  author: string;
  status: "joined" | "left";
  /** The broker-assigned SFU identity (joined only). */
  identity?: string;
  /** All identities this member authenticates, primary first (Armada adds one for its H.265 screen-share publisher). */
  identities?: string[];
  /** Auxiliary identities explicitly assigned the custom screen-share role. */
  screenShareIdentities?: string[];
  /** The broker origin hint, canonicalized (joined only). */
  broker?: string;
  /**
   * Hand raised (joined only) — an ARMADA EXTENSION: additive `["hand","1"]` tag,
   * ignored by old clients (CORD-02 §6). Sticky, carried on every heartbeat.
   */
  hand?: boolean;
  /**
   * Recording the call (joined only) — an ARMADA EXTENSION: additive
   * `["recording","1"]`, announced before capture starts. Sticky like `hand`.
   */
  recording?: boolean;
  /**
   * Refuses to be recorded (joined only) — an ARMADA EXTENSION: additive
   * `["norecord","1"]`. Honest recorders capture only members whose fresh
   * presence lacks it, so an unknown member is never recorded either.
   */
  noRecord?: boolean;
  /**
   * A transport other than the brokered call (CORD-07 §4 Transports), e.g.
   * `"iroh"`; absent for a brokered `joined`. Such a member is in the call on a
   * transport Armada doesn't speak, never dropped.
   */
  transport?: string;
  /** Millisecond ordering basis (CORD-02 §4). */
  ms: number;
  /** The rumor id — the equal-ms tiebreak. */
  rumorId: string;
}

/**
 * Presence tags beyond the channel/epoch binding. `hand`, `recording` and
 * `norecord` are emitted only while joined and set.
 */
export function presenceTags(
  status: "joined" | "left",
  identity?: string,
  broker?: string,
  opts?: {
    hand?: boolean;
    recording?: boolean;
    noRecord?: boolean;
    additionalIdentities?: readonly string[];
  },
): string[][] {
  const tags: string[][] = [];
  if (status === "joined" && identity) tags.push(["identity", identity]);
  if (status === "joined" && identity) {
    const seen = new Set([identity]);
    for (const additional of opts?.additionalIdentities ?? []) {
      if (!additional || seen.has(additional)) continue;
      seen.add(additional);
      // Third value = signed role metadata; older clients read it as a repeated identity.
      tags.push(["identity", additional, "screen-share"]);
    }
  }
  if (status === "joined" && broker) tags.push(["broker", broker]);
  if (status === "joined" && opts?.hand) tags.push(["hand", "1"]);
  if (status === "joined" && opts?.recording) tags.push(["recording", "1"]);
  if (status === "joined" && opts?.noRecord) tags.push(["norecord", "1"]);
  return tags;
}

/** Max byte length of a reaction emoji (bounds hostile bloat; fits ZWJ sequences). */
const MAX_REACTION_LEN = 64;

/** A transient in-call emoji reaction, as opened from the Channel's stream. */
export interface VoiceReactionEntry {
  /** The verified real author (the presence rumor's seal signer). */
  author: string;
  /** The emoji (or shortcode) to float. */
  emoji: string;
  /** The sender-chosen nonce — the fire-once/dedup key. */
  nonce: string;
  /** Millisecond stamp (CORD-02 §4) — the decay basis. */
  ms: number;
}

/**
 * In-call emoji reaction tag — an ARMADA EXTENSION: additive `["react", emoji,
 * nonce]` on an off-cycle `joined` presence (CORD-02 §6). Fired once per unseen
 * nonce, never folded into state.
 */
export function reactionTag(emoji: string, nonce: string): string[] {
  return ["react", emoji, nonce];
}

/**
 * Parse a kind-23313 rumor's reaction tag, or null if none/malformed. The caller
 * checks the channel/epoch binding.
 */
export function parseReaction(opened: OpenedEvent): VoiceReactionEntry | null {
  if (opened.kind !== KIND_VOICE_PRESENCE) return null;
  const tag = opened.tags.find((t) => t[0] === "react");
  if (!tag) return null;
  const emoji = tag[1];
  const nonce = tag[2];
  if (typeof emoji !== "string" || emoji.length === 0) return null;
  // Reject (not truncate) oversize payloads so clients agree on what floated.
  if (new TextEncoder().encode(emoji).length > MAX_REACTION_LEN) return null;
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 128) return null;
  return { author: opened.author, emoji, nonce, ms: opened.ms };
}

/**
 * Parse a kind-23313 rumor into a presence entry, or null if malformed. The caller
 * checks the channel/epoch binding.
 */
export function parsePresence(opened: OpenedEvent): VoicePresenceEntry | null {
  if (opened.kind !== KIND_VOICE_PRESENCE) return null;
  if (opened.content !== "joined" && opened.content !== "left") return null;
  const status = opened.content;
  const rawIdentities = opened.tags
    .filter((tag) => tag[0] === "identity")
    .map((tag) => tag[1])
    .filter(
      (identity): identity is string =>
        typeof identity === "string" && identity.length > 0 && identity.length <= 128,
    );
  // Bound identities so hostile members can't inflate the claims map.
  const identities = [...new Set(rawIdentities)].slice(0, 4);
  const allowedIdentities = new Set(identities);
  const screenShareIdentities = [...new Set(
    opened.tags
      .filter((tag) => tag[0] === "identity" && tag[2] === "screen-share")
      .map((tag) => tag[1])
      .filter(
        (identity): identity is string =>
          typeof identity === "string" && allowedIdentities.has(identity),
      ),
  )].filter((candidate) => candidate !== identities[0]);
  const rawBroker = opened.tags.find((t) => t[0] === "broker")?.[1];
  const identity = status === "joined" ? identities[0] : undefined;
  const transport = status === "joined" ? otherTransport(opened.tags) : undefined;
  if (transport === null) return null;
  if (status === "joined" && !identity && !transport) return null;
  const broker =
    status === "joined" && typeof rawBroker === "string" && rawBroker.length <= 512
      ? canonicalOrigin(rawBroker) ?? undefined
      : undefined;
  const flag = (name: string) =>
    status === "joined" && opened.tags.some((t) => t[0] === name && t[1] === "1");
  return {
    author: opened.author,
    status,
    identity,
    identities: status === "joined" ? identities : undefined,
    screenShareIdentities: status === "joined" ? screenShareIdentities : undefined,
    broker,
    hand: flag("hand"),
    recording: flag("recording"),
    noRecord: flag("norecord"),
    ...(transport ? { transport } : {}),
    ms: opened.ms,
    rumorId: opened.rumorId,
  };
}

/**
 * The `transport` a `joined` names, when it isn't the brokered call: undefined
 * for brokered presence, null for a malformed one (CORD-07 §4: an iroh
 * `joined` whose endpoint isn't 64 hex digits is dropped).
 */
function otherTransport(tags: string[][]): string | undefined | null {
  const transport = tags.find((t) => t[0] === "transport")?.[1];
  if (typeof transport !== "string" || transport.length === 0) return undefined;
  if (transport.length > 32) return null;
  if (transport === "iroh") {
    const endpoint = tags.find((t) => t[0] === "endpoint")?.[1];
    if (typeof endpoint !== "string" || !/^[0-9a-f]{64}$/i.test(endpoint)) return null;
  }
  return transport;
}

/** A verified-present participant: one fresh `joined` per author. */
export interface VoicePresent {
  author: string;
  identity: string;
  broker?: string;
  /** Signed auxiliary identities owned by this member's screen-share publisher. */
  screenShareIdentities: string[];
  /** Whether this member's latest presence has their hand raised (client ext). */
  hand: boolean;
  /** Whether this member announces they are recording the call (client ext). */
  recording: boolean;
  /** Whether this member refuses to be recorded (client ext). */
  noRecord: boolean;
  ms: number;
}

/** The folded presence view of one channel's call. */
export interface VoicePresenceFold {
  /** Fresh `joined` authors (per author, the latest presence won). */
  present: VoicePresent[];
  /**
   * SFU identity → authors claiming it. A participant is a member only when exactly
   * ONE author claims its identity (§4).
   */
  claims: Map<string, string[]>;
  /**
   * Fresh `joined` authors on a transport Armada doesn't speak (CORD-07 §4):
   * in the call, but in a group we can't hear. Never in `present` or `claims`.
   */
  otherTransport: VoiceOtherTransport[];
}

/** A member in the call on another transport. */
export interface VoiceOtherTransport {
  author: string;
  transport: string;
  ms: number;
}

/**
 * Fold raw presence entries: per author the latest wins (ms basis, rumor-id
 * tiebreak), then a `joined` older than the staleness window counts as absent.
 */
export function foldVoicePresence(entries: VoicePresenceEntry[], nowMs: number): VoicePresenceFold {
  const latest = new Map<string, VoicePresenceEntry>();
  for (const e of entries) {
    const prev = latest.get(e.author);
    if (!prev || e.ms > prev.ms || (e.ms === prev.ms && e.rumorId < prev.rumorId)) {
      latest.set(e.author, e);
    }
  }
  const present: VoicePresent[] = [];
  const claims = new Map<string, string[]>();
  const otherTransport: VoiceOtherTransport[] = [];
  for (const e of latest.values()) {
    if (e.status !== "joined") continue;
    if (nowMs - e.ms > VOICE_STALE_MS) continue;
    if (e.transport) {
      otherTransport.push({ author: e.author, transport: e.transport, ms: e.ms });
      continue;
    }
    if (!e.identity) continue;
    present.push({
      author: e.author,
      identity: e.identity,
      broker: e.broker,
      screenShareIdentities: e.screenShareIdentities ?? [],
      hand: e.hand ?? false,
      recording: e.recording ?? false,
      noRecord: e.noRecord ?? false,
      ms: e.ms,
    });
    for (const identity of e.identities?.length ? e.identities : [e.identity]) {
      const list = claims.get(identity);
      if (list) list.push(e.author);
      else claims.set(identity, [e.author]);
    }
  }
  present.sort((a, b) => a.ms - b.ms || (a.author < b.author ? -1 : 1));
  otherTransport.sort((a, b) => a.ms - b.ms || (a.author < b.author ? -1 : 1));
  return { present, claims, otherTransport };
}

/** The author behind an SFU identity, or undefined if unclaimed or contested. */
export function verifiedAuthorOf(fold: VoicePresenceFold, identity: string): string | undefined {
  const claimants = fold.claims.get(identity);
  return claimants && claimants.length === 1 ? claimants[0] : undefined;
}

/** Whether signed fresh presence assigns this verified identity to a screen-share sidecar. */
export function isVerifiedScreenShareIdentity(
  fold: VoicePresenceFold,
  identity: string,
): boolean {
  const author = verifiedAuthorOf(fold, identity);
  if (!author) return false;
  return Boolean(
    fold.present.find((present) => present.author === author)
      ?.screenShareIdentities.includes(identity),
  );
}

/**
 * Rendezvous candidates for a room: the Community's brokers (CORD-02 §6) if any,
 * else the client's config — NOT presence `broker` hints, which are untrusted
 * member input (the steering attack §5 concedes). Ordered by the room-keyed
 * tie-break so members converge without coordination. Callers probe in order.
 */
export function rendezvousCandidates(
  roomHex: string,
  defaults: string[],
  communityBrokers: string[] = [],
): string[] {
  const community = orderBrokers(roomHex, communityBrokers);
  if (community.length > 0) return community;
  return [...new Set(defaults.map(canonicalOrigin).filter((o): o is string => Boolean(o)))];
}

/**
 * Members whose presence is on a different broker than ours — a separate call we
 * can't hear. Surfaced so it isn't mistaken for broken audio. No broker tag = not counted.
 */
export function occupantsElsewhere(fold: VoicePresenceFold, origin: string): VoicePresent[] {
  const ours = canonicalOrigin(origin);
  if (!ours) return [];
  return fold.present.filter((p) => {
    const theirs = p.broker ? canonicalOrigin(p.broker) : null;
    return Boolean(theirs) && theirs !== ours;
  });
}
