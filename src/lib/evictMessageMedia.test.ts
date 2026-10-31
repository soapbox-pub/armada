import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ evicted: [] as string[], forgotten: [] as string[] }));
vi.mock("@/lib/encryptedMedia", () => ({ evictAttachment: (url: string) => calls.evicted.push(url) }));
vi.mock("@/lib/mediaCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mediaCache")>()),
  forgetBlob: (hash: string) => calls.forgotten.push(hash),
}));

import { evictMessageMedia, evictRemovedMessageMedia } from "./evictMessageMedia";

const A = "a".repeat(64);
const B = "b".repeat(64);
const O = "c".repeat(64);

beforeEach(() => {
  calls.evicted.length = 0;
  calls.forgotten.length = 0;
});

describe("evictMessageMedia", () => {
  it("forgets every URL and hash a message's imeta names", () => {
    evictMessageMedia([["imeta", `url https://blossom.example/${A}.jpg`, `thumb https://blossom.example/${B}.jpg`, `ox ${O}`]]);
    expect(calls.evicted).toEqual([`https://blossom.example/${A}.jpg`, `https://blossom.example/${B}.jpg`]);
    expect(calls.forgotten.sort()).toEqual([A, B, O].sort());
  });

  it("keeps media a message still shown also names", () => {
    const url = `https://blossom.example/${A}.jpg`;
    const shared = [["imeta", `url ${url}`, `ox ${O}`]];
    evictMessageMedia([...shared, ["imeta", `url https://blossom.example/${B}.png`]], "", [{ tags: shared, content: "" }]);
    expect(calls.evicted).toEqual([`https://blossom.example/${B}.png`]);
    expect(calls.forgotten).toEqual([B]);
  });

  it("acts once per removed message", () => {
    evictRemovedMessageMedia("m1", [], `see https://blossom.example/${A}.png`);
    evictRemovedMessageMedia("m1", [], `see https://blossom.example/${A}.png`);
    expect(calls.evicted).toHaveLength(1);
  });
});
