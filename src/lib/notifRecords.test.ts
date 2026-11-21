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
  roomMutedAt,
  roomMuteKey,
  roomMutes,
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
    expect(effectiveLevels(mergeNotifRecords(unmuted, stale), 0, "all").has(CH)).toBe(false);
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
    expect(effectiveLevels(records, 999, "all").get(CH)).toBe("nothing");
    expect(effectiveLevels(records, 1_000, "all").get(CH)).toBe("mentions");
    expect(effectiveLevels(records, 999, "none").get(CH)).toBe("mentions");
    expect(effectiveLevels(records, 10 ** 12, "all").get(DM)).toBe("nothing");
    expect(effectiveLevels(records, 0, "all").has(COMMUNITY)).toBe(false);
  });

  it("arm one timer for the soonest end still ahead", () => {
    expect(nextMuteExpiry(records.mutes, 0)).toBe(1_000);
    expect(nextMuteExpiry(records.mutes, 1_000)).toBeUndefined();
  });
});

describe("timed mutes a background notifier judges itself", () => {
  const records: NotifRecords = {
    levels: { [CH]: { v: "mentions", at: 1, op: "a" } },
    mutes: {
      [CH]: { until: 1_000, at: 2, op: "b" },
      [COMMUNITY]: { until: 2_000, at: 2, op: "b" },
      [DM]: { until: MUTE_FOREVER, at: 3, op: "c" },
      "wss://relay.example": { until: 3_000, at: 4, op: "d" },
      "wss://relay.example::grp": { until: 500, at: 4, op: "d" },
    },
  };

  it("leave a timed-muted room at its chosen level, and a mute with no end at nothing", () => {
    const standing = effectiveLevels(records, 0, "standing");
    expect(standing.get(CH)).toBe("mentions");
    expect(standing.has(COMMUNITY)).toBe(false);
    expect(standing.get(DM)).toBe("nothing");
  });

  it("are named by the keys the notifiers use, with their ends, running ones only", () => {
    expect(roomMuteKey(CH)).toBe("c2:bb");
    expect(roomMuteKey(COMMUNITY)).toBe("c2:aa");
    expect(roomMuteKey("wss://relay.example::grp")).toBe("h:wss://relay.example|grp");
    expect(roomMuteKey(DM)).toBe(DM);
    expect(roomMutes(records, 600)).toEqual({
      "c2:bb": 1_000,
      "c2:aa": 2_000,
      "h:wss://relay.example": 3_000,
    });
  });

  it("silence a channel under its own or its community's, until the later ends", () => {
    const mutes = roomMutes(records, 0);
    expect(roomMutedAt(mutes, ["c2:bb", "c2:aa"], 1_500)).toBe(true);
    expect(roomMutedAt(mutes, ["c2:bb", "c2:aa"], 2_000)).toBe(false);
    expect(roomMutedAt(undefined, ["c2:bb"], 0)).toBe(false);
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
    expect(effectiveLevels(local, 0, "all")).toEqual(new Map([[COMMUNITY, "nothing"], [CH, "nothing"]]));
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
    expect(effectiveLevels(merged, 0, "all").has(CH)).toBe(false);
  });

  it("from an older build does not undo a later choice of this device", () => {
    const local: NotifRecords = { levels: {}, mutes: { [CH]: { until: MUTE_FOREVER, at: 200_000, op: "x" } } };
    const { merged } = mergeNotificationsDoc(local, { notifLevels: {}, mutedChannels: [], mutedCommunities: [] }, event);
    expect(effectiveLevels(merged, 0, "all").get(CH)).toBe("nothing");
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
