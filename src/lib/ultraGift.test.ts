import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { giftPath, parseGiftSegment, parseGiftUrl } from "@/lib/ultraGift";

const PK = "a".repeat(64);
const NPUB = nip19.npubEncode(PK);

describe("ultra gift links", () => {
  it("round-trips the gifter through the path", () => {
    expect(giftPath(PK)).toBe(`/gift/${NPUB}`);
    expect(parseGiftSegment(NPUB)).toBe(PK);
  });

  it("accepts an nprofile", () => {
    expect(parseGiftSegment(nip19.nprofileEncode({ pubkey: PK }))).toBe(PK);
  });

  it("matches gift URLs on any host", () => {
    expect(parseGiftUrl(`https://armada.buzz/gift/${NPUB}`)).toBe(PK);
    expect(parseGiftUrl(`https://chat.example.com/gift/${NPUB}/`)).toBe(PK);
  });

  it("rejects anything else", () => {
    expect(parseGiftUrl(`https://armada.buzz/${NPUB}`)).toBeUndefined();
    expect(parseGiftUrl(`https://armada.buzz/gift/${NPUB}/extra`)).toBeUndefined();
    expect(parseGiftUrl("https://armada.buzz/gift/nope")).toBeUndefined();
    expect(parseGiftUrl(`javascript:/gift/${NPUB}`)).toBeUndefined();
    expect(parseGiftSegment(nip19.noteEncode(PK))).toBeUndefined();
    expect(giftPath("xyz")).toBeUndefined();
  });
});
