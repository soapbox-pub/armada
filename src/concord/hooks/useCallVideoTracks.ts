import { ParticipantEvent, Track, type Room } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";

import type { VideoKind } from "@/concord/lib/irohVideo";
import { getPreferredCameraId } from "@/lib/voiceDevices";

type Sources = Partial<Record<VideoKind, MediaStreamTrack>>;

function same(a: Sources, b: Sources): boolean {
  return a.camera === b.camera && a.screen === b.screen;
}

/**
 * Our camera and screen as LiveKit publishes them, for the peer-to-peer links to send the
 * same pictures to members off the SFU.
 */
export function useLiveKitVideoTracks(room: Room | null, enabled: boolean): Sources {
  const [sources, setSources] = useState<Sources>({});
  useEffect(() => {
    if (!enabled || !room) return;
    const lp = room.localParticipant;
    const read = () => {
      const live = (source: Track.Source) => {
        const pub = lp.getTrackPublication(source);
        const track = pub?.track?.mediaStreamTrack;
        return pub && !pub.isMuted && track?.readyState === "live" ? track : undefined;
      };
      const next: Sources = {};
      const camera = live(Track.Source.Camera);
      const screen = live(Track.Source.ScreenShare);
      if (camera) next.camera = camera;
      if (screen) next.screen = screen;
      setSources((prev) => (same(prev, next) ? prev : next));
    };
    read();
    const events = [ParticipantEvent.LocalTrackPublished, ParticipantEvent.LocalTrackUnpublished, ParticipantEvent.TrackMuted, ParticipantEvent.TrackUnmuted] as const;
    for (const e of events) lp.on(e, read);
    return () => {
      for (const e of events) lp.off(e, read);
      setSources({});
    };
  }, [room, enabled]);
  return sources;
}

/** The call's own camera and screen captures, for a call that is peer to peer alone. */
export function useOwnVideoCapture(enabled: boolean): {
  sources: Sources;
  toggle: (kind: VideoKind) => Promise<void>;
} {
  const [sources, setSources] = useState<Sources>({});
  const held = useRef<Sources>({});
  const stop = useCallback((kind: VideoKind) => {
    held.current[kind]?.stop();
    delete held.current[kind];
    setSources({ ...held.current });
  }, []);
  const toggle = useCallback(
    async (kind: VideoKind) => {
      if (held.current[kind]) return stop(kind);
      try {
        const camera = getPreferredCameraId();
        const stream =
          kind === "camera"
            ? await navigator.mediaDevices.getUserMedia({ video: camera ? { deviceId: camera } : true })
            : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const track = stream.getVideoTracks()[0];
        if (!track) return;
        track.addEventListener("ended", () => {
          if (held.current[kind] === track) stop(kind);
        });
        held.current[kind] = track;
        setSources({ ...held.current });
      } catch (e) {
        console.warn(`[iroh video] no ${kind}`, e);
      }
    },
    [stop],
  );
  useEffect(() => {
    if (enabled) return;
    for (const kind of ["camera", "screen"] as const) if (held.current[kind]) stop(kind);
  }, [enabled, stop]);
  useEffect(
    () => () => {
      for (const t of Object.values(held.current)) t?.stop();
      held.current = {};
    },
    [],
  );
  return { sources, toggle };
}
