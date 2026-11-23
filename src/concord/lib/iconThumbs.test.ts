// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearIconThumbMemory,
  deleteIconThumb,
  readIconThumb,
  writeIconThumb,
} from "@/concord/lib/iconThumbs";

const URL_A = "data:image/png;base64,AAAA";

describe("iconThumbs", () => {
  beforeEach(() => {
    localStorage.clear();
    clearIconThumbMemory();
  });

  it("round-trips through storage, not just memory", () => {
    writeIconThumb("c1", { hash: "h1", url: URL_A });
    clearIconThumbMemory();
    expect(readIconThumb("c1")).toEqual({ hash: "h1", url: URL_A });
  });

  it("stores under the armada: prefix so logout purges it", () => {
    writeIconThumb("c1", { hash: "h1", url: URL_A });
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "");
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith("armada:"))).toBe(true);
  });

  it("remembers a miss without re-reading storage", () => {
    expect(readIconThumb("c1")).toBeUndefined();
    localStorage.setItem("armada:c2icon:v2:c1", JSON.stringify({ hash: "h1", url: URL_A }));
    expect(readIconThumb("c1")).toBeUndefined();
  });

  it("refuses anything that isn't an image data: URL", () => {
    localStorage.setItem("armada:c2icon:v2:c1", JSON.stringify({ hash: "h1", url: "https://evil.example/x.png" }));
    expect(readIconThumb("c1")).toBeUndefined();
  });

  it("never reads a v1 thumb, and drops it when the community's thumb is rewritten", () => {
    localStorage.setItem("armada:c2icon:v1:c1", JSON.stringify({ hash: "h1", url: URL_A }));
    expect(readIconThumb("c1")).toBeUndefined();
    writeIconThumb("c1", { hash: "h1", url: URL_A });
    expect(localStorage.getItem("armada:c2icon:v1:c1")).toBeNull();
  });

  it("deletes", () => {
    writeIconThumb("c1", { hash: "h1", url: URL_A });
    deleteIconThumb("c1");
    clearIconThumbMemory();
    expect(readIconThumb("c1")).toBeUndefined();
  });

  it("evicts the oldest past the cap", () => {
    for (let i = 0; i < 65; i++) writeIconThumb(`c${i}`, { hash: `h${i}`, url: URL_A });
    clearIconThumbMemory();
    expect(readIconThumb("c0")).toBeUndefined();
    expect(readIconThumb("c64")).toEqual({ hash: "h64", url: URL_A });
  });
});
