import { beforeEach, describe, expect, it, vi } from "vitest";

const saves: { filename: string; bytes: Uint8Array; mime?: string }[] = [];
vi.mock("@/lib/mediaGallery", () => ({
  hasMediaGallery: () => true,
  saveToDevice: async (filename: string, bytes: Uint8Array, mime?: string) => {
    saves.push({ filename, bytes, mime });
    return mime?.startsWith("image/") ? "Pictures/Armada" : "Download/Armada";
  },
}));
vi.mock("@/lib/share", () => ({ openUrl: vi.fn() }));

const { downloadBinaryFile, downloadUrl, savedDescription } = await import("@/lib/downloadFile");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function respond(bytes: Uint8Array, type = "") {
  vi.stubGlobal("fetch", async () => new Response(bytes as BlobPart, { headers: type ? { "content-type": type } : {} }));
}

describe("downloadFile on Android", () => {
  beforeEach(() => {
    saves.length = 0;
  });

  it("files a sniffed image into the gallery whatever the sender declared", async () => {
    respond(PNG);
    const result = await downloadUrl("blob:x", { nameHint: "https://h.example/abc.png", mime: "application/pdf" });
    expect(saves[0]).toMatchObject({ filename: "abc.png", mime: "image/png" });
    expect(result).toEqual({ status: "downloaded", location: "Pictures/Armada" });
  });

  it("falls back to the declared type for media it cannot sniff", async () => {
    respond(new Uint8Array([0, 0, 0, 0]));
    await downloadUrl("blob:x", { nameHint: "https://h.example/clip", mime: "video/mp4" });
    expect(saves[0]).toMatchObject({ filename: "clip.mp4", mime: "video/mp4" });
  });

  it("saves a forced download with no type and a sanitized name", async () => {
    const location = await downloadBinaryFile("../../evil.apk", PNG);
    expect(saves[0]).toMatchObject({ filename: "_.._evil.apk", mime: undefined });
    expect(savedDescription(location)).toBe("You'll find it in Download/Armada.");
  });

  it("describes a web download without a location", () => {
    expect(savedDescription(undefined)).toBe("Check your downloads folder.");
  });
});
