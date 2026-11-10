/**
 * The Web Push service worker's runtime. `worker.ts` handles the worker's
 * events and `sw.ts` hands it these functions; the build bundles all three
 * into `/sw.js`. For the inlined push event (`inline_event`, see
 * `pushSubscriptions.ts`) it:
 *   - OPENS it via the app's own `openDmWrap`/`openWrap`, so the worker can't
 *     apply laxer anti-spoof/seal/NIP-40 rules than the page;
 *   - STORES it in ArmadaDB (IndexedDB) via `writeDm17Rumors`/`writeRumors`;
 *   - PRESENTS it with names/images read from that same database, asking
 *     relays only for a profile it has never stored (`profileFetch.ts`).
 * Every step is best-effort; failure falls back to the gateway's static wake-up.
 */

import { isRenderableReaction } from "@/concord/lib/reactionContent";
import { getConversationKey, decrypt as nip44Decrypt } from "nostr-tools/nip44";
import { verifyEvent } from "nostr-tools/pure";
import { hexToBytes } from "@noble/hashes/utils.js";

import { rolePings } from "@/concord/lib/roleMentions";
import { checkChannelBinding, FUTURE_HOLD_MS, openWrap, StreamError } from "@/concord/lib/stream";
import {
  KIND_COMMENT,
  KIND_MESSAGE,
  KIND_REACTION,
  KIND_SEAL_ENCRYPTED,
  PLANE_KINDS,
} from "@/concord/lib/kinds";
import { decryptNotificationIcon } from "@/concord/lib/image";
import { writeRumors } from "@/concord/lib/rumorStore";
import { hasEveryoneMention } from "@/concord/lib/everyoneMention";
import { sentDuringMembership } from "@/concord/lib/membershipFloor";
import { presetIndexedDBArmadaDB } from "@/lib/db/armadaDB";
import { APP_BLOSSOM_SERVERS } from "@/lib/blossom";
import { appEventStore } from "@/lib/db/mainEventStore";
import { createAppIntl, setIntl, t } from "@/i18n/intl";
import { getDisplayName } from "@/lib/getDisplayName";
import { mediaPolicyFromConfig, mediaSrc, type MediaPolicy } from "@/lib/mediaPolicy";
import { withArrival, writeDm17Rumors } from "@/lib/nip17/dm17Store";
import { nip29ThreadRootOf } from "@/lib/nip29Threads";
import { dmAt, KIND_DM_CHAT, KIND_DM_FILE, openDmWrap } from "@/lib/nip17/protocol";
import { dmConvKey } from "@/lib/nip17/conversation";
import {
  attributedLine,
  firstImetaMime,
  isThreadReply,
  mentionPubkeys,
  NOTIFICATION_BADGE_ICON,
  NOTIFICATION_FALLBACK_ICON,
  notificationMessages,
  presentNotification,
  type NotificationMessage,
} from "@/lib/notificationPreview";
import { concordRoomIdentity, nip29RoomIdentity } from "@/lib/notificationRoom";
import { openSealedConfig } from "@/lib/swSecretVault";
import { fetchProfiles } from "@/sw/profileFetch";

import type { OpenedChat } from "@/concord/lib/chat";
import type { ImagePointer } from "@/concord/lib/types";
import type { NostrEvent, NostrMetadata } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { PushScope } from "@/lib/pushSubscriptions";
import type { SwConcordStream, SwPushConfig } from "@/lib/swPushConfig";
import { plainProfilePicture } from "@/lib/profileImeta";

// The worker shares the page's store; fix the adapter before anything reads.
presetIndexedDBArmadaDB();

/**
 * What the worker knows about one push. A legacy gateway echoed `scope` and
 * `relays` back from the registration; a `napp.push.payload` carries only the
 * event and where it came from, so `scope` is derived ({@link pushScope}).
 */
export interface PushData {
  scope?: PushScope;
  relays?: unknown;
  url?: string;
  event?: NostrEvent;
  [key: string]: unknown;
}

/**
 * What the worker needs to show one notification. `line` is separate because
 * accumulating lines needs `registration.getNotifications` (worker-side).
 */
export interface PreparedPush {
  /**
   * Show NOTHING (vs undefined = "use your fallback", which is visible). Only
   * the decrypted rumor reveals own-device sends or others' reactions, so
   * silence must be requestable.
   */
  drop?: true;
  /** Collapse tag — one entry per conversation. */
  tag: string;
  /** Exact active-room key shared with the foreground page, when resolvable. */
  roomKey?: string;
  /** Opened rumor/event id shared with the foreground page for acknowledgement. */
  eventId?: string;
  /** Deep link for `notificationclick`. */
  url: string;
  title: string;
  /** This message's line, to append to the room's recent ones. */
  line: string;
  icon: string;
  badge: string;
  /** The message's own `created_at`, in ms. */
  timestamp: number;
  /** Unknown sender under the `off` policy: as quiet as possible, never silent (iOS revokes those). */
  quiet?: boolean;
  /** Whether earlier room lines may show; content-blind request pings must not accumulate. */
  accumulate: boolean;
}

/** A raw-key NIP-44 signer, so the worker can drive the app's own `openDmWrap`. */
function rawSigner(skHex: string) {
  const sk = hexToBytes(skHex);
  return {
    nip44: {
      encrypt: () => Promise.reject(new Error("the push worker never encrypts")),
      decrypt: (pubkey: string, ciphertext: string) =>
        Promise.resolve(nip44Decrypt(ciphertext, getConversationKey(sk, pubkey))),
    },
  };
}

/**
 * Open an inlined NIP-17 wrap, or null (can't open, malformed, expired). Uses
 * `openDmWrap` so seal, anti-spoof, id-hash and expiry checks are identical to
 * the app's. Own-sent copies are handled by `prepareDm`.
 */
export async function openDm(
  wrap: NostrEvent,
  skHex: string,
  self: string,
): Promise<Awaited<ReturnType<typeof openDmWrap>>> {
  try {
    return await openDmWrap(wrap, rawSigner(skHex), self);
  } catch {
    return undefined;
  }
}

/**
 * Open an inlined Concord chat wrap via the stream keyed by `wrap.pubkey` (no
 * trial decryption). Channel/epoch bindings are checked against the opening
 * stream to stop cross-channel splices. The seal MUST be encrypted (CORD-02 §5).
 */
export function openConcord(
  wrap: NostrEvent,
  streams: SwConcordStream[],
): { opened: OpenedChat; stream: SwConcordStream } | "malformed" | undefined {
  const stream = streams.find((s) => s.pk === wrap.pubkey);
  if (!stream) return undefined;
  try {
    const ev = openWrap(wrap as NostrRumor, {
      pk: stream.pk,
      convKey: hexToBytes(stream.convKey),
    });
    if (ev.sealKind !== KIND_SEAL_ENCRYPTED) return undefined;
    const epoch = BigInt(stream.epoch);
    checkChannelBinding(ev, stream.channelId, epoch);
    // Only read addresses are listened on here, and a `wepoch` there is forged (CORD-03 §3):
    // stored, the timeline would stand it as a writer's post.
    if (ev.tags.some((t) => t[0] === "wepoch")) return undefined;
    // Another plane's kind re-sealed onto a chat stream is not chat (CORD-02 §5).
    if (PLANE_KINDS.has(ev.kind)) return undefined;
    return { opened: { ...ev, channelIdHex: stream.channelId, epoch }, stream };
  } catch (e) {
    // A bad `ms` opened fine and is refused for what it says (CORD-02 §5, Vector `BadMs`).
    if (e instanceof StreamError && e.code === "bad-ms") return "malformed";
    // not ours, spliced, or otherwise malformed
    return undefined;
  }
}

/** The one value of `name`, or undefined when absent or repeated (CORD-01). */
function uniqueTag(tags: string[][], name: string): string | undefined {
  const found = tags.filter((t) => t[0] === name);
  return found.length === 1 ? found[0][1] : undefined;
}

/** The viewer's media policy from the sealed config (older configs get the default). */
function policyOf(cfg: SwPushConfig | null): MediaPolicy {
  return mediaPolicyFromConfig(cfg?.mediaPolicy);
}

/** A name (absent for an unnamed profile) and an avatar routed per media policy (the OS fetches icons from this device). */
interface ResolvedProfile {
  name?: string;
  avatar?: string;
}

/** Mentions looked up per message; any beyond keep their raw token. */
const MAX_MENTION_LOOKUPS = 8;

function resolvedProfile(ev: { content: string; pubkey: string; tags: string[][] }, policy: MediaPolicy): ResolvedProfile | undefined {
  try {
    const metadata = JSON.parse(ev.content) as NostrMetadata;
    if (!metadata || typeof metadata !== "object") return undefined;
    const plain = plainProfilePicture(ev.tags, metadata);
    const picture = plain && /^https:\/\//.test(plain) ? plain : undefined;
    return { name: metadata.name || metadata.display_name || undefined, avatar: mediaSrc(picture, policy) };
  } catch {
    return undefined;
  }
}

/**
 * Profiles for `pubkeys`: the stored kind 0 first, then a short lookup on
 * `relays` for whoever this device has never stored. What the relays return is
 * kept, so the app opens already knowing the name.
 */
async function profilesFor(
  pubkeys: string[],
  relays: string[],
  policy: MediaPolicy,
): Promise<Map<string, ResolvedProfile>> {
  const profiles = new Map<string, ResolvedProfile>();
  let store: Awaited<ReturnType<typeof appEventStore>> | undefined;
  try {
    store = await appEventStore();
    for (const ev of await store.query([{ kinds: [0], authors: pubkeys }])) {
      const profile = resolvedProfile(ev, policy);
      if (profile) profiles.set(ev.pubkey, profile);
    }
  } catch {
    // store unreadable — the relays may still answer
  }

  const missing = pubkeys.filter((pk) => !profiles.has(pk));
  if (missing.length === 0 || relays.length === 0) return profiles;
  const fetched = await fetchProfiles(relays, missing);
  await Promise.all(fetched.map(async (ev) => {
    const profile = resolvedProfile(ev, policy);
    if (profile) profiles.set(ev.pubkey, profile);
    await store?.event(ev).catch(() => undefined);
  }));
  return profiles;
}

/** Where to ask for a missing kind 0: the push's own relays first, then the user's. */
function profileRelaysFor(cfg: SwPushConfig | null, pushRelays: string[] = []): string[] {
  return [...new Set([...pushRelays, ...(cfg?.profileRelays ?? [])])];
}

/** A community icon as a small `data:` URL (workers lack `URL.createObjectURL`). */
function imageDataUrl(pointer: ImagePointer, policy: MediaPolicy): Promise<string | undefined> {
  return decryptNotificationIcon(pointer, APP_BLOSSOM_SERVERS, policy);
}

/** Deep link to a message in a NIP-29 group, inside its thread when it is a reply (mirrors `routes.ts`). */
function groupUrl(relayUrl: string, groupId: string, eventId: string, threadRoot?: string): string {
  const param = encodeURIComponent(
    relayUrl.replace(/^wss?:\/\//i, (m) => (m.toLowerCase() === "ws://" ? "ws:" : "")),
  );
  const thread = threadRoot ? `/t/${encodeURIComponent(threadRoot)}` : "";
  return `/s/${param}/${encodeURIComponent(groupId)}${thread}/m/${encodeURIComponent(eventId)}`;
}

/** Show nothing at all for this push (see {@link PreparedPush.drop}). */
const DROP: PreparedPush = {
  drop: true,
  tag: "",
  url: "/",
  title: "",
  line: "",
  icon: NOTIFICATION_FALLBACK_ICON,
  badge: NOTIFICATION_BADGE_ICON,
  timestamp: 0,
  accumulate: false,
};

/** The content-blind ping for an unknown sender: nothing they control. */
function requestPing(
  quiet: boolean,
  eventId?: string,
  roomKey?: string,
): PreparedPush {
  return {
    tag: "armada-dm-requests",
    url: "/dm",
    title: t(notificationMessages.messageRequests),
    line: t(notificationMessages.newMessageRequest, { count: quiet ? 2 : 1 }),
    icon: NOTIFICATION_FALLBACK_ICON,
    badge: NOTIFICATION_BADGE_ICON,
    timestamp: Date.now(),
    quiet,
    accumulate: false,
    eventId,
    roomKey,
  };
}

/** Compose a prepared notification from an opened message. */
async function present(
  msg: Omit<NotificationMessage, "authorName" | "authorAvatar" | "mentionNames">,
  author: string,
  room: { title?: string; image?: string },
  route: { tag: string; url: string; timestamp: number; roomKey?: string; eventId?: string },
  policy: MediaPolicy,
  /** Relays to ask for a kind 0 this device doesn't hold. */
  profileRelays: string[],
  /** Show the sender's avatar; false = the room icon or the app's. */
  showAvatar = true,
  /** The name the sender goes by in this Community (CORD-04 §10), over their profile's. */
  nickname?: string,
): Promise<PreparedPush> {
  const mentioned = mentionPubkeys(msg.content).slice(0, MAX_MENTION_LOOKUPS);
  const profiles = await profilesFor([...new Set([author, ...mentioned])], profileRelays, policy);
  const { name: profileName = getDisplayName(undefined), avatar } = profiles.get(author) ?? {};
  const name = nickname || profileName;
  // An unnamed mention keeps its raw token: "@Anonymous" would name nobody.
  const mentionNames = new Map<string, string>();
  for (const pk of mentioned) {
    const mentionedName = profiles.get(pk)?.name;
    if (mentionedName) mentionNames.set(pk, mentionedName);
  }
  const full: NotificationMessage = {
    ...msg,
    authorName: name,
    authorAvatar: showAvatar ? avatar : undefined,
    roomTitle: room.title,
    roomImage: room.image,
    mentionNames,
  };
  const presented = presentNotification(full);
  return {
    tag: route.tag,
    url: route.url,
    title: presented.title,
    line: attributedLine(full),
    icon: presented.icon,
    badge: presented.badge,
    timestamp: route.timestamp,
    accumulate: true,
    roomKey: route.roomKey,
    eventId: route.eventId,
  };
}

/** NIP-29 kinds the group subscriptions watch (`buildPushSubscriptions`). */
const GROUP_KINDS = new Set([9, 1111, 7]);

/**
 * Which plane an event belongs to, from the event alone.
 *
 * A `napp.push.payload` says nothing about which subscription matched: both
 * transports send the event and the relay it came from, and nostr-push2 merges
 * every subscription into one list. The event is enough. A kind-1059 is a
 * Concord wrap when its author is one of our stream addresses — routing is by
 * `pubkey` there, as in {@link openConcord} — and a NIP-17 wrap when it is
 * addressed to us; an `h`-tagged group kind is NIP-29. Undefined for anything
 * this install cannot place, which then gets the generic fallback.
 */
export function pushScope(event: NostrEvent, cfg: SwPushConfig | null): PushScope | undefined {
  const addressedToSelf = Boolean(cfg?.self)
    && event.tags.some(([name, value]) => name === "p" && value === cfg?.self);
  if (event.kind === 1059) {
    if (cfg?.concord?.some((stream) => stream.pk === event.pubkey)) return "c2";
    return addressedToSelf ? "dm" : undefined;
  }
  if (event.kind === 4) return "dm";
  if (GROUP_KINDS.has(event.kind) && uniqueTag(event.tags, "h") !== undefined) {
    return addressedToSelf ? "group-mention" : "group";
  }
  return undefined;
}

/**
 * Open the inlined event, store it, and return what to show (undefined = static
 * fallback). Storing comes FIRST: the message must survive even if presentation fails.
 */
export async function preparePush(
  data: PushData,
  cfg: SwPushConfig | null,
): Promise<PreparedPush | undefined> {
  const wrapOrEvent = data.event;
  if (!wrapOrEvent || typeof wrapOrEvent !== "object") return undefined;

  // Tenna delivers what its relays sent without checking it, and a fetched
  // event is only as good as the relay that answered. A forged event is not a
  // message; say nothing about it.
  if (!verifyEvent(wrapOrEvent)) return DROP;

  const relays = Array.isArray(data.relays) ? (data.relays as string[]) : [];
  const scope = data.scope ?? pushScope(wrapOrEvent, cfg);

  // Fail closed only for the non-authoritative plane; `undefined` = ready (older configs).
  if (scope === "dm") {
    if (cfg?.dmReady === false) return DROP;
    return prepareDm(wrapOrEvent, cfg);
  }
  if (scope === "c2") {
    if (cfg?.concordReady === false) return DROP;
    return prepareConcord(wrapOrEvent, relays, cfg);
  }
  if (scope === "group" || scope === "group-mention") {
    return prepareGroup(wrapOrEvent, relays, cfg);
  }
  return undefined;
}

async function prepareDm(
  wrap: NostrEvent,
  cfg: SwPushConfig | null,
): Promise<PreparedPush | undefined> {
  if (!cfg?.sk) return undefined; // non-nsec login → the worker can't decrypt
  const unwrapped = await openDm(wrap, cfg.sk, cfg.self);
  if (!unwrapped) return undefined;
  // A push is delivered as the message is published: time it by its arrival where the sender's clock was off.
  const opened = withArrival(unwrapped, Math.floor(Date.now() / 1000));

  // Persist first (including own sent copies from other devices).
  await writeDm17Rumors(cfg.self, [opened]).catch(() => undefined);

  const conversation = dmConvKey(opened.peers);
  const roomKey = `dm:${conversation}`;

  if (opened.author === cfg.self) return DROP;

  // Like the DM list: any muted participant hides the conversation, even under `full`.
  if (opened.peers.some((peer) => cfg.mutedPeers?.includes(peer))) return DROP;

  // Per-conversation levels are device policy (the gateway can't see the
  // conversation); both `all` and `mentions` admit DMs.
  const dmLevel = cfg.dmLevels?.[conversation];
  if (dmLevel === "nothing" || (!dmLevel && cfg.directMessages === false)) return DROP;

  // Non-message rumors still need something shown on iOS: the request ping.
  if (opened.kind !== KIND_DM_CHAT && opened.kind !== KIND_DM_FILE) {
    return requestPing(true, opened.rumorId, roomKey);
  }

  const known = cfg.knownConversations?.includes(conversation)
    || opened.peers.every((peer) => cfg.knownPeers.includes(peer));
  if (!known && cfg.policy !== "full") {
    // A stranger controls text, name and avatar: gate all three.
    return requestPing(cfg.policy === "off", opened.rumorId, roomKey);
  }

  return present(
    {
      plane: "dm",
      kind: opened.kind,
      content: opened.content,
      imetaMime: firstImetaMime(opened.tags),
      threadReply: isThreadReply(opened.kind, opened.tags),
    },
    opened.author,
    {},
    {
      tag: `dm-${conversation}`,
      roomKey,
      eventId: opened.rumorId,
      url: `/dm/${conversation}`,
      timestamp: dmAt(opened) * 1000,
    },
    policyOf(cfg),
    // Not the wrap's relays: asking the inbox that just delivered a wrap for
    // the sender's profile ties the two together there.
    profileRelaysFor(cfg),
  );
}

async function prepareConcord(
  wrap: NostrEvent,
  relays: string[],
  cfg: SwPushConfig | null,
): Promise<PreparedPush | undefined> {
  const streams = cfg?.concord;
  if (!streams || streams.length === 0) return undefined;
  const result = openConcord(wrap, streams);
  if (result === "malformed") return DROP;
  if (!result) {
    const addressed = streams.find((s) => s.pk === wrap.pubkey);
    return addressed ? opaqueConcord(addressed, policyOf(cfg)) : undefined;
  }
  const { opened, stream } = result;

  // Store it regardless: the timeline has no other copy.
  await writeRumors(stream.communityId, [opened]).catch(() => undefined);

  // Future-dated messages are held by the timeline (FUTURE_HOLD_MS); don't announce yet.
  if (opened.ms > Date.now() + (stream.clockOffsetMs ?? 0) + FUTURE_HOLD_MS) return DROP;

  // Own message from another device (only the decrypted author reveals it).
  if (cfg?.self && opened.author === cfg.self) return DROP;

  // Muted (level `nothing`): stored, never announced — silences a lingering gateway sub.
  if (stream.muted) return DROP;

  // Banned (CORD-04): stored, never announced.
  if (stream.banned?.includes(opened.author)) return DROP;

  // A post its readers collapse rings nobody (CORD-04 §8): no SEND here, or inside a running Timeout.
  if (stream.sendDenied?.includes(opened.author)) return DROP;
  // At a restricted Channel's read address a post stands only from those who manage it (CORD-03 §1).
  if (stream.postAuthors && opened.kind !== KIND_REACTION && !stream.postAuthors.includes(opened.author)) return DROP;
  const nowMs = Date.now() + (stream.clockOffsetMs ?? 0);
  if (stream.timeouts?.some((t) => t.pk === opened.author && t.until * 1000 > nowMs && opened.ms >= t.fromSecs * 1000 && opened.ms < t.until * 1000)) return DROP;

  // Sent before this membership began: the viewer wasn't there.
  if (!sentDuringMembership(opened.ms, stream.joinedAtMs)) return DROP;

  // Edits, deletes, votes and the rest ride the same wraps; stored, never announced.
  if (opened.kind !== KIND_MESSAGE && opened.kind !== KIND_COMMENT && opened.kind !== KIND_REACTION) {
    return DROP;
  }

  const mention = Boolean(cfg?.self) && (
    opened.tags.some(([n, v]) => n === "p" && v === cfg?.self)
    // A reaction is aimed at one message's author only: its content mentions nobody.
    || (opened.kind !== KIND_REACTION && (
      ((stream.mentionEveryoneAnyone === true || stream.mentionEveryoneAuthors?.includes(opened.author))
        && hasEveryoneMention(opened.content))
      || rolePings(opened.content, opened.tags, stream.roleMentions ?? [], stream.roleMentionAuthors?.includes(opened.author) ?? false)
    ))
  );
  const reaction = opened.kind === KIND_REACTION;
  // Reactions only notify when pointing at YOUR message (`p` on the encrypted rumor), and
  // never one no row could render (Vector `is_renderable_reaction`).
  if (reaction && (!mention || !isRenderableReaction(opened.content))) return DROP;

  // Mentions-only can only be enforced here, after decryption.
  if (stream.mentionOnly && !mention) return DROP;

  const policy = policyOf(cfg);
  const room = await concordRoomIdentity(stream.communityId, stream.channelId);
  const image = room.iconPointer ? await imageDataUrl(room.iconPointer, policy) : undefined;

  const base = `/c/${stream.communityId}/${stream.channelId}`;
  // A thread reply opens its thread (routes.ts `/t/<root>`), as the native service does.
  const threadRoot = opened.kind === KIND_COMMENT ? uniqueTag(opened.tags, "E") : undefined;
  return present(
    {
      plane: "c2",
      kind: opened.kind,
      content: opened.content,
      mention,
      reaction,
      imetaMime: firstImetaMime(opened.tags),
      threadReply: isThreadReply(opened.kind, opened.tags),
    },
    opened.author,
    { title: room.title, image },
    {
      tag: `c2:${stream.channelId}`,
      roomKey: `c2:${stream.channelId}`,
      eventId: opened.rumorId,
      // Link to the reacted-to message.
      url: threadRoot
        ? `${base}/t/${encodeURIComponent(threadRoot)}`
        : `${base}/m/${encodeURIComponent(uniqueTag(opened.tags, "e") ?? opened.rumorId)}`,
      timestamp: opened.createdAt * 1000,
    },
    policy,
    profileRelaysFor(cfg, relays),
    communityAvatarShown(opened.author, cfg),
    stream.nicknames?.[opened.author],
  );
}

/**
 * Whether a community sender's avatar may be the notification icon. Anyone with
 * the key can post (CORD-04 §1), so unless the reader loads everyone's media only
 * a known peer's face reaches the lock screen — the worker has no view of the
 * in-app trust graph (`mediaTrust.ts`).
 */
export function communityAvatarShown(author: string, cfg: SwPushConfig | null): boolean {
  if (cfg?.mediaPolicy?.allCommunityAvatars === true) return true;
  return Boolean(cfg?.knownPeers?.includes(author));
}

/**
 * A wrap from one of our streams that would not open (an epoch whose key we
 * lack, a splice). Nothing inside is known, but the room is, as on native.
 */
async function opaqueConcord(stream: SwConcordStream, policy: MediaPolicy): Promise<PreparedPush> {
  // Muted, or mentions-only with no readable mention to go on.
  if (stream.muted || stream.mentionOnly) return DROP;

  const room = await concordRoomIdentity(stream.communityId, stream.channelId);
  const image = room.iconPointer ? await imageDataUrl(room.iconPointer, policy) : undefined;
  return {
    tag: `c2:${stream.channelId}`,
    roomKey: `c2:${stream.channelId}`,
    url: `/c/${stream.communityId}/${stream.channelId}`,
    title: room.title || t(notificationMessages.newCommunityMessage),
    line: t(notificationMessages.newMessage),
    icon: image ?? NOTIFICATION_FALLBACK_ICON,
    badge: NOTIFICATION_BADGE_ICON,
    timestamp: Date.now(),
    accumulate: true,
  };
}

/**
 * A NIP-29 group message (plaintext). NOT stored: legacy multi-relay
 * registrations lack exact room identity for a tenant write, and plaintext is
 * refetched on open.
 */
async function prepareGroup(
  ev: NostrEvent,
  relays: string[],
  cfg: SwPushConfig | null,
): Promise<PreparedPush | undefined> {
  const groupId = uniqueTag(ev.tags, "h");
  if (!groupId || typeof ev.content !== "string") return undefined;
  if (cfg?.self && ev.pubkey === cfg.self) return DROP; // our own, from another device

  // Name the room only if exactly ONE relay tenant knows this group id.
  const identities = await Promise.all(
    relays.map(async (relay) => ({ relay, room: await nip29RoomIdentity(relay, groupId) })),
  );
  const named = identities.filter((i) => i.room.title);
  const exact = identities.length === 1 ? identities[0] : undefined;
  const only = exact ?? (named.length === 1 ? named[0] : undefined);

  const mention = Boolean(cfg?.self) && ev.tags.some(([n, v]) => n === "p" && v === cfg?.self);
  const policy = policyOf(cfg);
  const threadRoot = nip29ThreadRootOf(ev);
  return present(
    {
      plane: "nip29",
      kind: ev.kind,
      content: ev.content,
      mention,
      imetaMime: firstImetaMime(ev.tags),
      threadReply: isThreadReply(ev.kind, ev.tags),
    },
    ev.pubkey,
    // A kind-39000 `picture` is operator-controlled: policed like an avatar.
    { title: only?.room.title, image: mediaSrc(only?.room.iconUrl, policy) },
    {
      tag: `h:${groupId}`,
      // Unresolved unless exactly one tenant identifies the group.
      roomKey: only ? `h:${only.relay}|${groupId}` : undefined,
      eventId: ev.id,
      url: only
        ? groupUrl(only.relay, groupId, ev.id, threadRoot)
        : (relays[0] ? groupUrl(relays[0], groupId, ev.id, threadRoot) : "/"),
      timestamp: ev.created_at * 1000,
    },
    policy,
    profileRelaysFor(cfg, relays),
  );
}

let installedLocale = "";

/** Word every notification in the page's language; English without a usable catalog. */
function installLocale(cfg: SwPushConfig | null): void {
  const usable = cfg?.locale && cfg.messages ? cfg.locale : "en";
  const key = usable === "en" ? "en" : `${usable}\0${JSON.stringify(cfg?.messages)}`;
  if (key === installedLocale) return;
  installedLocale = key;
  setIntl(createAppIntl(usable, usable === "en" ? undefined : cfg?.messages));
}

/** Open the sealed config, or null when it can't be opened. Installs its language. */
export async function openConfig(sealed: Uint8Array | undefined): Promise<SwPushConfig | null> {
  let cfg: SwPushConfig | null = null;
  if (sealed) {
    try {
      cfg = (await openSealedConfig(sealed)) as SwPushConfig | null;
    } catch {
      cfg = null;
    }
  }
  installLocale(cfg);
  return cfg;
}
