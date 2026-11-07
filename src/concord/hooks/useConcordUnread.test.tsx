/**
 * The unread badge must agree with what the reader actually SEES. The trap this
 * guards: the badge scans the raw rumor store, but the timeline render folds
 * kind-5 deletes — and the store's NIP-09 only removes a delete's target within
 * one write batch, so a self-delete a relay delivered a beat after its target
 * leaves that target physically cached (chat.ts:302-308). A self-deleted NEWEST
 * message would then pin `latest` above every rendered row: a badge no channel
 * open can ever clear, because clear-on-open stamps the newest UNDELETED row.
 * (Observed live in a #ditto channel: a ".." posted and deleted 5s later left
 * the room unread for every member but its author until someone else posted.)
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KIND_DELETE, KIND_MESSAGE } from "@/concord/lib/kinds";
import type { OpenedChat } from "@/concord/lib/chat";
import { toggleForumAsChat } from "@/concord/lib/forumPresentation";

const ME = "a".repeat(64);
const X = "b".repeat(64);
const Y = "c".repeat(64);
const CH = "d".repeat(64);

const h = vi.hoisted(() => ({
  rumors: [] as OpenedChat[],
  readState: {} as Record<string, number>,
  banned: new Set<string>(),
  everyoneAuthors: new Set<string>(),
  joinedAtMs: undefined as number | undefined,
  posters: undefined as Set<string> | undefined,
}));

vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: ME } }) }));
vi.mock("@/hooks/useMuteList", () => ({ useMutedPubkeys: () => ({ mutedPubkeys: new Set<string>() }) }));
vi.mock("@/concord/hooks/useCommunityRumors", () => ({
  useCommunityRumors: () => ({ byChannel: new Map([[CH, h.rumors]]), isLoading: false }),
}));
vi.mock("@/concord/hooks/useChannel", () => ({
  useChatModeration: () => ({
    banned: h.banned,
    canDelete: () => false,
    canMentionEveryone: (author: string) => h.everyoneAuthors.has(author),
    holdsPost: (author: string) => h.posters !== undefined && !h.posters.has(author),
  }),
}));
vi.mock("@/concord/hooks/useCommunityList", () => ({
  useCommunityEntry: () => (h.joinedAtMs === undefined ? undefined : { added_at: h.joinedAtMs }),
}));
vi.mock("@/concord/lib/floodCluster", () => ({ quarantinedIn: () => new Set<string>() }));
vi.mock("@/concord/lib/quarantineMemory", () => ({
  quarantineMemoryRevision: () => 0,
  recallQuarantined: () => undefined,
  rememberQuarantined: () => undefined,
  subscribeQuarantineMemory: () => () => undefined,
}));
vi.mock("@/hooks/useReadState", () => ({
  concordReadKey: (idHex: string) => `c2:${idHex}`,
  useReadState: () => ({
    readState: h.readState,
    getLastRead: (k: string) => h.readState[k] ?? 0,
    markRead: vi.fn(),
  }),
}));

const { useConcordUnread } = await import("@/concord/hooks/useConcordUnread");

/** Minimal OpenedChat row (only the fields the unread scan reads). */
function row(
  rumorId: string,
  author: string,
  kind: number,
  createdAt: number,
  tags: string[][] = [],
  content = "",
): OpenedChat {
  return {
    rumorId,
    author,
    kind,
    createdAt,
    ms: createdAt * 1000,
    content,
    tags,
    channelIdHex: CH,
  } as OpenedChat;
}

const render = () =>
  renderHook(() => useConcordUnread({ idHex: "cc".repeat(32) } as never, [{ idHex: CH } as never]));

const renderForum = () =>
  renderHook(() => useConcordUnread({ idHex: "cc".repeat(32) } as never, [{ idHex: CH, view: "forum" } as never]));

beforeEach(() => {
  localStorage.clear();
  h.rumors = [];
  h.readState = {};
  h.banned = new Set<string>();
  h.posters = undefined;
  h.everyoneAuthors = new Set<string>();
  h.joinedAtMs = undefined;
});

describe("useConcordUnread — @everyone", () => {
  it("marks an authorized mass mention as a mention", () => {
    h.everyoneAuthors = new Set([X]);
    h.rumors = [row("B", X, KIND_MESSAGE, 200, [], "Heads up @everyone")];
    h.readState[`c2:${CH}`] = 100;
    expect(render().result.current.byChannel[CH]).toEqual({ latest: 200, mention: true });
  });

  it("does not let an unauthorized author forge a mass mention", () => {
    h.rumors = [row("B", X, KIND_MESSAGE, 200, [], "Heads up @everyone")];
    h.readState[`c2:${CH}`] = 100;
    expect(render().result.current.byChannel[CH]).toEqual({ latest: 200, mention: false });
  });

  it("does not ping for a mass mention sent before this membership began", () => {
    h.everyoneAuthors = new Set([X]);
    h.joinedAtMs = 300_000;
    h.rumors = [row("B", X, KIND_MESSAGE, 200, [], "Heads up @everyone")];
    expect(render().result.current.byChannel[CH]).toEqual({ latest: 200, mention: false });
  });

  it("does not ping for a direct mention sent before this membership began", () => {
    h.joinedAtMs = 300_000;
    h.rumors = [row("B", X, KIND_MESSAGE, 200, [["p", ME]], "hi")];
    expect(render().result.current.byChannel[CH]).toEqual({ latest: 200, mention: false });
  });

  it("still pings for a mass mention sent after joining", () => {
    h.everyoneAuthors = new Set([X]);
    h.joinedAtMs = 150_000;
    h.rumors = [row("B", X, KIND_MESSAGE, 200, [], "Heads up @everyone")];
    expect(render().result.current.byChannel[CH]).toEqual({ latest: 200, mention: true });
  });
});

describe("useConcordUnread — deletes fold into the badge", () => {
  it("a self-deleted newest message does not keep the channel unread", () => {
    // Read up to the older message (100). The newest (200) was deleted by its
    // own author, so it must not raise the badge.
    h.rumors = [
      row("A", X, KIND_MESSAGE, 100),
      row("B", X, KIND_MESSAGE, 200),
      row("delB", X, KIND_DELETE, 205, [["e", "B"], ["k", "9"]]),
    ];
    h.readState[`c2:${CH}`] = 100;
    expect(render().result.current.byChannel[CH]).toBeUndefined();
  });

  it("still badges an undeleted newer message (fix does not over-suppress)", () => {
    h.rumors = [row("A", X, KIND_MESSAGE, 100), row("B", X, KIND_MESSAGE, 200)];
    h.readState[`c2:${CH}`] = 100;
    expect(render().result.current.byChannel[CH]).toEqual({ latest: 200, mention: false });
  });

  it("a delete by a DIFFERENT author cannot suppress a still-shown message", () => {
    // Only self-deletes are honored (the store's NIP-09 rule): an attacker's
    // kind-5 over someone else's newest message leaves it rendered, so it must
    // stay counted rather than let a stranger silence the badge.
    h.rumors = [
      row("B", X, KIND_MESSAGE, 200),
      row("delB", Y, KIND_DELETE, 205, [["e", "B"], ["k", "9"]]),
    ];
    h.readState[`c2:${CH}`] = 100;
    expect(render().result.current.byChannel[CH]).toEqual({ latest: 200, mention: false });
  });
});

describe("useConcordUnread — the Banlist folds into the badge", () => {
  it("a banned author's message does not light the channel", () => {
    // This scan reads the raw store, so it does not inherit the fold's Banlist
    // drop. Without its own, a banned member kept badging a channel whose
    // timeline renders nothing of theirs — a dot no open can clear.
    h.rumors = [row("A", X, KIND_MESSAGE, 100), row("B", X, KIND_MESSAGE, 200)];
    h.readState[`c2:${CH}`] = 100;
    h.banned = new Set([X]);
    expect(render().result.current.byChannel[CH]).toBeUndefined();
  });

  it("a banned author's mention does not light the mention badge either", () => {
    h.rumors = [row("B", X, KIND_MESSAGE, 200, [["p", ME]])];
    h.readState[`c2:${CH}`] = 100;
    h.banned = new Set([X]);
    expect(render().result.current.byChannel[CH]).toBeUndefined();
  });

  it("an unbanned author still badges (the drop is not blanket)", () => {
    h.rumors = [row("B", X, KIND_MESSAGE, 200)];
    h.readState[`c2:${CH}`] = 100;
    h.banned = new Set([Y]);
    expect(render().result.current.byChannel[CH]).toEqual({ latest: 200, mention: false });
  });
});

describe("useConcordUnread — a restricted Channel's held posts (CORD-03 §1)", () => {
  it("a post nobody vouches for does not light the channel; a manager's does", () => {
    h.rumors = [row("A", X, KIND_MESSAGE, 200, [["p", ME]])];
    h.readState[`c2:${CH}`] = 100;
    h.posters = new Set([Y]);
    expect(render().result.current.byChannel[CH]).toBeUndefined();
    h.posters = new Set([X]);
    expect(render().result.current.byChannel[CH]).toEqual({ latest: 200, mention: true });
  });
});

describe("useConcordUnread — forum channels", () => {
  it("does not badge an untitled message the feed never shows", () => {
    h.rumors = [row("U", X, KIND_MESSAGE, 200, [], "plain chat")];
    expect(renderForum().result.current.byChannel[CH]).toBeUndefined();
  });

  it("does not raise a mention for an untitled message the feed never shows", () => {
    h.rumors = [row("U", X, KIND_MESSAGE, 200, [["p", ME]], "hi")];
    expect(renderForum().result.current.byChannel[CH]).toBeUndefined();
  });

  it("badges a titled post", () => {
    h.rumors = [
      row("P", X, KIND_MESSAGE, 150, [["subject", "Release notes"]]),
      row("U", X, KIND_MESSAGE, 200, [], "plain chat"),
    ];
    expect(renderForum().result.current.byChannel[CH]).toEqual({ latest: 150, mention: false });
  });

  it("badges untitled messages once this device shows the forum as chat", () => {
    h.rumors = [row("U", X, KIND_MESSAGE, 200, [], "plain chat")];
    const view = renderForum();
    expect(view.result.current.byChannel[CH]).toBeUndefined();
    act(() => toggleForumAsChat(CH));
    expect(view.result.current.byChannel[CH]).toEqual({ latest: 200, mention: false });
  });
});
