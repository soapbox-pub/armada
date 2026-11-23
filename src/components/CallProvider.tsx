import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FloatingCallStage } from "@/components/chat/FloatingCallStage";
import { MobileCallPreview } from "@/components/chat/MobileCallPreview";
import { useCallForegroundService } from "@/hooks/useCallForegroundService";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { usePinScrollOrigin } from "@/hooks/usePinScrollOrigin";
import {
  CallContext,
  type ActiveCall,
  type CallSummary,
  type ConcordVoiceContext,
  type DmVoiceContext,
} from "@/contexts/CallContext";
import { VoiceActivityContext } from "@/contexts/VoiceActivityContext";
import { holdBackgroundActivity } from "@/lib/backgroundQuiet";
import { cn } from "@/lib/utils";

/** LiveKit (~0.5MB) loads lazily on the first call join. */
const PersistentVoiceRoom = lazy(() => import("@/components/PersistentVoiceRoom"));

const NO_SPEAKERS: ReadonlySet<string> = new Set();

/** Order-insensitive set equality (speaker sets are tiny). */
function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** Element-wise list equality (rosters are tiny and order-stable). */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * App-level voice call state. Renders the persistent LiveKitRoom so navigation
 * doesn't tear down the call.
 */
export function CallProvider({ children }: { children: React.ReactNode }) {
  const { user } = useCurrentUser();
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  // Never hand the background to the native service mid-call (see backgroundQuiet.ts).
  const inCall = activeCall !== null;
  useEffect(() => (inCall ? holdBackgroundActivity("call") : undefined), [inCall]);
  const [exiting, setExiting] = useState(false);
  const [slots, setSlots] = useState<HTMLElement[]>([]);
  const [stageSlots, setStageSlots] = useState<HTMLElement[]>([]);
  // Floating-window hosts, registered by FloatingCallStage (desktop) or
  // MobileCallPreview (mobile). Tracked per variant so one variant's cleanup
  // during a breakpoint change can't clobber the other's registration.
  const [floatingHosts, setFloatingHosts] = useState<{
    desktop: HTMLElement | null;
    mobile: HTMLElement | null;
  }>({ desktop: null, mobile: null });
  const floatingSlot = floatingHosts.desktop ?? floatingHosts.mobile;
  const floatingVariant: "desktop" | "mobile" | null = floatingHosts.desktop
    ? "desktop"
    : floatingHosts.mobile
      ? "mobile"
      : null;
  const [stageOpen, setStageOpen] = useState(false);
  // MobileCallBar's measured height (incl. safe area); 0 when not mounted.
  const [callBarHeight, setCallBarHeightState] = useState(0);
  const setCallBarHeight = useCallback((px: number) => {
    setCallBarHeightState((prev) => (prev === px ? prev : px));
  }, []);
  // Floating window dismissed (still in the call); the stage parks off-DOM.
  const [floatingHidden, setFloatingHidden] = useState(false);
  // Registered by the connected room, which owns its route.
  const [focusActiveCall, setFocusActiveCall] = useState<(() => void) | null>(null);
  // Label for the Android ongoing-call notification, registered by the room.
  const [callSummary, setCallSummary] = useState<CallSummary | null>(null);
  // The following live sets are reported by the connected room so they render
  // outside the LiveKit context (sidebar rosters).
  const [speakingPubkeys, setSpeakingState] = useState<ReadonlySet<string>>(NO_SPEAKERS);
  const [mutedPubkeys, setMutedState] = useState<ReadonlySet<string>>(NO_SPEAKERS);
  const [streamingPubkeys, setStreamingState] = useState<ReadonlySet<string>>(NO_SPEAKERS);
  // Streamers this client has opted into (ScreenShareWatchContext); per call.
  const [watchedStreams, setWatchedStreams] = useState<ReadonlySet<string>>(NO_SPEAKERS);
  // Concord only; empty in NIP-29/DM calls.
  const [raisedHands, setRaisedHandsState] = useState<ReadonlySet<string>>(NO_SPEAKERS);
  // LiveKit truth, rather than laggy relay presence. Null while not connected.
  const [voiceRoomPubkeys, setRosterState] = useState<readonly string[] | null>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // MobileCallBar writes `--call-bar-h` here.
  const shellRef = useRef<HTMLDivElement>(null);
  // `overflow-hidden` to CLIP, never scroll; a stray scroll offset freezes touch.
  usePinScrollOrigin(shellRef);

  const joinCall = useCallback((relayUrl: string, groupId: string) => {
    if (exitTimer.current) {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
    setExiting(false);
    setStageOpen(true);
    setActiveCall({ relayUrl, groupId });
  }, []);

  const joinDmCall = useCallback((ctx: DmVoiceContext) => {
    if (exitTimer.current) {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
    setExiting(false);
    setStageOpen(true);
    // A new call id changes the remount key (`${relayUrl}|${groupId}`), so the
    // room rebuilds against the new secret.
    setActiveCall({ relayUrl: ctx.broker, groupId: ctx.callId, dmPeer: ctx.peer, dm: ctx });
  }, []);

  const joinConcordCall = useCallback((ctx: ConcordVoiceContext) => {
    if (exitTimer.current) {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
    setExiting(false);
    setStageOpen(true);
    // Room name + token derive inside ConcordVoiceRoom from the channel.
    setActiveCall({ relayUrl: ctx.broker ?? "", groupId: ctx.channel.idHex, concord: ctx });
  }, []);

  // Keep the room mounted for the slide-out, then unmount (disconnects). The
  // leave chirp plays in VoiceBar's onClick, inside the user gesture.
  const leaveCall = useCallback(() => {
    setExiting(true);
    setStageOpen(false);
    setFloatingHidden(false);
    setSpeakingState(NO_SPEAKERS);
    setMutedState(NO_SPEAKERS);
    setRaisedHandsState(NO_SPEAKERS);
    setRosterState(null);
    if (exitTimer.current) clearTimeout(exitTimer.current);
    exitTimer.current = setTimeout(() => {
      setActiveCall(null);
      setExiting(false);
      exitTimer.current = null;
    }, 200);
  }, []);

  useEffect(() => () => {
    if (exitTimer.current) clearTimeout(exitTimer.current);
  }, []);

  const registerCallBarSlot = useCallback((el: HTMLElement) => {
    setSlots((prev) => (prev.includes(el) ? prev : [...prev, el]));
    return () => setSlots((prev) => prev.filter((s) => s !== el));
  }, []);

  const registerCallStageSlot = useCallback((el: HTMLElement) => {
    setStageSlots((prev) => (prev.includes(el) ? prev : [...prev, el]));
    return () => setStageSlots((prev) => prev.filter((s) => s !== el));
  }, []);

  const registerFloatingSlot = useCallback(
    (el: HTMLElement | null, variant: "desktop" | "mobile" = "desktop") => {
      setFloatingHosts((prev) => (prev[variant] === el ? prev : { ...prev, [variant]: el }));
    },
    [],
  );

  const registerFocusActiveCall = useCallback((fn: (() => void) | null) => {
    // Functional form: React would otherwise call `fn` as an updater.
    setFocusActiveCall(() => fn);
  }, []);

  // Value-guarded, or every re-register would re-post the OS notification.
  const registerCallSummary = useCallback((summary: CallSummary | null) => {
    setCallSummary((prev) =>
      prev?.title === summary?.title && prev?.subtitle === summary?.subtitle && prev?.icon === summary?.icon
        ? prev
        : summary,
    );
  }, []);

  // Android foreground service keeps a backgrounded call alive. Includes
  // `exiting`, so it outlives the slide-out like the connection does.
  useCallForegroundService(Boolean(user && activeCall), callSummary, leaveCall);

  const hasNormalSlot = stageSlots.length > 0;

  // Returning to the call's channel clears a stale floating-window dismissal.
  useEffect(() => {
    if (hasNormalSlot) setFloatingHidden(false);
  }, [hasNormalSlot]);

  // A call-lifetime host the stage portals into, *reparented* between the normal
  // slot, floating window, or detached. Reparenting keeps CallStage mounted so
  // video subscriptions and stage state survive navigation (a remount pauses
  // remote video and drops it on the E2EE Concord path).
  const stageHost = useMemo(() => {
    const el = document.createElement("div");
    el.style.display = "contents";
    return el;
  }, []);

  // A normal slot always wins, so full stage and floating window never both show.
  const stageTarget = hasNormalSlot ? stageSlots[stageSlots.length - 1] : floatingSlot;

  useEffect(() => {
    if (stageTarget) {
      stageTarget.appendChild(stageHost);
      // Browsers pause detached media elements and re-insertion doesn't resume them
      // (LiveKit only plays on attach/visibility change), so kick them.
      for (const video of stageHost.querySelectorAll("video")) {
        if (video.paused) video.play().catch(() => {});
      }
    } else {
      stageHost.remove();
    }
  }, [stageTarget, stageHost]);
  useEffect(() => () => stageHost.remove(), [stageHost]);

  // Away from the call's channel, toggle the floating window. `stageOpen` is the
  // docked-stage preference only and is left alone on that path.
  const toggleStage = useCallback(() => {
    if (hasNormalSlot) setStageOpen((o) => !o);
    else setFloatingHidden((h) => !h);
  }, [hasNormalSlot]);

  // Equality-guarded so frequent room reports only re-render on real changes.
  const setSpeakingPubkeys = useCallback((next: Set<string>) => {
    setSpeakingState((prev) => (sameSet(prev, next) ? prev : next));
  }, []);

  const setMutedPubkeys = useCallback((next: Set<string>) => {
    setMutedState((prev) => (sameSet(prev, next) ? prev : next));
  }, []);

  const setStreamingPubkeys = useCallback((next: Set<string>) => {
    setStreamingState((prev) => (sameSet(prev, next) ? prev : next));
  }, []);

  useEffect(() => setWatchedStreams(NO_SPEAKERS), [activeCall]);

  // Tuning in also brings the stage on screen, wherever it lives.
  const watchStream = useCallback((owner: string) => {
    setWatchedStreams((prev) => (prev.has(owner) ? prev : new Set(prev).add(owner)));
    if (hasNormalSlot) setStageOpen(true);
    else setFloatingHidden(false);
  }, [hasNormalSlot]);

  const stopWatchingStream = useCallback((owner: string) => {
    setWatchedStreams((prev) => {
      if (!prev.has(owner)) return prev;
      const next = new Set(prev);
      next.delete(owner);
      return next;
    });
  }, []);

  const setRaisedHands = useCallback((next: Set<string>) => {
    setRaisedHandsState((prev) => (sameSet(prev, next) ? prev : next));
  }, []);

  const setVoiceRoomPubkeys = useCallback((next: readonly string[] | null) => {
    setRosterState((prev) => {
      if (prev === next) return prev;
      if (prev && next && sameList(prev, next)) return prev;
      return next;
    });
  }, []);

  // Which floating destination mounts is decided by each component's responsive
  // CSS; exactly one registers its host.
  const showFloating = Boolean(user && activeCall) && !hasNormalSlot && !floatingHidden && !exiting;
  const stageFloating = showFloating && floatingSlot !== null;

  // `showFloating`, not `stageFloating`: the latter waits a commit for host
  // registration and would briefly contradict the label.
  const stageVisible = hasNormalSlot ? stageOpen : showFloating;
  const stageDocked = Boolean(user && activeCall) && hasNormalSlot;

  // Memoized: this provider holds fast-moving state. The live sets are in
  // `VoiceActivityContext` so this changes at human speed.
  const callValue = useMemo(
    () => ({
      activeCall,
      joinCall,
      joinDmCall,
      joinConcordCall,
      leaveCall,
      registerCallBarSlot,
      registerCallStageSlot,
      stageOpen,
      toggleStage,
      setStageOpen,
      stageVisible,
      stageDocked,
      exiting,
      stageFloating,
      floatingVariant,
      callBarHeight,
      setCallBarHeight,
      floatingHidden,
      setFloatingHidden,
      focusActiveCall,
      registerFocusActiveCall,
      registerCallSummary,
      setSpeakingPubkeys,
      setMutedPubkeys,
      setStreamingPubkeys,
      watchStream,
      stopWatchingStream,
      setRaisedHands,
      setVoiceRoomPubkeys,
    }),
    [
      activeCall,
      joinCall,
      joinDmCall,
      joinConcordCall,
      leaveCall,
      registerCallBarSlot,
      registerCallStageSlot,
      stageOpen,
      toggleStage,
      stageVisible,
      stageDocked,
      exiting,
      stageFloating,
      floatingVariant,
      callBarHeight,
      setCallBarHeight,
      floatingHidden,
      focusActiveCall,
      registerFocusActiveCall,
      registerCallSummary,
      setSpeakingPubkeys,
      setMutedPubkeys,
      setStreamingPubkeys,
      watchStream,
      stopWatchingStream,
      setRaisedHands,
      setVoiceRoomPubkeys,
    ],
  );

  // The per-frame half, reaching only live voice-activity renderers.
  const voiceActivityValue = useMemo(
    () => ({ speakingPubkeys, mutedPubkeys, streamingPubkeys, watchedStreams, raisedHands, voiceRoomPubkeys }),
    [speakingPubkeys, mutedPubkeys, streamingPubkeys, watchedStreams, raisedHands, voiceRoomPubkeys],
  );

  return (
    <CallContext.Provider value={callValue}>
      <VoiceActivityContext.Provider value={voiceActivityValue}>
      <div
        ref={shellRef}
        className={cn(
          "relative flex h-full w-full overflow-hidden",
          // Mobile: reserve the fixed call bar's measured height. Desktop: the bar is in the sidebar.
          // The bar already clears the bottom inset, so content above it drops its own —
          // only while the bar is mounted (it isn't on the call's own channel).
          user && activeCall && "max-sidebar:pb-[var(--call-bar-h,0px)]",
          user && activeCall && callBarHeight > 0 && "max-sidebar:[--safe-area-pad-bottom:0px] max-sidebar:[--bottom-chrome-pad:0.5rem]",
        )}
      >
        {children}
        {user && activeCall && (
          <Suspense fallback={null}>
            {/* Keyed on the voice room pubkey (SFU room name + token grant identity),
                which changes on any epoch roll or refounding, keeping mint/remount in step. */}
            <PersistentVoiceRoom
              key={
                activeCall.concord
                  ? `concord|${activeCall.concord.channel.idHex}|${activeCall.concord.channel.voice.room.pk}|${activeCall.concord.broker}`
                  : `${activeCall.relayUrl}|${activeCall.groupId}`
              }
              call={activeCall}
              onLeave={leaveCall}
              slots={slots}
              stageHost={stageHost}
              stageOpen={stageOpen}
              exiting={exiting}
              shellRef={shellRef}
            />
          </Suspense>
        )}
        {/* Only ONE registers its host at a time (by breakpoint); the persistent stage
            host is reparented into it, with no remount or second connection. */}
        {showFloating && (
          <>
            <FloatingCallStage
              registerSlot={registerFloatingSlot}
              onExpand={focusActiveCall ?? undefined}
              onHide={() => setFloatingHidden(true)}
            />
            <MobileCallPreview
              registerSlot={registerFloatingSlot}
              onExpand={focusActiveCall ?? undefined}
              onHide={() => setFloatingHidden(true)}
            />
          </>
        )}
      </div>
      </VoiceActivityContext.Provider>
    </CallContext.Provider>
  );
}
