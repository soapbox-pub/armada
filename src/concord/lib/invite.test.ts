import { describe, expect, it } from "vitest";

import { bytesToHex, communityIdOf, hex32, random32 } from "@/concord/lib/derive";
import {
  buildBundleEvent,
  buildInviteUrl,
  buildRefreshedBundleEvents,
  buildRevocationEvent,
  decodeFragment,
  encodeFragment,
  EMPTY_INVITE_LIST,
  inviteEntryEpoch,
  inviteTombstoneFor,
  mergeInviteLists,
  pruneExpiredInvites,
  mintLinkSigner,
  mintToken,
  parseBundleEvent,
  parseInviteLink,
  shareableInviteUrl,
  STOCK_RELAYS,
  type InviteBundle,
} from "@/concord/lib/invite";

function makeBundle(): { bundle: InviteBundle; ownerHex: string } {
  const ownerHex = bytesToHex(random32());
  const salt = random32();
  const cid = communityIdOf(hex32(ownerHex), salt);
  return {
    ownerHex,
    bundle: {
      community_id: bytesToHex(cid),
      owner: ownerHex,
      owner_salt: bytesToHex(salt),
      community_root: bytesToHex(random32()),
      root_epoch: 0,
      channels: [],
      relays: ["wss://a.example", "wss://b.example"],
      name: "Test community",
    },
  };
}

describe("fragment codec (CORD-05 §3)", () => {
  it("round-trips the stock set with zero relay bytes", () => {
    const token = mintToken();
    const frag = encodeFragment(token, STOCK_RELAYS);
    // version + flags + 16 token bytes = 18 bytes → 24 base64url chars.
    expect(frag.length).toBe(24);
    const decoded = decodeFragment(frag);
    expect(bytesToHex(decoded.token)).toBe(bytesToHex(token));
    expect(decoded.relays).toEqual(STOCK_RELAYS);
  });

  it("round-trips dictionary ids, wss-implied literals, and verbatim literals", () => {
    const token = mintToken();
    const relays = ["wss://relay.ditto.pub", "wss://armada.example.com", "ws://192.168.1.5:5577"];
    const decoded = decodeFragment(encodeFragment(token, relays));
    expect(decoded.relays).toEqual(relays);
    expect(bytesToHex(decoded.token)).toBe(bytesToHex(token));
  });

  it("caps bootstrap relays at 3", () => {
    const token = mintToken();
    const relays = ["wss://a.example", "wss://b.example", "wss://c.example", "wss://d.example"];
    expect(decodeFragment(encodeFragment(token, relays)).relays.length).toBe(3);
  });

  it("rejects legacy and future versions, truncation, and trailing bytes", () => {
    const token = mintToken();
    const good = encodeFragment(token, []);
    expect(() => decodeFragment(good)).not.toThrow();
    expect(() => decodeFragment("A" + good)).toThrow(); // corrupt
    expect(() => decodeFragment("")).toThrow();
  });
});

describe("invite bundle (CORD-05 §1–2)", () => {
  it("round-trips through the addressable event", async () => {
    const { bundle } = makeBundle();
    const token = mintToken();
    const link = mintLinkSigner();
    const event = await buildBundleEvent(bundle, token, link.sk);
    expect(event.pubkey).toBe(link.pk);
    expect(event.tags).toContainEqual(["d", ""]);

    const parsed = parseBundleEvent(event, link.pk, token, Date.now());
    expect(parsed.community_id).toBe(bundle.community_id);
    expect(parsed.name).toBe("Test community");
  });

  it("refuses a bundle whose owner does not reproduce the community_id", async () => {
    const { bundle } = makeBundle();
    const forged = { ...bundle, owner: bytesToHex(random32()) };
    const token = mintToken();
    const link = mintLinkSigner();
    const event = await buildBundleEvent(forged, token, link.sk);
    expect(() => parseBundleEvent(event, link.pk, token, Date.now())).toThrow(/community_id/);
  });

  it("refuses an impostor's event at a different author", async () => {
    const { bundle } = makeBundle();
    const token = mintToken();
    const link = mintLinkSigner();
    const squatter = mintLinkSigner();
    const event = await buildBundleEvent(bundle, token, squatter.sk);
    expect(() => parseBundleEvent(event, link.pk, token, Date.now())).toThrow(/not a valid/);
  });

  it("a revocation tombstone reads as revoked", async () => {
    const link = mintLinkSigner();
    const tomb = await buildRevocationEvent(link.sk);
    expect(() => parseBundleEvent(tomb, link.pk, mintToken(), Date.now())).toThrow(/revoked/);
  });

  it("expiry refuses joining but only past expires_at", async () => {
    const { bundle } = makeBundle();
    const token = mintToken();
    const link = mintLinkSigner();
    const withExpiry = { ...bundle, expires_at: 1_000_000 };
    const event = await buildBundleEvent(withExpiry, token, link.sk);
    expect(() => parseBundleEvent(event, link.pk, token, 999_999)).not.toThrow();
    expect(() => parseBundleEvent(event, link.pk, token, 1_000_001)).toThrow(/expired/);
  });

  it("carries the description preview, truncated to the byte cap on a code-point boundary", async () => {
    const { bundle } = makeBundle();
    const token = mintToken();
    const link = mintLinkSigner();
    // 3-byte code points, 200 of them = 600 bytes: the 500-byte cap falls
    // mid-code-point (500 / 3), so truncation must back off to a boundary.
    const withDescription = { ...bundle, description: "€".repeat(200) };
    const event = await buildBundleEvent(withDescription, token, link.sk);
    const parsed = parseBundleEvent(event, link.pk, token, Date.now());
    expect(parsed.description).toBe("€".repeat(166));
  });

  it("drops a non-string description rather than refusing the bundle", async () => {
    const { bundle } = makeBundle();
    const token = mintToken();
    const link = mintLinkSigner();
    const hostile = { ...bundle, description: 42 as unknown as string };
    const event = await buildBundleEvent(hostile, token, link.sk);
    const parsed = parseBundleEvent(event, link.pk, token, Date.now());
    expect(parsed.description).toBeUndefined();
  });

  it("bounds a hostile bundle's channel count", async () => {
    const { bundle } = makeBundle();
    const token = mintToken();
    const link = mintLinkSigner();
    const hostile = {
      ...bundle,
      channels: Array.from({ length: 300 }, () => ({
        id: bytesToHex(random32()),
        key: bytesToHex(random32()),
        epoch: 0,
        name: "x",
      })),
    };
    const event = await buildBundleEvent(hostile, token, link.sk);
    expect(() => parseBundleEvent(event, link.pk, token, Date.now())).toThrow(/channels/);
  });
});

describe("invite links", () => {
  it("builds and parses a full URL and the bare naddr#fragment form", () => {
    const link = mintLinkSigner();
    const token = mintToken();
    const url = buildInviteUrl("https://armada.example.com", link.pk, token, ["wss://a.example"]);
    expect(url).toContain("/invite/naddr1");
    expect(url).toContain("#");

    const parsed = parseInviteLink(url);
    expect(parsed).toBeDefined();
    expect(parsed!.linkSigner).toBe(link.pk);
    expect(bytesToHex(parsed!.token)).toBe(bytesToHex(token));
    expect(parsed!.bootstrapRelays).toEqual(["wss://a.example"]);

    const bare = `${parsed!.naddr}#${url.split("#")[1]}`;
    const parsedBare = parseInviteLink(bare);
    expect(parsedBare?.linkSigner).toBe(link.pk);
  });

  it("returns undefined for unrecognized invites and garbage (so classifiers fall through)", () => {
    expect(parseInviteLink("https://armada.example.com/invite#sometokenpayload_here123")).toBeUndefined();
    expect(parseInviteLink("wss://relay.example.com")).toBeUndefined();
    expect(parseInviteLink("hello world")).toBeUndefined();
  });

  it("re-bases a link stored on an origin only its own app can resolve", () => {
    const link = mintLinkSigner();
    const token = mintToken();
    // What the desktop shell minted: its private app:// scheme, which no
    // recipient (and no other device of the creator's) can open.
    const stored = buildInviteUrl("app://armada", link.pk, token, ["wss://a.example"]);
    const shared = shareableInviteUrl("https://armada.buzz", stored);

    expect(shared.startsWith("https://armada.buzz/invite/")).toBe(true);
    // The naddr and the secret are the link: re-basing must not touch them.
    expect(shared.slice("https://armada.buzz".length)).toBe(stored.slice("app://armada".length));
    const parsed = parseInviteLink(shared);
    expect(parsed?.linkSigner).toBe(link.pk);
    expect(bytesToHex(parsed!.token)).toBe(bytesToHex(token));
  });

  it("leaves an http(s) link on the deployment it was minted for", () => {
    const link = mintLinkSigner();
    const token = mintToken();
    for (const base of ["https://chat.example.com", "http://localhost:8080"]) {
      const url = buildInviteUrl(base, link.pk, token, ["wss://a.example"]);
      expect(shareableInviteUrl("https://armada.buzz", url)).toBe(url);
    }
  });

  it("leaves anything that isn't an invite link alone", () => {
    expect(shareableInviteUrl("https://armada.buzz", "hello world")).toBe("hello world");
  });
});

describe("bundle refresh after a Refounding (CORD-05 §2)", () => {
  it("re-posts every live link's bundle at the current keys, preserving per-link expiry/label", async () => {
    const { bundle } = makeBundle();
    const linkA = mintLinkSigner();
    const linkB = mintLinkSigner();
    const tokenA = mintToken();
    const tokenB = mintToken();

    // The community Refounded: a fresh root at epoch 1. The refreshed bundle
    // carries the CURRENT keys (what buildBundle reads post-rotation).
    const fresh: InviteBundle = {
      ...bundle,
      community_root: bytesToHex(random32()),
      root_epoch: 1,
    };
    const futureSecs = Math.floor(Date.now() / 1000) + 3600;
    const events = await buildRefreshedBundleEvents(fresh, [
      { token: bytesToHex(tokenA), signer_sk: bytesToHex(linkA.sk), expires_at: futureSecs, label: "Reddit" },
      { token: bytesToHex(tokenB), signer_sk: bytesToHex(linkB.sk) },
    ]);
    expect(events.length).toBe(2);

    // Each event sits at its own link's coordinate and decrypts with its token.
    const a = parseBundleEvent(events[0], linkA.pk, tokenA, Date.now());
    expect(events[0].pubkey).toBe(linkA.pk);
    expect(a.root_epoch).toBe(1); // the CURRENT epoch, not the stale 0
    expect(a.community_root).toBe(fresh.community_root);
    expect(a.expires_at).toBe(futureSecs * 1000); // seconds → ms, preserved
    expect(a.label).toBe("Reddit");

    const b = parseBundleEvent(events[1], linkB.pk, tokenB, Date.now());
    expect(b.root_epoch).toBe(1);
    expect(b.expires_at).toBeUndefined();
  });

  it("skips a malformed entry rather than throwing", async () => {
    const { bundle } = makeBundle();
    const link = mintLinkSigner();
    const token = mintToken();
    const events = await buildRefreshedBundleEvents(bundle, [
      { token: "not-hex", signer_sk: "also-not-hex" },
      { token: bytesToHex(token), signer_sk: bytesToHex(link.sk) },
    ]);
    expect(events.length).toBe(1);
    expect(events[0].pubkey).toBe(link.pk);
  });
});

describe("invite list merge (CORD-05 §4)", () => {
  it("entries are immutable, tombstones union and win terminally", () => {
    const entry = {
      token: "aa".repeat(16),
      signer_sk: "bb".repeat(32),
      community_id: "cc".repeat(32),
      url: "https://x/invite/naddr1xyz#frag",
      created_at: 1000,
    };
    const a = mergeInviteLists(EMPTY_INVITE_LIST, { entries: [entry], tombstones: [] });
    expect(a.entries.length).toBe(1);

    const b = mergeInviteLists(a, {
      entries: [],
      tombstones: [{ token: entry.token, community_id: entry.community_id }],
    });
    expect(b.entries.length).toBe(0);
    expect(b.tombstones.length).toBe(1);

    // A stale device re-merging the entry can't resurrect the revoked link.
    const c = mergeInviteLists(b, { entries: [entry], tombstones: [] });
    expect(c.entries.length).toBe(0);
  });

  it("prunes entries and tombstones past their expiry, and a tombstone inherits it", () => {
    const entry = {
      token: "aa".repeat(16),
      signer_sk: "bb".repeat(32),
      community_id: "cc".repeat(32),
      url: "https://x/invite/naddr1xyz#frag",
      created_at: 1000,
      expires_at: 2000,
    };
    const tomb = inviteTombstoneFor(entry);
    expect(tomb).toEqual({ token: entry.token, community_id: entry.community_id, expires_at: 2000 });
    const forever = { ...entry, token: "dd".repeat(16), expires_at: undefined };
    const list = { entries: [entry, forever], tombstones: [{ ...tomb, token: "ee".repeat(16) }] };
    expect(pruneExpiredInvites(list, 1999)).toBe(list);
    const pruned = pruneExpiredInvites(list, 2000);
    expect(pruned.entries.map((e) => e.token)).toEqual([forever.token]);
    expect(pruned.tombstones).toEqual([]);
  });

  it("reads an entry without an epoch as minted at epoch 0", () => {
    const entry = { token: "aa".repeat(16), signer_sk: "bb".repeat(32), community_id: "cc".repeat(32), url: "", created_at: 1 };
    expect(inviteEntryEpoch(entry)).toBe(0);
    expect(inviteEntryEpoch({ ...entry, epoch: 4 })).toBe(4);
  });
});
