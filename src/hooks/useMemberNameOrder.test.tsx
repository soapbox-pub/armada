import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { useMemberNameOrder } from "./useMemberSearch";

import type { ReactNode } from "react";

describe("useMemberNameOrder", () => {
  it("sorts by name, case-insensitively, with nameless members last", () => {
    const client = new QueryClient();
    const pk = (c: string) => c.repeat(64);
    client.setQueryData(["author", pk("a")], { metadata: { name: "zed" } });
    client.setQueryData(["author", pk("b")], { metadata: { display_name: "Alice" } });
    client.setQueryData(["author", pk("c")], { metadata: { name: "bob" } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useMemberNameOrder("en"), { wrapper });

    expect([pk("0"), pk("a"), pk("c"), pk("b")].sort(result.current)).toEqual([pk("b"), pk("c"), pk("a"), pk("0")]);
  });

  it("changes identity only when a name it sorted by changes", () => {
    const client = new QueryClient();
    const pk = (c: string) => c.repeat(64);
    client.setQueryData(["author", pk("a")], { metadata: { name: "zed" } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useMemberNameOrder("en"), { wrapper });
    const first = result.current;
    [pk("a"), pk("b")].sort(first);

    act(() => {
      client.setQueryData(["author", pk("9")], { metadata: { name: "someone else" } });
      client.setQueryData(["author", pk("a")], { metadata: { name: "zed", about: "same name" } });
    });
    expect(result.current).toBe(first);

    act(() => client.setQueryData(["author", pk("b")], { metadata: { name: "amy" } }));
    expect(result.current).not.toBe(first);
    expect([pk("a"), pk("b")].sort(result.current)).toEqual([pk("b"), pk("a")]);
  });
});
