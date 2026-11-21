import { normalizeRelayUrl } from "@/lib/platform";

/**
 * Per-conversation notification settings as records, so two devices editing the
 * `notifications` document never undo each other. Each scope key (see
 * `useNotifLevels`) has one LEVEL register and one MUTE register; per register
 * the newer `at` (ms, corrected clock) wins and `op` breaks a tie. A cleared
 * value stays as a tombstone, so a copy that still holds it can't bring it back.
 * See `docs/settings-documents.md`.
 */

export type NotifLevel = "all" | "mentions" | "nothing";

interface Stamp {
  /** When the choice was made, ms on the corrected clock. */
  at: number;
  /** Tie-break for an equal `at`. */
  op: string;
}

/** No `v` = inherit (a cleared level). */
export interface LevelRecord extends Stamp {
  v?: NotifLevel;
}

/** `until`: epoch seconds, {@link MUTE_FOREVER}, or {@link MUTE_OFF} (unmuted). */
export interface MuteRecord extends Stamp {
  until: number;
}

export type LevelRecords = Record<string, LevelRecord>;
export type MuteRecords = Record<string, MuteRecord>;

export interface NotifRecords {
  levels: LevelRecords;
  mutes: MuteRecords;
}

/** The fields older builds read and write wholesale. */
export interface LegacyNotif {
  notifLevels: Record<string, NotifLevel>;
  mutedCommunities: string[];
  mutedChannels: string[];
}

export const MUTE_FOREVER = -1;
export const MUTE_OFF = 0;

export function recordWins(candidate: Stamp, current: Stamp | undefined): boolean {
  return !current
    || candidate.at > current.at
    || (candidate.at === current.at && candidate.op > current.op);
}

/** Per-key last-writer-wins union; keys sorted so equal maps serialize equally. */
export function mergeRecordMaps<R extends Stamp>(
  ...maps: ReadonlyArray<Readonly<Record<string, R>> | undefined>
): Record<string, R> {
  const merged = new Map<string, R>();
  for (const map of maps) {
    for (const [scope, record] of Object.entries(map ?? {})) {
      if (recordWins(record, merged.get(scope))) merged.set(scope, record);
    }
  }
  return Object.fromEntries([...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function mergeNotifRecords(...sets: ReadonlyArray<NotifRecords>): NotifRecords {
  return {
    levels: mergeRecordMaps(...sets.map((s) => s.levels)),
    mutes: mergeRecordMaps(...sets.map((s) => s.mutes)),
  };
}

export function isMuteActive(mute: MuteRecord | undefined, nowSecs: number): boolean {
  return !!mute && (mute.until === MUTE_FOREVER || mute.until > nowSecs);
}

/** The soonest timed mute still running, so one timer covers them all. */
export function nextMuteExpiry(mutes: MuteRecords, nowSecs: number): number | undefined {
  let next: number | undefined;
  for (const { until } of Object.values(mutes)) {
    if (until > nowSecs && (next === undefined || until < next)) next = until;
  }
  return next;
}

/** An `at` strictly after every record this device has seen, so a local edit beats them. */
export function nextStamp(records: NotifRecords, nowMs: number): number {
  let at = Math.floor(nowMs);
  for (const record of [...Object.values(records.levels), ...Object.values(records.mutes)]) {
    if (record.at >= at) at = record.at + 1;
  }
  return at;
}

function communityKey(key: string): string {
  return key.startsWith("c2:") ? key : normalizeRelayUrl(key) ?? key;
}

/** What the legacy fields mean: a mute set entry reads as `nothing`, an explicit level overrides it. */
export function legacyLevelMap(legacy: LegacyNotif): Map<string, NotifLevel> {
  const map = new Map<string, NotifLevel>();
  for (const key of legacy.mutedCommunities) map.set(communityKey(key), "nothing");
  for (const key of legacy.mutedChannels) map.set(key, "nothing");
  for (const [key, level] of Object.entries(legacy.notifLevels)) map.set(key, level);
  return map;
}

/**
 * The legacy fields for older builds and native readers that predate records:
 * the explicit level, with a mute until turned off as `nothing`. A TIMED mute is
 * left out, because an older build would keep it forever.
 */
export function projectLegacy(records: NotifRecords): LegacyNotif {
  const notifLevels: Record<string, NotifLevel> = {};
  const scopes = [...new Set([...Object.keys(records.levels), ...Object.keys(records.mutes)])].sort();
  for (const scope of scopes) {
    if (records.mutes[scope]?.until === MUTE_FOREVER) notifLevels[scope] = "nothing";
    else if (records.levels[scope]?.v) notifLevels[scope] = records.levels[scope].v!;
  }
  const silent = Object.keys(notifLevels).filter((s) => notifLevels[s] === "nothing" && !s.startsWith("dm:"));
  return {
    notifLevels,
    mutedCommunities: silent.filter((s) => !s.includes("::")),
    mutedChannels: silent.filter((s) => s.includes("::")),
  };
}

/**
 * Fold an edit an older build made to the legacy fields into records: wherever
 * they disagree with what `records` project, the legacy side is a choice made at
 * `at`. Deterministic in `opPrefix`, so every device turns one document into the
 * same records. Each one only lands if it beats the record already there.
 */
export function reconcileLegacy(
  records: NotifRecords,
  legacy: LegacyNotif,
  at: number,
  opPrefix: string,
): NotifRecords {
  const want = legacyLevelMap(legacy);
  const have = legacyLevelMap(projectLegacy(records));
  const levels = { ...records.levels };
  const mutes = { ...records.mutes };
  const put = <R extends Stamp>(map: Record<string, R>, scope: string, record: R) => {
    if (recordWins(record, map[scope])) map[scope] = record;
  };
  for (const scope of new Set([...want.keys(), ...have.keys()])) {
    const wanted = want.get(scope);
    if (wanted === have.get(scope)) continue;
    const op = `${opPrefix}:${scope}`;
    // Older builds have no mute of their own: their `nothing` is a level, and a level
    // they set or clear over one of our mutes ends it.
    if (records.mutes[scope]?.until === MUTE_FOREVER) put(mutes, scope, { until: MUTE_OFF, at, op });
    put(levels, scope, wanted === undefined ? { at, op } : { v: wanted, at, op });
  }
  return { levels: mergeRecordMaps(levels), mutes: mergeRecordMaps(mutes) };
}

/** Levels as they apply now: an explicit level, overridden by a running mute when `withMutes`. */
export function effectiveLevels(
  records: NotifRecords,
  nowSecs: number,
  withMutes: boolean,
): Map<string, NotifLevel> {
  const map = new Map<string, NotifLevel>();
  for (const [scope, record] of Object.entries(records.levels)) {
    if (record.v) map.set(scope, record.v);
  }
  if (withMutes) {
    for (const [scope, mute] of Object.entries(records.mutes)) {
      if (isMuteActive(mute, nowSecs)) map.set(scope, "nothing");
    }
  }
  return map;
}

/** The notification fields as AppConfig and the `notifications` document carry them. */
export interface NotifFields extends LegacyNotif {
  notifLevelRecords: LevelRecords;
  notifMuteRecords: MuteRecords;
}

/** The records, with the legacy fields kept in step. */
export function notifFields(records: NotifRecords): NotifFields {
  return { notifLevelRecords: records.levels, notifMuteRecords: records.mutes, ...projectLegacy(records) };
}

/**
 * The records `fields` stand for. Legacy fields that disagree with them come
 * from before records existed, so they are folded in at `at` 0: they fill
 * scopes nothing else has decided and lose to any real record.
 */
export function recordsOf(fields: Partial<NotifFields>): NotifRecords {
  return reconcileLegacy(
    { levels: fields.notifLevelRecords ?? {}, mutes: fields.notifMuteRecords ?? {} },
    {
      notifLevels: fields.notifLevels ?? {},
      mutedCommunities: fields.mutedCommunities ?? [],
      mutedChannels: fields.mutedChannels ?? [],
    },
    0,
    "local",
  );
}

/**
 * Fold an incoming `notifications` document into `local`. The document's legacy
 * fields disagreeing with its own records are an older build's edit, made when
 * the document was signed. `remote` is what the document alone stands for: when
 * the merge holds more, the document is missing something this device knows and
 * should be republished.
 */
export function mergeNotificationsDoc(
  local: NotifRecords,
  doc: Partial<NotifFields>,
  event: { id: string; created_at: number },
): { merged: NotifRecords; remote: NotifRecords } {
  const own = { levels: doc.notifLevelRecords ?? {}, mutes: doc.notifMuteRecords ?? {} };
  const hasLegacy = doc.notifLevels !== undefined
    || doc.mutedCommunities !== undefined
    || doc.mutedChannels !== undefined;
  const remote = hasLegacy
    ? reconcileLegacy(
      own,
      {
        notifLevels: doc.notifLevels ?? {},
        mutedCommunities: doc.mutedCommunities ?? [],
        mutedChannels: doc.mutedChannels ?? [],
      },
      event.created_at * 1000,
      event.id,
    )
    : mergeNotifRecords(own);
  return { merged: mergeNotifRecords(local, remote), remote };
}
