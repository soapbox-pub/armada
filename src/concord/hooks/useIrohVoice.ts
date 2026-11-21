import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { CallAllowance } from "@/concord/lib/callGate";
import { p2pTargets } from "@/concord/lib/irohVoice";
import type { IrohAddress, VoicePresenceFold } from "@/concord/lib/voice";
import { IrohVoiceAudio, irohAudioSupported } from "@/lib/irohVoice/audio";
import { IrohVoiceCall, type LinkedPeer } from "@/lib/irohVoice/call";
import { voiceNodeBinder } from "@/lib/realtimeTransport";
import { getPreferredSpeakerId, getUserVolume, subscribeUserVolumes, subscribeVoiceDevices } from "@/lib/voiceDevices";

export type IrohVoiceStatus = "off" | "starting" | "on" | "unavailable";

/**
 * Why peer to peer is off: this build has no iroh module (`npm run build:wasm` didn't run or
 * failed), this browser has no WebCodecs Opus, or the endpoint wouldn't bind.
 */
export type IrohUnavailable = "build" | "browser" | "start";

export interface IrohVoiceOptions {
  /** In the call: binds an endpoint for as long as this holds. */
  enabled: boolean;
  /** On the LiveKit call: then only members off it are linked. */
  onSfu: boolean;
  fold: VoicePresenceFold;
  me: string | undefined;
  /** The Community's iroh relays (`communityVoiceRelays`). */
  relays: readonly string[];
  /** The microphone the call sends, already through its processing. */
  micTrack: MediaStreamTrack | undefined;
  muted: boolean;
  /** The call's gate (`callGateFor`): who is heard, and whether we may speak. */
  gate: ((pubkey: string) => CallAllowance) | undefined;
}

export interface IrohVoice {
  status: IrohVoiceStatus;
  /** Set while `status` is `"unavailable"`. */
  unavailable?: IrohUnavailable;
  /** What our presence names, once bound. */
  address: IrohAddress | undefined;
  /** The members linked now. */
  linked: LinkedPeer[];
}

const NONE: LinkedPeer[] = [];

/** Whether this build and browser can hold a peer-to-peer call: the iroh module, and WebCodecs Opus. */
export async function peerToPeerAvailable(): Promise<boolean> {
  return irohAudioSupported() && Boolean(await voiceNodeBinder());
}
const noop = () => () => undefined;

/**
 * A voice Channel's peer-to-peer half (CORD-07 §8): a fresh iroh endpoint for the
 * call, linked to each member the LiveKit call doesn't carry to us — Vector, or
 * an Armada member whose LiveKit failed — until they join it.
 */
export function useIrohVoice(opts: IrohVoiceOptions): IrohVoice {
  const { enabled, onSfu, fold, me, relays, micTrack, muted, gate } = opts;
  const [call, setCall] = useState<{ call: IrohVoiceCall; audio: IrohVoiceAudio } | undefined>();
  const [status, setStatus] = useState<IrohVoiceStatus>("off");
  const [unavailable, setUnavailable] = useState<IrohUnavailable | undefined>();
  const [address, setAddress] = useState<IrohAddress | undefined>();
  const relaysKey = relays.join(",");

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let held: IrohVoiceCall | undefined;
    setStatus("starting");
    const off = (why: IrohUnavailable, detail?: unknown) => {
      console.warn(`[iroh voice] peer-to-peer calls are off here (${why})`, detail ?? "");
      setUnavailable(why);
      setStatus("unavailable");
    };
    void (async () => {
      if (!irohAudioSupported()) return off("browser", "no WebCodecs AudioEncoder/AudioDecoder or AudioWorklet");
      const bind = await voiceNodeBinder();
      if (cancelled) return;
      if (!bind) return off("build", "the iroh wasm module (crates/webxdc-rt) isn't in this build, or predates VoiceNode");
      let audio: IrohVoiceAudio | undefined;
      try {
        held = await IrohVoiceCall.start(bind, relaysKey ? relaysKey.split(",") : [], (send) => (audio = new IrohVoiceAudio(send)));
      } catch (e) {
        if (!cancelled) off("start", e);
        return;
      }
      if (cancelled) {
        void held.stop();
        return;
      }
      setCall({ call: held, audio: audio! });
      setAddress(held.address());
      setStatus("on");
    })();
    return () => {
      cancelled = true;
      void held?.stop();
      setCall(undefined);
      setAddress(undefined);
      setUnavailable(undefined);
      setStatus("off");
    };
  }, [enabled, relaysKey]);

  // The relay a browser homes on can change; presence must name the current one.
  useEffect(() => {
    if (!call) return;
    const timer = setInterval(() => {
      const next = call.call.address();
      setAddress((prev) => (prev?.endpoint === next.endpoint && prev.relay === next.relay ? prev : next));
    }, 5_000);
    return () => clearInterval(timer);
  }, [call]);

  const mine = address?.endpoint;
  useEffect(() => {
    if (!call || !me || !mine) return;
    call.call.setTargets(p2pTargets(fold, me, { onSfu, endpoint: mine, communityRelays: relays }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, fold, me, mine, onSfu, relaysKey]);

  const gateRef = useRef(gate);
  gateRef.current = gate;
  useEffect(() => {
    if (!call) return;
    const apply = () =>
      call.call.setGain((author) => ({ audible: gateRef.current?.(author).speak ?? true, volume: getUserVolume(author) }));
    apply();
    return subscribeUserVolumes(apply);
  }, [call, gate]);

  const maySpeak = !me || (gate?.(me).speak ?? true);
  useEffect(() => {
    call?.audio.setMuted(muted || !maySpeak);
  }, [call, muted, maySpeak]);

  useEffect(() => {
    if (call) void call.audio.setTrack(micTrack);
  }, [call, micTrack]);

  useEffect(() => {
    if (!call) return;
    const apply = () => void call.audio.setSpeaker(getPreferredSpeakerId());
    apply();
    return subscribeVoiceDevices((kind) => {
      if (kind === "audiooutput") apply();
    });
  }, [call]);

  const linked = useSyncExternalStore(
    call ? (l) => call.call.subscribe(l) : noop,
    () => call?.call.linked() ?? NONE,
  );

  return { status, unavailable, address, linked };
}
