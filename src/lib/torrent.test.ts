import { describe, expect, it } from "vitest";

import { parseTorrent } from "./torrent";

const bytes = new TextEncoder();
const pieces = `6:pieces20:${"x".repeat(20)}`;
const tracker = "udp://tracker.test:80/announce";
const announce = `${tracker.length}:${tracker}`;

function parse(info: string, fields = "") {
  return parseTorrent(bytes.encode(`d${fields}4:info${info}e`));
}

describe("torrent metainfo", () => {
  it("hashes the original info bytes and preserves tracker query parameters", () => {
    const info = `d4:name9:guide.pdf6:lengthi42e${pieces}12:piece lengthi16384ee`;
    const mirror = "https://tracker.test/announce?passkey=a&other=b";
    const fields = `8:announce${announce}13:announce-listll${announce}e` +
      `l${mirror.length}:${mirror}17:file:///etc/hostsee`;
    const torrent = parse(info, fields);
    const hash = "7f7acb00926603c2d8378056eebfff936045e36d";
    expect(torrent.files).toEqual([{ path: "guide.pdf", size: 42 }]);
    expect(torrent.pieceCount).toBe(1);
    expect(torrent.hash).toBe(hash);
    expect(torrent.trackers).toEqual(["tracker.test:80", "tracker.test"]);
    const magnet = new URL(torrent.magnet).searchParams;
    expect(magnet.getAll("xt")).toEqual([`urn:btih:${hash}`]);
    expect(magnet.getAll("tr")).toEqual([tracker, mirror]);
  });

  it("reads the v2 file tree and emits a SHA-256 multihash", () => {
    const torrent = parse("d9:file treed4:docsd8:read.txtd0:d6:lengthi5eeeee12:meta versioni2e4:name5:Guide12:piece lengthi16384ee");
    expect(torrent.files).toEqual([{ path: "docs/read.txt", size: 5 }]);
    expect(torrent.magnet).toBe("magnet:?xt=urn:btmh:1220004db5b4978927a0f0d08f20b98cdaaba68b3c65faf66f5cef2e58b92aac7bea&dn=Guide");
  });

  it("uses the v1 file listing once and strips padding in a hybrid", () => {
    const torrent = parse("d9:file treed4:docsd8:read.txtd0:d6:lengthi5eeeee" +
      "5:filesld6:lengthi5e4:pathl8:read.txteed4:attr1:p6:lengthi16379e4:pathl3:padeee" +
      `12:meta versioni2e4:name5:Guide12:piece lengthi16384e${pieces}e`);
    expect(torrent.files).toEqual([{ path: "read.txt", size: 5 }]);
    expect(torrent.size).toBe(5);
    expect(new URL(torrent.magnet).searchParams.getAll("xt")).toEqual([
      `urn:btih:${torrent.hash}`,
      expect.stringMatching(/^urn:btmh:1220[0-9a-f]{64}$/),
    ]);
  });

  it.each([
    ["a short string", "d4:name99:x"],
    ["duplicate keys", "d4:name1:x4:name1:ye"],
    ["a deeply nested extension", `d1:x${"l".repeat(50)}1:x${"e".repeat(51)}`],
    ["an integer outside the safe range", "d6:lengthi9007199254740993ee"],
  ])("rejects %s", (_, info) => {
    expect(() => parse(info)).toThrow("Invalid torrent metainfo");
  });
});
