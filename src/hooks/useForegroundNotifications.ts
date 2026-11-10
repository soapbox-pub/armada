import { useNostr } from "@nostrify/react";
import { clockNowMs, nowSecs } from "@/lib/relayClock";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAppContext } from "@/hooks/useAppContext";
import { useEventStore } from "@/hooks/useEventStore";
import { useBlossomServers } from "@/hooks/useBlossomServers";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useMediaPolicy } from "@/hooks/useMediaPolicy";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { useNotifLevels, type NotifLevel } from "@/hooks/useNotifLevels";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { parseAuthorEvent, seedAuthorCache, type AuthorResult } from "@/lib/authorCache";
import type { ProfileImeta } from "@/lib/profileImeta";
import { isForegroundNotifyReady } from "@/hooks/useForegroundNotificationSettings";
import { useCommunityList } from "@/concord/hooks/useCommunityList";
import { decryptNotificationIcon } from "@/concord/lib/image";
import { sentDuringMembership } from "@/concord/lib/membershipFloor";
import { FUTURE_HOLD_MS, FUTURE_HORIZON_MS } from "@/concord/lib/stream";
import { isRoomActive } from "@/lib/activeRooms";
import { isDesktop, requestDesktopAttention } from "@/lib/desktop";
import { desktopNotificationTag } from "@/lib/desktopNotificationTag";
import { getDisplayName } from "@/lib/getDisplayName";
import { mediaSrc } from "@/lib/mediaPolicy";
import { backgroundPushActive } from "@/lib/nappPush";
import { queryDm17Conversations } from "@/lib/nip17/dm17Store";
import { dmConvPeers } from "@/lib/nip17/conversation";
import {
  attributedLine,
  mentionPubkeys,
  NOTIFICATION_BADGE_ICON,
  NOTIFICATION_FALLBACK_ICON,
  notificationMessages,
  presentNotification,
  type NotificationMessage,
  type PresentedNotification,
} from "@/lib/notificationPreview";
import { t } from "@/i18n";
import { concordRoomIdentity, nip29RoomIdentity } from "@/lib/notificationRoom";
import {
  loadNotificationSoundSettings,
  playNotificationSound,
} from "@/lib/notificationSounds";
import { isNativeRuntime, normalizeRelayUrl } from "@/lib/platform";
import {
  notificationPolicyIsAuthoritative,
  useNotificationSettingsReady,
} from "@/lib/notificationSettingsAuthority";
import { chatRoute, parseChatRoute } from "@/lib/routes";
import {
  installTabAttentionClearHandlers,
  markTabAttention,
} from "@/lib/tabAttention";
import { PROFILE_FETCH_TIMEOUT_MS } from "@/sw/profileFetch";
import {
  candidateStillRings,
  ingestPushedEvent,
  registerNotifySink,
  wrapOpenedThisSession,
  type NotifyCandidate,
} from "@/wire/notify";
import { useWireNip29Groups } from "@/wire/useWireNip29Groups";

import type { NostrEvent, NostrMetadata } from "@nostrify/nostrify";

/**
 * Client-side notifier while Armada is OPEN (web/desktop; native uses its service). Turns the
 * wire's unread/mention candidates into an OS Notification, an in-app sound and a tab marker.
 * Gates: the resolved notification level (`useNotifLevels`), not the on-screen room, not already
 * read (`useReadState`), and newer than session start and the room's last notification.
 * Intent + OS permission gate only the system Notification; sound and tab marker need neither.
 */

/**
 * Per-room ceiling, mirroring `sw.js`'s `ROOM_ALERT_*` and native `ALERT_BURST_MAX`: past it,
 * notifications post without sound.
 */
const ROOM_ALERT_MAX = 5;
/** Mentions looked up per message, matching the push worker; any beyond keep their raw token. */
const MAX_MENTION_LOOKUPS = 8;
const ROOM_ALERT_WINDOW_MS = 120_000;
const ROOM_ALERT_MAX_TRACKED = 64;
/**
 * How long a page opens a wrap the worker handed it: a signer round trip and
 * the profile lookups, inside the worker's own budget (`PAGE_OPEN_BUDGET_MS`).
 */
export const PUSH_OPEN_WAIT_MS = 4_000;

function levelAdmits(level: NotifLevel, mention: boolean): boolean {
  if (level === "nothing") return false;
  if (level === "mentions") return mention;
  return true; // "all"
}

/**
 * The favicon dot promises something addressed to the viewer: a DM or a mention. Ordinary
 * channel traffic and reactions may still notify per the room's level, but don't badge.
 */
export function callsForTabAttention(
  candidate: Pick<NotifyCandidate, "plane" | "mention" | "reaction">,
): boolean {
  if (candidate.plane === "dm") return true;
  return candidate.mention && !candidate.reaction;
}

/**
 * The page may show an OS notification only after proving there's no background
 * push (a Web Push subscription, or Tenna subscriptions). Fail closed to avoid
 * duplicates.
 */
export async function pageMayShowOsNotification(): Promise<boolean> {
  // Desktop (app://armada) throws SecurityError on service-worker lookups and has no Web Push,
  // so the page always owns presentation there.
  if (isDesktop()) return true;
  if (!("serviceWorker" in navigator)) return true;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return true;
    return !(await backgroundPushActive(registration));
  } catch {
    return false;
  }
}

export interface PageNotificationCoordination {
  allowActivePush?: boolean;
  shouldAbort?: () => boolean;
  onPresenting?: () => void;
}

/**
 * Present via the registration when possible: mobile WebKit rejects the page Notification
 * constructor for installed apps. Registration notifications route clicks through sw.js.
 */
export async function showPageOsNotification(
  title: string,
  options: NotificationOptions,
  coordination: PageNotificationCoordination = {},
): Promise<Notification | null | undefined> {
  const abort = () => coordination.shouldAbort?.() === true;
  let presenting = false;
  const beginPresentation = () => {
    if (presenting) return;
    presenting = true;
    coordination.onPresenting?.();
  };

  if (abort()) return null;
  // Electron's `registration.showNotification()` draws nothing; the page constructor does
  // reach the OS, so desktop takes that path.
  const preferPageConstructor = isDesktop();
  if (!preferPageConstructor && "serviceWorker" in navigator) {
    try {
      const current = await navigator.serviceWorker.getRegistration();
      if (current) {
        // A subscription may have been enabled meanwhile; `null` hands the event to the PushEvent.
        if (!coordination.allowActivePush && await backgroundPushActive(current)) {
          return null;
        }
        const registration = await navigator.serviceWorker.ready;
        if (abort()) return null;
        if (!coordination.allowActivePush && await backgroundPushActive(registration)) {
          return null;
        }
        if (abort()) return null;
        beginPresentation();
        await registration.showNotification(title, options);
        return undefined;
      }
    } catch {
      // One last no-subscription proof before the constructor fallback.
      try {
        const current = await navigator.serviceWorker.getRegistration();
        if (
          !coordination.allowActivePush
          && current
          && await backgroundPushActive(current)
        ) return null;
      } catch {
        return null; // indeterminate ownership: fail closed against duplicates
      }
    }
  }
  if (abort()) return null;
  beginPresentation();
  return new Notification(title, options);
}

function rasterizeFirstFrame(url: string, size = 128): Promise<string | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    // Without CORS `toDataURL` throws on cross-origin images (all avatars, from app://armada).
    img.crossOrigin = "anonymous";
    let settled = false;
    const done = (value?: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return done(undefined);
        ctx.drawImage(img, 0, 0, size, size);
        done(canvas.toDataURL("image/png"));
      } catch {
        done(undefined); // tainted canvas: host sent no CORS headers
      }
    };
    img.onerror = () => done(undefined);
    img.src = url;
    setTimeout(() => done(undefined), 4000);
  });
}

/**
 * libnotify renders an animated GIF icon blank, so flatten a GIF to a static PNG (dropped if
 * CORS blocks it). Non-GIFs pass through.
 */
export async function desktopSafeNotificationIcon(
  icon: string | undefined,
): Promise<string | undefined> {
  if (!icon || !isDesktop()) return icon;
  if (!/^https:\/\//i.test(icon) || !/\.gif(\?|#|$)/i.test(icon)) return icon;
  return await rasterizeFirstFrame(icon);
}

/**
 * Clear the accumulated body of rooms read up to the newest notified message, so the next
 * message starts fresh. Rooms without a read key are untouched.
 */
export function retireSeenRoomLines(
  roomLines: Map<string, string[]>,
  roomReadKeys: Map<string, string>,
  lastNotified: Map<string, number>,
  alertTimes: Map<string, number[]>,
  readState: Record<string, number>,
): void {
  for (const [roomKey, lines] of roomLines) {
    if (lines.length === 0) continue;
    const readKey = roomReadKeys.get(roomKey);
    const lastAt = lastNotified.get(roomKey) ?? 0;
    if (readKey && lastAt > 0 && (readState[readKey] ?? 0) >= lastAt) {
      roomLines.delete(roomKey);
      alertTimes.delete(roomKey);
    }
  }
}

export type PagePushOutcome = "presenting" | "presented" | "suppressed";

interface PagePushState {
  roomKey: string;
  outcome: PagePushOutcome;
}

/** Resolve NIP-29's relay-scoped key before common self/mute/session gates. */
export function foregroundPushRoomKey(
  candidate: Pick<NotifyCandidate, "plane" | "roomKey" | "relayUrl" | "groupId">,
  relayByGroup: ReadonlyMap<string, string>,
): string {
  if (candidate.plane !== "nip29" || !candidate.groupId) return candidate.roomKey;
  const relay = candidate.relayUrl
    ? normalizeRelayUrl(candidate.relayUrl) ?? candidate.relayUrl
    : relayByGroup.get(candidate.groupId);
  return relay ? `h:${relay}|${candidate.groupId}` : candidate.roomKey;
}

/**
 * Whether a candidate dated `createdAt` (seconds) is due: "now", the ms until it
 * is (CORD-03 §3, released inside the tolerance as Vector's `early.rs` does), or
 * "beyond" the horizon, past which it isn't held.
 */
/** At most this many candidates wait on their date at once; past it a flood of future-dated rumors rings nothing. */
export const MAX_HELD_CANDIDATES = 256;

export function futureHold(createdAt: number, nowMs: number): "now" | "beyond" | number {
  const aheadMs = createdAt * 1000 - nowMs;
  if (aheadMs <= FUTURE_HOLD_MS) return "now";
  if (aheadMs > FUTURE_HORIZON_MS) return "beyond";
  return aheadMs - FUTURE_HOLD_MS + 1;
}

export function useForegroundNotifications(): void {
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const durableNotificationSettingsReady = useNotificationSettingsReady(user?.pubkey);
  const notificationSettingsReady = notificationPolicyIsAuthoritative(
    durableNotificationSettingsReady,
    config.automaticSettingsSync,
  );
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const { nostr } = useNostr();

  const { readState } = useReadState();
  const { channelLevel, concordChannelLevel, dmLevel } = useNotifLevels();
  const { isKnown, knownConversationKeys } = useKnownDmPeers();
  const knownConversationSet = useMemo(
    () => new Set(knownConversationKeys),
    [knownConversationKeys],
  );
  const { data: groupList } = useUserGroupList();
  const { mutedPubkeys } = useMutedPubkeys();
  // The OS fetches the icon from the sender-named host, so apply the avatar media policy.
  const mediaPolicy = useMediaPolicy();
  const blossomServers = useBlossomServers();

  // Own ref so the sink sees a fresh mute without re-registering.
  const mutedRef = useRef(mutedPubkeys);
  mutedRef.current = mutedPubkeys;

  // Fallback for legacy candidates without ingest's exact source relay. Duplicate ids across
  // relays are removed rather than guessed.
  const wireGroups = useWireNip29Groups();
  const relayByGroup = useMemo(() => {
    const m = new Map<string, string>();
    const ambiguous = new Set<string>();
    const add = (id: string, rawRelay: string) => {
      const relay = normalizeRelayUrl(rawRelay);
      if (!relay || !id || ambiguous.has(id)) return;
      const held = m.get(id);
      if (held && held !== relay) {
        m.delete(id);
        ambiguous.add(id);
      } else if (!held) {
        m.set(id, relay);
      }
    };
    for (const g of groupList?.groups ?? []) {
      add(g.id, g.relay);
    }
    for (const g of wireGroups) {
      if (g.id && g.relay) add(g.id, g.relay);
    }
    return m;
  }, [groupList, wireGroups]);

  const { data: communityList } = useCommunityList();
  const joinedAtByCommunity = useMemo(
    () => new Map((communityList?.list.entries ?? []).map((e) => [e.community_id, e.added_at])),
    [communityList],
  );

  // Refs so the stable sink reads current values; re-registering drops the wire's reference.
  const ctx = useRef({
    readState,
    channelLevel,
    concordChannelLevel,
    dmLevel,
    isKnown,
    knownConversationSet,
    relayByGroup,
    navigate,
    queryClient,
    eventStore,
    nostr,
    dmRequestPolicy: config.pushPrefs.dmRequests,
    mediaPolicy,
    blossomServers,
    joinedAtByCommunity,
  });
  ctx.current = {
    readState,
    channelLevel,
    concordChannelLevel,
    dmLevel,
    isKnown,
    knownConversationSet,
    relayByGroup,
    navigate,
    queryClient,
    eventStore,
    nostr,
    dmRequestPolicy: config.pushPrefs.dmRequests,
    mediaPolicy,
    blossomServers,
    joinedAtByCommunity,
  };

  // Session floor: a fresh login backfilling history must stay silent.
  const sessionFloor = useRef(nowSecs());
  // Per-room high-water mark so overlapping transports / re-ingests don't double-alert.
  const lastNotified = useRef(new Map<string, number>());
  const notifiedEvents = useRef(new Set<string>());
  // Arbitrate the live page against its PushEvent; session-only and bounded.
  const pagePushStates = useRef(new Map<string, PagePushState>());
  const workerOwnedPushes = useRef(new Map<string, string>());
  const alertTimes = useRef(new Map<string, number[]>());
  const roomLines = useRef(new Map<string, string[]>());
  const roomReadKeys = useRef(new Map<string, string>());

  // Room keys (not flattened participants) are load-bearing for group privacy.
  const mineConversationKeys = useRef(new Set<string>());
  const mineLoading = useRef(false);

  // Retire a room's body once read (here or elsewhere), or the collapsed notification's body
  // only ever grows.
  useEffect(() => {
    retireSeenRoomLines(
      roomLines.current,
      roomReadKeys.current,
      lastNotified.current,
      alertTimes.current,
      readState,
    );
  }, [readState]);

  useEffect(() => {
    if (!user) return;
    // Mounted outside SyncGate: stay silent until the encrypted notification policy (or a
    // relay-backed absence proof) has been applied.
    if (!notificationSettingsReady) return;
    if (isNativeRuntime()) return; // native has its own background service

    const removeTabAttentionHandlers = installTabAttentionClearHandlers();
    let mounted = true;

    const trimExactMap = <T,>(map: Map<string, T>) => {
      if (map.size <= 512) return;
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    };
    const exactState = (eventId: string, roomKey: string) => {
      const state = pagePushStates.current.get(eventId);
      return state?.roomKey === roomKey ? state : undefined;
    };
    const stateForWorkerRequest = (eventId: string, roomKey: string) => {
      const state = pagePushStates.current.get(eventId);
      return !roomKey || state?.roomKey === roomKey ? state : undefined;
    };
    const workerOwns = (eventId: string | undefined, roomKey: string) => (
      Boolean(eventId && roomKey && (
        workerOwnedPushes.current.get(eventId) === roomKey
        || workerOwnedPushes.current.get(eventId) === "*"
      ))
    );
    const recordPushState = (
      eventId: string | undefined,
      roomKey: string,
      outcome: PagePushOutcome,
    ) => {
      if (!eventId || !roomKey) return;
      const prior = exactState(eventId, roomKey);
      // Never downgrade a completed presentation.
      if (prior?.outcome === "presented" && outcome !== "presented") return;
      pagePushStates.current.set(eventId, { roomKey, outcome });
      trimExactMap(pagePushStates.current);
    };
    const clearPresenting = (eventId: string | undefined, roomKey: string) => {
      if (!eventId) return;
      if (exactState(eventId, roomKey)?.outcome === "presenting") {
        pagePushStates.current.delete(eventId);
      }
    };
    const claimForWorker = (eventId: string, roomKey: string) => {
      workerOwnedPushes.current.set(eventId, roomKey);
      trimExactMap(workerOwnedPushes.current);
    };
    // An encrypted candidate is known to the page by its rumor id and to a
    // worker that couldn't open it by its wrap id, so both carry the state.
    const recordCandidateState = (cand: NotifyCandidate, roomKey: string, outcome: PagePushOutcome) => {
      recordPushState(cand.eventId, roomKey, outcome);
      recordPushState(cand.wrapId, roomKey, outcome);
    };
    const clearCandidatePresenting = (cand: NotifyCandidate, roomKey: string) => {
      clearPresenting(cand.eventId, roomKey);
      clearPresenting(cand.wrapId, roomKey);
    };
    const workerOwnsCandidate = (cand: NotifyCandidate, roomKey: string) => (
      workerOwns(cand.eventId, roomKey) || workerOwns(cand.wrapId, roomKey)
    );
    const trimSet = (set: Set<string>) => {
      if (set.size <= 512) return;
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    };
    // Wraps a worker that couldn't open them handed here, and wraps that
    // reached the sink as a candidate.
    const handedPushes = new Set<string>();
    const candidateWraps = new Set<string>();

    /**
     * A worker without the signer hands the page the wrap it can't open. The
     * page runs it through its own ingest and answers with what its notifier
     * did, so the worker shows its generic text only when no page could open it.
     */
    const answerPushOpen = (event: MessageEvent) => {
      if (event.data?.type !== "armada-push-open") return;
      const port = event.ports[0];
      const eventId = typeof event.data.eventId === "string" ? event.data.eventId : "";
      const pushed = event.data.event as NostrEvent | undefined;
      if (!port || !eventId) return;

      handedPushes.add(eventId);
      trimSet(handedPushes);
      void (async () => {
        const reply = (roomKey: string, outcome: string) => port.postMessage({ eventId, roomKey, outcome });
        if (pushed && typeof pushed === "object" && pushed.id === eventId) void ingestPushedEvent(pushed);
        const deadline = Date.now() + PUSH_OPEN_WAIT_MS;
        while (mounted) {
          const state = stateForWorkerRequest(eventId, "");
          if (state && state.outcome !== "presenting") return reply(state.roomKey, state.outcome);
          // Opened with nothing to notify (a self-copy, an edit, a reaction to someone else).
          if (!state && !candidateWraps.has(eventId) && wrapOpenedThisSession(eventId)) {
            return reply("*", "suppressed");
          }
          if (Date.now() >= deadline) {
            return reply(state?.roomKey ?? "", state?.outcome ?? "unhandled");
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      })();
    };
    navigator.serviceWorker?.addEventListener("message", answerPushOpen);

    const answerPushPresentationQuery = (event: MessageEvent) => {
      if (event.data?.type !== "armada-push-presentation-query") return;
      const port = event.ports[0];
      const eventId = typeof event.data.eventId === "string" ? event.data.eventId : "";
      const roomKey = typeof event.data.roomKey === "string" ? event.data.roomKey : "";
      if (!port || !eventId) return;

      void (async () => {
        // Let a running live candidate finish; the worker claims explicitly if unhandled.
        for (let i = 0; i < 8; i++) {
          const state = stateForWorkerRequest(eventId, roomKey);
          if (state && state.outcome !== "presenting") {
            port.postMessage({ eventId, roomKey: state.roomKey, outcome: state.outcome });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (!mounted) return;
        }
        const pending = stateForWorkerRequest(eventId, roomKey);
        port.postMessage({
          eventId,
          roomKey: pending?.roomKey ?? roomKey,
          outcome: pending?.outcome ?? "unhandled",
        });
      })();
    };
    navigator.serviceWorker?.addEventListener("message", answerPushPresentationQuery);

    const answerWorkerClaim = (event: MessageEvent) => {
      if (event.data?.type !== "armada-push-worker-claim") return;
      const port = event.ports[0];
      const eventId = typeof event.data.eventId === "string" ? event.data.eventId : "";
      const roomKey = typeof event.data.roomKey === "string" ? event.data.roomKey : "";
      if (!port || !eventId) return;

      void (async () => {
        // Let an already-issued page presentation settle before the claim wins.
        for (let i = 0; i < 12; i++) {
          const state = stateForWorkerRequest(eventId, roomKey);
          if (!state || state.outcome !== "presenting") break;
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (!mounted) return;
        }
        const state = stateForWorkerRequest(eventId, roomKey);
        if (state) {
          port.postMessage({ eventId, roomKey: state.roomKey, outcome: state.outcome });
          return;
        }
        // Wildcard claim when the worker couldn't resolve a NIP-29 room; the event id is exact.
        claimForWorker(eventId, roomKey || "*");
        port.postMessage({ eventId, roomKey, outcome: "worker" });
      })();
    };
    navigator.serviceWorker?.addEventListener("message", answerWorkerClaim);

    // Local reads only (author cache, then event store kind-0), so a missing profile never
    // delays the notification. No profile → "Anonymous", matching Android and `getDisplayName`.
    const profileFor = async (pubkey: string): Promise<{ name: string; named: boolean; avatar?: string }> => {
      const present = (metadata: NostrMetadata | undefined, imeta?: ProfileImeta) => ({
        name: getDisplayName(metadata, pubkey),
        named: !!(metadata?.name || metadata?.display_name),
        // https only (http is a failing mixed-content fetch), then the media policy. An
        // encrypted picture can't be an OS icon: its URL is ciphertext.
        avatar: mediaSrc(
          typeof metadata?.picture === "string" && /^https:\/\//.test(metadata.picture) && !imeta?.picture?.encryption
            ? metadata.picture
            : undefined,
          ctx.current.mediaPolicy,
        ),
      });

      if (!pubkey) return { name: getDisplayName(undefined), named: false };
      const qc = ctx.current.queryClient;
      const cached = qc.getQueryData<AuthorResult>(["author", pubkey]);
      if (cached?.metadata) return present(cached.metadata, cached.imeta);
      if (cached?.event) {
        const parsed = parseAuthorEvent(cached.event);
        return present(parsed.metadata, parsed.imeta);
      }

      // Local event store fallback (no network).
      try {
        const store = await ctx.current.eventStore;
        const [ev] = await store.query([{ kinds: [0], authors: [pubkey], limit: 1 }]);
        if (ev) {
          const parsed = parseAuthorEvent(ev);
          seedAuthorCache(qc, pubkey, ev);
          if (parsed.metadata) return present(parsed.metadata, parsed.imeta);
        }
      } catch {
        // Store unavailable — fall through.
      }

      return { name: getDisplayName(undefined), named: false };
    };

    /** Room title and icon, matching the Android conversation shortcut. Local reads only. */
    const roomIdentityFor = async (
      cand: NotifyCandidate,
      relayUrl: string | undefined,
      communityId: string | undefined,
    ): Promise<{ title?: string; image?: string }> => {
      try {
        if (cand.plane === "nip29") {
          if (!relayUrl || !cand.groupId) return {};
          const room = await nip29RoomIdentity(relayUrl, cand.groupId);
          // A kind-39000 `picture` is the relay operator's URL: policed like an avatar.
          return { title: room.title, image: mediaSrc(room.iconUrl, ctx.current.mediaPolicy) };
        }
        if (cand.plane === "c2") {
          if (!communityId || !cand.channelIdHex) return {};
          const room = await concordRoomIdentity(communityId, cand.channelIdHex);
          // Encrypted blob, usually a warm Cache Storage hit. A `data:` URL, since a
          // native host (Tenna) draws the notification and can't read a `blob:`.
          const image = room.iconPointer
            ? await decryptNotificationIcon(room.iconPointer, ctx.current.blossomServers, ctx.current.mediaPolicy)
            : undefined;
          return { title: room.title, image };
        }
      } catch {
        // Never let room decoration cost the notification itself.
      }
      return {};
    };

    // Unlike the sender, a mentioned user is often someone this device has never
    // shown (a newcomer being welcomed), so a local miss gets one short relay lookup,
    // bounded as in the push worker.
    const mentionNamesFor = async (content: string | undefined): Promise<Map<string, string>> => {
      const names = new Map<string, string>();
      if (!content) return names;
      const keys = mentionPubkeys(content).slice(0, MAX_MENTION_LOOKUPS);
      if (keys.length === 0) return names;
      const missing: string[] = [];
      await Promise.all(keys.map(async (pk) => {
        const { name, named } = await profileFor(pk);
        // "Anonymous" is an absence; the raw token means more.
        if (named) names.set(pk, name);
        else missing.push(pk);
      }));
      if (missing.length === 0) return names;

      try {
        const fetched = await ctx.current.nostr.query(
          [{ kinds: [0], authors: missing, limit: missing.length }],
          { signal: AbortSignal.timeout(PROFILE_FETCH_TIMEOUT_MS) },
        );
        const newest = new Map<string, NostrEvent>();
        for (const ev of fetched) {
          const prev = newest.get(ev.pubkey);
          if (missing.includes(ev.pubkey) && (!prev || ev.created_at > prev.created_at)) newest.set(ev.pubkey, ev);
        }
        const store = await ctx.current.eventStore;
        for (const [pk, ev] of newest) {
          seedAuthorCache(ctx.current.queryClient, pk, ev);
          void store.event(ev).catch(() => undefined);
          const { metadata } = parseAuthorEvent(ev);
          if (metadata?.name || metadata?.display_name) names.set(pk, getDisplayName(metadata, pk));
        }
      } catch {
        // Timed out or no relays: unresolved mentions keep their raw token.
      }
      return names;
    };

    /**
     * Past the ceiling, still shown but silent. Records every attempt so a sustained flood stays
     * quiet until it stops.
     */
    const roomAlertSilent = (roomKey: string): boolean => {
      const now = Date.now();
      const times = (alertTimes.current.get(roomKey) ?? [])
        .filter((t) => now - t <= ROOM_ALERT_WINDOW_MS);
      const silent = times.length >= ROOM_ALERT_MAX;
      times.push(now);
      alertTimes.current.set(
        roomKey,
        times.length > ROOM_ALERT_MAX_TRACKED ? times.slice(-ROOM_ALERT_MAX_TRACKED) : times,
      );
      return silent;
    };

    const appendRoomLine = (roomKey: string, line: string): string[] => {
      const lines = [...(roomLines.current.get(roomKey) ?? []).slice(-4), line];
      roomLines.current.set(roomKey, lines);
      return lines;
    };

    // Reload rooms the viewer authored in, on mount and when an unknown DM arrives (they may have
    // replied since; `acceptedDms` is only written from the compose pane).
    const refreshMineConversationKeys = () => {
      if (mineLoading.current) return;
      mineLoading.current = true;
      void (async () => {
        try {
          const rows = await queryDm17Conversations(user.pubkey);
          // A written group makes that conversation known, not each member in unrelated 1:1s.
          mineConversationKeys.current = new Set(
            rows.filter((row) => row.mine).map((row) => row.key),
          );
        } catch {
          // Store unavailable — follows ∪ accepted ∪ pinned still apply.
        } finally {
          mineLoading.current = false;
        }
      })();
    };
    refreshMineConversationKeys();

    // Candidates dated ahead, re-judged once due as if they arrived then (CORD-03 §3).
    const heldTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const onCandidates = (candidates: NotifyCandidate[]) => {
      const canShowOsNotification = isForegroundNotifyReady();
      const soundSettings = loadNotificationSoundSettings();
      let playedSound = false;
      // One ownership proof per batch. The in-app sound is NOT gated on it (OS notifications are
      // always `silent: true`).
      let pageOwnership: Promise<boolean> | undefined;
      const pageOwnsPresentation = () => (
        pageOwnership ??= pageMayShowOsNotification()
      );

      const c = ctx.current;

      for (const cand of candidates) {
        const initialRoomKey = foregroundPushRoomKey(cand, c.relayByGroup);
        const suppress = (key: string) => recordCandidateState(cand, key, "suppressed");
        if (cand.wrapId) {
          candidateWraps.add(cand.wrapId);
          trimSet(candidateWraps);
        }
        if (cand.createdAt <= sessionFloor.current) {
          suppress(initialRoomKey);
          continue;
        }
        // Hold future-dated candidates like the timeline does (FUTURE_HOLD_MS), within the horizon.
        const hold = futureHold(cand.createdAt, clockNowMs());
        if (hold !== "now") {
          suppress(initialRoomKey);
          const key = cand.eventId ?? cand.wrapId;
          if (key && hold !== "beyond" && !heldTimers.has(key) && heldTimers.size < MAX_HELD_CANDIDATES) {
            heldTimers.set(key, setTimeout(() => {
              heldTimers.delete(key);
              // A ban or Timeout since it arrived silences it.
              if (mounted && candidateStillRings(cand)) onCandidates([cand]);
            }, hold));
          }
          continue;
        }
        // Belt-and-braces: ingest normally drops self-authored events.
        if (cand.author && cand.author === user.pubkey) {
          suppress(initialRoomKey);
          continue;
        }
        // A muted person must not raise any cue.
        if (cand.author && mutedRef.current.has(cand.author)) {
          suppress(initialRoomKey);
          continue;
        }

        let roomKey = initialRoomKey;
        let readKey = cand.readKey;
        let path = cand.path;
        let level: NotifLevel;
        // Unknown DM sender under the "generic" request policy: cue but show nothing they control.
        let dmGeneric = false;
        let relayUrl: string | undefined;
        let communityId: string | undefined;

        if (cand.plane === "nip29") {
          const relay = cand.relayUrl
            ? normalizeRelayUrl(cand.relayUrl) ?? cand.relayUrl
            : cand.groupId ? c.relayByGroup.get(cand.groupId) : undefined;
          if (!relay || !cand.groupId) {
            suppress(initialRoomKey);
            continue; // not a group we're in
          }
          relayUrl = relay;
          roomKey = `h:${relay}|${cand.groupId}`;
          readKey = channelReadKey(relay, cand.groupId);
          path = chatRoute({
            kind: "nip29",
            relayUrl: relay,
            groupId: cand.groupId,
            threadRoot: cand.threadRoot,
            messageId: cand.eventId,
          });
          level = c.channelLevel(relay, cand.groupId);
        } else if (cand.plane === "dm") {
          // Match the DM list: a group with any muted participant is hidden.
          if (cand.peer && dmConvPeers(cand.peer).some((peer) => mutedRef.current.has(peer))) {
            suppress(roomKey);
            continue;
          }
          level = cand.peer ? c.dmLevel(cand.peer) : "all";
          // Unknown senders control text, name and avatar: apply the request policy ("off" silent,
          // "generic" content-free, "full" normal).
          const conversationKnown = cand.peer
            ? c.knownConversationSet.has(cand.peer)
              || mineConversationKeys.current.has(cand.peer)
              || dmConvPeers(cand.peer).every((peer) => c.isKnown(peer, false))
            : true;
          if (cand.peer && !conversationKnown) {
            // The viewer may have written to them since the set was loaded.
            refreshMineConversationKeys();
            const policy = c.dmRequestPolicy;
            if (policy === "off") {
              suppress(roomKey);
              continue;
            }
            if (policy !== "full") dmGeneric = true;
          }
        } else {
          if (!path) {
            suppress(roomKey);
            continue; // couldn't resolve the community route
          }
          // Parsed (not split): the route may carry `/m/<id>`; git candidates carry `?ticket=`.
          const parsed = parseChatRoute(path.split("?")[0]);
          communityId = parsed?.kind === "concord" ? parsed.communityId : "";
          // Nothing from before this membership began: the viewer wasn't there.
          if (communityId && !sentDuringMembership(cand.createdAt * 1000, c.joinedAtByCommunity.get(communityId))) {
            suppress(roomKey);
            continue;
          }
          level =
            communityId && cand.channelIdHex
              ? c.concordChannelLevel("c2", communityId, cand.channelIdHex)
              : "all";
        }

        if (!levelAdmits(level, cand.mention)) {
          suppress(roomKey);
          continue;
        }

        if (readKey && (c.readState[readKey] ?? 0) >= cand.createdAt) {
          suppress(roomKey);
          continue;
        }

        // Only while the Armada window is focused on this room.
        if (isRoomActive(roomKey)) {
          suppress(roomKey);
          continue;
        }

        const eventKey = cand.eventId ? `${roomKey}:${cand.eventId}` : "";
        if (eventKey && notifiedEvents.current.has(eventKey)) {
          suppress(roomKey);
          continue;
        }
        const mark = lastNotified.current.get(roomKey) ?? 0;
        // Legacy candidates lack an event id, so dedupe by timestamp; git events have source ids.
        if (!eventKey && cand.createdAt <= mark) {
          suppress(roomKey);
          continue;
        }
        lastNotified.current.set(roomKey, cand.createdAt);
        if (eventKey) notifiedEvents.current.add(eventKey);
        // Lets a read clear the accumulated body.
        if (readKey) roomReadKeys.current.set(roomKey, readKey);

        // Content-blind rate limiting: anyone with the invite can flood a channel.
        const silent = roomAlertSilent(roomKey);

        // Page-owned cues need no permission; one sound per batch. The favicon badge is idempotent.
        if (callsForTabAttention(cand)) markTabAttention();

        // Play the sound here at ingest, not after the presentation handoff: the worker can't play
        // audio and OS notifications are always silent.
        if (soundSettings.enabled && !playedSound && !silent) {
          playNotificationSound({ settings: soundSettings });
          playedSound = true;
        }

        const canCoordinateExactEvent = () => Boolean(
          cand.eventId
          && roomKey
          && document.visibilityState === "visible"
          && document.hasFocus(),
        );

        // The worker asked this page to present it, whatever the page's focus.
        const handed = Boolean(cand.wrapId && handedPushes.has(cand.wrapId));

        if (!canShowOsNotification) continue;

        // Errors are swallowed so one bad event never breaks the batch.
        void (async () => {
          // A visible page may cover a missing PushEvent only for exact events the worker can arbitrate.
          if (!handed && !canCoordinateExactEvent() && !(await pageOwnsPresentation())) return;
          if (workerOwnsCandidate(cand, roomKey)) return;
          // Composing is deferred past the last active-room check so an unshown notification leaves no
          // line in the room body.
          let presented: PresentedNotification | undefined;
          let message: NotificationMessage | undefined;
          let notificationLines: string[] | undefined;

          if (cand.plane === "dm" && dmGeneric) {
            // Content-blind: nothing the sender controls (name/avatar/text).
            presented = {
              title: t(notificationMessages.messageRequest),
              body: t(notificationMessages.newMessageRequest, { count: 1 }),
              icon: NOTIFICATION_FALLBACK_ICON,
              badge: NOTIFICATION_BADGE_ICON,
            };
          } else if (cand.git) {
            // Repository activity keeps its own shape rather than going through the presenter.
            const { name, avatar } = await profileFor(cand.author);
            presented = {
              title: t(notificationMessages.gitActivity, { name, action: cand.git.action, repository: cand.git.repository }),
              body: cand.git.ticketTitle ?? t(notificationMessages.gitActivityFallback),
              icon: avatar ?? NOTIFICATION_FALLBACK_ICON,
              badge: NOTIFICATION_BADGE_ICON,
            };
          } else {
            const [{ name, avatar }, room, mentionNames] = await Promise.all([
              profileFor(cand.author),
              roomIdentityFor(cand, relayUrl, communityId),
              mentionNamesFor(cand.content),
            ]);
            message = {
              plane: cand.plane,
              kind: cand.kind,
              // `body` is truncated; `content` is the raw text the preview pipeline needs.
              content: cand.content ?? cand.body ?? "",
              authorName: cand.authorNickname || name,
              authorAvatar: avatar,
              roomTitle: room.title,
              roomImage: room.image,
              mention: cand.mention,
              reaction: cand.reaction,
              threadReply: cand.threadReply,
              imetaMime: cand.imetaMime,
              mentionNames,
            };
          }

          try {
            // Re-check: the user may have focused the conversation during profile resolution.
            if (cand.author === user.pubkey || isRoomActive(roomKey)) {
              suppress(roomKey);
              return;
            }
            // Accumulate lines so a busy room reads as a thread (like native MessagingStyle).
            if (message) {
              notificationLines = appendRoomLine(roomKey, attributedLine(message));
              presented = presentNotification(
                message,
                notificationLines,
              );
            }
            if (!presented) return;
            // libnotify draws animated GIF icons blank.
            const icon = await desktopSafeNotificationIcon(presented.icon);
            const allowActivePush = handed || canCoordinateExactEvent();
            const n = await showPageOsNotification(presented.title, {
              body: presented.body,
              icon,
              badge: presented.badge,
              // Armada plays its own sound; avoid the browser's default tone.
              silent: true,
              // Tag by room to collapse repeats. Desktop digests it: the raw key overflows Windows'
              // toast tag limit (desktopNotificationTag.ts).
              tag: isDesktop() ? desktopNotificationTag(roomKey) : roomKey || "armada",
              // sw.js handles registration notification clicks, so carry the SPA route.
              data: { url: path || "/", lines: notificationLines },
            }, {
              allowActivePush,
              shouldAbort: () => (
                workerOwnsCandidate(cand, roomKey)
                || (allowActivePush && !handed && !canCoordinateExactEvent())
              ),
              onPresenting: () => recordCandidateState(cand, roomKey, "presenting"),
            });
            if (n === null) {
              clearCandidatePresenting(cand, roomKey);
              return;
            }
            recordCandidateState(cand, roomKey, "presented");
            if (n) {
              n.onclick = () => {
                window.focus();
                if (path) c.navigate(path);
                n.close();
              };
              // A toast Windows refuses surfaces only here; log it.
              n.onerror = () => {
                console.warn("[notify] OS refused the notification", { roomKey, title: n.title });
              };
              // Taskbar flash on desktop; no-op on the web and when focused.
              if (isDesktop()) requestDesktopAttention();
            }
          } catch {
            clearCandidatePresenting(cand, roomKey);
            // Permission may have changed after the initial gate.
          }
        })();
      }
    };
    const unregister = registerNotifySink(onCandidates);

    return () => {
      mounted = false;
      for (const t of heldTimers.values()) clearTimeout(t);
      unregister();
      removeTabAttentionHandlers();
      navigator.serviceWorker?.removeEventListener("message", answerPushPresentationQuery);
      navigator.serviceWorker?.removeEventListener("message", answerWorkerClaim);
      navigator.serviceWorker?.removeEventListener("message", answerPushOpen);
    };
  }, [user, notificationSettingsReady]);
}
