/**
 * Collect the live writer key and this member's certificate for every restricted
 * Channel they may post in, or manage, but can't post in yet (CORD-03 §1, Vector
 * `collect_writers`): delivered on the Channel's access plane at its writer scope.
 */

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { readAccessPlanes } from "@/concord/hooks/useChannelAccess";
import { useCoalescedRefetch } from "@/concord/hooks/useCoalescedRefetch";
import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useGuestbook } from "@/concord/hooks/useGuestbook";
import { useNewlyOwed, useOwedReread } from "@/concord/hooks/useOwedReread";
import { accessPlane, parseDelivery, type ParsedDelivery } from "@/concord/lib/delivery";
import { hex32 } from "@/concord/lib/derive";
import { rereadOnBackoff } from "@/concord/lib/quorum";
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

  const needs = community && folded?.rankedRoster && me
    ? [...(folded.writers?.keys() ?? [])].flatMap((id) => {
        const need = writerNeeds(folded, community.id, id, me);
        return need ? [{ id, need }] : [];
      }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    : [];
  const owed = needs.map((n) => n.id);
  const owedKey = owed.join(",");
  // What is owed, down to each piece of each epoch: a rotation re-owes a Channel under the
  // same id. Held keys warm after mount, which only shrinks this, so it moves on news alone.
  const writerSig = useNewlyOwed(
    community && folded && me
      ? needs.flatMap(({ id, need }) =>
          (["key", "cert", "certifier"] as const).filter((p) => need[p]).map((p) => `${id}:${need.epoch}:${need.pk}:${p}`),
        )
      : undefined,
  );

  const query = useQuery({
    queryKey: ["concord", "writer-access", community?.idHex ?? null, community?.rootEpoch.toString() ?? null, owedKey, heldSig],
    enabled: Boolean(community && owed.length > 0),
    staleTime: 15_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    queryFn: ({ signal }) => readAccessPlanes(nostr, community!, owed, signal),
  });
  const refetch = useCoalescedRefetch(query.refetch);
  const planePks = useMemo(
    () => (community ? owed.map((id) => accessPlane(community, hex32(id)).pk) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [community?.idHex, community?.rootEpoch, owedKey],
  );
  // A writer key is delivered just after the change that owes it, often after this read.
  useOwedReread({
    owner: community && `writer:${community.idHex}`,
    relays: community?.relays ?? [],
    pks: planePks,
    pending: owed.length > 0,
    sig: writerSig,
    refetch,
    onMount: false,
  });
  // Owed once the inputs load: no window, as it may never be delivered, but the same
  // backoff Channel keys get, so a delivery whose live event was dropped isn't left a minute.
  const owedAtLoad = useRef<boolean | undefined>(undefined);
  if (owedAtLoad.current === undefined && writerSig !== undefined) owedAtLoad.current = owed.length > 0;
  // Only what was owed at load: anything owed after nothing was is the window's.
  else if (owedAtLoad.current && owed.length === 0) owedAtLoad.current = false;
  const backoff = owedAtLoad.current === true && owed.length > 0;
  useEffect(() => {
    if (!backoff) return;
    return rereadOnBackoff(refetch);
  }, [backoff, refetch]);

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
