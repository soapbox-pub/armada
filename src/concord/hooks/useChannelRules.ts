import { useMemo } from "react";

import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useGuestbook } from "@/concord/hooks/useGuestbook";
import { channelRules } from "@/concord/lib/channelJudges";
import type { Channel, Community } from "@/concord/lib/types";
import { clockNowMs } from "@/lib/relayClock";

export type ChannelRules = ReturnType<typeof channelRules>;

const NO_TIMEOUTS = new Map();

/**
 * Each Channel's timeline rules (CORD-03 §1, CORD-04 §8) for panes that read several
 * Channels at once, so they hold and collapse exactly what the Channel itself does.
 * Inactive callers (rail badges) read no Guestbook: they get the Writers ledger's
 * holds, judged without membership, and no Timeouts.
 */
export function useChannelRules(
  community: Community | undefined,
  channels: readonly Channel[],
  active: boolean,
): (channelIdHex: string) => ChannelRules {
  const { data: control } = useControlFold(community, false);
  const { timeouts, history } = useGuestbook(active && control ? community : undefined);
  const publicUntilSig = channels.map((c) => `${c.idHex}:${c.publicUntil ?? ""}`).join(",");
  return useMemo(() => {
    const publicUntil = new Map(channels.map((c) => [c.idHex, c.publicUntil]));
    const nowMs = clockNowMs();
    const cache = new Map<string, ChannelRules>();
    return (channelIdHex: string) => {
      let rules = cache.get(channelIdHex);
      if (!rules) {
        rules = channelRules(control, channelIdHex, community?.id, active ? timeouts : NO_TIMEOUTS, active ? history : undefined, nowMs, publicUntil.get(channelIdHex));
        cache.set(channelIdHex, rules);
      }
      return rules;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [control, community?.id, timeouts, history, active, publicUntilSig]);
}
