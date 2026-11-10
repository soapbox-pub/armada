/**
 * The "All messages" feed merges per-channel windows, and the trap that
 * creates is a SILENT HOLE: each channel is read under its own limit, so a
 * busy channel's window reaches back hours while a quiet one's reaches back
 * months. Merged naively, scrolling past the busy channel's oldest row lands
 * on a month-old message from somewhere quiet, with everything said in between
 * missing and nothing on screen admitting it.
 *
 * So the feed is cut at the completeness watermark — the oldest point back to
 * which EVERY channel has been read — and `loadOlder` widens the window rather
 * than paging a cursor. These tests pin that: what is shown is always a whole
 * slice of the community, never a sample of it.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KIND_MESSAGE } from "@/concord/lib/kinds";
import type { OpenedChat } from "@/concord/lib/chat";

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);
const MUTED = "e".repeat(64);
const BUSY = "c".repeat(64);
const QUIET = "d".repeat(64);
const COMMUNITY = "f".repeat(64);

const h = vi.hoisted(() => ({
  /** The whole store, per channel, newest-first. */
  rows: new Map<string, OpenedChat[]>(),
  muted: new Set<string>(),
  /** Every `perChannel` the hook has asked for, in order. */
  windows: [] as number[],
  /** Authors each channel's rules hold back, as a restricted Channel's ledger would. */
  held: new Map<string, Set<string>>(),
}));

vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: ME } }) }));
vi.mock("@/hooks/useMuteList", () => ({ useMutedPubkeys: () => ({ mutedPubkeys: h.muted }) }));
vi.mock("@/concord/hooks/useChannel", () => ({
  useChatModeration: () => ({ ready: true, banned: new Set<string>(), canDelete: () => false }),
}));
vi.mock("@/concord/lib/quarantineMemory", () => ({
  quarantineMemoryRevision: () => 0,
  recallQuarantined: () => undefined,
  subscribeQuarantineMemory: () => () => undefined,
}));
vi.mock("@/wire/useWireScopes", () => ({ useWireScopes: () => undefined }));
vi.mock("@/concord/hooks/useChannelRules", () => ({
  useChannelRules: () => (idHex: string) => {
    const held = h.held.get(idHex);
    return held ? { hold: (m: OpenedChat) => held.has(m.author) } : {};
  },
}));
vi.mock("@/concord/lib/rumorStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/concord/lib/rumorStore")>();
  return {
    ...actual,
    // The real read applies `perChannel` per channel independently — which is
    // exactly what makes the tail ragged, so the fake must do it too.
    queryRumorsByChannel: vi.fn(
      async (_community: string, ids: string[], opts: { perChannel: number }) => {
        h.windows.push(opts.perChannel);
        const out = new Map<string, OpenedChat[]>();
        for (const id of ids) {
          const all = h.rows.get(id) ?? [];
          if (all.length > 0) out.set(id, all.slice(0, opts.perChannel));
        }
        return out;
      },
    ),
  };
});

const { useCommunityFeed } = await import("@/concord/hooks/useCommunityFeed");

/** Minimal chat row. `at` is unix seconds. */
function row(id: string, channelIdHex: string, at: number, author = OTHER): OpenedChat {
  return {
    rumorId: id,
    author,
    kind: KIND_MESSAGE,
    createdAt: at,
    ms: at * 1000,
    content: id,
    tags: [["channel", channelIdHex]],
    channelIdHex,
  } as OpenedChat;
}

/** `n` rows in `channel`, newest-first, one second apart ending at `newest`. */
function burst(channel: string, prefix: string, n: number, newest: number): OpenedChat[] {
  return Array.from({ length: n }, (_, i) => row(`${prefix}${i}`, channel, newest - i));
}

function render(channels: string[] = [BUSY, QUIET], active = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(
    () =>
      useCommunityFeed(
        { idHex: COMMUNITY } as never,
        channels.map((idHex) => ({ idHex })) as never,
        active,
      ),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
}

beforeEach(() => {
  h.rows = new Map();
  h.muted = new Set();
  h.windows = [];
  h.held = new Map();
});

describe("useCommunityFeed", () => {
  it("merges every channel into one newest-first list", async () => {
    h.rows.set(BUSY, [row("busy-new", BUSY, 300), row("busy-old", BUSY, 100)]);
    h.rows.set(QUIET, [row("quiet", QUIET, 200)]);

    const { result } = render();
    await waitFor(() => expect(result.current.messages.length).toBe(3));

    expect(result.current.messages.map((m) => m.id)).toEqual(["busy-new", "quiet", "busy-old"]);
    // Nothing was truncated, so the whole store is on screen and there is no
    // older page to ask for.
    expect(result.current.hasMore).toBe(false);
  });

  it("leaves out what a channel's own rules hold back, there and nowhere else", async () => {
    const STRAY = "9".repeat(64);
    h.rows.set(BUSY, [row("stray", BUSY, 300, STRAY), row("busy", BUSY, 200)]);
    h.rows.set(QUIET, [row("quiet-stray-author", QUIET, 100, STRAY)]);
    h.held.set(BUSY, new Set([STRAY]));

    const { result } = render();
    await waitFor(() => expect(result.current.messages.length).toBe(2));
    expect(result.current.messages.map((m) => m.id)).toEqual(["busy", "quiet-stray-author"]);
  });

  it("carries each message's channel binding through to the row", async () => {
    h.rows.set(BUSY, [row("m", BUSY, 100)]);

    const { result } = render();
    await waitFor(() => expect(result.current.messages.length).toBe(1));

    // The view recovers the channel from this tag; a merged feed with no
    // channel on its rows can't label anything.
    expect(result.current.messages[0].tags).toContainEqual(["channel", BUSY]);
  });

  it("cuts the feed where a truncated channel stops, rather than showing a hole", async () => {
    // The busy channel fills its window with today's traffic; the quiet one
    // holds a single message from long before. Showing that old message would
    // imply nothing happened in between, which is false — the busy channel has
    // hundreds of unread rows down there.
    h.rows.set(BUSY, burst(BUSY, "busy", 200, 100_000));
    h.rows.set(QUIET, [row("ancient", QUIET, 1_000)]);

    const { result } = render();
    await waitFor(() => expect(result.current.messages.length).toBeGreaterThan(0));

    const ids = result.current.messages.map((m) => m.id);
    expect(ids).not.toContain("ancient");
    // Exactly the busy channel's window: the watermark is its oldest row.
    expect(ids.length).toBe(100);
    expect(ids[0]).toBe("busy0");
    expect(result.current.hasMore).toBe(true);
  });

  it("loadOlder widens the window and lowers the watermark", async () => {
    h.rows.set(BUSY, burst(BUSY, "busy", 150, 100_000));
    h.rows.set(QUIET, [row("ancient", QUIET, 1_000)]);

    const { result } = render();
    await waitFor(() => expect(result.current.messages.length).toBe(100));
    expect(h.windows.at(-1)).toBe(100);

    act(() => result.current.loadOlder());
    await waitFor(() => expect(h.windows.at(-1)).toBe(200));

    // The busy channel is exhausted inside the wider window, so no channel is
    // truncated any more: the watermark lifts and the quiet channel's ancient
    // message is finally sound to show.
    await waitFor(() => expect(result.current.messages.length).toBe(151));
    expect(result.current.hasMore).toBe(false);
    expect(result.current.messages.map((m) => m.id)).toContain("ancient");
  });

  it("treats an exactly-full window as truncated", async () => {
    // A channel that returns precisely `perChannel` rows is indistinguishable
    // from one with more behind it, so the feed assumes more and offers the
    // page. Being wrong costs one click; the other way costs a silent hole.
    h.rows.set(BUSY, burst(BUSY, "busy", 100, 100_000));
    h.rows.set(QUIET, [row("ancient", QUIET, 1_000)]);

    const { result } = render();
    await waitFor(() => expect(result.current.messages.length).toBe(100));

    expect(result.current.hasMore).toBe(true);
    expect(result.current.messages.map((m) => m.id)).not.toContain("ancient");
  });

  it("drops muted authors without re-reading the store", async () => {
    h.rows.set(BUSY, [row("keep", BUSY, 200), row("hide", BUSY, 100, MUTED)]);
    h.muted = new Set([MUTED]);

    const { result } = render();
    await waitFor(() => expect(result.current.messages.length).toBe(1));

    expect(result.current.messages[0].id).toBe("keep");
    expect(h.windows.length).toBe(1);
  });

  it("does not touch the store while its pane is closed", async () => {
    h.rows.set(BUSY, [row("m", BUSY, 100)]);

    const { result } = render([BUSY, QUIET], false);
    await new Promise((r) => setTimeout(r, 20));

    expect(h.windows.length).toBe(0);
    expect(result.current.messages).toEqual([]);
    // A disabled query must not read as perpetually loading.
    expect(result.current.isLoading).toBe(false);
  });
});
