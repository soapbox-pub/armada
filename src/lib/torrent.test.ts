import { describe, expect, it } from "vitest";

import { isMagnetUri } from "./sanitizeUrl";
import { parseMagnet, parseTorrent, torrentMatchesMagnet } from "./torrent";

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
    expect(torrent.magnet).toBe("magnet:?xt=urn:btmh:1220004db5b4978927a0f0d08f20b98cdaaba68b3c65faf66f5cef2e58b92aac7bea&dn=Guide&xl=5");
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

describe("torrent text and magnet", () => {
  const info = `d4:name9:guide.pdf6:lengthi42e${pieces}12:piece lengthi16384ee`;

  it("strips bidi overrides and control characters from names, paths and comments", () => {
    const name = "holiday\u202Egpj.exe";
    const bytesLength = new TextEncoder().encode(name).length;
    const torrent = parse(
      `d4:name${bytesLength}:${name}6:lengthi1e${pieces}12:piece lengthi16384ee`,
      "7:comment5:a\u0007b\n ",
    );
    expect(torrent.name).toBe("holidaygpj.exe");
    expect(torrent.files[0].path).toBe("holidaygpj.exe");
    expect(torrent.comment).toBe("ab");
  });

  it("adds the size, wss trackers and web seeds to the magnet", () => {
    const wss = "wss://tracker.test";
    const seed = "https://mirror.test/guide.pdf";
    const torrent = parse(info, `8:announce${wss.length}:${wss}8:url-list${seed.length}:${seed}`);
    const params = new URL(torrent.magnet).searchParams;
    expect(params.get("xl")).toBe("42");
    expect(params.getAll("tr")).toEqual([wss]);
    expect(params.getAll("ws")).toEqual([seed]);
  });

  it("keeps the magnet short enough to open", () => {
    const tiers = Array.from({ length: 16 }, (_, i) => {
      const url = `https://t${i}.test/${"%".repeat(240)}`;
      return `l${url.length}:${url}e`;
    }).join("");
    const torrent = parse(info, `13:announce-listl${tiers}e`);
    expect(isMagnetUri(torrent.magnet)).toBe(true);
  });

  it("reads a magnet's hash, name, size, trackers and exact source", () => {
    const magnet = parseMagnet(
      "magnet:?xt=urn:btih:D0F23C109D8662A3FE9338F75839AF8D57E5D4A9&dn=Ubuntu+MATE&xl=1234" +
        "&tr=udp%3A%2F%2Ft.test%3A80&tr=javascript%3Ax&xs=http%3A%2F%2F192.168.1.2%2Fa.torrent" +
        "&xs=https%3A%2F%2Freleases.test%2Fa.torrent",
    )!;
    expect(magnet.btih).toBe("d0f23c109d8662a3fe9338f75839af8d57e5d4a9");
    expect(magnet.name).toBe("Ubuntu MATE");
    expect(magnet.size).toBe(1234);
    expect(magnet.trackers).toEqual(["t.test:80"]);
    expect(magnet.exactSource).toBe("https://releases.test/a.torrent");
  });

  it("decodes a base32 btih and refuses a magnet without a full hash", () => {
    expect(parseMagnet("magnet:?xt=urn:btih:2DZDYEE5QZRKH7UTHD3VQONPRVL6LVFJ")!.btih)
      .toBe("d0f23c109d8662a3fe9338f75839af8d57e5d4a9");
    expect(parseMagnet("magnet:?xt=urn:btih:abc")).toBeUndefined();
    expect(parseMagnet("magnet:?dn=x")).toBeUndefined();
  });

  it("matches a torrent to a magnet only by every hash the magnet names", () => {
    const torrent = parse(info);
    expect(torrentMatchesMagnet(torrent, parseMagnet(torrent.magnet)!)).toBe(true);
    expect(torrentMatchesMagnet(torrent, parseMagnet(`magnet:?xt=urn:btih:${"0".repeat(40)}`)!)).toBe(false);
    expect(torrentMatchesMagnet(torrent, parseMagnet(`magnet:?xt=urn:btmh:1220${"0".repeat(64)}`)!)).toBe(false);
  });
});
