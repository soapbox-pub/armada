import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, Buffer[]>();
vi.mock("@capacitor/filesystem", () => ({
  Filesystem: {
    writeFile: async ({ path, data }: { path: string; data: string }) => {
      files.set(path, [Buffer.from(data, "base64")]);
      return { uri: `file:///cache/${path}` };
    },
    appendFile: async ({ path, data }: { path: string; data: string }) => {
      files.get(path)!.push(Buffer.from(data, "base64"));
    },
  },
}));

const { BRIDGE_CHUNK, writeFileChunked } = await import("@/lib/chunkedWrite");

describe("writeFileChunked", () => {
  beforeEach(() => files.clear());

  it("writes a large file in bounded pieces that reassemble to the original", async () => {
    const bytes = new Uint8Array(2_000_000).map((_, i) => i % 251);
    const uri = await writeFileChunked("clip.mp4", bytes, "CACHE" as never);
    expect(uri).toBe("file:///cache/clip.mp4");
    const pieces = files.get("clip.mp4")!;
    expect(pieces.length).toBe(Math.ceil(bytes.length / BRIDGE_CHUNK));
    expect(Buffer.concat(pieces).equals(bytes)).toBe(true);
  });

  it("writes an empty file", async () => {
    await writeFileChunked("empty.txt", new Uint8Array(0), "CACHE" as never);
    expect(Buffer.concat(files.get("empty.txt")!).length).toBe(0);
  });
});
