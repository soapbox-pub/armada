/**
 * Lazy access to the iroh gossip transport (`crates/webxdc-rt`): ~2.8 MB wasm,
 * imported on first use and optional (CI can't build it). Without it Mini Apps
 * still sync durable state but have no realtime — a Nostr substitute would split
 * games between Armada and Vector players.
 *
 * The same module carries a voice Channel's peer-to-peer call (`VoiceNode`), so
 * there is one iroh in the bundle, loaded once, whichever needs it first.
 */

/** The slice of the wasm class this app uses. */
export interface RealtimeTransport {
  publicKeyHex(): string;
  nodeAddrJson(): string;
  join(
    topic: Uint8Array,
    peerAddrsJson: string[],
    onMessage: (bytes: Uint8Array) => void,
    onEvent?: (msg: string) => void,
  ): Promise<void>;
  send(topic: Uint8Array, frame: Uint8Array): Promise<void>;
  addPeer(topic: Uint8Array, peerAddrJson: string): Promise<void>;
  leave(topic: Uint8Array): void;
}

/** The slice of the wasm `VoiceNode` a peer-to-peer call uses (`crates/webxdc-rt/src/voice.rs`). */
export interface VoiceTransport {
  endpointHex(): string;
  relayUrl(): string | undefined;
  dial(idHex: string, relay: string): Promise<void>;
  send(idHex: string, datagram: Uint8Array): boolean;
  sendStream(idHex: string, bytes: Uint8Array, priority: number, staleMs: number): Promise<boolean>;
  rttMs(idHex: string): number;
  unlink(idHex: string, reason: string): void;
  close(): Promise<void>;
}

export type VoiceNodeBinder = (
  relays: string[],
  onLink: (idHex: string, inbound: boolean) => void,
  onDatagram: (idHex: string, bytes: Uint8Array) => void,
  onClosed: (idHex: string) => void,
  onStream: (idHex: string, bytes: Uint8Array | undefined) => void,
) => Promise<VoiceTransport>;

interface WasmModule {
  default: (input?: unknown) => Promise<unknown>;
  RealtimeNode: new () => Promise<RealtimeTransport>;
  VoiceNode: { bind: VoiceNodeBinder };
  defaultVoiceRelays?: () => string[];
}

/** Where `npm run build:wasm` puts the package. */
const MODULE_PATH = "/src/wasm/webxdc-rt/webxdc_rt.js";

/**
 * `import.meta.glob` so the package may be absent: Vite emits a lazy chunk when
 * built and an empty map otherwise. A plain `import(path)` either fails the
 * build or (with `@vite-ignore`) 404s from `dist`.
 */
const CANDIDATES = import.meta.glob("/src/wasm/webxdc-rt/webxdc_rt.js");

let pending: Promise<RealtimeTransport | undefined> | undefined;
let module: Promise<WasmModule | undefined> | undefined;

/** The wasm module, initialised once; undefined when it wasn't built or won't load. */
function wasmModule(): Promise<WasmModule | undefined> {
  module ??= (async () => {
    const loader = CANDIDATES[MODULE_PATH];
    if (!loader) return undefined;
    try {
      const mod = (await loader()) as WasmModule;
      await mod.default();
      return mod;
    } catch (e) {
      console.warn("[iroh] transport module failed to load", e);
      return undefined;
    }
  })();
  return module;
}

/**
 * How to bind a peer-to-peer call's endpoint, or undefined where this build has no
 * iroh. Each call binds its own, unlinkable to the last (Vector `calls/voice.rs`).
 */
export async function voiceNodeBinder(): Promise<VoiceNodeBinder | undefined> {
  const mod = await wasmModule();
  // An older build of the module, from before the voice half.
  if (!mod?.VoiceNode) return undefined;
  return (relays, onLink, onDatagram, onClosed, onStream) => mod.VoiceNode.bind(relays, onLink, onDatagram, onClosed, onStream);
}

/**
 * The relays of the iroh release this build ships (CORD-07 §8 "iroh's defaults"), or
 * undefined where this build has no iroh, or one from before the export.
 */
export async function irohDefaultRelays(): Promise<string[] | undefined> {
  const mod = await wasmModule();
  return mod?.VoiceNode && mod.defaultVoiceRelays ? mod.defaultVoiceRelays() : undefined;
}

/**
 * The process-wide node, created once: binding takes seconds, and two endpoints
 * would look like two players to everyone else.
 */
export function realtimeTransport(): Promise<RealtimeTransport | undefined> {
  pending ??= load();
  return pending;
}

async function load(): Promise<RealtimeTransport | undefined> {
  if (!CANDIDATES[MODULE_PATH]) {
    console.info("[webxdc] realtime transport not built — Mini App multiplayer is off (npm run build:wasm)");
    return undefined;
  }
  try {
    const mod = await wasmModule();
    if (!mod) return undefined;
    return await new mod.RealtimeNode();
  } catch (e) {
    // Built but unusable (old browser, blocked relay): multiplayer is off, durable sync still works.
    console.warn("[webxdc] realtime transport unavailable — Mini App multiplayer is off", e);
    return undefined;
  }
}
