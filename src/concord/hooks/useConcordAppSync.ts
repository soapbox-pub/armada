import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { clockNowMs } from "@/lib/relayClock";
import { chatExpiresAt, messageExpirationOf } from "@/concord/lib/disappearing";
import { KIND_SEAL_ENCRYPTED, KIND_WEBXDC } from "@/concord/lib/kinds";
import {
  buildRumor,
  channelBindingTags,
  sealRumor,
  wrapSeal,
} from "@/concord/lib/stream";
import {
  queryWebxdcPeerSignals,
  queryWebxdcRumors,
  writeRumors,
} from "@/concord/lib/rumorStore";
import type { OpenedChat } from "@/concord/lib/chat";
import type { Channel, Community } from "@/concord/lib/types";
import { useWireScopes } from "@/wire/useWireScopes";

import {
  realtimeTransport,
  type RealtimeTransport,
} from "@/lib/realtimeTransport";
import {
  base32Decode,
  decodeNodeAddr,
  encodeNodeAddr,
  foldPeerSignals,
  frame,
  isTopicId,
  peerSignalContent,
  unframe,
} from "@/lib/webxdcRealtime";

import type {
  AppStateMeta,
  AppStateUpdate,
  AppSync,
} from "@/hooks/useWebxdcApi";

/** Least time between peer-signal re-reads driven by chat traffic. */
const PEER_READ_THROTTLE_MS = 5_000;

/** How many dials one session keeps in flight at once. */
const MAX_DIAL_PEERS = 16;

function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find(([n]) => n === name)?.[1];
}

/**
 * In-chat app coordination for a Concord channel, scoped to one app session
 * (`uuid`). Rumors are kind {@link KIND_WEBXDC} (3310) sealed under the channel's
 * current stream key:
 *
 *  - **state** (`sendUpdate`) is a durable 1059 wrap that the wire decrypts into
 *    the rumor store (3310 is excluded from {@link CHAT_KINDS}); read with
 *    {@link queryWebxdcRumors}.
 *  - **realtime** (`joinRealtimeChannel`) goes peer to peer over iroh gossip
 *    (Vector's transport, so both clients share one game); the channel carries
 *    only peer signals. No relay fallback: it would split the room.
 */
export function useConcordAppSync(
  community: Community | undefined,
  channel: Channel | undefined,
  uuid: string,
): AppSync {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  // App state disappears with the chat plane (CORD-08 §2).
  const { data: folded } = useControlFold(community);
  const timerSecs = messageExpirationOf(folded?.metadata);

  const enabled = Boolean(community && channel && uuid && user);
  const channelIdHex = channel?.idHex ?? null;
  const queryKey = useMemo(
    () => ["concord", "app-state", channelIdHex, uuid] as const,
    [channelIdHex, uuid],
  );

  const { data: opened } = useQuery<OpenedChat[]>({
    queryKey,
    enabled,
    // Live via the wire bus; this poll is only a backstop for a missed ring.
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const rows = await queryWebxdcRumors(
        community!.idHex,
        channelIdHex!,
        uuid,
        { signal },
      );
      return rows.sort((a, b) => a.ms - b.ms);
    },
  });

  // Peer signals carry no session tag, so they need their own read.
  const peerKey = useMemo(
    () => ["concord", "webxdc-peers", channelIdHex] as const,
    [channelIdHex],
  );
  const { data: peerRows } = useQuery<OpenedChat[]>({
    queryKey: peerKey,
    enabled: enabled && isTopicId(uuid),
    refetchInterval: 60_000,
    queryFn: async ({ signal }) =>
      queryWebxdcPeerSignals(community!.idHex, channelIdHex!, { signal }),
  });
  const peerSignals = useMemo(
    () =>
      (peerRows ?? []).map((r) => ({
        author: r.author,
        content: r.content,
        ms: r.ms,
      })),
    [peerRows],
  );

  // The peer read is throttled separately: the wire rings on every chat message
  // and it's a 2000-row scan with a JSON.parse per row.
  const peerReadAt = useRef(0);
  useWireScopes((scopes) => {
    if (!channelIdHex || !(scopes.has(`c2:${channelIdHex}`) || scopes.has(`c2old:${channelIdHex}`))) return;
    void queryClient.invalidateQueries({ queryKey });
    const now = Date.now();
    if (now - peerReadAt.current < PEER_READ_THROTTLE_MS) return;
    peerReadAt.current = now;
    void queryClient.invalidateQueries({ queryKey: peerKey });
  });

  const stateUpdates = useMemo((): AppStateUpdate[] => {
    return (opened ?? []).map((m) => {
      let payload: unknown;
      try {
        payload = JSON.parse(m.content);
      } catch {
        payload = m.content;
      }
      return {
        payload,
        info: tagValue(m.tags, "info"),
        document: tagValue(m.tags, "document"),
        summary: tagValue(m.tags, "summary"),
      };
    });
  }, [opened]);

  const publish = useCallback(
    async (content: string, extraTags: string[][]) => {
      if (!community || !channel || !user) return;
      const ms = clockNowMs();
      const expiresAt = chatExpiresAt(KIND_WEBXDC, ms, timerSecs);
      const rumor = buildRumor({
        kind: KIND_WEBXDC,
        content,
        tags: [
          ...channelBindingTags(channel.idHex, channel.current.epoch),
          ...extraTags,
          ...(expiresAt !== undefined
            ? [["expiration", String(expiresAt)]]
            : []),
        ],
        pubkey: user.pubkey,
        ms,
      });
      const seal = await sealRumor(
        rumor,
        KIND_SEAL_ENCRYPTED,
        channel.current.group,
        user.signer,
      );
      const wrap = await wrapSeal(
        seal,
        channel.current.group,
        expiresAt !== undefined ? { expiration: expiresAt } : undefined,
      );
      // Store our own rumor now so the app sees its state without a relay round trip.
      writeRumors(community.idHex, [
        {
          rumorId: rumor.id,
          author: user.pubkey,
          kind: KIND_WEBXDC,
          content,
          tags: rumor.tags,
          ms,
          createdAt: rumor.created_at,
          wrapId: wrap.id,
          streamPk: wrap.pubkey,
          sealKind: KIND_SEAL_ENCRYPTED,
          seal,
          channelIdHex: channel.idHex,
          epoch: channel.current.epoch,
        },
      ], { local: true });
      await Promise.allSettled(
        community.relays.map((url) =>
          nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) }),
        ),
      );
    },
    [nostr, community, channel, user, timerSecs],
  );

  // The join effect outlives a rekey, so its departure must seal under the
  // current key. Stamped with its scope: a dep-change cleanup runs after this ref
  // already points at the NEW channel's publisher, which would misroute the departure.
  const publishScope = `${community?.idHex ?? ""}:${channelIdHex ?? ""}`;
  const publishRef = useRef({ scope: publishScope, publish });
  publishRef.current = { scope: publishScope, publish };

  const sendState = useCallback(
    (payload: unknown, opts?: AppStateMeta) => {
      const extraTags: string[][] = [
        ["i", uuid],
        ["alt", "Webxdc update"],
      ];
      if (opts?.info) extraTags.push(["info", opts.info]);
      if (opts?.document) extraTags.push(["document", opts.document]);
      if (opts?.summary) extraTags.push(["summary", opts.summary]);
      void publish(JSON.stringify(payload), extraTags).then(() =>
        queryClient.invalidateQueries({ queryKey }),
      );
    },
    [uuid, publish, queryClient, queryKey],
  );

  // A ref so the send path needn't re-render to learn the mesh came up.
  const gossip = useRef<
    { node: RealtimeTransport; topic: Uint8Array; key: Uint8Array } | undefined
  >(undefined);
  const seq = useRef(0);
  const dialledRef = useRef(new Set<string>());
  const sessionClaim = useRef(0);
  const inFlightDials = useRef(0);
  const [meshReady, setMeshReady] = useState(0);

  const sendRealtime = useCallback((data: Uint8Array) => {
    const g = gossip.current;
    // Gossip or nothing: a relay path reaching only some members would split one
    // game into two.
    if (!g) return;
    seq.current += 1;
    // Vector's frame format, so its receivers strip the trailer and drop echoes.
    void g.node
      .send(g.topic, frame(data, seq.current, g.key))
      .catch(() => undefined);
  }, []);

  const listenersRef = useRef(new Set<(data: Uint8Array) => void>());
  const selfPubkey = user?.pubkey;

  /**
   * Bring up the mesh if the attachment named a topic and the transport exists.
   * Order is Vector's: join, then advertise — a dial for an unregistered topic
   * drops its frames. The advertisement is a durable 3310 so late openers can backfill it.
   */
  useEffect(() => {
    if (!enabled || !isTopicId(uuid) || !community || !channel || !selfPubkey)
      return;
    const topic = base32Decode(uuid);
    if (!topic || topic.length !== 32) return;

    let cancelled = false;
    let node: RealtimeTransport | undefined;
    const scope = publishScope;
    // This run's claim on the topic, so a late join and a successor never tear
    // down each other's session.
    const claim = ++sessionClaim.current;
    // Captured for the cleanup (the lint rule can't tell the ref is stable).
    const dialled = dialledRef.current;

    void (async () => {
      node = await realtimeTransport();
      if (!node || cancelled) return;

      const key = Uint8Array.from(
        node
          .publicKeyHex()
          .match(/../g)!
          .map((h) => parseInt(h, 16)),
      );
      await node.join(
        topic,
        [],
        (bytes) => {
          const got = unframe(bytes);
          // Gossip echoes our own broadcasts back; the trailer is how we know.
          if (!got || got.sender === node!.publicKeyHex()) return;
          for (const cb of listenersRef.current) cb(got.payload);
        },
        // Distinguishes "mesh never formed" from "nobody spoke".
        (msg) => console.debug("[webxdc] gossip:", msg),
      );
      if (cancelled) {
        // The join succeeded but nobody owns it: leave the topic, unless a later run
        // has claimed it.
        if (sessionClaim.current === claim) node.leave(topic);
        return;
      }
      gossip.current = { node, topic, key };
      void publishRef.current.publish(peerSignalContent(uuid, encodeNodeAddr(node.nodeAddrJson())), []);
      // Trigger the dial pass: advertising peers loaded long before the mesh came up.
      setMeshReady((n) => n + 1);
    })();

    return () => {
      cancelled = true;
      const g = gossip.current;
      gossip.current = undefined;
      if (!g) return;
      // Tell the room before dropping the mesh, via this session's channel publisher.
      if (publishRef.current.scope === scope) {
        void publishRef.current.publish(peerSignalContent(uuid), []);
      }
      g.node.leave(g.topic);
      // Addresses are per-node; a fresh session may re-dial.
      dialled.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, uuid, community?.idHex, channel?.idHex, selfPubkey]);

  /**
   * Dial advertised peers when signals change or the mesh comes up; one attempt
   * per address per session (failed connects don't reject here — we rely on the
   * peer dialling us back).
   */
  useEffect(() => {
    const g = gossip.current;
    if (!g || !isTopicId(uuid)) return;
    // Old channels are mostly ghost advertisements whose dials hang to timeout, so
    // bound how many are IN FLIGHT, not how many are considered.
    const peers = foldPeerSignals(peerSignals, uuid, selfPubkey);
    for (const peer of peers) {
      if (inFlightDials.current >= MAX_DIAL_PEERS) break;
      if (dialledRef.current.has(peer.addr)) continue;
      // Decode BEFORE reserving a slot: `addr` is sender-controlled, and bailing
      // after reserving would leak the counter and wedge the dialer. Mark dialled
      // either way.
      dialledRef.current.add(peer.addr);
      const json = decodeNodeAddr(peer.addr);
      if (!json) continue;
      inFlightDials.current += 1;
      void g.node
        .addPeer(g.topic, json)
        .catch(() => dialledRef.current.delete(peer.addr))
        .finally(() => {
          inFlightDials.current -= 1;
        });
    }
  }, [peerSignals, uuid, selfPubkey, meshReady]);

  const onRealtime = useCallback((cb: (data: Uint8Array) => void) => {
    listenersRef.current.add(cb);
    return () => {
      listenersRef.current.delete(cb);
    };
  }, []);

  return useMemo<AppSync>(
    () => ({ stateUpdates, sendState, sendRealtime, onRealtime }),
    [stateUpdates, sendState, sendRealtime, onRealtime],
  );
}
