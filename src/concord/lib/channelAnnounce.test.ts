import { describe, expect, it } from "vitest";

import {
  ARMADA_CHANNEL_ANNOUNCE_METADATA_KEY,
  channelAnnouncePk,
  isAnnouncementChannel,
  withChannelAnnouncePk,
} from "./channelAnnounce";
import type { ChannelMetadata } from "./types";

const PK = "ab".repeat(32);

describe("armada.announce channel metadata", () => {
  it("round-trips the address and leaves other extensions alone", () => {
    // CORD-02 §6's client-extensible object is SHARED. An editor that rebuilds
    // `custom` instead of spreading it silently unfiles the channel from its
    // category, or drops its repository attachment.
    const before: ChannelMetadata = {
      name: "news",
      private: false,
      custom: { "armada.category": { name: "Info" }, "armada.order": 3 },
    };
    const after = withChannelAnnouncePk(before, PK);
    expect(channelAnnouncePk(after)).toBe(PK);
    expect(after.custom).toMatchObject({ "armada.category": { name: "Info" }, "armada.order": 3 });
    // …and the original is not mutated in place.
    expect(channelAnnouncePk(before)).toBeUndefined();
  });

  it("clearing the address drops the key without emptying the object", () => {
    const withBoth = withChannelAnnouncePk(
      { name: "news", private: false, custom: { "armada.order": 1 } },
      PK,
    );
    const cleared = withChannelAnnouncePk(withBoth, undefined);
    expect(isAnnouncementChannel(cleared)).toBe(false);
    expect(cleared.custom).toEqual({ "armada.order": 1 });
  });

  it("drops `custom` entirely when the address was its only member", () => {
    const cleared = withChannelAnnouncePk(withChannelAnnouncePk({ name: "news", private: false }, PK), undefined);
    expect(cleared).not.toHaveProperty("custom");
  });

  it("refuses anything that is not a 32-byte hex address", () => {
    // A malformed value must read as "ordinary channel", never as an address:
    // `channelsView` would otherwise point the whole channel at a stream no
    // member can subscribe to and no staff member can sign for.
    for (const bad of ["", "nope", PK.slice(0, 63), `${PK}00`, "zz".repeat(32)]) {
      expect(channelAnnouncePk({ name: "n", private: false, custom: { [ARMADA_CHANNEL_ANNOUNCE_METADATA_KEY]: { pk: bad } } })).toBeUndefined();
      expect(withChannelAnnouncePk({ name: "n", private: false }, bad)).not.toHaveProperty("custom");
    }
    // Shape errors too: the extension must be an object carrying a string `pk`.
    expect(channelAnnouncePk({ name: "n", private: false, custom: { [ARMADA_CHANNEL_ANNOUNCE_METADATA_KEY]: PK } })).toBeUndefined();
    expect(channelAnnouncePk({ name: "n", private: false, custom: { [ARMADA_CHANNEL_ANNOUNCE_METADATA_KEY]: [PK] } })).toBeUndefined();
  });

  it("normalizes case, so one address has one spelling", () => {
    const upper = withChannelAnnouncePk({ name: "n", private: false }, PK.toUpperCase());
    expect(channelAnnouncePk(upper)).toBe(PK);
  });
});
