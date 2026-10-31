/**
 * The ArmadaDB provider/hook wiring: components get one shared database, the
 * same tenant store for the same id, and a clear error when the provider is
 * missing.
 */
import { renderHook } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

import { ArmadaDBProvider } from "@/components/ArmadaDBProvider";

import { useDB } from "./useDB";

import type { ReactNode } from "react";

function wrapper({ children }: { children: ReactNode }) {
  return <ArmadaDBProvider>{children}</ArmadaDBProvider>;
}

// Installed once, not per test: the database is a module-level singleton that
// captures whatever factory is present when each of its stores first opens, so
// swapping the factory mid-file would only orphan the connections it already
// holds.
(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

describe("useDB", () => {
  it("returns the same database across components and renders", () => {
    const first = renderHook(() => useDB(), { wrapper });
    const second = renderHook(() => useDB(), { wrapper });
    first.rerender();

    expect(first.result.current).toBe(second.result.current);
  });

  it("returns the same store for a tenant id", () => {
    const { result } = renderHook(() => useDB(), { wrapper });

    expect(result.current.tenant("c2:abc")).toBe(result.current.tenant("c2:abc"));
    expect(result.current.tenant("c2:abc")).not.toBe(result.current.tenant("c2:xyz"));
  });

  it("reads back what it stored", async () => {
    const { result } = renderHook(() => useDB(), { wrapper });
    const db = result.current;

    const rumor = {
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      kind: 9,
      created_at: 1000,
      content: "ahoy",
      tags: [["channel", "chan-1"]],
    };
    await db.tenant("c2:abc").event(rumor);
    await db.kv.set("cursor", 1234);

    expect(await db.tenant("c2:abc").query([{ "#channel": ["chan-1"] }])).toEqual([rumor]);
    expect(await db.kv.get("cursor")).toBe(1234);
  });

  it("takes an injected database", () => {
    const db = {
      tenant: vi.fn(),
      kv: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), list: vi.fn() },
      forget: vi.fn(),
    };
    const { result } = renderHook(() => useDB(), {
      wrapper: ({ children }) => <ArmadaDBProvider db={db}>{children}</ArmadaDBProvider>,
    });

    expect(result.current).toBe(db);
  });

  it("throws outside a provider", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => renderHook(() => useDB())).toThrow(/ArmadaDBProvider/);
    } finally {
      error.mockRestore();
    }
  });
});
