import { createContext } from "react";

import type { Channel, Community } from "@/concord/lib/types";

/**
 * A Concord (CORD-07) E2EE voice room: community + channel (whose keys derive the
 * room, token grant and media keys) and the §5-chosen blind broker origin; null
 * when none answered, and the call is peer to peer only (CORD-07 §8).
 */
export interface ConcordVoiceContext {
  community: Community;
  channel: Channel;
  broker: string | null;
}

/**
 * A 1:1 DM voice room (`src/lib/dmCall.ts`): peer, per-call secret, call id (SFU
 * room name) and broker origin. Same blind-broker token path as Concord.
 */
export interface DmVoiceContext {
  peer: string;
  callId: string;
  secretHex: string;
  broker: string;
}

/** Identifies a single voice room (a NIP-29 group, a 1:1 DM call, or a Concord channel). */
export interface ActiveCall {
  relayUrl: string;
  /** The LiveKit room id: a NIP-29 group id, or a DM call id (room pubkey). */
  groupId: string;
  /** For DM calls, the peer's hex pubkey (mirror of `dm.peer`) for quick checks. */
  dmPeer?: string;
  /** For DM calls, the blind-broker voice context. */
  dm?: DmVoiceContext;
  /** For Concord calls: blind-broker token path + per-sender E2EE instead of the NIP-29 relay token. */
  concord?: ConcordVoiceContext;
}

/**
 * How the active call reads outside the app (the Android ongoing-call
 * notification, `useCallForegroundService`), registered by the connected room.
 */
export interface CallSummary {
  /** The room as the user knows it: "#general", or a DM peer's display name. */
  title: string;
  /** Where that room lives: a server or community name. Absent for DMs. */
  subtitle?: string;
  /** The community/server icon or DM peer's avatar, as a small `data:` URL. */
  icon?: string;
}

export interface CallContextType {
  activeCall: ActiveCall | null;
  /** Connect to a group's voice room (replaces any current call). */
  joinCall: (relayUrl: string, groupId: string) => void;
  /** Connect to a 1:1 DM room; signaling is owned by DmCallProvider. */
  joinDmCall: (ctx: DmVoiceContext) => void;
  /** Connect to a Concord channel's room (CORD-07 blind broker + per-sender E2EE). */
  joinConcordCall: (ctx: ConcordVoiceContext) => void;
  leaveCall: () => void;
  /**
   * Register a sidebar node for the call bar. Multiple slots may register (desktop
   * pane, mobile drawer); each host controls its visibility. Returns an unregister.
   */
  registerCallBarSlot: (el: HTMLElement) => () => void;
  /**
   * Register the top-of-chat node for the call stage (only the matching chat
   * surface). Returns an unregister.
   */
  registerCallStageSlot: (el: HTMLElement) => () => void;
  /** Whether the call stage box is currently expanded. */
  stageOpen: boolean;
  /**
   * Show/hide this route's stage: docked box on the call's channel, floating window
   * elsewhere. The floating path leaves `stageOpen` alone.
   */
  toggleStage: () => void;
  /** Explicitly set the call stage open state (the stage's close button uses this). */
  setStageOpen: (open: boolean) => void;
  /**
   * Whether a stage is actually on screen. `stageOpen` only drives the DOCKED box,
   * so off the call's channel it's a deferred preference.
   */
  stageVisible: boolean;
  /**
   * Whether the stage is docked in the call's own chat. The docked strip/stage
   * then carries the controls, so the mobile call bar steps aside.
   */
  stageDocked: boolean;
  /** The call is sliding out after a leave (the room is still mounted). */
  exiting: boolean;
  /**
   * Whether the stage is in the floating desktop window (no normal slot, not hidden,
   * desktop width). The same stage host is reparented, so no duplicate media.
   */
  stageFloating: boolean;
  /**
   * Which floating destination hosts the stage: `"desktop"` (full controls) or
   * `"mobile"` (MobileCallBar carries the controls). Null when not floating.
   */
  floatingVariant: "desktop" | "mobile" | null;
  /**
   * MobileCallBar's measured height incl. safe area, used to position the mobile
   * preview reactively (not via `--call-bar-h`). 0 when not mounted.
   */
  callBarHeight: number;
  /** Internal: MobileCallBar reports its measured height (incl. safe area) here. */
  setCallBarHeight: (px: number) => void;
  /**
   * Whether the floating window was dismissed without leaving. The stage parks
   * off-DOM (subscriptions alive). Reset on returning to a slot or a new call.
   */
  floatingHidden: boolean;
  /** Hide the floating video window (the floating window's close button). */
  setFloatingHidden: (hidden: boolean) => void;
  /** Navigate to the active call's conversation (registered by the room); null before registration. */
  focusActiveCall: (() => void) | null;
  /** Internal: the connected room registers its navigate-to-call handler here. */
  registerFocusActiveCall: (fn: (() => void) | null) => void;
  /** Internal: the room registers its outside-the-app label; null until its name resolves. */
  registerCallSummary: (summary: CallSummary | null) => void;
  // Live speaker/muted/hand/roster VALUES live in `VoiceActivityContext` (they
  // change several times a second); only the setters are here.
  /** Internal: the connected room reports its live speaker set here. */
  setSpeakingPubkeys: (pubkeys: Set<string>) => void;
  /** Internal: the connected room reports its live muted set here. */
  setMutedPubkeys: (pubkeys: Set<string>) => void;
  /** Internal: the connected room reports who is screen sharing here. */
  setStreamingPubkeys: (pubkeys: Set<string>) => void;
  /** Opt into a streamer's screen share (pubkey, or bare identity if unverified) and show the stage. */
  watchStream: (owner: string) => void;
  stopWatchingStream: (owner: string) => void;
  /** Internal: the connected Concord room reports its raised-hand set here. */
  setRaisedHands: (pubkeys: Set<string>) => void;
  /** Internal: the connected room reports its live participant roster here. */
  setVoiceRoomPubkeys: (pubkeys: readonly string[] | null) => void;
}

export const CallContext = createContext<CallContextType | undefined>(undefined);
