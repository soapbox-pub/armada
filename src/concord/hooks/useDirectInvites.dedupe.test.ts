import { describe, expect, it } from "vitest";

import { dedupeParkedInvites, splitInviteInbox, type ParkedInvite } from "./useDirectInvites";
import type { InviteBundle } from "@/concord/lib/invite";

/** A minimal ParkedInvite for the dedup logic (only the read fields matter). */
function inv(
  over: Partial<ParkedInvite> & { communityId: string; wrapId: string; receivedAt: number },
): ParkedInvite {
  const channels = over.bundle?.channels ?? [];
  return {
    wrapId: over.wrapId,
    sender: over.sender ?? "sender",
    bundle: { community_id: over.communityId, name: "c", channels } as unknown as InviteBundle,
    communityId: over.communityId,
    name: over.name ?? "c",
    receivedAt: over.receivedAt,
    catchUp: over.catchUp,
  };
}

const chan = (id: string) => ({ id, key: "1".repeat(64), epoch: 0, name: "ch" });

describe("dedupeParkedInvites", () => {
  it("collapses a re-invite to one row per community, keeping the newest wrap", () => {
    const out = dedupeParkedInvites([
      inv({ communityId: "A", wrapId: "old", receivedAt: 100 }),
      inv({ communityId: "A", wrapId: "new", receivedAt: 200 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].wrapId).toBe("new");
  });

  it("keeps invites to different communities apart", () => {
    const out = dedupeParkedInvites([
      inv({ communityId: "A", wrapId: "a", receivedAt: 100 }),
      inv({ communityId: "B", wrapId: "b", receivedAt: 100 }),
    ]);
    expect(new Set(out.map((i) => i.communityId))).toEqual(new Set(["A", "B"]));
  });

  it("breaks a receivedAt tie deterministically by wrap id (lower wins)", () => {
    const out = dedupeParkedInvites([
      inv({ communityId: "A", wrapId: "zzz", receivedAt: 100 }),
      inv({ communityId: "A", wrapId: "aaa", receivedAt: 100 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].wrapId).toBe("aaa");
  });

  it("collapses catch-ups that carry the SAME channel set", () => {
    const out = dedupeParkedInvites([
      inv({ communityId: "A", wrapId: "old", receivedAt: 100, catchUp: true, bundle: { channels: [chan("cc")] } as unknown as InviteBundle }),
      inv({ communityId: "A", wrapId: "new", receivedAt: 200, catchUp: true, bundle: { channels: [chan("cc")] } as unknown as InviteBundle }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].wrapId).toBe("new");
  });

  it("keeps each sender's catch-up for the same channels, so a newer one can't bury the genuine vend", () => {
    const out = dedupeParkedInvites([
      inv({ communityId: "A", wrapId: "staff", sender: "admin", receivedAt: 100, catchUp: true, bundle: { channels: [chan("cc")] } as unknown as InviteBundle }),
      inv({ communityId: "A", wrapId: "junk", sender: "stranger", receivedAt: 900, catchUp: true, bundle: { channels: [chan("cc")] } as unknown as InviteBundle }),
    ]);
    expect(new Set(out.map((i) => i.wrapId))).toEqual(new Set(["staff", "junk"]));
  });

  it("keeps catch-ups for the same community that vend DIFFERENT channels", () => {
    // Each carries a private-channel key the member still lacks; collapsing by
    // community would hide a key that exists in no other wrap.
    const out = dedupeParkedInvites([
      inv({ communityId: "A", wrapId: "aa", receivedAt: 100, catchUp: true, bundle: { channels: [chan("aa")] } as unknown as InviteBundle }),
      inv({ communityId: "A", wrapId: "bb", receivedAt: 100, catchUp: true, bundle: { channels: [chan("bb")] } as unknown as InviteBundle }),
    ]);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((i) => i.wrapId))).toEqual(new Set(["aa", "bb"]));
  });

  it("normalizes channel-id case so one channel spelled two ways is one key", () => {
    const out = dedupeParkedInvites([
      inv({ communityId: "A", wrapId: "lo", receivedAt: 100, catchUp: true, bundle: { channels: [chan("abcd")] } as unknown as InviteBundle }),
      inv({ communityId: "A", wrapId: "up", receivedAt: 200, catchUp: true, bundle: { channels: [chan("ABCD")] } as unknown as InviteBundle }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].wrapId).toBe("up");
  });
});

describe("splitInviteInbox", () => {
  const known = (pubkey: string) => pubkey === "friend";

  it("lists a catch-up only once it's judged a manual Accept, and never badges one being adopted", () => {
    const keys = (wrapId: string) => inv({ communityId: "A", wrapId, receivedAt: 100, catchUp: true, sender: "admin" });
    const manual = (wrapId: string) => wrapId === "refused";
    const out = splitInviteInbox([keys("adopting"), keys("refused")], 0, known, new Set(), manual);
    expect(out.items.map((i) => i.invite.wrapId)).toEqual(["refused"]);
    expect(out.unreadCount).toBe(1);
    expect(out.catchUps.map((i) => i.wrapId).sort()).toEqual(["adopting", "refused"]);
  });

  it("puts known senders in the inbox and strangers in requests, newest first", () => {
    const out = splitInviteInbox(
      [
        inv({ communityId: "A", wrapId: "a", receivedAt: 100, sender: "friend" }),
        inv({ communityId: "B", wrapId: "b", receivedAt: 300, sender: "stranger" }),
        inv({ communityId: "C", wrapId: "c", receivedAt: 200, sender: "stranger" }),
      ],
      0,
      known,
      new Set(),
    );
    expect(out.items.map((i) => i.invite.wrapId)).toEqual(["a"]);
    expect(out.requests.map((i) => i.invite.wrapId)).toEqual(["b", "c"]);
  });

  it("counts only inbox invites as unread", () => {
    const out = splitInviteInbox(
      [
        inv({ communityId: "A", wrapId: "a", receivedAt: 200, sender: "friend" }),
        inv({ communityId: "B", wrapId: "b", receivedAt: 200, sender: "stranger" }),
      ],
      100,
      known,
      new Set(),
    );
    expect(out.unreadCount).toBe(1);
  });

  it("drops muted senders and keeps catch-ups in the inbox", () => {
    const out = splitInviteInbox(
      [
        inv({ communityId: "A", wrapId: "muted", receivedAt: 100, sender: "troll" }),
        inv({ communityId: "B", wrapId: "keys", receivedAt: 100, sender: "admin", catchUp: true }),
      ],
      0,
      known,
      new Set(["troll"]),
    );
    expect(out.items.map((i) => i.invite.wrapId)).toEqual(["keys"]);
    expect(out.requests).toHaveLength(0);
  });
});
