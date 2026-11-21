import {
  DM_CONFIG_KEYS,
  METADATA_CONFIG_KEYS,
  NOTIF_CONFIG_KEYS,
  RAIL_CONFIG_KEYS,
  type AppConfig,
  type ClosedDmMarker,
} from "@/contexts/AppContext";

import { mergeNotificationsDoc, notifFields, type NotifFields } from "@/lib/notifRecords";
import { railLayoutOf, type SettingsDocName } from "@/lib/settingsDocs";

import type { RailLayoutNode } from "@/lib/railLayout";

/** AppConfig keys per settings document (`read-state`/`reactions` sync via their own modules). */
export const CONFIG_KEYS_BY_DOC = {
  "metadata": METADATA_CONFIG_KEYS,
  "rail": RAIL_CONFIG_KEYS,
  "notifications": NOTIF_CONFIG_KEYS,
  "dms": DM_CONFIG_KEYS,
} as const satisfies Partial<Record<SettingsDocName, readonly (keyof AppConfig)[]>>;

/** A settings document that mirrors a slice of AppConfig. */
export type ConfigDocName = keyof typeof CONFIG_KEYS_BY_DOC;

/**
 * The AppConfig slice a settings document carries (publish value and diff
 * snapshot). Undefined values are omitted to keep the snapshot stable.
 */
export function configSnapshot(config: AppConfig, name: ConfigDocName): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS_BY_DOC[name]) {
    const value = config[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * AppConfig fields to apply from an incoming document; `current` is used only for
 * `dms` and `notifications`, `event` (the document's) only for `notifications`.
 */
export function docToConfigPatch(
  name: ConfigDocName,
  doc: Record<string, unknown>,
  current: AppConfig,
  event?: { id: string; created_at: number },
): Partial<AppConfig> {
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS_BY_DOC[name]) {
    const value = doc[key];
    if (value !== undefined) out[key] = value;
  }
  // Legacy pre-folder clients stored a flat `railOrder`.
  if (name === "rail") {
    const layout = railLayoutOf(doc as { railLayout?: RailLayoutNode[]; railOrder?: string[] });
    if (layout !== undefined) out.railLayout = layout;
  }
  if (name === "dms") mergeDmMaps(out, current);
  if (name === "notifications" && event) Object.assign(out, notificationsDocFields(doc, current, event).merged);
  return out as Partial<AppConfig>;
}

/**
 * The notification fields after folding `doc` into `current` per scope, and the
 * ones `doc` alone stands for. Only records already in AppConfig take part:
 * legacy fields that predate them were last-writer-wins, as the document is.
 */
export function notificationsDocFields(
  doc: Record<string, unknown>,
  current: AppConfig,
  event: { id: string; created_at: number },
): { merged: NotifFields; remote: NotifFields } {
  const { merged, remote } = mergeNotificationsDoc(
    { levels: current.notifLevelRecords, mutes: current.notifMuteRecords },
    doc as Partial<NotifFields>,
    event,
  );
  return { merged: notifFields(merged), remote: notifFields(remote) };
}

/**
 * Union the additive per-peer DM maps into the current ones, in place. `dms` is
 * last-writer-wins, so a stale republish from another device would otherwise
 * drop a hide/pin/accept. Removals become best-effort; for `closedDms` the
 * marker with the newer `createdAt` wins. `dmProtocol` stays wholesale.
 */
function mergeDmMaps(patch: Record<string, unknown>, current: AppConfig): void {
  if (patch.closedDms) {
    const merged: Record<string, ClosedDmMarker> = { ...current.closedDms };
    for (const [peer, marker] of Object.entries(patch.closedDms as Record<string, ClosedDmMarker>)) {
      const existing = merged[peer];
      if (!existing || marker.createdAt > existing.createdAt) merged[peer] = marker;
    }
    patch.closedDms = merged;
  }
  for (const key of ["pinnedDms", "acceptedDms", "startedDms"] as const) {
    if (patch[key]) {
      patch[key] = [...new Set([...current[key], ...(patch[key] as string[])])];
    }
  }
}
