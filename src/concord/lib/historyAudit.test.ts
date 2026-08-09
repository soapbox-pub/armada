import { describe, expect, it } from "vitest";

import {
  auditHistory,
  danglingRefsOf,
  summarizeReport,
  type ChannelCollection,
  type ControlCollection,
  type RelayCoverage,
} from "@/concord/lib/historyAudit";
import { KIND_COMMENT, KIND_EDIT, KIND_MESSAGE, KIND_REACTION } from "@/concord/lib/kinds";
import type { OpenedChat } from "@/concord/lib/chat";

const CH = "c0ffee";

function msg(rumorId: string, opts: Partial<OpenedChat> = {}): OpenedChat {
  return {
    rumorId,
    author: opts.author ?? "aa",
    kind: opts.kind ?? KIND_MESSAGE,
    content: opts.content ?? "hi",
    tags: opts.tags ?? [],
    ms: opts.ms ?? 1000,
    createdAt: opts.createdAt ?? 1,
    channelIdHex: opts.channelIdHex ?? CH,
    epoch: opts.epoch ?? 0n,
  };
}

function comment(rumorId: string, rootId: string, epoch = 0n): OpenedChat {
  return msg(rumorId, { kind: KIND_COMMENT, tags: [["E", rootId, "", "aa"]], epoch });
}

function edit(rumorId: string, targetId: string, epoch = 0n): OpenedChat {
  return msg(rumorId, { kind: KIND_EDIT, tags: [["e", targetId]], epoch });
}

function reaction(rumorId: string, targetId: string, epoch = 0n): OpenedChat {
  return msg(rumorId, { kind: KIND_REACTION, content: "+", tags: [["e", targetId]], epoch });
}

const okRelays: RelayCoverage[] = [{ url: "wss://r", answered: true, failed: false }];

function channel(over: Partial<ChannelCollection> = {}): ChannelCollection {
  const opened = over.opened ?? [msg("m1"), msg("m2")];
  return {
    channelIdHex: over.channelIdHex ?? CH,
    name: over.name ?? "general",
    isPrivate: over.isPrivate ?? false,
    deleted: over.deleted ?? false,
    opened,
    messageCount: over.messageCount ?? opened.length,
    queriedEpochs: over.queriedEpochs ?? ["0"],
    exhaustedEpochs: over.exhaustedEpochs ?? ["0"],
    relays: over.relays ?? okRelays,
  };
}

function control(over: Partial<ControlCollection> = {}): ControlCollection {
  return {
    incompleteEntities: over.incompleteEntities ?? [],
    truncated: over.truncated ?? false,
    quorum: over.quorum ?? true,
    relays: over.relays ?? okRelays,
    channelCount: over.channelCount ?? 1,
    memberCount: over.memberCount ?? 3,
  };
}

describe("danglingRefsOf", () => {
  it("flags a reply whose thread root is absent", () => {
    const d = danglingRefsOf([msg("m1"), comment("c1", "missing")]);
    expect(d.replyTargets).toEqual(["missing"]);
    expect(d.editTargets).toEqual([]);
  });

  it("does not flag a reply whose root is present", () => {
    const d = danglingRefsOf([msg("root"), comment("c1", "root")]);
    expect(d.replyTargets).toEqual([]);
  });

  it("flags an edit to an absent message", () => {
    const d = danglingRefsOf([edit("e1", "gone")]);
    expect(d.editTargets).toEqual(["gone"]);
  });

  it("ignores reactions to absent targets (may be deleted, not a gap)", () => {
    const d = danglingRefsOf([reaction("r1", "gone")]);
    expect(d.replyTargets).toEqual([]);
    expect(d.editTargets).toEqual([]);
  });

  it("dedupes repeated missing targets", () => {
    const d = danglingRefsOf([comment("c1", "x"), comment("c2", "x")]);
    expect(d.replyTargets).toEqual(["x"]);
  });
});

describe("auditHistory", () => {
  it("is ready on a clean, exhausted, quorate view", () => {
    const r = auditHistory({ communityIdHex: "cid", control: control(), channels: [channel()] });
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.totalMessages).toBe(2);
    expect(summarizeReport(r)).toContain("complete");
  });

  it("blocks when the control fold reports incomplete entities", () => {
    const r = auditHistory({
      communityIdHex: "cid",
      control: control({ incompleteEntities: ["eid1"] }),
      channels: [channel()],
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.map((b) => b.kind)).toContain("control-incomplete");
  });

  it("blocks on a truncated control sweep", () => {
    const r = auditHistory({
      communityIdHex: "cid",
      control: control({ truncated: true }),
      channels: [channel()],
    });
    expect(r.blockers.map((b) => b.kind)).toContain("control-truncated");
  });

  it("blocks when control quorum is not met", () => {
    const r = auditHistory({
      communityIdHex: "cid",
      control: control({ quorum: false }),
      channels: [channel()],
    });
    expect(r.blockers.map((b) => b.kind)).toContain("control-no-quorum");
  });

  it("warns (not blocks) on a control relay failure with quorum intact", () => {
    const relays: RelayCoverage[] = [
      { url: "wss://a", answered: true, failed: false },
      { url: "wss://b", answered: false, failed: true },
    ];
    const r = auditHistory({
      communityIdHex: "cid",
      control: control({ relays }),
      channels: [channel()],
    });
    expect(r.ready).toBe(true);
    expect(r.warnings.map((w) => w.kind)).toContain("control-relay-failures");
  });

  it("blocks a channel whose queried epoch never reached its floor", () => {
    const r = auditHistory({
      communityIdHex: "cid",
      control: control(),
      channels: [channel({ queriedEpochs: ["0", "1"], exhaustedEpochs: ["0"] })],
    });
    expect(r.ready).toBe(false);
    const b = r.blockers.find((b) => b.kind === "channel-not-exhausted");
    expect(b?.detail).toContain("1");
    expect(b?.channelIdHex).toBe(CH);
  });

  it("blocks a channel where a relay failed mid-sweep", () => {
    const relays: RelayCoverage[] = [{ url: "wss://a", answered: true, failed: true }];
    const r = auditHistory({
      communityIdHex: "cid",
      control: control(),
      channels: [channel({ relays })],
    });
    expect(r.blockers.map((b) => b.kind)).toContain("channel-relay-failures");
  });

  it("treats dangling refs as a warning by default and a blocker when asked", () => {
    const opened = [msg("m1"), comment("c1", "missing")];
    const base = { communityIdHex: "cid", control: control(), channels: [channel({ opened, messageCount: 2 })] };

    const warn = auditHistory(base);
    expect(warn.ready).toBe(true);
    expect(warn.warnings.map((w) => w.kind)).toContain("dangling-references");

    const block = auditHistory({ ...base, options: { danglingIsBlocker: true } });
    expect(block.ready).toBe(false);
    expect(block.blockers.map((b) => b.kind)).toContain("dangling-references");
  });

  it("does not require exhaustion when the option is off", () => {
    const r = auditHistory({
      communityIdHex: "cid",
      control: control(),
      channels: [channel({ queriedEpochs: ["0", "1"], exhaustedEpochs: ["0"] })],
      options: { requireChannelExhaustion: false },
    });
    expect(r.blockers.map((b) => b.kind)).not.toContain("channel-not-exhausted");
  });

  it("reports per-epoch coverage sorted newest-first", () => {
    const opened = [msg("a", { epoch: 0n }), msg("b", { epoch: 2n }), msg("c", { epoch: 2n })];
    const r = auditHistory({
      communityIdHex: "cid",
      control: control(),
      channels: [channel({ opened, messageCount: 3, queriedEpochs: ["0", "1", "2"], exhaustedEpochs: ["0", "1", "2"] })],
    });
    const epochs = r.channels[0].epochs;
    expect(epochs.map((e) => e.epoch)).toEqual(["2", "1", "0"]);
    expect(epochs.find((e) => e.epoch === "2")?.messageCount).toBe(2);
    expect(epochs.find((e) => e.epoch === "1")?.messageCount).toBe(0);
  });

  it("blocks when there are no relays at all", () => {
    const r = auditHistory({
      communityIdHex: "cid",
      control: control({ relays: [] }),
      channels: [channel()],
    });
    expect(r.blockers.map((b) => b.kind)).toContain("no-relays");
  });
});
