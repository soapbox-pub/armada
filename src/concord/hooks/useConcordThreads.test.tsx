import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { OpenedChat } from "@/concord/lib/chat";
import type { Channel, Community } from "@/concord/lib/types";

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);

const h = vi.hoisted(() => ({
  byChannel: new Map<string, OpenedChat[]>(),
  folds: 0,
  moderation: { ready: true },
  rules: new Map<string, object>(),
}));

vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: ME } }) }));
vi.mock("@/hooks/useMuteList", () => ({ useMutedPubkeys: () => ({ mutedPubkeys: NO_MUTES }) }));
vi.mock("@/hooks/useReadState", () => ({
  useReadState: () => ({ readState: {}, markRead: () => undefined }),
  concordThreadReadKey: (id: string) => `c2t:${id}`,
}));
vi.mock("@/concord/hooks/useChannel", () => ({ useChatModeration: () => h.moderation }));
vi.mock("@/concord/hooks/useChannelRules", () => ({
  useChannelRules: () => RULES_FOR,
}));
vi.mock("@/concord/hooks/useCommunityRumors", () => ({
  useCommunityRumors: () => ({ byChannel: h.byChannel, isLoading: false }),
}));
vi.mock("@/concord/lib/chat", async (orig) => {
  const real = await orig<typeof import("@/concord/lib/chat")>();
  return {
    ...real,
    foldTimeline: (rumors: OpenedChat[]) => (h.folds++, { messages: rumors, quarantined: new Set<string>() }),
  };
});

const NO_MUTES: ReadonlySet<string> = new Set();
const RULES_FOR = (id: string) => {
  let rules = h.rules.get(id);
  if (!rules) h.rules.set(id, (rules = {}));
  return rules;
};

const { useConcordThreads } = await import("@/concord/hooks/useConcordThreads");

function msg(id: string, author: string, createdAt: number, root?: string): OpenedChat {
  return {
    rumorId: id,
    author,
    kind: root ? 1111 : 9,
    content: id,
    tags: root ? [["E", root]] : [],
    ms: createdAt * 1000,
    createdAt,
    channelIdHex: "",
    epoch: 0n,
  };
}

const community = { idHex: "c1" } as Community;
const channels = [{ idHex: "ch1" }, { idHex: "ch2" }] as Channel[];

describe("useConcordThreads", () => {
  it("lists the viewer's threads newest first, and re-scans only a channel that changed", async () => {
    h.byChannel = new Map([
      ["ch1", [msg("r1", ME, 10), msg("x1", OTHER, 20, "r1")]],
      ["ch2", [msg("r2", OTHER, 30), msg("x2", ME, 40, "r2")]],
    ]);
    const { result, rerender } = renderHook(() => useConcordThreads(community, channels, true));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.threads.map((t) => [t.root.id, t.channelIdHex, t.hasNew])).toEqual([
      ["r2", "ch2", false],
      ["r1", "ch1", true],
    ]);
    expect(h.folds).toBe(2);

    // One channel's rows change (a new Map, ch1's array kept, as the delta read does).
    h.byChannel = new Map(h.byChannel).set("ch2", [...h.byChannel.get("ch2")!, msg("x3", OTHER, 50, "r2")]);
    await act(async () => rerender());
    await waitFor(() => expect(result.current.threads[0].replyCount).toBe(2));
    expect(h.folds).toBe(3);
  });
});
