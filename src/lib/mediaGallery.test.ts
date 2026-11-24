import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: [string, Record<string, unknown>][] = [];
let failAppend = false;
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "android", isPluginAvailable: () => true },
  registerPlugin: () => ({
    beginSave: async (o: Record<string, unknown>) => (calls.push(["begin", o]), { id: "s1" }),
    appendSave: async (o: Record<string, unknown>) => {
      calls.push(["append", o]);
      if (failAppend) throw new Error("disk full");
    },
    finishSave: async (o: Record<string, unknown>) => (calls.push(["finish", o]), { location: "Movies/Armada" }),
    cancelSave: async (o: Record<string, unknown>) => void calls.push(["cancel", o]),
  }),
}));

const { saveToDevice } = await import("@/lib/mediaGallery");

describe("saveToDevice", () => {
  beforeEach(() => {
    calls.length = 0;
    failAppend = false;
  });

  it("sends the bytes in bounded pieces that reassemble to the original", async () => {
    const bytes = new Uint8Array(2_000_000).map((_, i) => i % 251);
    expect(await saveToDevice("clip.mp4", bytes, "video/mp4")).toBe("Movies/Armada");

    expect(calls[0]).toEqual(["begin", { filename: "clip.mp4", mime: "video/mp4" }]);
    const pieces = calls.filter(([m]) => m === "append").map(([, o]) => Buffer.from(o.data as string, "base64"));
    expect(pieces.length).toBeGreaterThan(1);
    expect(Math.max(...pieces.map((p) => p.length))).toBeLessThanOrEqual(1024 * 1024);
    expect(Buffer.concat(pieces).equals(bytes)).toBe(true);
    expect(calls.at(-1)).toEqual(["finish", { id: "s1" }]);
  });

  it("finishes an empty file without appending", async () => {
    await saveToDevice("empty.txt", new Uint8Array(0));
    expect(calls.map(([m]) => m)).toEqual(["begin", "finish"]);
  });

  it("cancels the staged save when a piece fails", async () => {
    failAppend = true;
    await expect(saveToDevice("clip.mp4", new Uint8Array(10))).rejects.toThrow("disk full");
    expect(calls.map(([m]) => m)).toEqual(["begin", "append", "cancel"]);
  });
});
