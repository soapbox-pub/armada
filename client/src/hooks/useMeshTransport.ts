import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { MeshContext, type MeshContextType, type MeshState } from "@/contexts/MeshContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { BluetoothMesh, type MeshMessage, type MeshPeer } from "@/lib/bluetoothMesh";
import { meshAnonName } from "@/lib/meshIdentity";
import {
  buildRevealTemplate,
  createMeshChannel,
  decodeChannelFrame,
  decodeChannelInvite,
  encodeChannelFrame,
  encodeChannelInvite,
  isChannelFrame,
  openAgainstChannels,
  sealChannelMessage,
  type ChannelSendIdentity,
  type MeshChannel,
} from "@/lib/meshChannel";

import type { ChatMsg, ChatTransport } from "@/components/chat/transport";

export type { MeshState } from "@/contexts/MeshContext";

/** Synthetic Nostr kind for adapted mesh messages (mirrors NIP-29 chat kind 9). */
const MESH_KIND = 9;

/**
 * Adapt a mesh wire message to the shared `ChatMsg` (NostrEvent) shape so it
 * renders through the SAME `ChatMessage`/`ChatContent` path as NIP-29 and
 * Concord. Mesh peers are NOT Nostr pubkeys, so `pubkey` carries the mesh peer
 * id (or sender nickname) purely as a stable author key; rendering never
 * re-verifies the (empty) signature.
 */
function meshToEvent(m: MeshMessage): ChatMsg {
  return {
    id: m.id,
    pubkey: m.senderPeerID ?? m.sender,
    created_at: Math.floor((m.timestamp || Date.now()) / 1000),
    kind: MESH_KIND,
    tags: [["mesh_sender", m.sender]],
    content: m.content,
    sig: "",
  };
}

/**
 * Adapt an opened private-channel message to the shared `ChatMsg` shape. The
 * author key prefers a verified in-channel Nostr reveal (so revealed members
 * render as their Nostr identity); otherwise it falls back to the sender's mesh
 * peer id (incognito, resolved to an `anon<hex>` handle by the page). A
 * `mesh_reveal` tag carries the revealed display name for the row to use.
 */
function channelToEvent(
  id: string,
  senderPeerID: string,
  content: string,
  timestamp: number,
  reveal?: { pubkey: string; name: string },
): ChatMsg {
  const tags: string[][] = [];
  if (reveal) tags.push(["mesh_reveal", reveal.pubkey, reveal.name]);
  return {
    id,
    pubkey: senderPeerID || (reveal?.pubkey ?? "unknown"),
    created_at: Math.floor((timestamp || Date.now()) / 1000),
    kind: MESH_KIND,
    tags,
    content,
    sig: "",
  };
}

/**
 * Drives the Android Bluetooth mesh and exposes it as a {@link ChatTransport}
 * for the shared chat UI: the always-on `# nearby mesh` broadcast room, 1:1
 * Noise-XX DMs, and user-created PRIVATE CHANNELS.
 *
 * Private channels are end-to-end encrypted over the open mesh (see
 * {@link meshChannel}): the body is sealed under a shared channel key and rides
 * as an ordinary signed broadcast, so every nearby device (Armada or bitchat)
 * relays the opaque blob but only key-holders can read it. Messages we can't
 * open are never shown — and never leak into `# nearby mesh`.
 *
 * Identity: the mesh keeps its native crypto identity; we only push the
 * logged-in Nostr profile name down as the announced nickname. In-channel
 * reveal is a separate, per-channel, sealed Nostr-signed attestation.
 *
 * This is the implementation hosted by {@link MeshProvider}. It is mounted ONCE
 * above the router so the conversation history survives navigating away from
 * the Mesh page (the native side has no history replay — see {@link MeshContext}).
 * UI code should call {@link useMeshTransport}, which reads the provider value.
 */
export function useMeshTransportState(): MeshContextType {
  const { user, metadata } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const incognito = config.meshIncognito;
  const channels = config.meshChannels;
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [directMessages, setDirectMessages] = useState<Record<string, ChatMsg[]>>({});
  const [channelMessages, setChannelMessages] = useState<Record<string, ChatMsg[]>>({});
  const [peers, setPeers] = useState<MeshPeer[]>([]);
  const [available, setAvailable] = useState(false);
  const [started, setStarted] = useState(false);
  const [myPeerID, setMyPeerID] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // A live ref to held channels so the (stable) message listener can open
  // incoming blobs without being re-bound every time the channel list changes.
  const channelsRef = useRef<MeshChannel[]>(channels);
  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);

  // The user's real (non-incognito) name: profile display name → name → an
  // npub-ish fallback so a profileless account still has a stable handle.
  const realName = useMemo(() => {
    return (
      metadata?.display_name?.trim() ||
      metadata?.name?.trim() ||
      (user ? `armada-${user.pubkey.slice(0, 8)}` : "")
    );
  }, [metadata?.display_name, metadata?.name, user]);

  // The nickname actually announced on the mesh. Incognito → a stable
  // `anon<peerid>` derived from our peer id (only known once started, so blank
  // until then and the native side keeps its own anon default in the meantime).
  // Non-incognito → the real name.
  const myNickname = useMemo(() => {
    if (incognito) return myPeerID ? meshAnonName(myPeerID) : "";
    return realName;
  }, [incognito, myPeerID, realName]);

  const setIncognito = useCallback(
    (next: boolean) => updateConfig((c) => ({ ...c, meshIncognito: next })),
    [updateConfig],
  );

  // ── Channel management (persisted in app config) ─────────────────────────
  const addChannel = useCallback(
    (channel: MeshChannel) =>
      updateConfig((c) => {
        if (c.meshChannels.some((x) => x.id === channel.id)) return c;
        return { ...c, meshChannels: [...c.meshChannels, channel] };
      }),
    [updateConfig],
  );

  const createChannel = useCallback(
    (name: string, color: string): MeshChannel => {
      const channel = createMeshChannel(name, color);
      addChannel(channel);
      return channel;
    },
    [addChannel],
  );

  const removeChannel = useCallback(
    (channelId: string) => {
      updateConfig((c) => ({
        ...c,
        meshChannels: c.meshChannels.filter((x) => x.id !== channelId),
      }));
      setChannelMessages((prev) => {
        const next = { ...prev };
        delete next[channelId];
        return next;
      });
    },
    [updateConfig],
  );

  // De-dupe incoming messages by id (the mesh floods, so the same packet can
  // surface more than once) and keep ascending (oldest-first) order.
  const seenIds = useRef<Set<string>>(new Set());
  const seenPrivateIds = useRef<Set<string>>(new Set());
  const seenChannelIds = useRef<Set<string>>(new Set());

  const appendChannelMessage = useCallback((channelId: string, event: ChatMsg) => {
    if (seenChannelIds.current.has(event.id)) return;
    seenChannelIds.current.add(event.id);
    setChannelMessages((prev) => {
      const next = [...(prev[channelId] ?? []), event];
      next.sort((a, b) => a.created_at - b.created_at);
      return { ...prev, [channelId]: next };
    });
  }, []);

  const appendMessage = useCallback(
    (m: MeshMessage) => {
      // Private (Noise DM) path. A DM body may be a channel-invite bundle —
      // install the channel instead of showing raw text.
      if (m.isPrivate) {
        const peerID = m.senderPeerID;
        if (!peerID || seenPrivateIds.current.has(m.id)) return;
        seenPrivateIds.current.add(m.id);
        const invite = decodeChannelInvite(m.content);
        if (invite) {
          addChannel(invite);
          return;
        }
        setDirectMessages((prev) => {
          const nextMessages = [...(prev[peerID] ?? []), meshToEvent(m)];
          nextMessages.sort((a, b) => a.created_at - b.created_at);
          return { ...prev, [peerID]: nextMessages };
        });
        return;
      }

      // Private-channel frame: try to open against held keys. Openable → route
      // to that channel. Not openable (someone else's channel) → drop from the
      // UI entirely (it was already relayed natively; never show in broadcast).
      if (isChannelFrame(m.content)) {
        const frame = decodeChannelFrame(m.content);
        if (!frame) return;
        const hit = openAgainstChannels(channelsRef.current, frame.tag, frame.ciphertext);
        if (!hit) return;
        appendChannelMessage(
          hit.channel.id,
          channelToEvent(
            hit.message.id,
            hit.message.senderPeerID,
            hit.message.content,
            hit.message.timestamp,
            hit.message.reveal,
          ),
        );
        return;
      }

      // Ordinary public broadcast.
      if (seenIds.current.has(m.id)) return;
      seenIds.current.add(m.id);
      setMessages((prev) => {
        const next = [...prev, meshToEvent(m)];
        next.sort((a, b) => a.created_at - b.created_at);
        return next;
      });
    },
    [addChannel, appendChannelMessage],
  );

  const start = useCallback(async () => {
    setError(null);
    try {
      // Announce a name up front when we already have one. Incognito's anon
      // name needs the peer id (only known after start), so it's announced by
      // the sync effect below once `myNickname` resolves; until then the native
      // side keeps its own anon default, so we still read as anonymous.
      if (myNickname) await BluetoothMesh.setNickname({ nickname: myNickname });
      const { peerID } = await BluetoothMesh.start();
      setMyPeerID(peerID);
      setStarted(true);
      try {
        const { peers: p } = await BluetoothMesh.getPeers();
        setPeers(p);
      } catch { /* roster arrives via the "peers" event too */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStarted(false);
    }
  }, [myNickname]);

  const stop = useCallback(async () => {
    try {
      await BluetoothMesh.stop();
    } finally {
      setStarted(false);
    }
  }, []);

  // Probe availability + wire listeners once.
  useEffect(() => {
    let cancelled = false;
    const handles: Array<{ remove: () => Promise<void> }> = [];
    (async () => {
      try {
        const { available: avail } = await BluetoothMesh.isAvailable();
        if (cancelled) return;
        setAvailable(avail);
        if (avail) {
          handles.push(await BluetoothMesh.addListener("message", appendMessage));
          handles.push(
            await BluetoothMesh.addListener("peers", (d) => setPeers(d.peers)),
          );
        }
      } catch {
        if (!cancelled) setAvailable(false);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      for (const h of handles) void h.remove();
    };
  }, [appendMessage]);

  // Auto-start once available. Incognito doesn't need a nickname up front (the
  // native anon default covers the gap until our peer id resolves); otherwise
  // wait for the real name so we never announce a blank.
  useEffect(() => {
    if (available && !started && (incognito || realName)) void start();
    // Only react to availability/name readiness; `start` is stable enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, incognito, realName]);

  // Keep the announced nickname in sync when it changes mid-session (profile
  // edit, incognito toggle, or the anon name resolving once we learn our peer id).
  useEffect(() => {
    if (started && myNickname) void BluetoothMesh.setNickname({ nickname: myNickname }).catch(() => {});
  }, [started, myNickname]);

  const send = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      // Optimistic local echo (the mesh does not loop our own messages back).
      appendMessage({
        id: `local-${crypto.randomUUID()}`.toUpperCase(),
        sender: myNickname || "me",
        content: trimmed,
        timestamp: Date.now(),
        senderPeerID: myPeerID,
        channel: null,
        isPrivate: false,
      });
      await BluetoothMesh.sendMessage({ content: trimmed });
    },
    [appendMessage, myNickname, myPeerID],
  );

  const sendPrivate = useCallback(
    async (peer: MeshPeer, content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      const messageID = crypto.randomUUID().toUpperCase();
      const now = Date.now();
      const localMessage = meshToEvent({
        id: messageID,
        sender: myNickname || "me",
        content: trimmed,
        timestamp: now,
        senderPeerID: myPeerID,
        channel: null,
        isPrivate: true,
      });
      setDirectMessages((prev) => {
        const nextMessages = [...(prev[peer.peerID] ?? []), localMessage];
        nextMessages.sort((a, b) => a.created_at - b.created_at);
        return { ...prev, [peer.peerID]: nextMessages };
      });
      await BluetoothMesh.sendPrivateMessage({
        content: trimmed,
        peerID: peer.peerID,
        nickname: peer.nickname,
        messageID,
      });
    },
    [myPeerID, myNickname],
  );

  // Send a message to a private channel. `revealSelf` attaches a Nostr-signed
  // in-channel reveal (members-only); otherwise the sender posts incognito.
  const sendChannel = useCallback(
    async (channelId: string, content: string, revealSelf = false) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      const channel = channelsRef.current.find((c) => c.id === channelId);
      if (!channel || !myPeerID) return;

      let identity: ChannelSendIdentity = { kind: "incognito" };
      if (revealSelf && user) {
        try {
          const template = buildRevealTemplate(channel.id, myPeerID, realName || user.pubkey.slice(0, 8));
          const reveal = await user.signer.signEvent(template);
          identity = { kind: "reveal", reveal };
        } catch {
          // Signing failed/declined → fall back to incognito rather than blocking the send.
          identity = { kind: "incognito" };
        }
      }

      const id = crypto.randomUUID().toUpperCase();
      const ts = Date.now();
      const { tag, ciphertext } = sealChannelMessage(channel, {
        id,
        content: trimmed,
        senderPeerID: myPeerID,
        timestamp: ts,
        identity,
      });

      // Optimistic local echo (the mesh doesn't loop our own messages back).
      appendChannelMessage(
        channelId,
        channelToEvent(
          id,
          myPeerID,
          trimmed,
          ts,
          identity.kind === "reveal" && user ? { pubkey: user.pubkey, name: realName } : undefined,
        ),
      );

      await BluetoothMesh.sendChannelMessage({ content: encodeChannelFrame(tag, ciphertext) });
    },
    [appendChannelMessage, myPeerID, realName, user],
  );

  // Hand a channel's key to a specific nearby peer over the Noise DM, adding
  // them to the channel. The bundle is framed so the recipient installs it.
  const inviteToChannel = useCallback(
    async (channelId: string, peer: MeshPeer) => {
      const channel = channelsRef.current.find((c) => c.id === channelId);
      if (!channel) return;
      await BluetoothMesh.sendPrivateMessage({
        content: encodeChannelInvite(channel),
        peerID: peer.peerID,
        nickname: peer.nickname,
        messageID: crypto.randomUUID().toUpperCase(),
      });
    },
    [],
  );

  const transport = useMemo<ChatTransport>(
    () => ({
      messages,
      isLoading,
      canWrite: started,
      canModerate: false,
    }),
    [messages, isLoading, started],
  );

  const mesh = useMemo<MeshState>(
    () => ({
      available, started, myPeerID, peers, directMessages, channelMessages, channels, error,
      incognito, myNickname, start, stop, setIncognito,
      createChannel, removeChannel, inviteToChannel,
    }),
    [
      available, started, myPeerID, peers, directMessages, channelMessages, channels, error,
      incognito, myNickname, start, stop, setIncognito,
      createChannel, removeChannel, inviteToChannel,
    ],
  );

  return useMemo(
    () => ({ transport, mesh, send, sendPrivate, sendChannel }),
    [transport, mesh, send, sendPrivate, sendChannel],
  );
}

/**
 * Read the app-wide Bluetooth-mesh transport (provided by {@link MeshProvider}).
 * Throws if used outside the provider — every consumer is under it via
 * `App.tsx`.
 */
export function useMeshTransport(): MeshContextType {
  const ctx = useContext(MeshContext);
  if (!ctx) {
    throw new Error("useMeshTransport must be used within a MeshProvider");
  }
  return ctx;
}
