import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useGuestbook } from "@/concord/hooks/useGuestbook";
import { typingSilenced, writerJudge } from "@/concord/lib/channelJudges";
import { sendTarget } from "@/concord/lib/writerKeys";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isPlausiblyLive } from "@/lib/liveSignal";
import { sameTypers, TYPING_THROTTLE_MS, TYPING_WINDOW_MS, useTypersStillTyping, useTypingResetOnPost, type Typer } from "@/lib/typingSignal";
import { clockNowMs } from "@/lib/relayClock";
import { KIND_SEAL_ENCRYPTED, KIND_TYPING } from "@/concord/lib/kinds";
import { ignoreEcho, subscribeEphemeral } from "@/concord/lib/ephemeralSub";
import { buildRumor, channelBindingTags, checkChannelBinding, openWrap, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { Channel, Community } from "@/concord/lib/types";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Live "who is typing" for a channel: kind 23311 rumor in a kind-21059 wrap at
 * the channel's current address (CORD-02 Appendix B), and in a restricted Channel at
 * its live writer address, where typing moves with posting (CORD-03 §1). Relays store
 * nothing, so it's subscription-only into a decaying in-memory map.
 */
export function useTyping(community: Community | undefined, channel: Channel | undefined, messages?: readonly { pubkey: string; created_at: number }[]): string[] {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const enabled = useAppContext().config.dmTypingIndicators;
  const [typers, setTypers] = useState<readonly Typer[]>([]);
  /** Per typer: when their latest signal arrived (local ms), and the date it carried. */
  const seen = useRef(new Map<string, { at: number; date: number }>());
  const { data: folded } = useControlFold(community);
  const { history, timeouts } = useGuestbook(community);
  // Read through a ref so a Roster or Guestbook change doesn't resubscribe.
  const judges = useRef({ folded, history });
  judges.current = { folded, history };

  const channelIdHex = channel?.idHex ?? null;
  const currentPk = channel?.current.group.pk;
  // A Locked Channel's read address carries nothing a reader needs (CORD-03 §1).
  const listened = channel
    ? [...(channel.locked ? [] : [channel.current.group]), ...channel.streams.filter((st) => st.writer && st.epoch === channel.current.epoch && st.writer.to === undefined).map((st) => st.group)]
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
      const live: Typer[] = [];
      let oldest = Infinity;
      for (const [pubkey, { at, date }] of seen.current) {
        if (now - at <= TYPING_WINDOW_MS) {
          live.push({ pubkey, date });
          oldest = Math.min(oldest, at);
        } else seen.current.delete(pubkey);
      }
      live.sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1));
      setTypers((prev) => sameTypers(prev, live));
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
        // In a restricted Channel, a signal the Writers ledger doesn't stand behind (CORD-03 §1).
        const judge = writerJudge(judges.current.folded, channelIdHex, community.id, judges.current.history);
        if (judge && !judge.stands(opened)) return;
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

  const typing = useTypersStillTyping(typers, messages);
  return useMemo(() => {
    if (typing.length === 0 || !channelIdHex) return typing;
    const silenced = typingSilenced(folded, channelIdHex, timeouts, history, clockNowMs());
    const shown = typing.filter((pk) => !silenced(pk));
    return shown.length === typing.length ? typing : shown;
  }, [typing, folded, channelIdHex, timeouts, history]);
}

/** A throttled publisher for the current user's typing signal. */
export function useTypingPublisher(community: Community | undefined, channel: Channel | undefined, messages?: readonly { pubkey: string; created_at: number }[]) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const enabled = useAppContext().config.dmTypingIndicators;
  const lastSent = useRef(0);
  useTypingResetOnPost(lastSent, messages, user?.pubkey);
  const { data: folded } = useControlFold(community);
  const { history, timeouts } = useGuestbook(community);

  return useCallback(() => {
    if (!enabled || !user || !community || !channel) return;
    // Throttle first: `sendTarget` verifies the writer certificate, too costly per keystroke.
    const now = Date.now();
    if (now - lastSent.current < TYPING_THROTTLE_MS) return;
    lastSent.current = now;
    if (typingSilenced(folded, channel.idHex, timeouts, history, clockNowMs())(user.pubkey)) return;
    // Where a post would land; one who can't post there doesn't type there either.
    const at = sendTarget(channel.current.group, KIND_TYPING, folded, community.id, channel.idHex, user.pubkey, folded?.rankedRoster ? history : undefined);
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
        ignoreEcho(wrap.id);
        await Promise.allSettled(
          community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(6000) })),
        );
      } catch {
        // best-effort; typing is ephemeral
      }
    })();
  }, [nostr, user, community, channel, enabled, folded, history, timeouts]);
}
