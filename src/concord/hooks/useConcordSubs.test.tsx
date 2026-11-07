import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  listResult: { data: undefined as unknown, error: null as unknown },
  entries: [] as Array<Record<string, unknown>>,
  left: [] as string[],
  readControlFold: vi.fn<() => Promise<unknown>>(),
}));

const SUB = {
  relays: ["wss://c"],
  communityId: "c",
  communityName: "Community",
  channelId: "channel",
  channelName: "general",
  streams: [{ pk: "stream", convKey: "key", epoch: "1" }],
  timerSecs: 0,
  gitAttachments: [],
};

vi.mock("@/concord/hooks/useCommunityList", () => ({
  useCommunityList: () => h.listResult,
}));

vi.mock("@/concord/lib/communityList", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/concord/lib/communityList")>()),
  liveEntries: () => h.entries,
  removedCommunityIds: () => [...h.left],
  rehydrateCommunity: (entry: Record<string, unknown>) => ({
    idHex: entry.community_id,
    relays: ["wss://c"],
  }),
}));

vi.mock("@/concord/lib/control", () => ({
  readControlFold: () => h.readControlFold(),
}));

vi.mock("@/concord/hooks/useControlPlane", () => ({
  readLivePause: async () => undefined,
}));

vi.mock("@/concord/lib/concordNotifications", () => ({
  buildConcordSubs: () => ({ subs: [SUB], streamKeys: [] }),
}));

vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/concord/lib/streamAuth", () => ({ registerStreamKeys: () => {} }));
vi.mock("@/wire/bus", () => ({ onWireScopes: () => () => {} }));

import { useConcordSubsState } from "@/concord/hooks/useConcordSubs";

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  h.listResult = { data: undefined, error: null };
  h.entries = [];
  h.left = [];
  h.readControlFold.mockReset();
});

describe("useConcordSubsState", () => {
  it("distinguishes pending/folded membership from wire-confirmed empty", () => {
    const pending = renderHook(() => useConcordSubsState(), { wrapper: wrapper() });
    expect(pending.result.current).toMatchObject({ subs: [], ready: false, configReady: false });
    pending.unmount();

    h.listResult = { data: { list: {} }, error: null };
    const folded = renderHook(() => useConcordSubsState(), { wrapper: wrapper() });
    expect(folded.result.current).toMatchObject({ subs: [], ready: false, configReady: false });
    folded.unmount();

    h.listResult = { data: { list: {}, repairPending: false }, error: null };
    const empty = renderHook(() => useConcordSubsState(), { wrapper: wrapper() });
    expect(empty.result.current).toMatchObject({ subs: [], ready: true, configReady: true });
  });

  it("reports left communities before the list is authoritative", () => {
    h.left = ["gone"];
    h.listResult = { data: { list: {} }, error: null };
    const view = renderHook(() => useConcordSubsState(), { wrapper: wrapper() });
    expect(view.result.current).toMatchObject({ ready: false, left: ["gone"] });
    view.unmount();

    h.listResult = { data: { list: {}, decryptFailed: true }, error: null };
    const unreadable = renderHook(() => useConcordSubsState(), { wrapper: wrapper() });
    expect(unreadable.result.current.left).toEqual([]);
  });

  it("returns private additive subs but stays unready on a control-fold cache miss", async () => {
    let resolve!: (value: unknown) => void;
    h.entries = [{ community_id: "c", current: { root_epoch: 1, channels: [] } }];
    h.listResult = { data: { list: {}, repairPending: false }, error: null };
    h.readControlFold.mockReturnValue(new Promise((done) => { resolve = done; }));

    const view = renderHook(() => useConcordSubsState(), { wrapper: wrapper() });
    expect(view.result.current).toMatchObject({ subs: [], ready: false });

    await act(async () => { resolve(undefined); });
    await waitFor(() => expect(view.result.current.subs).toEqual([SUB]));
    expect(view.result.current.ready).toBe(false);
    expect(view.result.current.configReady).toBe(false);
  });

  it("uses a complete cached fold for config without granting prune authority", async () => {
    h.entries = [{ community_id: "c", current: { root_epoch: 1, channels: [] } }];
    h.listResult = { data: { list: {} }, error: null };
    h.readControlFold.mockResolvedValue({ channels: new Map() });

    const view = renderHook(() => useConcordSubsState(), { wrapper: wrapper() });
    await waitFor(() => expect(view.result.current.configReady).toBe(true));
    expect(view.result.current.ready).toBe(false);
    expect(view.result.current.subs).toEqual([SUB]);
  });

  it("becomes ready after an explicit persisted control fold, including empty", async () => {
    h.entries = [{ community_id: "c", current: { root_epoch: 1, channels: [] } }];
    h.listResult = { data: { list: {}, repairPending: false }, error: null };
    h.readControlFold.mockResolvedValue({ channels: new Map() });

    const view = renderHook(() => useConcordSubsState(), { wrapper: wrapper() });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(view.result.current.subs).toEqual([SUB]);
  });

  it("makes a same-count membership replacement a new pending snapshot", async () => {
    h.entries = [{ community_id: "c", current: { root_epoch: 1, channels: [{ id: "one" }] } }];
    h.listResult = { data: { list: { revision: 1 }, repairPending: false }, error: null };
    h.readControlFold.mockResolvedValue({ channels: new Map() });
    const view = renderHook(() => useConcordSubsState(), { wrapper: wrapper() });
    await waitFor(() => expect(view.result.current.ready).toBe(true));

    let resolve!: (value: unknown) => void;
    h.entries = [{ community_id: "c", current: { root_epoch: 1, channels: [{ id: "two" }] } }];
    h.listResult = { data: { list: { revision: 2 }, repairPending: false }, error: null };
    h.readControlFold.mockReturnValue(new Promise((done) => { resolve = done; }));
    view.rerender();
    expect(view.result.current.ready).toBe(false);

    await act(async () => { resolve({ channels: new Map() }); });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
  });
});
