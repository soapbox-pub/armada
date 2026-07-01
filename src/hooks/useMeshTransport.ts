import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { MeshContext, type MeshContextType, type MeshState } from "@/contexts/MeshContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { BluetoothMesh, type MeshMessage, type MeshPeer } from "@/lib/bluetoothMesh";
import { meshAnonName } from "@/lib/meshIdentity";
import { parseRebroadcast } from "@/lib/rebroadcast";

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
 *
 * Exception: a **rebroadcastable post** (`/post`) carries a *full signed Nostr
 * event* in its content. Those are unwrapped and verified here, then surfaced
 * AS-IS (real pubkey + sig + kind 1) — so they render with the author's actual
 * Nostr identity and can be relayed verbatim. The event MUST NOT be mutated:
 * its id/signature is computed over its exact fields (including `tags`), so
 * appending even a single tag would invalidate the signature and make every
 * relay reject the rebroadcast with "signature verification failed". A failed
 * verification falls through to the plain mesh-message form (the literal
 * envelope text), which is harmless and makes tampering visible rather than
 * silently trusted.
 */
function meshToEvent(m: MeshMessage): ChatMsg {
  const post = parseRebroadcast(m.content);
  if (post) {
    // Pass the signed event through unchanged — see the warning above.
    return post;
  }
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
 * Drives the Android Bluetooth mesh and exposes it as a {@link ChatTransport}
 * for the shared chat UI. Public (broadcast) mesh chat only in this first cut —
 * a single room of nearby devices. Channels/DMs/reactions/threads are omitted,
 * so the shared components hide those controls automatically.
 *
 * Identity: the mesh keeps its native crypto identity; we only push the
 * logged-in Nostr profile name down as the announced nickname.
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
  // Opt-in gate: the mesh never starts (no permission prompt, no foreground
  // service) until the user turns it on from the Mesh page. Persisted.
  const enabled = config.meshEnabled;
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [directMessages, setDirectMessages] = useState<Record<string, ChatMsg[]>>({});
  const [peers, setPeers] = useState<MeshPeer[]>([]);
  const [available, setAvailable] = useState(false);
  const [started, setStarted] = useState(false);
  const [myPeerID, setMyPeerID] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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

  // De-dupe incoming messages by id (the mesh floods, so the same packet can
  // surface more than once) and keep ascending (oldest-first) order. Rebroadcast
  // posts are additionally de-duped by their Nostr event id, since the same
  // signed note can arrive inside different mesh packets (different carriers
  // relaying it) — collapsing them keeps a single post with one author/button.
  const seenIds = useRef<Set<string>>(new Set());
  const seenPrivateIds = useRef<Set<string>>(new Set());
  const seenEventIds = useRef<Set<string>>(new Set());
  const appendMessage = useCallback((m: MeshMessage) => {
    const post = parseRebroadcast(m.content);
    if (m.isPrivate) {
      const peerID = m.senderPeerID;
      if (!peerID || seenPrivateIds.current.has(m.id)) return;
      if (post && seenEventIds.current.has(post.id)) return;
      seenPrivateIds.current.add(m.id);
      if (post) seenEventIds.current.add(post.id);
      setDirectMessages((prev) => {
        const nextMessages = [...(prev[peerID] ?? []), meshToEvent(m)];
        nextMessages.sort((a, b) => a.created_at - b.created_at);
        return { ...prev, [peerID]: nextMessages };
      });
      return;
    }
    if (seenIds.current.has(m.id)) return;
    if (post && seenEventIds.current.has(post.id)) return;
    seenIds.current.add(m.id);
    if (post) seenEventIds.current.add(post.id);
    setMessages((prev) => {
      const next = [...prev, meshToEvent(m)];
      next.sort((a, b) => a.created_at - b.created_at);
      return next;
    });
  }, []);

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

  const setEnabled = useCallback(
    (next: boolean) => {
      updateConfig((c) => ({ ...c, meshEnabled: next }));
      // Turning off tears the mesh down immediately (stops the FGS + BLE);
      // turning on lets the auto-start effect below bring it up.
      if (!next) void stop().catch(() => undefined);
    },
    [updateConfig, stop],
  );

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

  // Auto-start once available AND the user has opted in. Incognito doesn't
  // need a nickname up front (the native anon default covers the gap until our
  // peer id resolves); otherwise wait for the real name so we never announce a
  // blank. `enabled` is the consent gate: without it we never prompt for
  // Bluetooth permissions or start the foreground service.
  useEffect(() => {
    if (enabled && available && !started && (incognito || realName)) void start();
    // Only react to enablement/availability/name readiness; `start` is stable enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, available, incognito, realName]);

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
      available, probing: isLoading, enabled, started, myPeerID, peers, directMessages, error,
      incognito, myNickname, start, stop, setEnabled, setIncognito,
    }),
    [available, isLoading, enabled, started, myPeerID, peers, directMessages, error, incognito, myNickname, start, stop, setEnabled, setIncognito],
  );

  return useMemo(
    () => ({ transport, mesh, send, sendPrivate }),
    [transport, mesh, send, sendPrivate],
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
