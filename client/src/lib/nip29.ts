import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/**
 * NIP-29 (Relay-based Groups) constants and event parsing.
 * https://github.com/nostr-protocol/nips/blob/master/29.md
 */

/**
 * Turn a publish error into a human-readable, user-facing reason. Nostrify's
 * NRelay1 throws the relay's `OK: false` machine reason as the Error message
 * (e.g. "blocked: ...", "restricted: ..."), so we strip the leading
 * machine-readable prefix and fall back to a generic message when there's
 * nothing useful (timeouts, network errors).
 */
export function relayRejectionMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const trimmed = raw.trim();
  if (!trimmed) return "The relay rejected the message.";
  // NIP-01 OK reasons are "<machine-prefix>: <human message>". Show the human
  // part when present; otherwise show the whole thing.
  const m = trimmed.match(/^(blocked|restricted|invalid|error|rate-limited|duplicate|pow):\s*(.+)$/i);
  const message = m ? m[2] : trimmed;
  // Keep it short for a toast.
  return message.length > 200 ? message.slice(0, 197) + "…" : message;
}

// ── Kinds ────────────────────────────────────────────────────────────────────

/** NIP-09 event deletion request. */
export const KIND_DELETE = 5;
/** NIP-25 reaction to an event (requires `h` tag inside a group). */
export const KIND_REACTION = 7;
/** Chat message inside a group (requires `h` tag). */
export const KIND_GROUP_CHAT = 9;
/** Thread/forum post inside a group. */
export const KIND_GROUP_THREAD = 11;
/** NIP-22 comment — used here as a threaded reply to a chat message. */
export const KIND_COMMENT = 1111;

/** Moderation: add user / set roles. */
export const KIND_PUT_USER = 9000;
/** Moderation: remove user. */
export const KIND_REMOVE_USER = 9001;
/** Moderation: edit group metadata. */
export const KIND_EDIT_METADATA = 9002;
/** Moderation: delete an event. */
export const KIND_DELETE_EVENT = 9005;
/** Moderation: create group. */
export const KIND_CREATE_GROUP = 9007;
/** Moderation: delete group. */
export const KIND_DELETE_GROUP = 9008;
/** Moderation: create invite code. */
export const KIND_CREATE_INVITE = 9009;

/**
 * Armada extension: a group's set of pinned messages. Addressable
 * (`d` = group id) so the newest event per group is the authoritative list.
 * Each pinned message is an `e` tag; the relay restricts writes to admins.
 * Not part of NIP-29 proper.
 */
export const KIND_GROUP_PINS = 39041;

/** User: request to join a group. */
export const KIND_JOIN_REQUEST = 9021;
/** User: request to leave a group. */
export const KIND_LEAVE_REQUEST = 9022;

// ── Relay membership (zooid / Coracle "relay access", NIP-43-ish) ────────────
//
// Some community relays (e.g. zooid, which backs Flotilla/Soapbox) gate ALL
// reads and writes behind *relay-level* membership, separate from per-group
// NIP-29 membership. A non-member is rejected with "restricted: you are not a
// member of this relay" before any group join is even considered. To become a
// relay member you publish an ephemeral RELAY_JOIN carrying a `claim` tag whose
// value was minted by the relay as a RELAY_INVITE event. These kinds are not
// part of NIP-29 proper; they are the de-facto Coracle/zooid relay-access
// protocol that we implement for cross-relay interop.

/** User: ephemeral request to join the *relay* (carries a `claim` tag). */
export const KIND_RELAY_JOIN = 28934;
/** Relay-signed: an invite "claim" usable with KIND_RELAY_JOIN. */
export const KIND_RELAY_INVITE = 28935;
/** User: ephemeral request to leave the *relay*. */
export const KIND_RELAY_LEAVE = 28936;

/**
 * Relay-signed: a community's relay-level member list (zooid). Addressable;
 * one per relay. Each member is a `member` tag whose extra values are the ids
 * of the dynamic roles assigned to that member:
 * `["member", <pubkey>, <roleId>, ...]`.
 */
export const KIND_RELAY_MEMBERS = 13534;
/**
 * Relay-signed: a dynamic relay-level role *definition* (zooid). Addressable
 * (`d` = role id). These are cosmetic/organizational labels (label, color,
 * order) — they carry no permission semantics on the relay; real privileges
 * come from the relay's TOML `[roles]`. Created/edited via NIP-86
 * `createrole`/`editrole`/`deleterole` and assigned with `assignrole`.
 */
export const KIND_RELAY_ROLE = 33534;

/** NIP-98 HTTP auth event (also the NIP-86 RPC auth event). */
export const KIND_HTTP_AUTH = 27235;

/** Relay-signed: group metadata (addressable, `d` = group id). */
export const KIND_GROUP_METADATA = 39000;
/** Relay-signed: group admins. */
export const KIND_GROUP_ADMINS = 39001;
/** Relay-signed: group members. */
export const KIND_GROUP_MEMBERS = 39002;
/** Relay-signed: roles supported by the group. */
export const KIND_GROUP_ROLES = 39003;
/** Relay-signed: live AV room participants. */
export const KIND_GROUP_PARTICIPANTS = 39004;

/** NIP-51: user's list of groups. */
export const KIND_USER_GROUPS = 10009;

/** NIP-32 label event. Used here for per-server self-labels (nickname/label). */
export const KIND_LABEL = 1985;

// ── Per-server self-labels (NIP-32) ──────────────────────────────────────────
//
// Armada lets a user set a per-server nickname and a per-server label that
// apply ONLY within a given relay (server). These are NIP-32 kind-1985 label
// events the user authors about *their own* pubkey, namespaced under `armada`
// and scoped to a single relay via an `r` tag.
//
// Enforcement is a *client convention*, not a cryptographic guarantee: a
// signed kind-1985 event is public, so we can't stop another client (or the
// relay) from re-serving it. What this client guarantees is:
//   1. the event is published ONLY to its target relay (never fanned out),
//   2. it is queried ONLY from that relay, and
//   3. the nickname/label is rendered ONLY where the event's `r` tag matches
//      the relay currently being viewed.
// So within *our* client the value never manifests outside its server.

/** NIP-32 label namespace for Armada self-labels. */
export const SERVER_PROFILE_NAMESPACE = "armada";
/** Label mark identifying a per-server nickname value. */
export const SERVER_NICKNAME_MARK = "armada/nickname";
/** Label mark identifying a per-server label value. */
export const SERVER_LABEL_MARK = "armada/label";
/** Label mark identifying a per-server username color (CSS hex like `#ff8800`). */
export const SERVER_COLOR_MARK = "armada/color";

/** A user's per-server self-profile (nickname + label + color) for one relay. */
export interface ServerProfile {
  /** The relay (server) this profile applies to. */
  relay: string;
  /** The user's chosen nickname on this server, if any. */
  nickname?: string;
  /** The user's chosen label on this server, if any. */
  label?: string;
  /** The user's chosen username color on this server (CSS hex), if any. */
  color?: string;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface Nip29Group {
  /** Group id (the `d` tag of the kind 39000 event). */
  id: string;
  /** Relay websocket URL hosting this instance of the group. */
  relay: string;
  name: string;
  picture?: string;
  about?: string;
  /** Only members can read. */
  isPrivate: boolean;
  /** Only members can write. */
  isRestricted: boolean;
  /** Metadata hidden from non-members. */
  isHidden: boolean;
  /** Join requests are ignored (invite-only). */
  isClosed: boolean;
  /** Group supports LiveKit-powered live audio/video. */
  hasLivekit: boolean;
  /** Supported kinds, when restricted. `undefined` = all kinds. */
  supportedKinds?: number[];
  /** The raw kind 39000 event. */
  event: NostrEvent;
}

export interface Nip29Admin {
  pubkey: string;
  roles: string[];
}

export interface Nip29Role {
  name: string;
  description?: string;
}

/**
 * A zooid dynamic relay-level role (kind 33534). Cosmetic only: `id` is the
 * stable key (the event's `d` tag), the rest are display attributes.
 */
export interface CommunityRole {
  id: string;
  label?: string;
  description?: string;
  /** Hue 0–255 (zooid stores a single hue int), or undefined when unset. */
  color?: number;
  /** Sort order; lower first. */
  order?: number;
}

/** A group reference stored in the user's kind 10009 list. */
export interface GroupRef {
  id: string;
  relay: string;
}

/**
 * The fully-parsed kind 10009 list (NIP-51 "Simple groups"): the user's joined
 * groups (`group` tags) and the servers/relays they use (`r` tags). Both can
 * appear in the public tags or the NIP-44-encrypted private tags.
 */
export interface UserGroupList {
  /** Joined groups: `["group", id, relay, name?]`. */
  groups: GroupRef[];
  /** Servers in use: `["r", relayUrl]`. Normalized, de-duplicated. */
  servers: string[];
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;

function tag(event: NostrEvent, name: string): string[] | undefined {
  return event.tags.find(([n]) => n === name);
}

function hasTag(event: NostrEvent, name: string): boolean {
  return event.tags.some(([n]) => n === name);
}

/** Parse a kind 39000 group-metadata event. Returns undefined when malformed. */
export function parseGroupMetadata(event: NostrEvent, relay: string): Nip29Group | undefined {
  if (event.kind !== KIND_GROUP_METADATA) return undefined;
  const id = tag(event, "d")?.[1];
  if (!id) return undefined;

  const supported = tag(event, "supported_kinds");

  return {
    id,
    relay,
    name: tag(event, "name")?.[1] || id,
    picture: tag(event, "picture")?.[1],
    about: tag(event, "about")?.[1],
    isPrivate: hasTag(event, "private"),
    isRestricted: hasTag(event, "restricted"),
    isHidden: hasTag(event, "hidden"),
    isClosed: hasTag(event, "closed"),
    hasLivekit: hasTag(event, "livekit"),
    supportedKinds: supported
      ? supported.slice(1).map(Number).filter((n) => Number.isInteger(n))
      : undefined,
    event,
  };
}

/**
 * Build the IndexedDB filters that read a single relay's channel metadata
 * (kind 39000) from the shared local event cache.
 *
 * Scoping is the whole point. Every server's kind-39000 events live together
 * in one cache, so an unscoped `{ kinds: [39000] }` read returns *every*
 * server's channels and bleeds them into this server's list — the
 * duplicate/cross-server channels bug. Kind 39000 is signed by the relay's own
 * key, so when that key (`relaySelf`) is known we scope by `authors`. Before
 * NIP-11 resolves we don't know it, so we fall back to scoping by the ids the
 * user remembers for THIS relay (their `d` tag) — never an open read. With
 * neither, there is nothing relay-scoped to read, so we return no filters
 * rather than risk surfacing another server's channels.
 */
export function relayGroupCacheFilters(
  relaySelf: string | undefined,
  rememberedIds: string[],
): NostrFilter[] {
  if (relaySelf) return [{ kinds: [KIND_GROUP_METADATA], authors: [relaySelf] }];
  if (rememberedIds.length > 0) return [{ kinds: [KIND_GROUP_METADATA], "#d": rememberedIds }];
  return [];
}

/**
 * Collapse kind-39000 metadata events into a de-duplicated, name-sorted channel
 * list for `relay`. Events are de-duplicated by group id (`d` tag), keeping the
 * newest `created_at` so a relay edit/delete supersedes an older copy. Malformed
 * events are skipped.
 *
 * Callers pass cached events FIRST and live relay events SECOND so the cache
 * acts as a floor: a sparse or empty relay read can only add to or supersede
 * the cached list, never clear it. Relays legitimately return nothing on a
 * flaky connection, before AUTH completes, or because they hide closed/private
 * groups — none of which mean the channels are gone. This mirrors how
 * ditto/flotilla treat replaceable lists.
 */
export function buildRelayGroups(events: NostrEvent[], relay: string): Nip29Group[] {
  const groups = new Map<string, Nip29Group>();
  for (const event of events) {
    const group = parseGroupMetadata(event, relay);
    if (!group) continue;
    const existing = groups.get(group.id);
    if (!existing) {
      groups.set(group.id, group);
      continue;
    }
    // Newest wins. On a created_at TIE, prefer the event that actually carries
    // a name: a create-group (kind 9007) and its follow-up edit-metadata (kind
    // 9002) can produce two kind-39000 events in the same second, one nameless
    // (id-only) and one named. Picking by created_at alone can otherwise keep
    // the nameless one and show the raw group id in the UI.
    const newer = event.created_at > existing.event.created_at;
    const tieButNamed =
      event.created_at === existing.event.created_at &&
      group.name !== group.id &&
      existing.name === existing.id;
    if (newer || tieButNamed) {
      groups.set(group.id, group);
    }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse a kind 39001 group-admins event into a list of admins with roles. */
export function parseGroupAdmins(event: NostrEvent): Nip29Admin[] {
  if (event.kind !== KIND_GROUP_ADMINS) return [];
  const byPubkey = new Map<string, Nip29Admin>();
  for (const [n, pubkey, ...roles] of event.tags) {
    if (n !== "p" || !HEX64.test(pubkey ?? "")) continue;
    const existing = byPubkey.get(pubkey);
    const cleaned = roles.filter(Boolean);
    if (existing) {
      // A relay may list the same pubkey twice (e.g. owner + a can_manage
      // role); merge their roles instead of rendering the admin twice.
      existing.roles = [...new Set([...existing.roles, ...cleaned])];
    } else {
      byPubkey.set(pubkey, { pubkey, roles: cleaned });
    }
  }
  return [...byPubkey.values()];
}

/** Parse a kind 39002 group-members event into a list of pubkeys. */
export function parseGroupMembers(event: NostrEvent): string[] {
  if (event.kind !== KIND_GROUP_MEMBERS) return [];
  return event.tags
    .filter(([n, v]) => n === "p" && HEX64.test(v ?? ""))
    .map(([, pubkey]) => pubkey);
}

/** Parse a kind 39003 group-roles event. */
export function parseGroupRoles(event: NostrEvent): Nip29Role[] {
  if (event.kind !== KIND_GROUP_ROLES) return [];
  return event.tags
    .filter(([n, v]) => n === "role" && Boolean(v))
    .map(([, name, description]) => ({ name, description }));
}

/** Parse a kind 33534 zooid dynamic-role definition event. */
export function parseCommunityRole(event: NostrEvent): CommunityRole | undefined {
  if (event.kind !== KIND_RELAY_ROLE) return undefined;
  const id = tag(event, "d")?.[1];
  if (!id) return undefined;
  const label = tag(event, "label")?.[1];
  const description = tag(event, "description")?.[1];
  const colorRaw = tag(event, "color")?.[1];
  const orderRaw = tag(event, "order")?.[1];
  const color = colorRaw !== undefined ? Number(colorRaw) : undefined;
  const order = orderRaw !== undefined ? Number(orderRaw) : undefined;
  return {
    id,
    label: label || undefined,
    description: description || undefined,
    color: Number.isFinite(color) ? color : undefined,
    order: Number.isFinite(order) ? order : undefined,
  };
}

/**
 * Parse the role ids assigned to each member from a kind 13534 relay members
 * list. Returns a map of pubkey → assigned role ids
 * (`["member", <pubkey>, <roleId>, ...]`).
 */
export function parseCommunityMemberRoles(event: NostrEvent): Map<string, string[]> {
  const byPubkey = new Map<string, string[]>();
  if (event.kind !== KIND_RELAY_MEMBERS) return byPubkey;
  for (const [n, pubkey, ...roleIds] of event.tags) {
    if (n !== "member" || !HEX64.test(pubkey ?? "")) continue;
    byPubkey.set(pubkey, roleIds.filter(Boolean));
  }
  return byPubkey;
}

/** Parse a kind 39004 livekit-participants event into a list of pubkeys. */
export function parseGroupParticipants(event: NostrEvent): string[] {
  if (event.kind !== KIND_GROUP_PARTICIPANTS) return [];
  return event.tags
    .filter(([n, v]) => n === "participant" && HEX64.test(v ?? ""))
    .map(([, pubkey]) => pubkey);
}

/**
 * Parse a kind 39041 group-pins event into the list of pinned message ids,
 * newest-pinned first (the order the admin pinned them — preserved as authored).
 */
export function parseGroupPins(event: NostrEvent): string[] {
  if (event.kind !== KIND_GROUP_PINS) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const [n, v] of event.tags) {
    if (n === "e" && HEX64.test(v ?? "") && !seen.has(v)) {
      seen.add(v);
      ids.push(v);
    }
  }
  return ids;
}

/** Build the tags for a kind 39041 group-pins event from a list of message ids. */
export function buildGroupPinsTags(groupId: string, pinnedIds: string[]): string[][] {
  const tags: string[][] = [["d", groupId], ["h", groupId]];
  const seen = new Set<string>();
  for (const id of pinnedIds) {
    if (HEX64.test(id) && !seen.has(id)) {
      seen.add(id);
      tags.push(["e", id]);
    }
  }
  return tags;
}

/** Parse a kind 10009 user-groups list into group references (public tags only). */
export function parseUserGroupList(event: NostrEvent): GroupRef[] {
  if (event.kind !== KIND_USER_GROUPS) return [];
  return parseGroupListTags(event.tags).groups;
}

/**
 * Parse a set of kind 10009 tags (public or decrypted-private) into the full
 * list of joined groups and servers. Per NIP-51, the "Simple groups" list
 * carries `["group", id, relay, name?]` and `["r", relayUrl]` items.
 */
export function parseGroupListTags(tags: string[][]): UserGroupList {
  const groups: GroupRef[] = [];
  const servers: string[] = [];
  const seenGroups = new Set<string>();
  const seenServers = new Set<string>();

  for (const [name, a, b] of tags) {
    if (name === "group" && a && b) {
      const key = `${a}\u0000${b}`;
      if (!seenGroups.has(key)) {
        seenGroups.add(key);
        groups.push({ id: a, relay: b });
      }
    } else if (name === "r" && a) {
      if (!seenServers.has(a)) {
        seenServers.add(a);
        servers.push(a);
      }
    }
  }

  return { groups, servers };
}

/**
 * Build the kind 10009 tag list from groups + servers. Group tags carry the
 * host relay so the group can be located; server tags (`r`) list each relay in
 * use (NIP-51). Items are emitted in chronological order (servers first, then
 * groups) — callers preserve ordering by passing the existing arrays through.
 */
export function buildGroupListTags(list: UserGroupList): string[][] {
  return [
    ...list.servers.map((url) => ["r", url]),
    ...list.groups.map((g) => ["group", g.id, g.relay]),
  ];
}

/**
 * Parse a kind-1985 self-label event into a {@link ServerProfile}, scoped to a
 * relay. Returns `undefined` when the event isn't an Armada per-server
 * self-label authored by `pubkey` for `relay`.
 *
 * Expected shape:
 *   ["L", "armada"]
 *   ["l", "<nickname>", "armada/nickname"]   (optional)
 *   ["l", "<label>",    "armada/label"]      (optional)
 *   ["l", "<#rrggbb>",  "armada/color"]      (optional)
 *   ["p", "<pubkey>"]                        (self-label target)
 *   ["r", "<relay>"]                         (server scope)
 */
export function parseServerProfile(
  event: NostrEvent,
  pubkey: string,
  relay: string,
): ServerProfile | undefined {
  if (event.kind !== KIND_LABEL) return undefined;
  if (event.pubkey !== pubkey) return undefined;

  // Must be namespaced as an Armada label, self-targeted, and scoped to relay.
  const namespaces = event.tags.filter(([n]) => n === "L").map(([, v]) => v);
  if (!namespaces.includes(SERVER_PROFILE_NAMESPACE)) return undefined;

  const targetsSelf = event.tags.some(([n, v]) => n === "p" && v === pubkey);
  if (!targetsSelf) return undefined;

  const scopedToRelay = event.tags.some(([n, v]) => n === "r" && v === relay);
  if (!scopedToRelay) return undefined;

  let nickname: string | undefined;
  let label: string | undefined;
  let color: string | undefined;
  for (const [n, value, mark] of event.tags) {
    if (n !== "l") continue;
    if (mark === SERVER_NICKNAME_MARK && value) nickname = value;
    else if (mark === SERVER_LABEL_MARK && value) label = value;
    else if (mark === SERVER_COLOR_MARK && isHexColor(value)) color = value;
  }

  if (nickname === undefined && label === undefined && color === undefined) return undefined;
  return { relay, nickname, label, color };
}

/** True when `value` is a 3- or 6-digit CSS hex color (e.g. `#f80`, `#ff8800`). */
export function isHexColor(value: string | undefined): value is string {
  return typeof value === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

/**
 * Build the tags for a per-server self-label (kind 1985). Empty/blank values
 * are omitted so clearing a field removes it from the published event.
 */
export function buildServerProfileTags(
  pubkey: string,
  relay: string,
  profile: { nickname?: string; label?: string; color?: string },
): string[][] {
  const tags: string[][] = [
    ["L", SERVER_PROFILE_NAMESPACE],
    ["p", pubkey],
    ["r", relay],
  ];
  const nickname = profile.nickname?.trim();
  const label = profile.label?.trim();
  const color = profile.color?.trim();
  if (nickname) tags.push(["l", nickname, SERVER_NICKNAME_MARK]);
  if (label) tags.push(["l", label, SERVER_LABEL_MARK]);
  if (isHexColor(color)) tags.push(["l", color, SERVER_COLOR_MARK]);
  return tags;
}

/** Get the group id (`h` tag) of a group-scoped event. */
export function getGroupId(event: NostrEvent): string | undefined {
  return tag(event, "h")?.[1];
}

/**
 * Build the NIP-22 tags for a kind-1111 comment replying to `parent` inside a
 * NIP-29 group. The uppercase `K`/`E`/`P` tags pin the immutable *thread root*;
 * the lowercase `k`/`e`/`p` tags point at the *immediate parent*. When the
 * parent is itself a comment, its uppercase root tags are inherited so the root
 * is stable at any nesting depth (matching Flotilla / @welshman). The group `h`
 * tag is kept so the NIP-29 relay scopes and authorizes the reply.
 *
 * https://github.com/nostr-protocol/nips/blob/master/22.md
 */
export function buildCommentTags(parent: NostrEvent, groupId: string): string[][] {
  const tags: string[][] = [["h", groupId]];

  const rootTags = parent.tags.filter(([n]) => n === "K" || n === "E" || n === "P");
  if (rootTags.length > 0) {
    // Parent is itself a comment: inherit its root pointer verbatim.
    for (const t of rootTags) tags.push([...t]);
  } else {
    // Parent is the root of this thread.
    tags.push(["K", String(parent.kind)]);
    tags.push(["E", parent.id, "", parent.pubkey]);
    tags.push(["P", parent.pubkey]);
  }

  // Immediate-parent pointer (always the event being replied to).
  tags.push(["k", String(parent.kind)]);
  tags.push(["e", parent.id, "", parent.pubkey]);
  tags.push(["p", parent.pubkey]);

  return tags;
}

/** The thread-root event id a comment belongs to (its uppercase `E` tag). */
export function getCommentRootId(event: NostrEvent): string | undefined {
  return tag(event, "E")?.[1];
}

/** The immediate parent event id a comment replies to (its lowercase `e` tag). */
export function getCommentParentId(event: NostrEvent): string | undefined {
  return tag(event, "e")?.[1];
}
