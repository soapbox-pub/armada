import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { fetchImage, imageType, isLocalHost } = require("./imageFetch.js");

const GIF = Uint8Array.from("GIF89a\u0001\u0000", (c) => c.charCodeAt(0));
const respond = (status, { body, location } = {}) =>
  new Response(body ?? null, { status, headers: location ? { location } : {} });

describe("fetchImage", () => {
  it("returns an image's bytes and type from a public https host, without cookies", async () => {
    const fetchImpl = vi.fn(async () => respond(200, { body: GIF }));
    const out = await fetchImage("https://cdn.example/a.gif", { fetchImpl });
    expect(out?.type).toBe("image/gif");
    expect([...out.data]).toEqual([...GIF]);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ credentials: "omit", redirect: "manual" });
  });

  it("refuses http, local and private hosts, before asking", async () => {
    const fetchImpl = vi.fn();
    for (const url of ["http://cdn.example/a.gif", "https://localhost/a.gif", "https://printer.local/a.gif", "https://192.168.1.4/a.gif", "https://[::ffff:7f00:1]/a.gif", "not a url"]) {
      expect(await fetchImage(url, { fetchImpl })).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks every redirect hop", async () => {
    const fetchImpl = vi.fn(async () => respond(302, { location: "https://10.0.0.2/a.gif" }));
    expect(await fetchImage("https://cdn.example/a.gif", { fetchImpl })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns nothing that isn't an image by its own signature", async () => {
    const fetchImpl = vi.fn(async () => respond(200, { body: "<html>secret</html>" }));
    expect(await fetchImage("https://cdn.example/a.gif", { fetchImpl })).toBeNull();
  });

  it("knows image signatures and local hosts", () => {
    expect(imageType(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(imageType(Uint8Array.from("....ftypavif", (c) => c.charCodeAt(0)))).toBe("image/avif");
    expect(isLocalHost("172.20.0.1")).toBe(true);
    expect(isLocalHost("example.com")).toBe(false);
  });
});
