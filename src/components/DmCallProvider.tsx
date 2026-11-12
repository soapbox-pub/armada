import { useNostr } from "@nostrify/react";
import { Phone, PhoneOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { DmAvatar } from "@/components/DmAvatar";
import { DisplayName } from "@/components/DisplayName";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { useAppContext } from "@/hooks/useAppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { useVoiceActivity } from "@/hooks/useVoiceActivity";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useToast } from "@/hooks/useToast";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { DmCallContext, type DmCallState } from "@/contexts/DmCallContext";
import { inviteDeliveryRelays, recipientInboxRelays } from "@/concord/lib/inviteRelays";
import { ownAvServers } from "@/concord/hooks/useVoice";
import { canonicalOrigin, probeAvBroker } from "@/concord/lib/voice";
import { registerBeforeAccountExit } from "@/lib/beforeAccountExit";
import { signerNeedsApproval } from "@/lib/bulkDecryptGate";
import {
  consumeNativeCallAnswer,
  dismissNativeCallRing,
  peekNativeCallRing,
  setNativeCallPeer,
  type NativeCallAnswer,
} from "@/lib/nativeNotifications";
import {
  startIncomingRing,
  startRingback,
  stopIncomingRing,
  stopRingback,
} from "@/lib/callSounds";
import {
  DM_CALL_COLLISION_FALLBACK_MS,
  DM_CALL_RING_MS,
  deliverDmCallRumors,
  dmCallCollisionWinner,
  dmCallKeys,
  dmCallTags,
  isDmOfferFresh,
  mintDmCall,
  subscribeDmCallSignals,
  type DmCallPhase,
  type DmCallSignal,
} from "@/lib/dmCall";
import { getDisplayName } from "@/lib/getDisplayName";
import { FormattedMessage, t, useIntl } from "@/i18n";
import {
  buildDmRumor,
  KIND_DM_CALL,
  KIND_DM_WRAP_EPHEMERAL,
  sealDmRumor,
  wrapDmSealEphemeral,
  type Dm17Signer,
} from "@/lib/nip17/protocol";
import { openDmEphemeral } from "@/lib/nip17/ephemeralInbox";
import { hasNativeNotificationService, RESCUE_RELAYS } from "@/lib/platform";

import type { DmVoiceContext } from "@/contexts/CallContext";
import type { NostrEvent } from "@nostrify/nostrify";
import { clockNowMs, nowSecs } from "@/lib/relayClock";

/** Minimum gap between two receipts to one peer, so a burst of offers can't farm signatures. */
const RECEIPT_PEER_INTERVAL_MS = 3_000;
const RECEIPT_MEMORY = 256;
/** How often a live DM call re-reports its peer to the Android service. */
const CALL_PEER_HEARTBEAT_MS = 20_000;
/** sessionStorage key for the call ids this tab minted (room names, not secrets). */
const OWN_CALL_IDS_KEY = "armada:dm-call-own-ids";
const OWN_CALL_IDS_MEMORY = 32;

function readOwnCallIds(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(OWN_CALL_IDS_KEY) ?? "[]");
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function rememberOwnCallId(ids: Set<string>, callId: string): void {
  ids.add(callId);
  while (ids.size > OWN_CALL_IDS_MEMORY) ids.delete(ids.values().next().value!);
  try {
    sessionStorage.setItem(OWN_CALL_IDS_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage unavailable: only a reload forgets.
  }
}

/**
 * DM call signaling (wire scheme in `src/lib/dmCall.ts`).
 *
 * - Incoming offers ring only for KNOWN DM peers (`useKnownDmPeers`, muted
 *   excluded): the author controls name/avatar, so strangers must not be able
 *   to ring the phone. Their offers are dropped silently.
 * - Receipts ("ringing"/"busy") are auto-signed, so only nsec logins send them
 *   (never NIP-07/NIP-46, which may prompt), deduped per call id and rate-limited per peer.
 * - Busy is sent only from a DM call; a voice channel isn't busy, since "busy"
 *   would end the ring on all our other devices.
 * - Collisions (both dialing) settle via `dmCallCollisionWinner`: the loser
 *   joins the winner's room; the winner falls back to the loser's call if no
 *   answer/ringing arrives within {@link DM_CALL_COLLISION_FALLBACK_MS}.
 * - "end" is both cancel and hangup, so a 1:1 call ends when either leaves.
 *
 * Must be mounted inside CallProvider and the router (Android's ring deep-links
 * `/dm/<peer>?call=<id>`; the URL names a call and authorizes nothing).
 */
export function DmCallProvider({ children }: { children: React.ReactNode }) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { relays: publishedRelays } = useDmRelayList();
  const { knownPeers } = useKnownDmPeers();
  const { activeCall, joinDmCall, leaveCall } = useCall();
  const { voiceRoomPubkeys } = useVoiceActivity();
  const { toast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();

  const [incoming, setIncoming] = useState<DmCallSignal | null>(null);
  /**
   * The outgoing attempt, set when its call id is minted (BEFORE the offer is
   * out, so a crossing peer offer is recognised). `reached`: a peer device
   * reported ringing/answer. `collided`: the peer's losing offer, held for the
   * fallback. `sent`: our offer reached a relay (starts the fallback clock).
   */
  const outgoingRef = useRef<
    {
      callId: string;
      peer: string;
      answered: boolean;
      reached: boolean;
      sent: boolean;
      collided?: DmCallSignal;
    } | null
  >(null);
  const ringTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collisionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dialingPeer, setDialingPeer] = useState<string | null>(null);
  /** Call ids this device minted, so our offer's self copy isn't read as a sibling's. Persisted across reloads. */
  const ownCallIdsRef = useRef<Set<string> | null>(null);
  ownCallIdsRef.current ??= readOwnCallIds();
  const dismissedCallIdsRef = useRef(new Set<string>());
  const dismissedAtRef = useRef(new Map<string, number>());
  /** An offer another device of ours just placed: it owns any collision with that peer, so we don't ring. */
  const siblingDialRef = useRef<{ peer: string; callId: string; createdAtMs: number } | null>(null);
  const receiptCallIdsRef = useRef(new Set<string>());
  const receiptAtRef = useRef(new Map<string, number>());
  const incomingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live refs so the lifetime signal subscription reads current state.
  const incomingRef = useRef(incoming);
  incomingRef.current = incoming;
  const activeCallRef = useRef(activeCall);
  activeCallRef.current = activeCall;
  const userRef = useRef(user);
  userRef.current = user;
  // Same known-peer set as the inbox/request split, so the ring gate agrees with
  // where the conversation lands. Android mirrors it (`dmKnownPeers`).
  const knownPeersRef = useRef<readonly string[]>([]);
  knownPeersRef.current = knownPeers;

  // `dmsDisabled` collapses this to empty, so no call-signal subscription is held.
  const myRelays = useMemo(
    () =>
      config.dmsDisabled
        ? []
        : [...new Set([...effectiveDmRelays(config), ...publishedRelays])],
    [config, publishedRelays],
  );
  const myRelaysRef = useRef(myRelays);
  myRelaysRef.current = myRelays;

  // STOCK floor (mirrors inviteRelays.ts): a user with app relays off AND no
  // kind-10050 inbox has no rendezvous, so both caller and scanner fall back to
  // the stock set. Tightly gated so private-floor users never REQ their `#p` publicly.
  const scanRelays = useMemo(() => {
    if (myRelays.length === 0) return [];
    const stockFloor = !config.useAppRelays && publishedRelays.length === 0 ? RESCUE_RELAYS : [];
    return [...new Set([...myRelays, ...stockFloor])];
  }, [myRelays, config.useAppRelays, publishedRelays]);
  const scanRelaysRef = useRef(scanRelays);
  scanRelaysRef.current = scanRelays;

  const clearIncoming = useCallback(() => {
    if (incomingTimeoutRef.current) {
      clearTimeout(incomingTimeoutRef.current);
      incomingTimeoutRef.current = null;
    }
    stopIncomingRing();
    setIncoming(null);
  }, []);

  /** Show the incoming-call overlay for a vetted offer until its ring window closes. */
  const ringIncoming = useCallback(
    (signal: DmCallSignal) => {
      // Set ahead of the render so a second delivery of the same call sees it.
      incomingRef.current = signal;
      setIncoming(signal);
      if (incomingTimeoutRef.current) clearTimeout(incomingTimeoutRef.current);
      incomingTimeoutRef.current = setTimeout(() => {
        clearIncoming();
      }, Math.max(0, signal.createdAtMs + DM_CALL_RING_MS - clockNowMs()));
    },
    [clearIncoming],
  );

  // Hidden on Android, the tray rings alone: a ring here would outlast a decline
  // or end there. On screen, this ring takes over.
  const incomingCallId = incoming?.callId;
  useEffect(() => {
    if (!incomingCallId) return;
    let ours = false;
    const sync = () => {
      if (ours) return;
      if (document.visibilityState === "visible") {
        dismissNativeCallRing(incomingCallId);
      } else if (hasNativeNotificationService()) {
        return;
      }
      ours = true;
      startIncomingRing();
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      stopIncomingRing();
    };
  }, [incomingCallId]);

  /**
   * Seal + publish a call rumor in an EPHEMERAL (21059) wrap to the peer's
   * inbox (or STOCK floor) ∪ our DM relays, plus a best-effort self copy for our
   * other devices. Receipts skip the self copy; `selfOnly` skips the peer.
   * Resolves true when a relay accepted the peer's copy.
   */
  const sendSignal = useCallback(
    async (
      phase: DmCallPhase,
      peer: string,
      callId: string,
      extras?: { secretHex?: string; broker?: string; selfOnly?: boolean },
    ): Promise<boolean> => {
      const selfCopy = phase !== "ringing" && phase !== "busy";
      if (!user?.signer.nip44) return false;
      const signer = user.signer as unknown as Dm17Signer;
      const rumor = buildDmRumor({
        kind: KIND_DM_CALL,
        content: phase,
        tags: dmCallTags(peer, callId, extras),
        pubkey: user.pubkey,
      });
      let delivered = true;
      if (!extras?.selfOnly) {
        // A failed lookup (`null`) is NOT "no inbox"; only `[]` falls back to the stock set.
        const inbox = await recipientInboxRelays(nostr, peer).catch(() => null);
        const floor = inbox === null ? [] : inviteDeliveryRelays(inbox);
        const targets = [...new Set([...floor, ...myRelaysRef.current])];
        if (targets.length === 0) return false;
        const wrap = await wrapDmSealEphemeral(await sealDmRumor(rumor, peer, signer), peer);
        const results = await Promise.allSettled(
          targets.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
        );
        delivered = results.some((r) => r.status === "fulfilled");
      }
      // Self copy goes to our SCAN set. "answer"/"decline" stop other devices'
      // rings and an ephemeral broadcast is lost on a socket blip, so re-send them
      // a few times verbatim (siblings dedupe by rumor id).
      if (selfCopy) void (async () => {
        try {
          const selfWrap = await wrapDmSealEphemeral(
            await sealDmRumor(rumor, user.pubkey, signer),
            user.pubkey,
          );
          const broadcastSelf = () =>
            Promise.allSettled(
              scanRelaysRef.current.map((url) =>
                nostr.relay(url).event(selfWrap, { signal: AbortSignal.timeout(8000) }),
              ),
            );
          await broadcastSelf();
          if (phase === "answer" || phase === "decline") {
            for (const delay of [1500, 4000]) {
              await new Promise((resolve) => setTimeout(resolve, delay));
              await broadcastSelf();
            }
          }
        } catch { /* ignore */ }
      })();
      return delivered;
    },
    [nostr, user],
  );

  // Call rumors ride ephemeral wraps, so nothing arrives via inbox sync: hold a
  // standing 21059 subscription. Typing signals share the filter and are discarded,
  // opened once with the typing listener (`openDmEphemeral`).
  const scanRelaysKey = scanRelays.join(",");
  useEffect(() => {
    const self = user?.pubkey;
    if (!self || !user?.signer.nip44 || scanRelays.length === 0) return;
    const controller = new AbortController();
    const signer = user.signer as unknown as Dm17Signer;
    for (const url of scanRelays) {
      void (async () => {
        try {
          for await (const msg of nostr.relay(url).req(
            [{ kinds: [KIND_DM_WRAP_EPHEMERAL], "#p": [self], since: nowSecs() }],
            { signal: controller.signal },
          )) {
            if (msg[0] !== "EVENT") continue;
            void (async () => {
              const opened = await openDmEphemeral(msg[2] as NostrEvent, signer, self);
              if (opened && opened.kind === KIND_DM_CALL) deliverDmCallRumors([opened]);
            })();
          }
        } catch (err) {
          if (!controller.signal.aborted) {
            console.warn(`[dm-call] subscription to ${url} ended:`, err);
          }
        }
      })();
    }
    return () => controller.abort();
    // Keyed on the pubkey (the signer is stable per login), like useDmTyping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, user?.pubkey, scanRelaysKey]);

  const clearOutgoing = useCallback(() => {
    if (ringTimeoutRef.current) {
      clearTimeout(ringTimeoutRef.current);
      ringTimeoutRef.current = null;
    }
    if (collisionTimerRef.current) {
      clearTimeout(collisionTimerRef.current);
      collisionTimerRef.current = null;
    }
    stopRingback();
    outgoingRef.current = null;
    setDialingPeer(null);
  }, []);

  /** End our attempt in favour of the peer's colliding offer if still live. True when it did. */
  const yieldToCollided = useCallback((): boolean => {
    const theirs = outgoingRef.current?.collided;
    if (!theirs || !isDmOfferFresh(theirs)) return false;
    clearOutgoing();
    joinOfferRef.current(theirs);
    return true;
  }, [clearOutgoing]);

  /**
   * Start the collision fallback clock once BOTH our offer is delivered and the
   * loser's offer is in hand. Starting earlier could have the loser land in our
   * room just as we left for theirs, each "end" hanging up the other.
   */
  const armCollisionFallback = useCallback(
    (callId: string) => {
      const out = outgoingRef.current;
      if (!out || out.callId !== callId || !out.sent || !out.collided) return;
      if (collisionTimerRef.current) return;
      collisionTimerRef.current = setTimeout(() => {
        collisionTimerRef.current = null;
        const now = outgoingRef.current;
        if (!now || now.callId !== callId || now.answered || now.reached) return;
        yieldToCollided();
      }, DM_CALL_COLLISION_FALLBACK_MS);
    },
    [yieldToCollided],
  );

  const cancelCollisionFallback = useCallback(() => {
    if (collisionTimerRef.current) {
      clearTimeout(collisionTimerRef.current);
      collisionTimerRef.current = null;
    }
  }, []);

  const startCall = useCallback(
    async (peer: string) => {
      if (!user?.signer.nip44) {
        toast({
          title: t({ id: "dmCallProvider.unavailable", defaultMessage: "Calls unavailable" }),
          description: t({ id: "dmCallProvider.unavailableDescription", defaultMessage: "This login can't make encrypted calls (NIP-44 unsupported)." }),
          variant: "destructive",
        });
        return;
      }
      // The peer is ringing US: calling back is answering.
      if (incomingRef.current?.author === peer) {
        acceptRef.current();
        return;
      }
      if (activeCallRef.current) {
        toast({
          title: t({ id: "dmCallProvider.alreadyInCall", defaultMessage: "Already in a call" }),
          description: t({ id: "dmCallProvider.leaveFirst", defaultMessage: "Leave the current call first." }),
        });
        return;
      }
      if (outgoingRef.current) return;
      const { secretHex, callId } = mintDmCall();
      outgoingRef.current = { callId, peer, answered: false, reached: false, sent: false };
      rememberOwnCallId(ownCallIdsRef.current!, callId);
      setDialingPeer(peer);
      // False once the peer's call won a collision while we were resolving/sending.
      const stillOurs = () => outgoingRef.current?.callId === callId;
      // The offer carries our broker as the rendezvous hint.
      let broker: string | null = null;
      for (const origin of ownAvServers()) {
        if (await probeAvBroker(origin)) {
          broker = origin;
          break;
        }
      }
      if (!stillOurs()) return;
      if (!broker) {
        if (yieldToCollided()) return;
        clearOutgoing();
        toast({
          title: t({ id: "dmCallProvider.startFailed", defaultMessage: "Could not start the call" }),
          description: t({ id: "dmCallProvider.noServer", defaultMessage: "No voice server is reachable." }),
          variant: "destructive",
        });
        return;
      }
      const sent = await sendSignal("offer", peer, callId, { secretHex, broker }).catch(() => false);
      if (!stillOurs()) {
        if (sent) void sendSignal("end", peer, callId).catch(() => undefined);
        return;
      }
      if (!sent) {
        // Our offer reached no relay; if theirs is in hand, that's the call.
        if (yieldToCollided()) return;
        clearOutgoing();
        toast({
          title: t({ id: "dmCallProvider.startFailed", defaultMessage: "Could not start the call" }),
          description: t({ id: "dmCallProvider.notDelivered", defaultMessage: "The call invite could not be delivered to any relay." }),
          variant: "destructive",
        });
        return;
      }
      outgoingRef.current!.sent = true;
      armCollisionFallback(callId);
      const ctx: DmVoiceContext = { peer, callId, secretHex, broker };
      joinDmCall(ctx);
      // The answer can beat our own offer's slowest relay; nothing stops a ringback started after it.
      if (!outgoingRef.current!.answered) startRingback();
      ringTimeoutRef.current = setTimeout(() => {
        const out = outgoingRef.current;
        if (!out || out.callId !== callId || out.answered) return;
        // The leave effect below sends "end" so the peer's ring stops.
        clearOutgoing();
        leaveCall();
        if (out.reached) {
          toast({ title: t({ id: "dmCallProvider.noAnswer", defaultMessage: "No answer" }) });
        } else {
          // No "ringing" receipt: it may be offline, lack receipts, or have silently
          // refused us at the ring gate.
          toast({
            title: t({ id: "dmCallProvider.noAnswer", defaultMessage: "No answer" }),
            description: t({
              id: "dmCallProvider.noAnswerDescription",
              defaultMessage:
                "The call may not have rung for them. Calls only ring for people who follow you or have messaged you, and only while Armada is running for them.",
            }),
          });
        }
      }, DM_CALL_RING_MS);
    },
    [user, toast, sendSignal, joinDmCall, leaveCall, clearOutgoing, yieldToCollided, armCollisionFallback],
  );

  const joinOffer = useCallback(
    (offer: DmCallSignal) => {
      if (!offer.secretHex || !offer.broker) return;
      void sendSignal("answer", offer.author, offer.callId).catch(() => undefined);
      joinDmCall({
        peer: offer.author,
        callId: offer.callId,
        secretHex: offer.secretHex,
        broker: offer.broker,
      });
    },
    [sendSignal, joinDmCall],
  );
  const joinOfferRef = useRef(joinOffer);
  joinOfferRef.current = joinOffer;
  const sendSignalRef = useRef(sendSignal);
  sendSignalRef.current = sendSignal;

  const acceptCall = useCallback(() => {
    const offer = incomingRef.current;
    if (!offer?.secretHex || !offer.broker) return;
    clearIncoming();
    dismissNativeCallRing(offer.callId);
    joinOffer(offer);
  }, [clearIncoming, joinOffer]);

  const declineCall = useCallback(() => {
    const offer = incomingRef.current;
    if (!offer) return;
    clearIncoming();
    dismissNativeCallRing(offer.callId);
    void sendSignal("decline", offer.author, offer.callId).catch(() => undefined);
  }, [clearIncoming, sendSignal]);

  const acceptRef = useRef(acceptCall);
  acceptRef.current = acceptCall;

  /** Send a "ringing"/"busy" receipt only if this login signs silently (not NIP-07/46); rate-limited. */
  const sendReceipt = useCallback((phase: "ringing" | "busy", peer: string, callId: string) => {
    if (signerNeedsApproval(userRef.current?.method)) return;
    const sentIds = receiptCallIdsRef.current;
    if (sentIds.has(callId)) return;
    const now = Date.now();
    const last = receiptAtRef.current.get(peer);
    if (last !== undefined && now - last < RECEIPT_PEER_INTERVAL_MS) return;
    sentIds.add(callId);
    if (sentIds.size > RECEIPT_MEMORY) sentIds.delete(sentIds.values().next().value!);
    receiptAtRef.current.set(peer, now);
    void sendSignalRef.current(phase, peer, callId).catch(() => undefined);
  }, []);

  /**
   * Tell our other devices a dropped colliding offer is settled (self-only
   * "answer", so no "Missed call"). Gated like a receipt since the peer's offer triggers it.
   */
  const dismissOnSiblings = useCallback((offer: DmCallSignal) => {
    if (signerNeedsApproval(userRef.current?.method)) return;
    const ids = dismissedCallIdsRef.current;
    if (ids.has(offer.callId)) return;
    const now = Date.now();
    const last = dismissedAtRef.current.get(offer.author);
    if (last !== undefined && now - last < RECEIPT_PEER_INTERVAL_MS) return;
    ids.add(offer.callId);
    if (ids.size > RECEIPT_MEMORY) ids.delete(ids.values().next().value!);
    dismissedAtRef.current.set(offer.author, now);
    void sendSignalRef.current("answer", offer.author, offer.callId, { selfOnly: true }).catch(
      () => undefined,
    );
  }, []);

  useEffect(() => {
    const self = user?.pubkey;
    if (!self) return;
    return subscribeDmCallSignals((signal) => {
      if (signal.author === self) {
        // Own copy from another device: answer/decline stops our ring; a sibling's
        // offer means that device owns any collision with that peer.
        if (!ownCallIdsRef.current!.has(signal.callId)) {
          if (signal.phase === "offer" && isDmOfferFresh(signal)) {
            // Bounded by the offer's own ring window, not arrival time.
            siblingDialRef.current = {
              peer: signal.peer,
              callId: signal.callId,
              createdAtMs: signal.createdAtMs,
            };
            const ringingNow = incomingRef.current;
            if (ringingNow && ringingNow.author === signal.peer) clearIncoming();
          } else if (signal.phase === "end" && siblingDialRef.current?.callId === signal.callId) {
            siblingDialRef.current = null;
          }
        }
        const ringing = incomingRef.current;
        if (
          ringing &&
          signal.callId === ringing.callId &&
          (signal.phase === "answer" || signal.phase === "decline")
        ) {
          clearIncoming();
        }
        return;
      }
      switch (signal.phase) {
        case "offer": {
          if (!isDmOfferFresh(signal)) return;
          if (incomingRef.current?.callId === signal.callId) return;
          const out = outgoingRef.current;
          if (out && out.peer === signal.author && !out.answered) {
            // Dialing each other: both apply the same tie-break so one call survives.
            // Ahead of the ring gate on purpose — dialing them is consent.
            if (dmCallCollisionWinner(self, signal.author) === "ours") {
              dismissOnSiblings(signal);
              // Held for the fallback if the loser never answers ours.
              if (!out.collided) {
                out.collided = signal;
                armCollisionFallback(out.callId);
              }
              return;
            }
            // We lost: yield to the winner's room.
            clearOutgoing();
            joinOfferRef.current(signal);
            return;
          }
          // The other half of a call we already own with this peer: glare, not a second caller.
          if (out?.peer === signal.author || activeCallRef.current?.dm?.peer === signal.author) {
            dismissOnSiblings(signal);
            return;
          }
          // A sibling device is dialing this peer and owns the collision.
          const sibling = siblingDialRef.current;
          if (
            sibling &&
            sibling.peer === signal.author &&
            clockNowMs() - sibling.createdAtMs <= DM_CALL_RING_MS
          ) {
            return;
          }
          // Ring only for known DM peers; strangers are dropped silently, no receipt.
          if (!knownPeersRef.current.includes(signal.author)) return;
          if (activeCallRef.current) {
            // From a DM call, reply busy so their attempt ends now. A voice channel isn't
            // busy: it would end the attempt for all our free devices.
            if (activeCallRef.current.dm) {
              sendReceipt("busy", signal.author, signal.callId);
              toast({
                title: t({ id: "dmCallProvider.missed", defaultMessage: "Missed call" }),
                description: t({ id: "dmCallProvider.missedBusy", defaultMessage: "You were already in a call." }),
              });
            } else {
              toast({
                title: t({ id: "dmCallProvider.missed", defaultMessage: "Missed call" }),
                description: t({ id: "dmCallProvider.missedVoice", defaultMessage: "You were in a voice channel." }),
              });
            }
            return;
          }
          ringIncoming(signal);
          sendReceipt("ringing", signal.author, signal.callId);
          return;
        }
        case "answer": {
          const out = outgoingRef.current;
          if (out && out.callId === signal.callId && signal.author === out.peer) {
            out.answered = true;
            out.reached = true;
            cancelCollisionFallback();
            stopRingback();
          }
          return;
        }
        case "ringing": {
          const out = outgoingRef.current;
          if (out && out.callId === signal.callId && signal.author === out.peer) {
            out.reached = true;
            // Our offer is ringing there, so it's no longer ours to abandon for theirs.
            cancelCollisionFallback();
          }
          return;
        }
        case "busy": {
          const out = outgoingRef.current;
          if (out && out.callId === signal.callId && signal.author === out.peer && !out.answered) {
            clearOutgoing();
            if (activeCallRef.current?.dm?.callId === signal.callId) leaveCall();
            toast({
              title: t({ id: "dmCallProvider.peerBusy", defaultMessage: "On another call" }),
              description: t({ id: "dmCallProvider.peerBusyDescription", defaultMessage: "They're already in a call. Try again later." }),
            });
          }
          return;
        }
        case "decline": {
          const out = outgoingRef.current;
          if (out && out.callId === signal.callId && signal.author === out.peer) {
            clearOutgoing();
            if (activeCallRef.current?.dm?.callId === signal.callId) leaveCall();
            toast({ title: t({ id: "dmCallProvider.declined", defaultMessage: "Call declined" }) });
          }
          return;
        }
        case "end": {
          // The collision loser withdrew: it's joining ours.
          const pending = outgoingRef.current;
          if (pending?.collided?.callId === signal.callId && signal.author === pending.peer) {
            pending.collided = undefined;
            cancelCollisionFallback();
          }
          const ringing = incomingRef.current;
          if (ringing && ringing.callId === signal.callId) {
            clearIncoming();
            toast({ title: t({ id: "dmCallProvider.missed", defaultMessage: "Missed call" }) });
          }
          if (activeCallRef.current?.dm?.callId === signal.callId) {
            // A 1:1 room with one person is over.
            clearOutgoing();
            leaveCall();
          }
          return;
        }
      }
    });
  }, [
    user?.pubkey,
    clearIncoming,
    ringIncoming,
    clearOutgoing,
    leaveCall,
    toast,
    sendReceipt,
    dismissOnSiblings,
    armCollisionFallback,
    cancelCollisionFallback,
  ]);

  useEffect(() => {
    const out = outgoingRef.current;
    if (!out || out.answered || !voiceRoomPubkeys) return;
    if (voiceRoomPubkeys.includes(out.peer)) {
      out.answered = true;
      cancelCollisionFallback();
      stopRingback();
    }
  }, [voiceRoomPubkeys, cancelCollisionFallback]);

  // The Android service rings from its own sockets, so tell it which peer we're
  // dialing/talking to so it doesn't ring or post a missed call for them.
  // Heartbeat-bound so a dead WebView can't silence that peer for long.
  const callPeer = activeCall?.dm?.peer ?? dialingPeer;
  useEffect(() => {
    setNativeCallPeer(callPeer);
    if (!callPeer) return;
    const beat = setInterval(() => setNativeCallPeer(callPeer), CALL_PEER_HEARTBEAT_MS);
    // Logout/account switch skip this cleanup, which would leave the peer muted until the heartbeat lapses.
    const unregisterExit = registerBeforeAccountExit(async () => {
      clearInterval(beat);
      setNativeCallPeer(null);
    });
    return () => {
      unregisterExit();
      clearInterval(beat);
      setNativeCallPeer(null);
    };
  }, [callPeer]);

  // Watching the activeCall transition catches every leave path to send "end".
  const prevDmRef = useRef<DmVoiceContext | null>(null);
  useEffect(() => {
    const dm = activeCall?.dm ?? null;
    const prev = prevDmRef.current;
    prevDmRef.current = dm;
    if (prev && (!dm || dm.callId !== prev.callId)) {
      clearOutgoing();
      void sendSignal("end", prev.peer, prev.callId).catch(() => undefined);
    }
  }, [activeCall, sendSignal, clearOutgoing]);

  // Android's ring deep-links `/dm/<peer>?call=<id>`, plus `&answer=<token>` from
  // the Answer action. The URL names a call and authorizes nothing: parameters
  // come from the service's ticket, and only the token claims it to join.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const wanted = params.get("call");
    if (!wanted || !HEX64.test(wanted)) return;
    const token = params.get("answer");
    // Strip the params first so a later navigation can't re-answer an ended call.
    navigate(location.pathname, { replace: true });
    const self = userRef.current?.pubkey;
    if (!self) return;

    if (token && HEX64.test(token)) {
      void consumeNativeCallAnswer(wanted, token).then((ticket) => {
        const offer = ticket && ticketOffer(ticket, wanted, self, clockNowMs());
        // Busy check: joining would drop the active call.
        if (!offer || activeCallRef.current) return;
        clearIncoming();
        dismissNativeCallRing(wanted);
        joinOfferRef.current(offer);
      });
      return;
    }

    void peekNativeCallRing(wanted).then((ticket) => {
      const offer = ticket && ticketOffer(ticket, wanted, self, ticket.createdAtMs);
      if (!offer || !isDmOfferFresh(offer) || activeCallRef.current) return;
      if (incomingRef.current?.callId === wanted) return;
      ringIncoming(offer);
    });
  }, [location.search, location.pathname, navigate, clearIncoming, ringIncoming]);

  useEffect(
    () => () => {
      stopIncomingRing();
      stopRingback();
      if (ringTimeoutRef.current) clearTimeout(ringTimeoutRef.current);
      if (collisionTimerRef.current) clearTimeout(collisionTimerRef.current);
      if (incomingTimeoutRef.current) clearTimeout(incomingTimeoutRef.current);
    },
    [],
  );

  const value = useMemo<DmCallState>(
    () => ({
      incoming,
      startCall,
      acceptCall,
      declineCall,
      canCall: Boolean(user?.signer.nip44),
    }),
    [incoming, startCall, acceptCall, declineCall, user],
  );

  return (
    <DmCallContext.Provider value={value}>
      {children}
      {incoming && user && (
        <IncomingCallOverlay
          signal={incoming}
          selfPubkey={user.pubkey}
          onAccept={acceptCall}
          onDecline={declineCall}
        />
      )}
    </DmCallContext.Provider>
  );
}

const HEX64 = /^[0-9a-f]{64}$/;

/** The offer a service ticket stands for, or null when it doesn't check out. */
function ticketOffer(
  ticket: NativeCallAnswer,
  callId: string,
  self: string,
  createdAtMs: number,
): DmCallSignal | null {
  // Re-validate across the bridge: the peer becomes a `p` tag we publish.
  if (!HEX64.test(ticket.peer) || !HEX64.test(ticket.secretHex)) return null;
  try {
    // Integrity check only; having the ticket is the authorization.
    if (dmCallKeys(ticket.secretHex).room.pk !== callId) return null;
  } catch {
    return null;
  }
  // A broker is a bearer-credential endpoint: refuse http, userinfo and paths.
  const broker = canonicalOrigin(ticket.broker);
  if (!broker) return null;
  return {
    phase: "offer",
    callId,
    author: ticket.peer,
    peer: self,
    createdAtMs,
    rumorId: "",
    secretHex: ticket.secretHex,
    broker,
  };
}

/** Full-screen, modal incoming-call surface (Accept / Decline). */
function IncomingCallOverlay({
  signal,
  selfPubkey,
  onAccept,
  onDecline,
}: {
  signal: DmCallSignal;
  selfPubkey: string;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const intl = useIntl();
  const author = useAuthor(signal.author);
  const name = getDisplayName(author.data?.metadata, signal.author);

  return (
    // Only Accept/Decline end the ring: Escape, outside clicks and back don't dismiss it.
    <Dialog open onOpenChange={() => {}}>
      <ChromeDialogContent
        title={intl.formatMessage({ id: "dmCallProvider.incomingTitle", defaultMessage: "Incoming call" })}
        hideClose
        className="w-80 max-w-[calc(100vw-2rem)]"
        contentClassName="flex flex-col items-center gap-6 px-8 py-10 sm:px-8 sm:py-10"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DmAvatar peers={[signal.author]} selfPubkey={selfPubkey} sizePx={96} className="size-24" />
        <div className="text-center space-y-1 min-w-0 w-full">
          <div className="chrome-dialog-title font-mono font-bold lowercase tracking-tight truncate">
            <DisplayName pubkey={signal.author} name={name} />
          </div>
          <div className="text-sm text-muted-foreground animate-pulse">
            <FormattedMessage id="dmCallProvider.incoming" defaultMessage="Incoming call…" />
          </div>
        </div>
        <div className="flex items-center gap-10">
          <div className="flex flex-col items-center gap-1.5">
            <Button
              size="icon"
              aria-label={intl.formatMessage({ id: "dmCallProvider.declineCall", defaultMessage: "Decline call" })}
              className="size-14 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onDecline}
            >
              <PhoneOff className="size-6" />
            </Button>
            <span className="text-xs text-muted-foreground">
              <FormattedMessage id="dmCallProvider.decline" defaultMessage="Decline" />
            </span>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <Button
              size="icon"
              aria-label={intl.formatMessage({ id: "dmCallProvider.acceptCall", defaultMessage: "Accept call" })}
              className="size-14 rounded-full bg-success text-success-foreground hover:bg-success/90"
              onClick={onAccept}
            >
              <Phone className="size-6" />
            </Button>
            <span className="text-xs text-muted-foreground">
              <FormattedMessage id="dmCallProvider.accept" defaultMessage="Accept" />
            </span>
          </div>
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}
