import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const usage = vi.fn();
vi.mock("@/lib/db/armadaDB", () => ({ getArmadaDB: () => ({ usage }) }));
vi.mock("@/concord/lib/image", () => ({
  communityImageCacheUsage: vi.fn(async () => ({ entries: 2, bytes: 300 })),
  clearCommunityImageCache: vi.fn(async () => {}),
}));
vi.mock("@/lib/mediaCache", () => ({
  mediaCacheUsage: vi.fn(() => ({ entries: 3, bytes: 1000 })),
  clearMediaCache: vi.fn(async () => {}),
}));

import { clearCommunityImageCache } from "@/concord/lib/image";
import { clearMediaCache } from "@/lib/mediaCache";
import { clearStorage, dataRows, measureStorage, tenantRow } from "@/lib/storageUsage";

describe("tenantRow()", () => {
  it("files each tenant under what its data is", () => {
    expect(tenantRow("dm17:abc")).toBe("dms");
    expect(tenantRow("c2:abc")).toBe("communities");
    expect(tenantRow("c2park")).toBe("communities");
    expect(tenantRow("nip29:wss://relay.example")).toBe("servers");
    expect(tenantRow("main")).toBe("profiles");
    expect(tenantRow("svc")).toBe("otherData");
  });
});

describe("dataRows()", () => {
  it("sums tenants into rows and adds the settings row", () => {
    const rows = dataRows(
      {
        tenants: [
          { id: "c2:a", rumors: 2, bytes: 100 },
          { id: "c2:b", rumors: 3, bytes: 50 },
          { id: "main", rumors: 1, bytes: 10 },
        ],
        kv: { entries: 4, bytes: 40 },
      },
      6,
    );
    expect(rows).toEqual([
      { id: "dms", count: 0, bytes: 0, clearable: false },
      { id: "communities", count: 5, bytes: 150, clearable: false },
      { id: "servers", count: 0, bytes: 0, clearable: false },
      { id: "profiles", count: 1, bytes: 10, clearable: false },
      { id: "settings", bytes: 46, clearable: false },
    ]);
  });

  it("leaves a row unsized when the engine couldn't size a tenant in it", () => {
    const rows = dataRows({ tenants: [{ id: "dm17:a", rumors: 2 }, { id: "svc", rumors: 1 }] }, 0);
    expect(rows.find((r) => r.id === "dms")).toEqual({ id: "dms", count: 2, bytes: undefined, clearable: false });
    expect(rows.find((r) => r.id === "otherData")?.count).toBe(1);
  });
});

describe("measureStorage()", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      storage: {
        estimate: async () => ({ usage: 5000, quota: 1_000_000 }),
        getDirectory: async () => ({ getDirectoryHandle: async () => { throw new DOMException("", "NotFoundError"); } }),
      },
    });
    usage.mockResolvedValue({ tenants: [{ id: "main", rumors: 1, bytes: 10 }], fileBytes: 2000 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists the web caches and adds the database file to the origin's usage", async () => {
    const report = await measureStorage();
    expect(report.caches).toEqual([
      { id: "media", bytes: 1000, count: 3, clearable: true },
      { id: "communityImages", bytes: 300, count: 2, clearable: true },
    ]);
    expect(report.data.find((r) => r.id === "profiles")).toMatchObject({ count: 1, bytes: 10 });
    expect(report.totalBytes).toBe(7000);
    expect(report.quotaBytes).toBe(1_000_000);
  });

  it("still answers when the database can't", async () => {
    usage.mockRejectedValue(new Error("closed"));
    const report = await measureStorage();
    expect(report.data.find((r) => r.id === "communities")?.count).toBe(0);
    expect(report.totalBytes).toBe(5000);
  });
});

describe("clearStorage()", () => {
  it("clears the cache a row names", async () => {
    await clearStorage("media");
    await clearStorage("communityImages");
    expect(clearMediaCache).toHaveBeenCalled();
    expect(clearCommunityImageCache).toHaveBeenCalled();
  });

  it("refuses to clear message history", async () => {
    await expect(clearStorage("dms")).rejects.toThrow();
    await expect(clearStorage("profiles")).rejects.toThrow();
  });
});
