/**
 * Collect the live writer key and this member's certificate for every restricted
 * Channel they may post in, or manage, but can't post in yet (CORD-03 §1, Vector
 * `collect_writers`): delivered on the Channel's access plane at its writer scope.
 */

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";

import { readAccessPlanes } from "@/concord/hooks/useChannelAccess";
import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useGuestbook } from "@/concord/hooks/useGuestbook";
import { parseDelivery, type ParsedDelivery } from "@/concord/lib/delivery";
import type { Community } from "@/concord/lib/types";
import { adoptWriterDeliveries, canPostIn, subscribeWriterKeys, writerKeysReady, writerNeeds } from "@/concord/lib/writerKeys";
import { useCurrentUser } from "@/hooks/useCurrentUser";

let warmedSig = 0;
const bumpOnWarm = (l: () => void) => {
  void writerKeysReady().then(() => {
    warmedSig++;
    l();
  });
  return subscribeWriterKeys(() => {
    warmedSig++;
    l();
  });
};

export function useWriterAccess(community: Community | undefined): void {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold(community);
  // Re-read what is owed once the held keys warm, and whenever one lands.
  const heldSig = useSyncExternalStore(bumpOnWarm, () => warmedSig);
  const me = user?.pubkey;

  const owed = community && folded?.rankedRoster && me
    ? [...(folded.writers?.keys() ?? [])].filter((id) => writerNeeds(folded, community.id, id, me) !== undefined).sort()
    : [];
  const owedKey = owed.join(",");

  const query = useQuery({
    queryKey: ["concord", "writer-access", community?.idHex ?? null, community?.rootEpoch.toString() ?? null, owedKey, heldSig],
    enabled: Boolean(community && owed.length > 0),
    staleTime: 15_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    queryFn: ({ signal }) => readAccessPlanes(nostr, community!, owed, signal),
  });

  useEffect(() => {
    const nip44 = user?.signer.nip44;
    if (!community || !folded || !me || !nip44 || !query.data?.length) return;
    const byChannel = new Map<string, ParsedDelivery[]>();
    for (const { channelIdHex, opened } of query.data) {
      const d = parseDelivery(opened);
      if (!d) continue;
      const list = byChannel.get(channelIdHex);
      if (list) list.push(d);
      else byChannel.set(channelIdHex, [d]);
    }
    void (async () => {
      for (const [channelIdHex, deliveries] of byChannel) {
        await adoptWriterDeliveries(deliveries, folded, community.id, channelIdHex, me, (pk, wrapped) => nip44.decrypt(pk, wrapped)).catch(() => false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.idHex, folded, me, query.data]);
}

/** Whether this member may post in the Channel now (Vector `can_post`), re-read as writer keys land. */
export function useCanPost(community: Community | undefined, channelIdHex: string | undefined): boolean {
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold(community);
  const { history } = useGuestbook(folded?.rankedRoster ? community : undefined);
  useSyncExternalStore(bumpOnWarm, () => warmedSig);
  return canPostIn(folded, community?.id, channelIdHex, user?.pubkey, history);
}
