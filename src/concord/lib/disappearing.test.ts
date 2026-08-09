import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import {
  COMMUNITY_TIMER_PRESETS,
  DEFAULT_MESSAGE_EXPIRATION_SECS,
  chatExpiresAt,
  communityTimerNotice,
  formatCommunityTimer,
  messageExpirationOf,
  publishTimerNotices,
  timerNoticeSeconds,
} from "@/concord/lib/disappearing";
import { bytesToHex, channelGroupKey, voiceGroupKey, voiceMediaKey } from "@/concord/lib/derive";
import { KIND_COMMENT, KIND_DELETE, KIND_MESSAGE, KIND_TIMER_NOTICE } from "@/concord/lib/kinds";
import { openWrap } from "@/concord/lib/stream";
import type { Channel, CommunityMetadata, Community } from "@/concord/lib/types";
import { channelWriteGroup } from "@/concord/lib/community";

// publishTimerNotices writes the actor's own copy through the rumor store,
// which opens IndexedDB — not what this suite is about.
vi.mock("@/concord/lib/rumorStore", () => ({ writeRumors: vi.fn(async () => true) }));

const DAY = 86_400;

function meta(extra: Partial<CommunityMetadata> = {}): CommunityMetadata {
  return { name: "Test", relays: [], ...extra };
}

describe("messageExpirationOf (CORD-08 §1)", () => {
  it("reads the timer, flooring a fractional value", () => {
    expect(messageExpirationOf(meta({ message_expiration: 30 * DAY }))).toBe(30 * DAY);
    expect(messageExpirationOf(meta({ message_expiration: 90.9 }))).toBe(90);
  });

  it("reads absent, zero, negative, and garbage all as OFF", () => {
    expect(messageExpirationOf(undefined)).toBe(0);
    expect(messageExpirationOf(meta())).toBe(0);
    expect(messageExpirationOf(meta({ message_expiration: 0 }))).toBe(0);
    expect(messageExpirationOf(meta({ message_expiration: -5 }))).toBe(0);
    expect(messageExpirationOf(meta({ message_expiration: "30 days" as unknown as number }))).toBe(0);
    expect(messageExpirationOf(meta({ message_expiration: NaN }))).toBe(0);
  });
});

describe("chatExpiresAt (CORD-08 §2)", () => {
  const sendMs = 1_719_800_000_417;

  it("stamps a message with send time plus the timer", () => {
    expect(chatExpiresAt(KIND_MESSAGE, sendMs, DAY)).toBe(1_719_800_000 + DAY);
    expect(chatExpiresAt(KIND_COMMENT, sendMs, DAY)).toBe(1_719_800_000 + DAY);
  });

  it("stamps nothing when the timer is off", () => {
    expect(chatExpiresAt(KIND_MESSAGE, sendMs, 0)).toBeUndefined();
  });

  it("exempts deletes and the timer notice itself", () => {
    expect(chatExpiresAt(KIND_DELETE, sendMs, DAY)).toBeUndefined();
    expect(chatExpiresAt(KIND_TIMER_NOTICE, sendMs, DAY)).toBeUndefined();
  });
});

describe("presets and copy", () => {
  it("defaults to 30 days, which is itself a preset", () => {
    expect(DEFAULT_MESSAGE_EXPIRATION_SECS).toBe(30 * DAY);
    expect(COMMUNITY_TIMER_PRESETS.some((p) => p.seconds === DEFAULT_MESSAGE_EXPIRATION_SECS)).toBe(true);
  });

  it("prefers preset labels and composes the rest", () => {
    // The DM formatter would render 30 days as "4 weeks 2 days".
    expect(formatCommunityTimer(30 * DAY)).toBe("30 days");
    expect(formatCommunityTimer(3600)).toBe("1 hour");
  });

  it("phrases the notice from the viewer's side", () => {
    expect(communityTimerNotice(DAY, true, "Alice")).toBe("You set disappearing messages to 1 day.");
    expect(communityTimerNotice(DAY, false, "Alice")).toBe("Alice set disappearing messages to 1 day.");
    expect(communityTimerNotice(0, false, "Alice")).toBe("Alice turned off disappearing messages.");
  });
});

describe("timerNoticeSeconds", () => {
  it("reads the timer tag, including an explicit off", () => {
    expect(timerNoticeSeconds({ tags: [["timer", "86400"]] })).toBe(DAY);
    expect(timerNoticeSeconds({ tags: [["timer", "0"]] })).toBe(0);
  });

  it("reads missing or malformed as unreadable, never as off", () => {
    expect(timerNoticeSeconds({ tags: [] })).toBeUndefined();
    expect(timerNoticeSeconds({ tags: [["timer", "-4"]] })).toBeUndefined();
    expect(timerNoticeSeconds({ tags: [["timer", "soon"]] })).toBeUndefined();
  });
});

describe("publishTimerNotices (CORD-08 §4)", () => {
  const root = new Uint8Array(32).fill(3);

  function makeChannel(byte: number): Channel {
    const channelId = new Uint8Array(32).fill(byte);
    const idHex = bytesToHex(channelId);
    const group = channelGroupKey(root, channelId, 0);
    const stream = { epoch: 0n, group };
    const voice = { room: voiceGroupKey(root, channelId, 0), mediaKey: voiceMediaKey(root, channelId, 0) };
    return { id: channelId, idHex, name: "general", isPrivate: false, isAnnouncement: false, voice, streams: [stream], current: stream };
  }

  it("posts one sealed notice per channel, and the notice never expires", async () => {
    const sk = generateSecretKey();
    const actor = getPublicKey(sk);
    const signer = { signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
    const channels = [makeChannel(5), makeChannel(6)];
    const community = { idHex: "ab".repeat(32), relays: ["wss://a.example", "wss://b.example"] } as Community;

    const published: NostrEvent[] = [];
    const nostr = {
      relay: () => ({
        event: async (event: NostrEvent) => {
          published.push(event);
        },
      }),
    };

    await publishTimerNotices(nostr, community, channels, signer, actor, DAY);

    // One wrap per channel, fanned out to both relays.
    expect(published).toHaveLength(channels.length * community.relays.length);
    for (const channel of channels) {
      const wrap = published.find((e) => e.pubkey === channelWriteGroup(channel).pk);
      expect(wrap).toBeDefined();
      // The notice documents the policy; the policy must not erase it — no
      // NIP-40 tag on the wrap, and none inside the signed rumor.
      expect(wrap!.tags.some((t) => t[0] === "expiration")).toBe(false);
      const opened = openWrap(wrap!, channelWriteGroup(channel));
      expect(opened.kind).toBe(KIND_TIMER_NOTICE);
      expect(opened.author).toBe(actor);
      expect(timerNoticeSeconds(opened)).toBe(DAY);
      expect(opened.tags).toContainEqual(["channel", channel.idHex]);
      expect(opened.tags.some((t) => t[0] === "expiration")).toBe(false);
    }

    // The actor's own copy is written through the store so their timelines
    // show the notice immediately.
    const { writeRumors } = await import("@/concord/lib/rumorStore");
    expect(writeRumors).toHaveBeenCalledWith(community.idHex, expect.arrayContaining([
      expect.objectContaining({ kind: KIND_TIMER_NOTICE }),
    ]));
  });
});
