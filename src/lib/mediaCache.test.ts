import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchCapped } from "@/lib/encryptedMedia";
import { blobHashOf, cachedBlob, clearMediaCacheMemory, forgetBlob, isMediaCached, storeBlob } from "@/lib/mediaCache";

const H = "a".repeat(64);

describe("blobHashOf()", () => {
  it("reads the hash from a Blossom path, with or without an extension", () => {
    expect(blobHashOf(`https://blossom.example/${H}`)).toBe(H);
    expect(blobHashOf(`https://blossom.example/${H}.jpeg`)).toBe(H);
    expect(blobHashOf(`https://blossom.example/${H.toUpperCase()}.png?x=1`)).toBe(H);
  });

  it("reads it through a proxy's url parameter", () => {
    expect(blobHashOf(`https://proxy.example/?url=${encodeURIComponent(`https://b.example/${H}.jpg`)}`)).toBe(H);
  });

  it("ignores URLs that don't name a blob", () => {
    expect(blobHashOf("https://example.com/cat.jpg")).toBeUndefined();
    expect(blobHashOf(`https://example.com/${H}x`)).toBeUndefined();
    expect(blobHashOf(`blob:https://localhost/${H}`)).toBeUndefined();
  });
});

describe("storeBlob / cachedBlob", () => {
  beforeEach(() => {
    const entries = new Map<string, Response>();
    const cache = {
      match: async (k: string) => entries.get(k)?.clone(),
      put: async (k: string, r: Response) => void entries.set(k, r),
      delete: async (k: string) => entries.delete(k),
    };
    vi.stubGlobal("caches", { open: async () => cache });
    clearMediaCacheMemory();
  });
  afterEach(() => {
    clearMediaCacheMemory();
    vi.unstubAllGlobals();
  });

  const hashOf = async (bytes: Uint8Array) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, "0")).join("");

  it("keeps bytes that hash to their name and serves them back", async () => {
    const bytes = new TextEncoder().encode("a picture");
    const hash = await hashOf(bytes);
    await storeBlob(hash, bytes.buffer as ArrayBuffer, "image/jpeg");
    expect(isMediaCached(hash)).toBe(true);
    expect(new Uint8Array(await (await cachedBlob(hash))!.arrayBuffer())).toEqual(bytes);
  });

  it("refuses bytes that don't hash to the name they'd be stored under", async () => {
    await storeBlob(H, new TextEncoder().encode("planted").buffer as ArrayBuffer, "image/jpeg");
    expect(isMediaCached(H)).toBe(false);
    expect(await cachedBlob(H)).toBeUndefined();
  });

  it("doesn't keep the bytes of media forgotten while its download was in flight", async () => {
    const bytes = new TextEncoder().encode("a removed picture");
    const hash = await hashOf(bytes);
    let respond!: () => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => {
      respond = () => resolve(new Response(bytes, { headers: { "content-type": "image/jpeg" } }));
    }));

    const download = fetchCapped(`https://blossom.example/${hash}.jpg`);
    await new Promise((r) => setTimeout(r, 0));
    // Its message is removed from the device mid-download.
    forgetBlob(hash);
    respond();
    await download;
    await new Promise((r) => setTimeout(r, 20));

    expect(isMediaCached(hash)).toBe(false);
    expect(await cachedBlob(hash)).toBeUndefined();
  });
});
