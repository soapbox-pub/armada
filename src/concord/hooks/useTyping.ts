import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useGuestbook } from "@/concord/hooks/useGuestbook";
import { sendTarget } from "@/concord/lib/writerKeys";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isPlausiblyLive } from "@/lib/liveSignal";
import { clockNowMs } from "@/lib/relayClock";
import { KIND_SEAL_ENCRYPTED, KIND_TYPING } from "@/concord/lib/kinds";
import { subscribeEphemeral } from "@/concord/lib/ephemeralSub";
import { buildRumor, channelBindingTags, checkChannelBinding, openWrap, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { Channel, Community } from "@/concord/lib/types";

import type { NostrEvent } from "@nostrify/nostrify";

/** How long a typing signal is considered live. */
const TYPING_WINDOW_MS = 8000;
/** Minimum gap between published signals. */
const TYPING_THROTTLE_MS = 4000;

/**
 * Live "who is typing" for a channel: kind 23311 rumor in a kind-21059 wrap at
 * the channel's current address (CORD-02 Appendix B), and in a restricted Channel at
 * its live writer address, where typing moves with posting (CORD-03 §1). Relays store
 * nothing, so it's subscription-only into a decaying in-memory map.
 */
export function useTyping(community: Community | undefined, channel: Channel | undefined): string[] {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const enabled = useAppContext().config.dmTypingIndicators;
  const [typers, setTypers] = useState<string[]>([]);
  /** Per typer: when their latest signal arrived (local ms), and the date it carried. */
  const seen = useRef(new Map<string, { at: number; date: number }>());

  const channelIdHex = channel?.idHex ?? null;
  const currentPk = channel?.current.group.pk;
  const listened = channel
    ? [channel.current.group, ...channel.streams.filter((st) => st.writer && st.epoch === channel.current.epoch && st.writer.to === undefined).map((st) => st.group)]
    : [];
  const listenedSig = listened.map((g) => g.pk).join(",");

  useEffect(() => {
    seen.current = new Map();
    setTypers([]);
    if (!enabled || !community || !channel || !channelIdHex || !currentPk) return;
    const groups = new Map(listened.map((g) => [g.pk, g]));
    const epoch = channel.current.epoch;

    // One-shot timer for the next expiry, so an idle channel schedules no wakeups.
    let decay: ReturnType<typeof setTimeout> | undefined;
    const recompute = () => {
      if (decay) clearTimeout(decay);
      decay = undefined;
      const now = Date.now();
      const live: string[] = [];
      let oldest = Infinity;
      for (const [pk, { at }] of seen.current) {
        if (now - at <= TYPING_WINDOW_MS) {
          live.push(pk);
          oldest = Math.min(oldest, at);
        } else seen.current.delete(pk);
      }
      setTypers((prev) =>
        prev.length === live.length && prev.every((p, i) => p === live[i]) ? prev : live,
      );
      if (live.length > 0) decay = setTimeout(recompute, oldest + TYPING_WINDOW_MS - now + 1);
    };

    const apply = (event: NostrEvent) => {
      const group = groups.get(event.pubkey);
      if (!group) return;
      try {
        const opened = openWrap(event, group);
        if (opened.kind !== KIND_TYPING) return;
        checkChannelBinding(opened, channelIdHex, epoch);
        if (user && opened.author === user.pubkey) return;
        if (!isPlausiblyLive(opened.ms)) return;
        if (opened.ms <= (seen.current.get(opened.author)?.date ?? 0)) return;
        seen.current.set(opened.author, { at: Date.now(), date: opened.ms });
        recompute();
      } catch {
        // not ours / malformed
      }
    };

    // One shared 21059 REQ per relay across channels (see `ephemeralSub.ts`).
    const unsubs = community.relays.flatMap((url) => [...groups.keys()].map((pk) => subscribeEphemeral(nostr, url, pk, apply)));

    return () => {
      for (const unsub of unsubs) unsub();
      if (decay) clearTimeout(decay);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, community?.idHex, channelIdHex, listenedSig, user?.pubkey, enabled]);

  return typers;
}

/** A throttled publisher for the current user's typing signal. */
export function useTypingPublisher(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const enabled = useAppContext().config.dmTypingIndicators;
  const lastSent = useRef(0);
  const { data: folded } = useControlFold(community);
  const { history } = useGuestbook(folded?.rankedRoster ? community : undefined);

  return useCallback(() => {
    if (!enabled || !user || !community || !channel) return;
    // Throttle first: `sendTarget` verifies the writer certificate, too costly per keystroke.
    const now = Date.now();
    if (now - lastSent.current < TYPING_THROTTLE_MS) return;
    lastSent.current = now;
    // Where a post would land; one who can't post there doesn't type there either.
    const at = sendTarget(channel.current.group, KIND_TYPING, folded, community.id, channel.idHex, user.pubkey, history);
    if (!at) return;

    void (async () => {
      try {
        const rumor = buildRumor({
          kind: KIND_TYPING,
          content: "",
          tags: [...channelBindingTags(channel.idHex, channel.current.epoch), ...at.tags],
          pubkey: user.pubkey,
          ms: clockNowMs(),
        });
        const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, at.group, user.signer);
        const wrap = await wrapSeal(seal, at.group, { ephemeral: true });
        await Promise.allSettled(
          community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(6000) })),
        );
      } catch {
        // best-effort; typing is ephemeral
      }
    })();
  }, [nostr, user, community, channel, enabled, folded, history]);
}
