import { createLocalAudioTrack, LocalAudioTrack, ParticipantEvent, Track, type Room } from "livekit-client";
import { useEffect, useState } from "react";

import { syncRnnoise } from "@/lib/voiceProcessor";
import { getAudioProcessing, micCaptureConstraints, subscribeVoiceDevices } from "@/lib/voiceDevices";

/** What a LiveKit mic track sends: its processor's output (RNNoise) where one runs. */
function sentTrack(track: LocalAudioTrack | undefined): MediaStreamTrack | undefined {
  return track?.getProcessor()?.processedTrack ?? track?.mediaStreamTrack;
}

/**
 * The microphone a voice Channel's peer-to-peer links send. On the LiveKit call it
 * is the published mic track, so a peer hears what the SFU does. Off it, a track
 * of the call's own, made the same way — `micCaptureConstraints` and RNNoise — so
 * nothing about the audio depends on which way it travels.
 */
export function useCallMicTrack(room: Room | null, onSfu: boolean, ownTrack: boolean): MediaStreamTrack | undefined {
  const [track, setTrack] = useState<MediaStreamTrack | undefined>();

  useEffect(() => {
    if (!onSfu || !room) return;
    const lp = room.localParticipant;
    const read = () => {
      const pub = lp.getTrackPublication(Track.Source.Microphone);
      const audio = pub?.audioTrack;
      setTrack(audio instanceof LocalAudioTrack ? sentTrack(audio) : undefined);
    };
    read();
    const events = [ParticipantEvent.LocalTrackPublished, ParticipantEvent.LocalTrackUnpublished, ParticipantEvent.TrackMuted, ParticipantEvent.TrackUnmuted] as const;
    for (const e of events) lp.on(e, read);
    // RNNoise attaches after the publish, and a device switch replaces the track in place: no event says so.
    const timer = setInterval(read, 1_000);
    return () => {
      for (const e of events) lp.off(e, read);
      clearInterval(timer);
      setTrack(undefined);
    };
  }, [room, onSfu]);

  useEffect(() => {
    if (!ownTrack) return;
    let cancelled = false;
    let local: LocalAudioTrack | undefined;
    const open = async () => {
      const prev = local;
      local = undefined;
      prev?.stop();
      try {
        const next = await createLocalAudioTrack(micCaptureConstraints());
        if (cancelled) {
          next.stop();
          return;
        }
        await syncRnnoise(next, getAudioProcessing().rnnoise);
        local = next;
        setTrack(sentTrack(next));
      } catch (e) {
        console.warn("[iroh voice] no microphone", e);
        setTrack(undefined);
      }
    };
    void open();
    const stop = subscribeVoiceDevices((kind) => {
      if (kind === "audioinput") void open();
    });
    return () => {
      cancelled = true;
      stop();
      local?.stop();
      setTrack(undefined);
    };
  }, [ownTrack]);

  return track;
}
