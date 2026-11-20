// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

const h = vi.hoisted(() => ({ folds: 0, plane: new Map<string, Array<{ rumorId: string }>>() }));
vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: { relay: () => ({ query: async () => [] }) } }) }));
vi.mock("@/concord/lib/planeSync", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/planeSync")>()),
  sweepControl: async () => undefined,
}));
vi.mock("@/concord/lib/rumorStore", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/rumorStore")>()),
  queryPlane: async (idHex: string) => h.plane.get(idHex) ?? [],
}));
vi.mock("@/concord/lib/control", async (orig) => {
  const real = await orig<typeof import("@/concord/lib/control")>();
  return {
    ...real,
    foldControlState: (...args: Parameters<typeof real.foldControlState>) => (h.folds++, real.foldControlState(...args)),
  };
});

import { useControlFold } from "@/concord/hooks/useControlPlane";
import { bytesToHex } from "@/concord/lib/derive";

import type { Community } from "@/concord/lib/types";

function communityOf(fill: number): Community {
  const root = new Uint8Array(32).fill(fill);
  const id = new Uint8Array(32).fill(fill + 1);
  return {
    id, idHex: bytesToHex(id), owner: "a".repeat(64), ownerSalt: new Uint8Array(32), root,
    rootEpoch: 0n, heldRoots: [{ epoch: 0n, key: root }], privateChannels: [], relays: [], name: "test",
  } as unknown as Community;
}

function wrapperFor(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useControlFold's shared store", () => {
  it("folds once for every holder of a community, and hands them the same fold", async () => {
    const community = communityOf(11);
    h.plane.set(community.idHex, [{ rumorId: "e".repeat(64) }]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const seen: Array<unknown> = [];
    function Holder({ i }: { i: number }) {
      seen[i] = useControlFold(community).data;
      return null;
    }
    h.folds = 0;
    render(<>{[0, 1, 2, 3].map((i) => <Holder key={i} i={i} />)}</>, { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(seen.every((d) => d !== undefined)).toBe(true));
    expect(new Set(seen).size).toBe(1);
    expect(h.folds).toBe(1);
  });

  it("never shows a caller the community it just left", async () => {
    const a = communityOf(21);
    const b = communityOf(31);
    h.plane.set(a.idHex, [{ rumorId: "a".repeat(64) }]);
    h.plane.set(b.idHex, []);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(({ c }) => useControlFold(c), { initialProps: { c: a }, wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const foldOfA = result.current.data;
    rerender({ c: b });
    expect(result.current.data).not.toBe(foldOfA);
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).not.toBe(foldOfA);
  });

  it("stops a community's entry when its last holder leaves", async () => {
    const community = communityOf(41);
    h.plane.set(community.idHex, []);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = renderHook(() => useControlFold(community), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(queryClient.getQueryCache().find({ queryKey: ["concord", "control", community.idHex], exact: false })?.getObserversCount()).toBe(1));
    unmount();
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(queryClient.getQueryCache().find({ queryKey: ["concord", "control", community.idHex], exact: false })?.getObserversCount() ?? 0).toBe(0);
  });
});
