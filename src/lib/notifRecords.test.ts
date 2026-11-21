import { describe, expect, it } from "vitest";

import {
  effectiveLevels,
  mergeNotificationsDoc,
  mergeNotifRecords,
  MUTE_FOREVER,
  MUTE_OFF,
  nextMuteExpiry,
  nextStamp,
  notifFields,
  projectLegacy,
  recordsOf,
  type NotifRecords,
} from "./notifRecords";

const CH = "c2:aa::bb";
const COMMUNITY = "c2:aa";
const DM = "dm:cc";

const none: NotifRecords = { levels: {}, mutes: {} };

describe("merging two devices' records", () => {
  it("keeps edits to different scopes from both", () => {
    const phone: NotifRecords = { levels: {}, mutes: { [CH]: { until: 2_000, at: 10, op: "a" } } };
    const laptop: NotifRecords = { levels: { [DM]: { v: "mentions", at: 20, op: "b" } }, mutes: {} };
    expect(mergeNotifRecords(phone, laptop)).toEqual({
      levels: { [DM]: { v: "mentions", at: 20, op: "b" } },
      mutes: { [CH]: { until: 2_000, at: 10, op: "a" } },
    });
  });

  it("settles one scope by the newer choice, the same in either order", () => {
    const older: NotifRecords = { levels: {}, mutes: { [CH]: { until: MUTE_FOREVER, at: 10, op: "z" } } };
    const newer: NotifRecords = { levels: {}, mutes: { [CH]: { until: MUTE_OFF, at: 11, op: "a" } } };
    expect(mergeNotifRecords(older, newer)).toEqual(mergeNotifRecords(newer, older));
    expect(mergeNotifRecords(older, newer).mutes[CH]!.until).toBe(MUTE_OFF);
  });

  it("breaks an equal time by op, the same in either order", () => {
    const a: NotifRecords = { levels: { [CH]: { v: "all", at: 10, op: "a" } }, mutes: {} };
    const b: NotifRecords = { levels: { [CH]: { v: "nothing", at: 10, op: "b" } }, mutes: {} };
    expect(mergeNotifRecords(a, b).levels[CH]!.v).toBe("nothing");
    expect(mergeNotifRecords(b, a).levels[CH]!.v).toBe("nothing");
  });

  it("does not let a stale copy bring back a mute that was ended", () => {
    const stale: NotifRecords = { levels: {}, mutes: { [CH]: { until: MUTE_FOREVER, at: 10, op: "a" } } };
    const unmuted: NotifRecords = { levels: {}, mutes: { [CH]: { until: MUTE_OFF, at: 12, op: "b" } } };
    expect(effectiveLevels(mergeNotifRecords(unmuted, stale), 0, true).has(CH)).toBe(false);
  });

  it("stamps a local edit after everything this device has seen", () => {
    const seen: NotifRecords = { levels: { [CH]: { v: "all", at: 5_000, op: "a" } }, mutes: {} };
    expect(nextStamp(seen, 4_000)).toBe(5_001);
    expect(nextStamp(seen, 9_000)).toBe(9_000);
  });
});

describe("mutes in force", () => {
  const records: NotifRecords = {
    levels: { [CH]: { v: "mentions", at: 1, op: "a" } },
    mutes: {
      [CH]: { until: 1_000, at: 2, op: "b" },
      [DM]: { until: MUTE_FOREVER, at: 3, op: "c" },
      [COMMUNITY]: { until: MUTE_OFF, at: 4, op: "d" },
    },
  };

  it("read as nothing while they run, and give the chosen level back after", () => {
    expect(effectiveLevels(records, 999, true).get(CH)).toBe("nothing");
    expect(effectiveLevels(records, 1_000, true).get(CH)).toBe("mentions");
    expect(effectiveLevels(records, 999, false).get(CH)).toBe("mentions");
    expect(effectiveLevels(records, 10 ** 12, true).get(DM)).toBe("nothing");
    expect(effectiveLevels(records, 0, true).has(COMMUNITY)).toBe(false);
  });

  it("arm one timer for the soonest end still ahead", () => {
    expect(nextMuteExpiry(records.mutes, 0)).toBe(1_000);
    expect(nextMuteExpiry(records.mutes, 1_000)).toBeUndefined();
  });
});

describe("the legacy fields older builds read", () => {
  it("carry a mute with no end and a chosen level, but never a timed mute", () => {
    const legacy = projectLegacy({
      levels: { [DM]: { v: "mentions", at: 1, op: "a" }, [COMMUNITY]: { v: "nothing", at: 1, op: "a" } },
      mutes: { [CH]: { until: MUTE_FOREVER, at: 1, op: "a" }, "c2:aa::dd": { until: 5_000, at: 1, op: "a" } },
    });
    expect(legacy).toEqual({
      notifLevels: { [CH]: "nothing", [COMMUNITY]: "nothing", [DM]: "mentions" },
      mutedCommunities: [COMMUNITY],
      mutedChannels: [CH],
    });
  });

  it("are read as records when they predate them, losing to any real record", () => {
    const local = recordsOf({
      notifLevels: { [COMMUNITY]: "nothing" },
      mutedCommunities: [],
      mutedChannels: [CH],
      notifLevelRecords: {},
      notifMuteRecords: {},
    });
    expect(effectiveLevels(local, 0, true)).toEqual(new Map([[COMMUNITY, "nothing"], [CH, "nothing"]]));
    expect(local.levels[CH]!.at).toBe(0);
  });

  it("agree with their records after any edit, so nothing is folded twice", () => {
    const fields = notifFields({
      levels: { [DM]: { v: "all", at: 1, op: "a" } },
      mutes: { [CH]: { until: MUTE_FOREVER, at: 2, op: "b" } },
    });
    expect(recordsOf(fields)).toEqual({ levels: fields.notifLevelRecords, mutes: fields.notifMuteRecords });
  });
});

describe("an incoming notifications document", () => {
  const event = { id: "e1", created_at: 100 };

  it("from an older build that unmuted a channel ends the mute, as of when it was signed", () => {
    // This device muted at t=50s; the older build kept the records and dropped the legacy entry.
    const local: NotifRecords = { levels: {}, mutes: { [CH]: { until: MUTE_FOREVER, at: 50_000, op: "x" } } };
    const doc = {
      ...notifFields(local),
      notifLevels: {},
      mutedChannels: [],
    };
    const { merged } = mergeNotificationsDoc(local, doc, event);
    expect(effectiveLevels(merged, 0, true).has(CH)).toBe(false);
  });

  it("from an older build does not undo a later choice of this device", () => {
    const local: NotifRecords = { levels: {}, mutes: { [CH]: { until: MUTE_FOREVER, at: 200_000, op: "x" } } };
    const { merged } = mergeNotificationsDoc(local, { notifLevels: {}, mutedChannels: [], mutedCommunities: [] }, event);
    expect(effectiveLevels(merged, 0, true).get(CH)).toBe("nothing");
  });

  it("missing a choice this device holds is reported, so it can be written back", () => {
    const local: NotifRecords = { levels: { [DM]: { v: "nothing", at: 5, op: "x" } }, mutes: {} };
    const { merged, remote } = mergeNotificationsDoc(local, notifFields(none), event);
    expect(merged).not.toEqual(remote);
  });

  it("that this device wrote changes nothing", () => {
    const local: NotifRecords = { levels: { [DM]: { v: "nothing", at: 5, op: "x" } }, mutes: {} };
    const { merged, remote } = mergeNotificationsDoc(local, notifFields(local), event);
    expect(merged).toEqual(local);
    expect(remote).toEqual(local);
  });
});
