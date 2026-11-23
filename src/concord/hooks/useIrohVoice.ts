import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { CallAllowance } from "@/concord/lib/callGate";
import { irohRelayPlan, p2pTargets, type IrohRelayPlan } from "@/concord/lib/irohVoice";
import type { IrohAddress, VoicePresenceFold } from "@/concord/lib/voice";
import { IrohVoiceAudio, irohAudioSupported } from "@/lib/irohVoice/audio";
import { IrohVoiceCall, type LinkedPeer } from "@/lib/irohVoice/call";
import { peerViews, SPEAKING_LEVEL, wantedFrom, type P2pPeerView } from "@/lib/irohVoice/peers";
import { IrohVideo } from "@/lib/irohVoice/video";
import type { VideoKind } from "@/concord/lib/irohVideo";
import { CONCORD_IROH_RELAYS } from "@/lib/platform";
import { irohDefaultRelays, voiceNodeBinder } from "@/lib/realtimeTransport";
import { getPreferredSpeakerId, getUserVolume, subscribeUserVolumes, subscribeVoiceDevices } from "@/lib/voiceDevices";

export type IrohVoiceStatus = "off" | "starting" | "on" | "unavailable";

/**
 * Why peer to peer is off: this build has no iroh module (`npm run build:wasm` didn't run or
 * failed), this browser has no WebCodecs Opus, neither the Community nor the deployment names
 * a relay to home on, or the endpoint wouldn't bind or no relay answered it.
 */
export type IrohUnavailable = "build" | "browser" | "relays" | "start";

export interface IrohVoiceOptions {
  /** In the call: binds an endpoint for as long as this holds. */
  enabled: boolean;
  /** On the LiveKit call: then only members off it are linked. */
  onSfu: boolean;
  fold: VoicePresenceFold;
  me: string | undefined;
  /** The Community's iroh relays (`communityVoiceRelays`), which replace the deployment's when listed. */
  communityRelays: readonly string[];
  /** The microphone the call sends, already through its processing. */
  micTrack: MediaStreamTrack | undefined;
  muted: boolean;
  /** The call's gate (`callGateFor`): who is heard, and whether we may speak. */
  gate: ((pubkey: string) => CallAllowance) | undefined;
  /** Our camera and screen as they are sent, if on: LiveKit's tracks, or the call's own. */
  video?: Partial<Record<VideoKind, MediaStreamTrack>>;
}

export interface IrohVoice {
  status: IrohVoiceStatus;
  /** Set while `status` is `"unavailable"`. */
  unavailable?: IrohUnavailable;
  /** What our presence names, once bound. */
  address: IrohAddress | undefined;
  /** The members linked now. */
  linked: LinkedPeer[];
  /** The linked members as the call's UI shows them. */
  peers: P2pPeerView[];
  /** Whether our own microphone is carrying speech. */
  selfSpeaking: boolean;
}

const NONE: LinkedPeer[] = [];

/** This deployment's iroh relays: `CONCORD_IROH_RELAYS`, else the shipped iroh release's; undefined without iroh. */
async function deploymentIrohRelays(): Promise<string[] | undefined> {
  const shipped = await irohDefaultRelays();
  if (!shipped) return undefined;
  return CONCORD_IROH_RELAYS ?? shipped;
}

/**
 * Whether a call can run peer to peer here: the iroh module, WebCodecs Opus, and a relay to
 * home on, the Community's or the deployment's.
 */
export async function peerToPeerAvailable(communityRelays: readonly string[]): Promise<boolean> {
  if (!irohAudioSupported() || !(await voiceNodeBinder())) return false;
  const defaults = await deploymentIrohRelays();
  return Boolean(defaults) && irohRelayPlan(communityRelays, defaults!).home.length > 0;
}
const noop = () => () => undefined;

/** A counter bumped on every video change, for `useSyncExternalStore`. */
const videoTicks = new WeakMap<IrohVideo, { n: number }>();
function videoTick(video: IrohVideo): number {
  let t = videoTicks.get(video);
  if (!t) {
    videoTicks.set(video, (t = { n: 0 }));
    video.subscribe(() => (t!.n += 1));
  }
  return t.n;
}

/**
 * A voice Channel's peer-to-peer half (CORD-07 §8): a fresh iroh endpoint for the
 * call, linked to each member the LiveKit call doesn't carry to us — Vector, or
 * an Armada member whose LiveKit failed — until they join it.
 */
export function useIrohVoice(opts: IrohVoiceOptions): IrohVoice {
  const { enabled, onSfu, fold, me, communityRelays, micTrack, muted, gate } = opts;
  const [call, setCall] = useState<{ call: IrohVoiceCall; audio: IrohVoiceAudio; video: IrohVideo; relays: IrohRelayPlan } | undefined>();
  const [status, setStatus] = useState<IrohVoiceStatus>("off");
  const [unavailable, setUnavailable] = useState<IrohUnavailable | undefined>();
  const [address, setAddress] = useState<IrohAddress | undefined>();
  const relaysKey = communityRelays.join(",");

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let held: IrohVoiceCall | undefined;
    let video: IrohVideo | undefined;
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
      const defaults = await deploymentIrohRelays();
      if (cancelled) return;
      if (!bind || !defaults) return off("build", "the iroh wasm module (crates/webxdc-rt) isn't in this build, or predates VoiceNode");
      const relays = irohRelayPlan(relaysKey ? relaysKey.split(",") : [], defaults);
      if (relays.home.length === 0) return off("relays", "CONCORD_IROH_RELAYS is empty and the Community lists no voice_relays");
      let audio: IrohVoiceAudio | undefined;
      try {
        held = await IrohVoiceCall.start(bind, relays.home, (send) => (audio = new IrohVoiceAudio(send)));
      } catch (e) {
        if (!cancelled) off("start", e);
        return;
      }
      if (cancelled) {
        void held.stop();
        return;
      }
      const v = (video = new IrohVideo(held));
      held.setStreamSink(
        (id, bytes) => v.onStream(id, bytes),
        (id, up) => (up ? v.relinked(id) : v.removePeer(id)),
      );
      setCall({ call: held, audio: audio!, video: v, relays });
      setAddress(held.address());
      setStatus("on");
    })();
    return () => {
      cancelled = true;
      video?.close();
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

  const gateRef = useRef(gate);
  gateRef.current = gate;

  const mine = address?.endpoint;
  useEffect(() => {
    if (!call || !me || !mine) return;
    const mayConnect = (author: string) => gateRef.current?.(author).connect !== false;
    call.call.setTargets(p2pTargets(fold, me, { onSfu, endpoint: mine, trustedRelays: call.relays.trusted, mayConnect }));
  }, [call, fold, me, mine, onSfu, gate]);

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

  const cameraTrack = opts.video?.camera;
  const screenTrack = opts.video?.screen;
  const maySend = !me || (gate?.(me).video ?? true);
  useEffect(() => {
    if (!call) return;
    void call.video.setSource("camera", maySend ? cameraTrack : undefined);
    void call.video.setSource("screen", maySend ? screenTrack : undefined);
  }, [call, cameraTrack, screenTrack, maySend]);

  // Every picture a linked member says they send, and may show here, is asked for.
  useEffect(() => {
    if (!call) return;
    for (const { author, endpoint } of linked) {
      call.video.setWatched(endpoint, wantedFrom(fold, author, gateRef.current?.(author).video ?? true));
    }
  }, [call, linked, fold, gate]);

  // Who is talking, five times a second; a re-render only when that changes.
  const [speaking, setSpeaking] = useState<ReadonlySet<string>>(new Set());
  const [selfSpeaking, setSelfSpeaking] = useState(false);
  useEffect(() => {
    if (!call) return;
    const timer = setInterval(() => {
      const next = new Set(call.call.linked().filter((l) => call.audio.levelOf(l.endpoint) > SPEAKING_LEVEL).map((l) => l.endpoint));
      setSpeaking((prev) => (prev.size === next.size && [...next].every((e) => prev.has(e)) ? prev : next));
      setSelfSpeaking(call.audio.micLevel() > SPEAKING_LEVEL);
    }, 200);
    return () => {
      clearInterval(timer);
      setSpeaking(new Set());
      setSelfSpeaking(false);
    };
  }, [call]);

  const videoVersion = useSyncExternalStore(
    call ? (l) => call.video.subscribe(l) : noop,
    () => (call ? videoTick(call.video) : 0),
  );
  const peers = useMemo(
    () => (call ? peerViews(linked, fold, speaking, (endpoint, kind) => call.video.remoteTrack(endpoint, kind)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [call, linked, fold, speaking, videoVersion],
  );

  return { status, unavailable, address, linked, peers, selfSpeaking };
}
