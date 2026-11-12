/**
 * NIP-17 typing indicators: a kind-23311 rumor sealed into a kind-21059 ephemeral wrap
 * (relays store nothing).
 * - RECEIVE: a live `{kinds:[21059], "#p":[me]}` sub on the inbox relay set (shared via
 *   `ephemeralInbox.ts`) feeding a decaying in-memory map; nothing is persisted.
 * - SEND: throttled, sealed to the peer ONLY, to their 10050 inbox ∪ our DM relays.
 * Gated only by `config.dmTypingIndicators` (the app-wide typing toggle).
 */

import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDmRelayList, useDmRelaysFor } from "@/hooks/useDmRelayList";
import { effectiveDmRelays } from "@/contexts/AppContext";
import {
  buildDmRumor,
  dmTypingTags,
  KIND_DM_TYPING,
  sealDmRumor,
  wrapDmSealEphemeral,
  type Dm17Signer,
} from "@/lib/nip17/protocol";
import { dmConvKey, dmConvPeers } from "@/lib/nip17/conversation";
import { openDmEphemeral, subscribeDmEphemeral } from "@/lib/nip17/ephemeralInbox";
import { isPlausiblyLive } from "@/lib/liveSignal";
import { sameTypers, TYPING_THROTTLE_MS, TYPING_WINDOW_MS, useTypersStillTyping, useTypingResetOnPost, type Typer } from "@/lib/typingSignal";

import type { NostrEvent } from "@nostrify/nostrify";

export interface DmTyping {
  typers: string[];
  publishTyping: () => void;
}

const IDLE: DmTyping = { typers: [], publishTyping: () => {} };

/** Returns an inert value when off/unsupported/no peer, so callers can mount it unconditionally. */
export function useDmTyping(conversation: string | undefined, enabled = true, messages?: readonly { pubkey: string; created_at: number }[]): DmTyping {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { relays: publishedRelays } = useDmRelayList();

  const self = user?.pubkey;
  const peers = useMemo(
    () => (conversation ? dmConvPeers(conversation) : []),
    [conversation],
  );
  // Groups receive but don't send: a per-member seal every throttle tick is too costly
  // on remote signers.
  const publishPeer = peers.length === 1 && peers[0] !== self ? peers[0] : undefined;
  const peerInboxRelays = useDmRelaysFor(publishPeer);
  const senders = useMemo(() => new Set(peers), [peers]);

  const [typers, setTypers] = useState<readonly Typer[]>([]);
  /** Per typer: when their latest signal arrived (local ms), and the date it carried. */
  const lastSeen = useRef(new Map<string, { at: number; date: number }>());
  const lastSent = useRef(0);
  useTypingResetOnPost(lastSent, messages, user?.pubkey);

  const on =
    enabled &&
    config.dmTypingIndicators &&
    // With DMs off, neither publish nor hold the 21059 sub.
    !config.dmsDisabled &&
    !!self &&
    peers.length > 0 &&
    !(peers.length === 1 && peers[0] === self) &&
    !!user?.signer.nip44;

  // Same union the inbox sync reads: senders deliver to our published 10050 inbox.
  const myRelays = useMemo(
    () => [...new Set([...effectiveDmRelays(config), ...publishedRelays])],
    [config, publishedRelays],
  );
  const myRelayKey = myRelays.join(",");
  const peerRelayKey = peerInboxRelays.join(",");
  const conversationKey = conversation ?? "";

  useEffect(() => {
    setTypers([]);
    lastSeen.current = new Map();
    if (!on || myRelays.length === 0) return;
    let released = false;
    const signer = user!.signer as unknown as Dm17Signer;

    // One-shot timer for the next expiry, so idle conversations schedule no wakeups.
    let decay: ReturnType<typeof setTimeout> | undefined;
    const recompute = () => {
      if (decay) clearTimeout(decay);
      decay = undefined;
      const now = Date.now();
      const cutoff = now - TYPING_WINDOW_MS;
      const live: Typer[] = [];
      let oldest = Infinity;
      for (const [pubkey, { at, date }] of lastSeen.current) {
        if (at > cutoff) {
          live.push({ pubkey, date });
          oldest = Math.min(oldest, at);
        } else lastSeen.current.delete(pubkey);
      }
      live.sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1));
      setTypers((prev) => sameTypers(prev, live));
      if (live.length > 0) decay = setTimeout(recompute, oldest + TYPING_WINDOW_MS - now + 1);
    };

    const apply = async (wrap: NostrEvent) => {
      const opened = await openDmEphemeral(wrap, signer, self!);
      if (released || !opened || opened.kind !== KIND_DM_TYPING) return;
      // Excludes our own echoed signal, and 1:1 signals from a group sharing its members.
      if (!senders.has(opened.author)) return;
      if (dmConvKey(opened.peers) !== conversationKey) return;
      const date = opened.createdAt * 1000;
      if (!isPlausiblyLive(date)) return;
      if (date <= (lastSeen.current.get(opened.author)?.date ?? 0)) return;
      lastSeen.current.set(opened.author, { at: Date.now(), date });
      recompute();
    };

    // Shared per (relay, me) across conversation switches — see `ephemeralInbox.ts`.
    const handler = (wrap: NostrEvent) => void apply(wrap);
    const unsubs = myRelays.map((url) => subscribeDmEphemeral(nostr, url, self!, handler));

    return () => {
      released = true;
      for (const unsub of unsubs) unsub();
      if (decay) clearTimeout(decay);
    };
    // Keyed on pubkey (signer is stable per login) so a profile refresh keeps the subs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, on, self, conversationKey, myRelayKey]);

  const publishTyping = useCallback(() => {
    if (!on || !publishPeer) return;
    const now = Date.now();
    if (now - lastSent.current < TYPING_THROTTLE_MS) return;
    lastSent.current = now;
    void (async () => {
      try {
        const signer = user!.signer as unknown as Dm17Signer;
        const rumor = buildDmRumor({
          kind: KIND_DM_TYPING,
          content: "",
          tags: dmTypingTags([publishPeer]),
          pubkey: self!,
        });
        // Peer copy only; a self copy would just echo our own indicator.
        const wrap = await wrapDmSealEphemeral(await sealDmRumor(rumor, publishPeer, signer), publishPeer);
        const targets = [...new Set([...peerInboxRelays, ...myRelays])];
        await Promise.allSettled(
          targets.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(6000) })),
        );
      } catch {
        // Best-effort; typing is ephemeral and a miss costs nothing.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, on, self, publishPeer, user, myRelayKey, peerRelayKey]);

  const shown = useTypersStillTyping(typers, messages);
  return useMemo(() => (on ? { typers: shown, publishTyping } : IDLE), [on, shown, publishTyping]);
}
