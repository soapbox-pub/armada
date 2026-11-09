import { openChatBatch } from "@/concord/lib/chat";
import { isRenderableReaction } from "@/concord/lib/reactionContent";
import { clockNowMs } from "@/lib/relayClock";
import { rolePings, type HeldRoleMention } from "@/concord/lib/roleMentions";
import { KIND_MESSAGE, KIND_REACTION } from "@/concord/lib/kinds";
import type { StreamKeyView } from "@/concord/lib/derive";
import { notePlaneWrapsJunk, notePlaneWrapsSeen, openPlaneWrapsChunked, unseenPlaneWraps } from "@/concord/lib/planeSync";
import { hasFreshChatListener, parkPendingWraps, writeOpened, writeRumors } from "@/concord/lib/rumorStore";
import { isRelayScoped } from "@/lib/db/relayScope";
import { bufferLiveDmWraps } from "@/lib/nip17/dm17Store";
import { bufferLiveInviteWraps } from "@/concord/lib/inviteInbox";
import { KIND_DIRECT_INVITE } from "@/concord/lib/kinds";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { nip29ThreadRootOf } from "@/lib/nip29Threads";
import { KIND_STREAM_MESSAGE_V2 } from "@/buzz/kinds";
import { reactionContentKey } from "@/hooks/useReactions";
import { dmThreadScope, emitWireScopes } from "@/wire/bus";
import { feedNotifyCandidates, noteWrapsOpened, type GitNotifyAction, type NotifyCandidate } from "@/wire/notify";
import { isCIEventKind, matchCIEventRepository } from "@/lib/ci";
import { firstImetaMime, isThreadReply } from "@/lib/notificationPreview";
import { chatRoute } from "@/lib/routes";
import { isGitRepositoryAttachedAt, matchGitTicketRepository, parseGitComment, parseGitStatusEvent, parseGitTicket } from "@/lib/gitActivity";

import type { OpenedChat } from "@/concord/lib/chat";
import type { WireSpec } from "@/wire/spec";
import type { Channel } from "@/concord/lib/types";
import type { NostrEvent } from "@nostrify/nostrify";

/** Gift-wrap kinds (Concord / NIP-59) — never persisted sealed. */
const WRAP_KINDS = new Set([1059, 21059]);
/** NIP-59 gift-wrap kind — the DM candidate's reported kind for a NIP-17 wrap. */
const KIND_DM_WRAP = 1059;
/** Legacy NIP-04 direct message kind (Armada's DM plane). */
const KIND_DM = 4;
/** NIP-88 poll kind — a channel-activity message in NIP-29 timelines. */
const KIND_POLL = 1068;

/** Preview text length cap for a foreground notification body. */
const PREVIEW_MAX = 140;

function preview(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX - 1)}\u2026` : t;
}

/**
 * The store surface the wire writes to. `relay` is the source relay: NIP-29
 * data is stored per relay, so events without one can't be stored (see
 * `db/relayScope.ts`).
 */
export interface WireEventStore {
  event(event: NostrEvent, opts?: { signal?: AbortSignal; relay?: string }): Promise<void>;
}

export interface WireSinks {
  /** The shared plaintext event store (ArmadaDB `main` + per-relay tenants). */
  eventStore: Promise<WireEventStore>;
  /** The current spec (decrypt map + scope naming). */
  getSpec: () => WireSpec | undefined;
  /** The logged-in user's pubkey (for mention detection / self-suppression). */
  getSelfPubkey?: () => string | undefined;
}

function tagValue(ev: NostrEvent, name: string): string | undefined {
  return tagValueIn(ev.tags, name);
}

/**
 * Plaintext events ingested this session. Quiet-rotation overlap and relay
 * fan-out re-deliver the same events (72–93% duplicates measured), and each
 * copy costs a store round-trip plus a scope emission driving re-renders.
 * Bounded; may only suppress writes the store would reject anyway (see
 * {@link plainSeenKey}).
 */
const seenPlain = new Set<string>();
const SEEN_PLAIN_CAP = 20_000;

/**
 * Dedupe key: the id, except relay-scoped (NIP-29) events, keyed per
 * (id, relay) since each relay has its own tenant.
 */
function plainSeenKey(ev: NostrEvent, relay: string | undefined): string {
  return isRelayScoped(ev) ? `${ev.id}|${relay ?? ""}` : ev.id;
}

/** Test seam: forget every ingested id. */
export function _resetIngestDedupeForTests(): void {
  seenPlain.clear();
}

function tagValueIn(tags: readonly string[][], name: string): string | undefined {
  for (const t of tags) if (t[0] === name && t[1]) return t[1];
  return undefined;
}

/** The bus scope a plaintext event belongs to, if any. */
function scopeOf(ev: NostrEvent, spec: WireSpec | undefined): string | undefined {
  const ticket = parseGitTicket(ev);
  const ticketRepository = ticket && spec ? matchGitTicketRepository(ticket, spec.gitByRepository) : undefined;
  if (ticketRepository) return `git:${ticketRepository.coordinate}`;
  const comment = parseGitComment(ev);
  if (comment) {
    const address = spec?.gitRootById.get(comment.ticketId);
    if (address) return `git:${address}`;
  }
  const status = parseGitStatusEvent(ev);
  if (status) {
    const address = spec?.gitRootById.get(status.ticketId);
    if (address) return `git:${address}`;
  }
  // CI runs carry repository coordinates, so they scope without a discovered root.
  const ciRepository = spec ? matchCIEventRepository(ev, spec.gitByRepository) : undefined;
  if (ciRepository) return `git:${ciRepository.coordinate}`;
  const h = tagValue(ev, "h");
  if (h) return `nip29:${h}`;
  if (ev.kind === 4) return "dm";
  return undefined;
}

/**
 * The wire's single ingestion point for every transport (web sockets, the APK
 * service's live feed and buffered drain):
 *   - Concord wraps with a held stream key → decrypt → rumor store.
 *   - Concord wraps without one → parked pending store.
 *   - Everything else → the event store (NIP-29 into `opts.relay`'s tenant;
 *     NIP-09 applied by the store).
 * Scopes are then announced on the bus. Writes are idempotent. `opts.relay`
 * is required (one call per relay); `opts.live` is accepted for parity only.
 */
export async function ingestWireEvents(
  sinks: WireSinks,
  events: NostrEvent[],
  opts?: { live?: boolean; relay?: string },
): Promise<void> {
  if (events.length === 0) return;
  const spec = sinks.getSpec();
  const self = sinks.getSelfPubkey?.();
  const scopes = new Set<string>();
  const candidates: NotifyCandidate[] = [];

  // Group decryptable wraps per channel (one decode batch each); control and
  // guestbook wraps per community.
  const wrapsByChannel = new Map<Channel, NostrEvent[]>();
  const ctlWraps: NostrEvent[] = [];
  const gbWraps: NostrEvent[] = [];
  const toPark: NostrEvent[] = [];
  const plain: NostrEvent[] = [];
  const dmWraps: NostrEvent[] = [];
  const inviteWraps: NostrEvent[] = [];
  const openedChatWraps: string[] = [];
  for (const ev of events) {
    if (!ev || typeof ev.id !== "string" || typeof ev.kind !== "number") continue;
    if (WRAP_KINDS.has(ev.kind)) {
      const channel = spec?.concordByPk.get(ev.pubkey);
      if (channel) {
        const list = wrapsByChannel.get(channel);
        if (list) list.push(ev);
        else wrapsByChannel.set(channel, [ev]);
      } else if (spec?.concordCtlByPk.has(ev.pubkey)) {
        ctlWraps.push(ev);
      } else if (spec?.concordGbByPk.has(ev.pubkey)) {
        gbWraps.push(ev);
      } else if (
        self &&
        ev.kind === KIND_DM_WRAP &&
        ev.tags.some(([n, v]) => n === "p" && v === self) &&
        ev.tags.some(([n, v]) => n === "k" && v === String(KIND_DIRECT_INVITE))
      ) {
        // CORD-05 §6 direct invite: a 1059 wrap #p-tagged to us with `#k`=3313.
        // Buffer it and ring `c2inv:wrap` for useDirectInvites (no re-fetch).
        // Checked BEFORE the DM branch: `#k` is the only difference. Not parked.
        inviteWraps.push(ev);
      } else if (self && ev.kind === KIND_DM_WRAP && ev.tags.some(([n, v]) => n === "p" && v === self)) {
        // NIP-17 wrap to the viewer: buffer it in hand and ring `dm:wrap` so
        // useDm17 decrypts without a re-fetch (NIP-42 re-auth latency). Its
        // store write rings `dm` separately so decryption doesn't re-trigger. Not parked.
        dmWraps.push(ev);
      } else {
        // No key held yet (control/invite plane, or a stale spec): park it.
        toPark.push(ev);
      }
    } else {
      plain.push(ev);
    }
  }
  if (dmWraps.length > 0) {
    // Dedupe by session-seen id (the `since` rewind replays wraps every
    // round); ingest can't attribute a sender, so no candidate here.
    const freshDmWraps = bufferLiveDmWraps(dmWraps);
    if (freshDmWraps.length > 0) scopes.add("dm:wrap");
  }
  if (inviteWraps.length > 0) {
    // Same idempotent buffer as DMs.
    const freshInviteWraps = bufferLiveInviteWraps(inviteWraps);
    if (freshInviteWraps.length > 0) scopes.add("c2inv:wrap");
  }

  // Concord chat → the owning community's rumor-store tenant. An open channel first:
  // each batch decrypts in turn, and a replay can hold dozens.
  const chatBatches = [...wrapsByChannel].sort(([a], [b]) => Number(hasFreshChatListener(b.idHex)) - Number(hasFreshChatListener(a.idHex)));
  for (const [channel, wraps] of chatBatches) {
    // Skip wraps already stored (persisted memo); the decode memo is session-only.
    const unseen = await unseenPlaneWraps(wraps);
    if (unseen.length === 0) continue;
    const opened = await openChatBatch(unseen, channel);
    if (opened.length === 0) continue;
    // No community mapping means the spec changed underneath: skip rather than
    // guess a tenant; the next sweep re-ingests.
    const communityIdHex = spec?.concordCommunityByChannel.get(channel.idHex);
    if (!communityIdHex) continue;
    // Memo only wraps that OPENED, after commit (a failed one may need a later
    // epoch key). Not awaited: the open timeline is handed the rows at once, and
    // `writeRumors` rings `c2:` itself once they are readable.
    void writeRumors(communityIdHex, opened).then((stored) => {
      if (stored) notePlaneWrapsSeen(opened.flatMap((o) => o.wrapId ?? []));
    });
    // Banned authors are stored (the timeline hides them) but never notify.
    const banned = communityIdHex ? spec?.concordBannedByCommunity.get(communityIdHex) : undefined;
    const roleMentions = spec?.concordRoleMentionsByCommunity.get(communityIdHex);
    const silence = spec?.concordSilenceByChannel.get(channel.idHex);
    // A post its readers collapse rings nobody (CORD-04 §8, Vector `post_silenced`).
    const nowMs = clockNowMs();
    const ringing = silence ? opened.filter((r) => !postSilenced(silence, r.author, r.kind, r.ms, nowMs)) : opened;
    const nicknames = spec?.concordNicknamesByCommunity.get(communityIdHex);
    for (const c of concordCandidates(ringing, channel, communityIdHex, self, banned, roleMentions)) {
      const nick = nicknames?.[c.author];
      candidates.push(nick ? { ...c, authorNickname: nick } : c);
    }
    for (const o of opened) if (o.wrapId) openedChatWraps.push(o.wrapId);
  }

  // Concord CONTROL → opened-event store, ring `c2ctl:<idHex>` so
  // useControlEvents re-folds promptly (new channels appear without the sweep).
  if (ctlWraps.length > 0 && spec) {
    const byCommunity = new Map<
      string,
      { groups: StreamKeyView[]; refounded: boolean; wraps: NostrEvent[] }
    >();
    for (const ev of ctlWraps) {
      const entry = spec.concordCtlByPk.get(ev.pubkey);
      if (!entry) continue;
      const bucket = byCommunity.get(entry.idHex);
      if (bucket) bucket.wraps.push(ev);
      else {
        byCommunity.set(entry.idHex, {
          groups: entry.groups,
          refounded: entry.refounded,
          wraps: [ev],
        });
      }
    }
    for (const [idHex, { groups, refounded, wraps }] of byCommunity) {
      // Skip already-processed wraps (rotations and the APK re-deliver them).
      const unseen = await unseenPlaneWraps(wraps);
      if (unseen.length === 0) continue;
      const opened = await openPlaneWrapsChunked(unseen, groups);
      let stored = true;
      if (opened.length > 0) {
        stored = await writeOpened(idHex, opened, "control", { refounded });
        scopes.add(`c2ctl:${idHex}`);
      }
      // Record junk before memoing (the only chance to count it).
      const openedIds = new Set(opened.map((e) => e.wrapId));
      notePlaneWrapsJunk(unseen.filter((w) => !openedIds.has(w.id)).map((w) => w.id));
      // Memo only after a successful write.
      if (stored) notePlaneWrapsSeen(unseen.map((w) => w.id));
    }
  }
  // Concord GUESTBOOK → opened-event store, ring `c2gb:<idHex>` for
  // useGuestbook. The live path for a KICK, which touches no control plane.
  if (gbWraps.length > 0 && spec) {
    const byCommunity = new Map<string, { groups: StreamKeyView[]; wraps: NostrEvent[] }>();
    for (const ev of gbWraps) {
      const entry = spec.concordGbByPk.get(ev.pubkey);
      if (!entry) continue;
      const bucket = byCommunity.get(entry.idHex);
      if (bucket) bucket.wraps.push(ev);
      else byCommunity.set(entry.idHex, { groups: entry.groups, wraps: [ev] });
    }
    for (const [idHex, { groups, wraps }] of byCommunity) {
      const unseen = await unseenPlaneWraps(wraps);
      if (unseen.length === 0) continue;
      const opened = await openPlaneWrapsChunked(unseen, groups);
      let stored = true;
      if (opened.length > 0) {
        stored = await writeOpened(idHex, opened, "guestbook");
        scopes.add(`c2gb:${idHex}`);
      }
      const openedIds = new Set(opened.map((e) => e.wrapId));
      notePlaneWrapsJunk(unseen.filter((w) => !openedIds.has(w.id)).map((w) => w.id));
      if (stored) notePlaneWrapsSeen(unseen.map((w) => w.id));
    }
  }

  // Park wraps without a held key (loss-proof peek+ack), and ring the stream
  // address so a hook that holds that key (e.g. right after a rekey) can drain.
  if (toPark.length > 0) {
    parkPendingWraps(toPark);
    for (const ev of toPark) scopes.add(`c2park:${ev.pubkey}`);
  }

  // Plaintext → event store. Submit ALL writes before awaiting so NIndexedDB
  // batches them into one transaction (a serial await loop means N idle-window
  // waits). See wire/ingestBatching.test.ts.
  if (plain.length > 0) {
    const store = await sinks.eventStore;
    // Only attached, well-formed NIP-34 roots are stored (stray `a`-tagged
    // deliveries mustn't land or wake repository hooks).
    const storable = plain.filter(
      (ev) =>
        !(ev.kind === 1618 || ev.kind === 1621 || ev.kind === 1111 || (ev.kind >= 1630 && ev.kind <= 1633) || isCIEventKind(ev.kind)) ||
        scopeOf(ev, spec),
    );
    // Mark BEFORE the write (a burst's duplicate keeps one); unmark on failure so it retries.
    const fresh = storable.filter((ev) => {
      const key = plainSeenKey(ev, opts?.relay);
      if (seenPlain.has(key)) return false;
      if (seenPlain.size >= SEEN_PLAIN_CAP) {
        const oldest = seenPlain.keys().next();
        if (!oldest.done) seenPlain.delete(oldest.value);
      }
      seenPlain.add(key);
      return true;
    });
    const writes = fresh.map((ev) =>
      Promise.resolve()
        .then(() => store.event(ev, { relay: opts?.relay }))
        .catch(() => {
          // duplicate or rejected: the store is authoritative
          seenPlain.delete(plainSeenKey(ev, opts?.relay));
        })
    );
    for (const ev of fresh) {
      const scope = scopeOf(ev, spec);
      if (scope) scopes.add(scope);
      // Root discovery re-reads the relays, so it wakes on new tickets only.
      if (scope?.startsWith("git:") && (ev.kind === 1618 || ev.kind === 1621)) {
        scopes.add(`gitroot:${scope.slice(4)}`);
      }
      // Also name the peer so other open threads don't re-read on every DM.
      if (ev.kind === KIND_DM && self) {
        const peer = ev.pubkey === self ? tagValue(ev, "p") : ev.pubkey;
        if (peer) scopes.add(dmThreadScope(peer));
      }
      candidates.push(...plaintextCandidates(ev, spec, self, opts?.relay));
    }
    // Ring only after the commit, so re-reads see the events.
    await Promise.all(writes);
  }

  if (scopes.size > 0) emitWireScopes(scopes);
  feedNotifyCandidates(candidates);
  noteWrapsOpened(openedChatWraps);
}

type ChannelSilence = NonNullable<ReturnType<WireSpec["concordSilenceByChannel"]["get"]>>;

/** Whether readers collapse a post, so it rings nobody (CORD-04 §8, Vector `post_silenced`). */
export function postSilenced(silence: ChannelSilence | undefined, author: string, kind: number, ms: number, nowMs: number): boolean {
  if (!silence) return false;
  if (silence.sendDenied?.has(author)) return true;
  if (silence.postAuthors && kind !== KIND_REACTION && !silence.postAuthors.has(author)) return true;
  return silence.timeouts?.some((t) => t.pk === author && t.until * 1000 > nowMs && ms >= t.fromSecs * 1000 && ms < t.until * 1000) ?? false;
}

/**
 * Whether a Concord candidate still rings by `spec` as it stands: one held for its date is
 * judged again when due, so a ban or Timeout since it arrived silences it.
 */
export function concordCandidateRings(spec: WireSpec | undefined, cand: NotifyCandidate, nowMs: number = clockNowMs()): boolean {
  if (cand.plane !== "c2" || !cand.channelIdHex || !spec) return true;
  const communityIdHex = spec.concordCommunityByChannel.get(cand.channelIdHex);
  if (communityIdHex && spec.concordBannedByCommunity.get(communityIdHex)?.has(cand.author)) return false;
  return !postSilenced(spec.concordSilenceByChannel.get(cand.channelIdHex), cand.author, cand.kind, cand.ms ?? cand.createdAt * 1000, nowMs);
}

/** Build notify candidates for a batch of decrypted Concord chat rumors. */
function concordCandidates(
  opened: OpenedChat[],
  channel: Channel,
  communityIdHex: string | undefined,
  self: string | undefined,
  banned: Set<string> | undefined,
  roleMentions?: { held: HeldRoleMention[]; authors: Set<string> },
): NotifyCandidate[] {
  const out: NotifyCandidate[] = [];
  // Tap lands on the message; unknown `communityIdHex` means the hook drops it.
  const room = communityIdHex
    ? ({ kind: "concord", communityId: communityIdHex, channelId: channel.idHex } as const)
    : undefined;
  const pathTo = (messageId: string | undefined) =>
    room ? chatRoute(messageId ? { ...room, messageId } : room) : "";
  for (const r of opened) {
    if (self && r.author === self) continue; // never notify on our own message
    if (banned?.has(r.author)) continue; // a banned member (CORD-04) never notifies
    const pTagsMe = Boolean(self) && r.tags.some(([n, v]) => n === "p" && v === self);

    // Reactions notify ONLY when p-tagging the user (NIP-25 `p` inside the
    // encrypted rumor); other non-message kinds stay silent.
    if (r.kind === KIND_REACTION) {
      // One no row could render is dropped, as the timeline drops it (Vector `is_renderable_reaction`).
      if (!pTagsMe || !isRenderableReaction(r.content)) continue;
      out.push({
        plane: "c2",
        author: r.author,
        createdAt: r.createdAt,
        ms: r.ms,
        mention: true, // a reaction to your message is directed at you
        reaction: true,
        reactionEmoji: reactionContentKey(r.content),
        kind: r.kind,
        roomKey: `c2:${channel.idHex}`,
        readKey: channel.idHex,
        // Link to the reacted-to message (reactions aren't rows).
        path: pathTo(tagValueIn(r.tags, "e")),
        eventId: r.rumorId,
        wrapId: r.wrapId,
        channelIdHex: channel.idHex,
      });
      continue;
    }
    if (r.kind !== KIND_MESSAGE) continue; // edits/deletes don't notify
    out.push({
      plane: "c2",
      author: r.author,
      createdAt: r.createdAt,
      ms: r.ms,
      mention: pTagsMe || Boolean(roleMentions && rolePings(r.content, r.tags, roleMentions.held, roleMentions.authors.has(r.author))),
      kind: r.kind,
      body: preview(r.content),
      content: r.content,
      imetaMime: firstImetaMime(r.tags),
      threadReply: isThreadReply(r.kind, r.tags),
      roomKey: `c2:${channel.idHex}`,
      readKey: channel.idHex, // Concord read map is keyed by channel id hex
      path: pathTo(r.rumorId),
      eventId: r.rumorId,
      wrapId: r.wrapId,
      channelIdHex: channel.idHex,
    });
  }
  return out;
}

/** Notify candidates for a plaintext event (NIP-29 chat or DM); empty if it shouldn't notify. */
function plaintextCandidates(
  ev: NostrEvent,
  spec: WireSpec | undefined,
  self: string | undefined,
  relay: string | undefined,
): NotifyCandidate[] {
  if (self && ev.pubkey === self) return []; // never notify on our own message

  const git = gitCandidates(ev, spec);
  if (git.length) return git;

  // NIP-29 chat / poll / Buzz stream-message v2.
  const h = tagValue(ev, "h");
  if (h) {
    if (ev.kind !== KIND_GROUP_CHAT && ev.kind !== KIND_POLL && ev.kind !== KIND_STREAM_MESSAGE_V2) return [];
    // `h` ids are relay-local, so carry the source relay.
    return [{
      plane: "nip29",
      author: ev.pubkey,
      createdAt: ev.created_at,
      mention: Boolean(self) && ev.tags.some(([n, v]) => n === "p" && v === self),
      kind: ev.kind,
      body: preview(ev.content),
      content: ev.content,
      imetaMime: firstImetaMime(ev.tags),
      threadReply: isThreadReply(ev.kind, ev.tags),
      threadRoot: nip29ThreadRootOf(ev),
      roomKey: "", // filled by the hook once the relay URL is known
      readKey: "", // filled by the hook (needs the relay URL)
      path: "", // ditto — the route names the relay
      eventId: ev.id,
      relayUrl: relay,
      groupId: h,
    }];
  }

  // DM (kind 4): ciphertext, so no body preview.
  if (ev.kind === KIND_DM) {
    const peer = ev.pubkey;
    return [{
      plane: "dm",
      author: peer,
      createdAt: ev.created_at,
      mention: true, // a DM is inherently directed at the user
      kind: KIND_DM,
      roomKey: `dm:${peer}`,
      readKey: `dm:${peer}`,
      path: chatRoute({ kind: "dm", peer, messageId: ev.id }),
      eventId: ev.id,
      peer,
    }];
  }

  return [];
}

/** Route accepted Git activity to every independently-attached C2 channel. */
function gitCandidates(ev: NostrEvent, spec: WireSpec | undefined): NotifyCandidate[] {
  let repository: string | undefined;
  let ticketId: string | undefined;
  let ticketTitle: string | undefined;
  let action: GitNotifyAction | undefined;
  const ticket = parseGitTicket(ev);
  if (ticket?.repositoryAddress) {
    repository = ticket.repositoryAddress.coordinate;
    ticketId = ticket.id;
    ticketTitle = ticket.subject;
    action = ticket.type === "issue" ? "issue" : "pr";
  }
  const comment = parseGitComment(ev);
  if (comment) {
    repository = spec?.gitRootById.get(comment.ticketId);
    ticketId = comment.ticketId;
    action = "comment";
  }
  const status = parseGitStatusEvent(ev);
  if (status) {
    repository = spec?.gitRootById.get(status.ticketId);
    ticketId = status.ticketId;
    // Owners always trusted; other status authors are validated by the timeline, never surfaced here.
    if (!repository || (status.author !== repository.split(":")[1] && status.author !== spec?.gitRootAuthorById.get(status.ticketId))) return [];
    action = "status";
  }
  if (!repository || !action) return [];
  const attachments = spec?.gitByRepository.get(repository) ?? [];
  return attachments
    .filter((item): item is { channelId: string; communityId: string; attachment: import("@/lib/gitActivity").GitRepositoryAttachment } => Boolean(item.communityId) && isGitRepositoryAttachedAt(item.attachment, ev.created_at))
    .map(({ channelId, communityId, attachment }) => ({
      plane: "c2" as const,
      author: ev.pubkey,
      createdAt: ev.created_at,
      mention: false,
      kind: ev.kind,
      roomKey: `c2:${channelId}`,
      readKey: channelId,
      // `?ticket=` opens the ticket pane (git activity isn't a timeline row).
      path: `${chatRoute({ kind: "concord", communityId, channelId })}?ticket=${encodeURIComponent(ticketId ?? ev.id)}`,
      channelIdHex: channelId,
      git: { action, repository: attachment.address.identifier, ticketId, ticketTitle },
      eventId: ev.id,
    }));
}
