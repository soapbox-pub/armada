/**
 * CORD-02 A.6/A.7 and CORD-04 §1 test vectors for the coordinates, keys and
 * hashes channel permissions and the vsk-13 Roster added.
 */
import { describe, expect, it } from "vitest";

import {
  aclLocator,
  banlistLocator,
  bytesToHex,
  channelAccessGroupKey,
  channelWriterGroupKey,
  editionBinding,
  everyoneLocator,
  grantLocator,
  overwriteTargetBytes,
  pinsLocator,
  syncLocator,
  tenureLocator,
  wrapOwnerKey,
  writersLocator,
  channelGroupKey,
} from "@/concord/lib/derive";
import { buildEditionRumor, markEdition, parseEdition } from "@/concord/lib/edition";
import type { OpenedEvent } from "@/concord/lib/stream";
import { editionHash, markedEditionHash } from "@/concord/lib/version";

const fill = (b: number) => new Uint8Array(32).fill(b);
const cid = fill(0x01);
const channel = fill(0x02);
const member = fill(0x03);
const sealer = fill(0x04);
const role = fill(0x05);
const hex = bytesToHex;

describe("CORD-02 A.6 coordinate vectors", () => {
  it.each([
    ["grant", () => grantLocator(cid, member), "087cc31d524f398b0810e36aa18b9d135427514c3788382c39c50c0bc50381f3"],
    ["banlist", () => banlistLocator(cid), "cf2767777adcceb8a2ce51d5c3d3c20de9c74bf4867bc2373e5b12eacb5c73d8"],
    ["everyone", () => everyoneLocator(cid), "3fbe677b7b2bbddc50d08a428d4e61c8e4c7fdba586d13f1b0f421ab906eeebd"],
    ["edition-binding", () => editionBinding(cid), "d09129fb5961dc61a181cdfaa2c6588396465ebbdb2c45d79b3fae0b9ad71955"],
    ["tenure", () => tenureLocator(cid, member, sealer), "e252eea5e2d7172d166c2dc9c6902df736180fb2105bfaf859f990f509be57d1"],
    ["sync", () => syncLocator(cid, channel), "6b08541be1e17ef80f2552273d2534d5b6eac9ab244c4044d2cf150cecfab49f"],
    ["writers", () => writersLocator(cid, channel), "f79c6f82f7076ca71112846c985a42acee711f95e2b37aaf05ed4777b0779324"],
    ["pins", () => pinsLocator(cid, channel), "6e1aa2cb6c78baed7d417d2f6432b1b651b8b605db58515d0749f400b0593a00"],
    ["acl everyone", () => aclLocator(cid, channel, overwriteTargetBytes(cid, "everyone")), "5b337620f7f8d929a0434be597e20ce5c4440bce8c377eb41e0b3b250b6a0ffe"],
    ["acl role", () => aclLocator(cid, channel, overwriteTargetBytes(cid, "role", role)), "cf60d1469c48371fe46a8a2643b4dc0e9da025ba3ac1b08c07acc63ca27d1393"],
    ["acl member", () => aclLocator(cid, channel, overwriteTargetBytes(cid, "member", member)), "1ac57124b4398297a2ac7c96099cef0f21b206e3602921f740c89408c3e69ed1"],
  ])("%s", (_name, derive, expected) => {
    expect(hex(derive())).toBe(expected);
  });
});

describe("CORD-02 A.6 key and address vectors", () => {
  const secret = Uint8Array.from({ length: 32 }, (_, i) => i);
  const id = Uint8Array.from({ length: 32 }, (_, i) => 0xff - i);
  const alt = fill(0x11);

  it("channel-access pk", () => {
    expect(channelAccessGroupKey(secret, id, 0).pk).toBe("901126284c4d1dfd5e753aa866e28b498825c3382611d1f5d5e929de0bcae15e");
  });

  it("channel-writer pk, epoch 1", () => {
    expect(channelWriterGroupKey(secret, id, 1).pk).toBe("7a5b45238020c162ffb7237c680934cf088ddfa47e1d5e2d630450672bc32555");
  });

  it("wrap-owner pk", () => {
    const address = channelGroupKey(secret, id, 0).pk;
    expect(address).toBe("7a5c5dff759a63f1fc2779864487432bae3d1ea72c4ffabd39f4c1fdaf62097a");
    expect(wrapOwnerKey(secret, address, alt).pk).toBe("5beb1665f03b5bdbd02dcb3e644a9c7ebca0e0c86b26767c7588470e4603f5dc");
  });
});

describe("CORD-04 §1 marked edition hash", () => {
  it("covers the signer", () => {
    const content = new TextEncoder().encode('{"name":"Mods"}');
    expect(hex(editionHash(fill(0x11), 2n, fill(0x22), content))).toBe(
      "3c1d4111bff28cea4c1f237dcce34efbc227db6e304cdd1146e1413657972475",
    );
    expect(hex(markedEditionHash(fill(0x11), 2n, fill(0x22), content, fill(0x33)))).toBe(
      "462cc81a6f74622e5ff660ab3efcc007527c8d108e8242942f7ba7787a27d0ed",
    );
  });
});

describe("CORD-04 §1 marked edition tags", () => {
  const author = "33".repeat(32);
  const opened = (tags: string[][]) =>
    ({
      rumorId: "aa".repeat(32),
      author,
      kind: 3308,
      content: '{"name":"Mods"}',
      tags,
      ms: 0,
      createdAt: 1,
      wrapId: "bb".repeat(32),
      streamPk: "",
      seal: {} as never,
    }) as OpenedEvent;
  const base = [["vsk", "13"], ["eid", "11".repeat(32)], ["ev", "2"], ["ep", "22".repeat(32)]];

  it("hashes a marked edition with its signer and keeps its binding", () => {
    const p = parseEdition(opened([...base, ["eh", "2"], ["eb", "dd".repeat(32)]]));
    expect(hex(p.selfHash)).toBe("462cc81a6f74622e5ff660ab3efcc007527c8d108e8242942f7ba7787a27d0ed");
    expect(hex(p.binding!)).toBe("dd".repeat(32));
  });

  it("reads an eb without eh as unmarked", () => {
    const p = parseEdition(opened([...base, ["eb", "dd".repeat(32)]]));
    expect(p.binding).toBeUndefined();
    expect(hex(p.selfHash)).toBe("3c1d4111bff28cea4c1f237dcce34efbc227db6e304cdd1146e1413657972475");
  });

  it("refuses an unknown eh, an eh without eb, and a repeated marker", () => {
    expect(() => parseEdition(opened([...base, ["eh", "3"], ["eb", "dd".repeat(32)]]))).toThrow();
    expect(() => parseEdition(opened([...base, ["eh", "2"]]))).toThrow();
    expect(() => parseEdition(opened([...base, ["eh", "2"], ["eb", "dd".repeat(32)], ["eb", "ee".repeat(32)]]))).toThrow();
  });

  it("writes the marker after the citation", () => {
    const rumor = buildEditionRumor({
      vsk: "13",
      entityId: fill(0x11),
      version: 1n,
      content: "{}",
      actorPubkey: author,
      binding: fill(0xdd),
    });
    expect(rumor.tags.slice(-2)).toEqual([["eh", "2"], ["eb", "dd".repeat(32)]]);
  });
});

describe("markEdition", () => {
  it("marks an unmarked rumor once, with a fresh id", () => {
    const rumor = buildEditionRumor({ vsk: "2", entityId: fill(0x11), version: 1n, content: "{}", actorPubkey: "33".repeat(32) });
    const marked = markEdition(rumor, fill(0xdd));
    expect(marked.tags.slice(-2)).toEqual([["eh", "2"], ["eb", "dd".repeat(32)]]);
    expect(marked.id).not.toBe(rumor.id);
    expect(markEdition(marked, fill(0xee))).toBe(marked);
  });
});
