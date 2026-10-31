/**
 * The {@link ArmadaDB} transport for Electron: the engine runs in the main
 * process (`electronMain.ts`) over `userData/armada.db`. The bridge implements
 * `ArmadaDBPlugin` so the store is `NativeArmadaDB` with all its batching
 * unchanged. Payloads cross as JSON text to match the Capacitor wire format.
 */
import { desktop } from "@/lib/desktop";

import { NativeArmadaDB } from "./NativeArmadaDB";

import type { ArmadaDBPlugin } from "./NativeArmadaDB";

/**
 * Whether the desktop shell offers its SQLite store. False in browsers, older
 * shells, or when the main process failed to open the file — so we fall back to IndexedDB.
 */
export function hasElectronArmadaDB(): boolean {
  return Boolean(desktop()?.armadaDb?.available);
}

/** The desktop store; call {@link hasElectronArmadaDB} first. */
export function createElectronArmadaDB(): NativeArmadaDB {
  const bridge = desktop()?.armadaDb;
  if (!bridge?.available) throw new Error("The desktop shell has no ArmadaDB store");
  return new NativeArmadaDB(electronBridge(bridge.call));
}

/** `ArmadaDBPlugin`, dispatched over the shell's single `armada:db` channel. */
function electronBridge(call: (op: string, payload?: unknown) => Promise<unknown>): ArmadaDBPlugin {
  const send = <T>(op: string, payload?: unknown) => call(op, payload) as Promise<T>;

  return {
    query: (options) => send("query", options),
    event: (options) => send("event", options),
    count: (options) => send("count", options),
    remove: (options) => send("remove", options),
    tenants: () => send("tenants"),
    kvGet: (options) => send("kvGet", options),
    kvSet: (options) => send("kvSet", options),
    kvDelete: (options) => send("kvDelete", options),
    kvList: (options) => send("kvList", options),
    kvOps: (options) => send("kvOps", options),
    wipe: () => send("wipe"),
    forget: (options) => send("forget", options),
  };
}
