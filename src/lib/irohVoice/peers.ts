/**
 * The members a call holds peer-to-peer links with, as the call's UI shows them: who, whether
 * they're talking, muted, and sending a camera or a screen — the same things an Armada
 * participant on LiveKit shows (CORD-07 §4, §8).
 */
import { createContext, useContext } from "react";

import type { Tracks, VideoKind } from "@/concord/lib/irohVideo";
import type { VoicePresenceFold } from "@/concord/lib/voice";
import type { LinkedPeer } from "@/lib/irohVoice/call";

export interface P2pPeerView {
  pubkey: string;
  endpoint: string;
  speaking: boolean;
  /** Their own mute, or a moderator's. */
  muted: boolean;
  /** What their presence says they send. */
  sending: Tracks;
  /** The pictures arriving from them now, decoded. */
  camera?: MediaStreamTrack;
  screen?: MediaStreamTrack;
}

/** What the call shows of us while it runs peer to peer only. */
export interface P2pSelfView {
  pubkey: string;
  speaking: boolean;
  muted: boolean;
  camera?: MediaStreamTrack;
  screen?: MediaStreamTrack;
}

export interface P2pCallView {
  /** A Concord call, where members can be on either transport: tiles say which. */
  connections?: boolean;
  /** Members whose presence puts them on LiveKit and iroh both. */
  onBoth?: ReadonlySet<string>;
  peers: readonly P2pPeerView[];
  /** Set only while the call is peer to peer alone; on LiveKit we're a LiveKit participant. */
  self?: P2pSelfView;
}

/** A level above this, lately, is speech (the speaking ring), as LiveKit's own threshold roughly is. */
export const SPEAKING_LEVEL = 0.03;

/** What each member's presence says of them: muted, and what they send. */
export function presenceFlags(fold: VoicePresenceFold, author: string): { muted: boolean; sending: Tracks } {
  const p = fold.present.find((x) => x.author === author) ?? fold.otherTransport.find((x) => x.author === author);
  return {
    muted: Boolean(p?.muted || p?.deafened || p?.serverMuted || p?.serverDeafened),
    sending: { camera: Boolean(p?.camera), screen: Boolean(p?.screen) },
  };
}

/** The pictures to ask a linked member for: what they send, and may show here (CORD-07 §6). */
export function wantedFrom(fold: VoicePresenceFold, author: string, mayShow: boolean): Tracks {
  if (!mayShow) return { camera: false, screen: false };
  return presenceFlags(fold, author).sending;
}

export function peerViews(
  linked: readonly LinkedPeer[],
  fold: VoicePresenceFold,
  speaking: ReadonlySet<string>,
  track: (endpoint: string, kind: VideoKind) => MediaStreamTrack | undefined,
): P2pPeerView[] {
  return linked.map(({ author, endpoint }) => {
    const { muted, sending } = presenceFlags(fold, author);
    const camera = track(endpoint, "camera");
    const screen = track(endpoint, "screen");
    return {
      pubkey: author,
      endpoint,
      speaking: !muted && speaking.has(endpoint),
      muted,
      sending,
      ...(camera ? { camera } : {}),
      ...(screen ? { screen } : {}),
    };
  });
}

const EMPTY: P2pCallView = { peers: [] };
export const IrohPeersContext = createContext<P2pCallView>(EMPTY);

/** The call's peer-to-peer members; empty outside a Concord call. */
export function useIrohPeers(): P2pCallView {
  return useContext(IrohPeersContext);
}
