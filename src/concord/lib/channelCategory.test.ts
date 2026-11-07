import { describe, expect, it } from "vitest";

import {
  ARMADA_CHANNEL_CATEGORY_METADATA_KEY,
  categoryNames,
  channelCategory,
  groupChannelsByCategory,
  withRankedCategories,
  mutedGroupIds,
  withChannelCategory,
} from "@/concord/lib/channelCategory";
import { ARMADA_GIT_CHANNEL_METADATA_KEY, NAME_MAX_BYTES } from "@/concord/lib/types";

import type { ChannelMetadata } from "@/concord/lib/types";

const base: ChannelMetadata = { name: "general", private: false };

/** A channel as the sidebar sees it, plus the category it declares. */
interface TestChannel {
  name: string;
  category?: string;
}
function ch(name: string, category?: string): TestChannel {
  return { name, category };
}
const categoryOf = (c: TestChannel) => c.category;

describe("channelCategory metadata", () => {
  it("round-trips a category", () => {
    const withCat = withChannelCategory(base, "Voice");
    expect(channelCategory(withCat)).toBe("Voice");
  });

  it("preserves sibling extensions, understood or not", () => {
    // Every convention shares one `custom` object, and CORD-02 §6 requires an
    // editor round-trip the members it doesn't understand — so filing a
    // channel keeps both the repo attachments and whatever a future client
    // (or another one, today) put beside them.
    const metadata: ChannelMetadata = {
      ...base,
      custom: {
        [ARMADA_GIT_CHANNEL_METADATA_KEY]: { repositories: [] },
        "someone-else/thing": { keep: true },
      },
    };
    const filed = withChannelCategory(metadata, "Staff");
    expect(filed.custom).toEqual({
      [ARMADA_GIT_CHANNEL_METADATA_KEY]: { repositories: [] },
      "someone-else/thing": { keep: true },
      [ARMADA_CHANNEL_CATEGORY_METADATA_KEY]: { name: "Staff" },
    });
  });

  it("keeps the private flag when filing", () => {
    // Filing is a metadata edition like any other; dropping `private` here
    // would publish a Private Channel as public.
    const filed = withChannelCategory({ name: "staff", private: true }, "Staff");
    expect(filed.private).toBe(true);
    expect(withChannelCategory(filed, undefined).private).toBe(true);
  });

  it("clearing removes the key and leaves no empty custom behind", () => {
    const cleared = withChannelCategory(withChannelCategory(base, "Voice"), undefined);
    expect(channelCategory(cleared)).toBeUndefined();
    expect("custom" in cleared).toBe(false);
  });

  it("clearing keeps other extensions", () => {
    const metadata = withChannelCategory({ ...base, custom: { [ARMADA_GIT_CHANNEL_METADATA_KEY]: { repositories: [] } } }, "Voice");
    expect(withChannelCategory(metadata, undefined).custom).toEqual({ [ARMADA_GIT_CHANNEL_METADATA_KEY]: { repositories: [] } });
  });

  it("treats blank, malformed and over-long names as uncategorized", () => {
    expect(channelCategory({ ...base, custom: { [ARMADA_CHANNEL_CATEGORY_METADATA_KEY]: { name: "   " } } })).toBeUndefined();
    expect(channelCategory({ ...base, custom: { [ARMADA_CHANNEL_CATEGORY_METADATA_KEY]: { name: 7 } } })).toBeUndefined();
    expect(channelCategory({ ...base, custom: { [ARMADA_CHANNEL_CATEGORY_METADATA_KEY]: "Voice" } })).toBeUndefined();
    const tooLong = "x".repeat(NAME_MAX_BYTES + 1);
    expect(channelCategory({ ...base, custom: { [ARMADA_CHANNEL_CATEGORY_METADATA_KEY]: { name: tooLong } } })).toBeUndefined();
    expect(channelCategory(base)).toBeUndefined();
  });

  it("does not mutate the metadata it was given", () => {
    const metadata: ChannelMetadata = { ...base, custom: { [ARMADA_GIT_CHANNEL_METADATA_KEY]: { repositories: [] } } };
    withChannelCategory(metadata, "Voice");
    expect(metadata.custom).toEqual({ [ARMADA_GIT_CHANNEL_METADATA_KEY]: { repositories: [] } });
  });
});

describe("grouping", () => {
  it("keeps uncategorized channels in a leading run", () => {
    const { uncategorized, categories } = groupChannelsByCategory(
      [ch("general"), ch("random"), ch("standup", "Team")],
      categoryOf,
    );
    expect(uncategorized.map((c) => c.name)).toEqual(["general", "random"]);
    expect(categories.map((c) => c.name)).toEqual(["Team"]);
  });

  it("orders categories by their first channel, so channel order drives both", () => {
    // No second arrangement to maintain: ordering the channels ordered the
    // categories too.
    const { categories } = groupChannelsByCategory(
      [ch("standup", "Team"), ch("lobby", "Voice"), ch("retro", "Team")],
      categoryOf,
    );
    expect(categories.map((c) => c.name)).toEqual(["Team", "Voice"]);
    expect(categories[0].channels.map((c) => c.name)).toEqual(["standup", "retro"]);
  });

  it("merges spellings that differ only by case, labelling from the first", () => {
    const { categories } = groupChannelsByCategory(
      [ch("lobby", "Voice"), ch("afk", "voice"), ch("stage", "VOICE")],
      categoryOf,
    );
    expect(categories).toHaveLength(1);
    expect(categories[0].name).toBe("Voice");
    expect(categories[0].channels).toHaveLength(3);
  });

  it("treats a whitespace-only category as no category", () => {
    const { uncategorized, categories } = groupChannelsByCategory([ch("general", "   ")], categoryOf);
    expect(uncategorized.map((c) => c.name)).toEqual(["general"]);
    expect(categories).toEqual([]);
  });
});

describe("the picker's name list", () => {
  it("offers each category once, in display order", () => {
    expect(
      categoryNames([ch("general"), ch("lobby", "Voice"), ch("standup", "Team"), ch("afk", "Voice")], categoryOf),
    ).toEqual(["Voice", "Team"]);
  });

  it("folds case so a second spelling isn't offered as a second category", () => {
    // Picking from this list is what keeps `Voice`/`voice` from ever being
    // created; offering both would defeat it.
    expect(categoryNames([ch("lobby", "Voice"), ch("afk", "voice")], categoryOf)).toEqual(["Voice"]);
  });

  it("has nothing to offer when nothing is filed", () => {
    expect(categoryNames([ch("general"), ch("random", "  ")], categoryOf)).toEqual([]);
  });
});

describe("visibility follows the channels", () => {
  // channelsView omits a private channel whose key the member doesn't hold, so
  // these tests model what the sidebar is handed, not a separate filter.
  const everything = [
    ch("general"),
    ch("standup", "Team"),
    ch("secret-planning", "Leadership"),
    ch("secret-budget", "Leadership"),
  ];

  it("shows a category when at least one of its channels is visible", () => {
    const visibleToMember = everything.filter((c) => c.name !== "secret-budget");
    const { categories } = groupChannelsByCategory(visibleToMember, categoryOf);
    expect(categories.map((c) => c.name)).toEqual(["Team", "Leadership"]);
    expect(categories[1].channels.map((c) => c.name)).toEqual(["secret-planning"]);
  });

  it("drops a category entirely once every channel in it is gated away", () => {
    // The heading would otherwise advertise channels the member can't read.
    const visibleToMember = everything.filter((c) => !c.name.startsWith("secret-"));
    const { categories } = groupChannelsByCategory(visibleToMember, categoryOf);
    expect(categories.map((c) => c.name)).toEqual(["Team"]);
  });

  it("cannot produce an empty category", () => {
    const { categories } = groupChannelsByCategory(everything, categoryOf);
    expect(categories.every((c) => c.channels.length > 0)).toBe(true);
  });

  it("leaves a member who can see nothing with no headings at all", () => {
    const { uncategorized, categories } = groupChannelsByCategory([] as TestChannel[], categoryOf);
    expect(uncategorized).toEqual([]);
    expect(categories).toEqual([]);
  });
});

describe("mutedGroupIds", () => {
  const channels = ["a", "b", "c", "d", "e"].map((idHex) => ({ idHex }));

  it("folds three or more muted channels", () => {
    expect([...mutedGroupIds(channels, (id) => "abc".includes(id))]).toEqual(["a", "b", "c"]);
  });

  it("leaves fewer alone, and a fully muted community alone", () => {
    expect(mutedGroupIds(channels, (id) => "ab".includes(id)).size).toBe(0);
    expect(mutedGroupIds(channels, () => true).size).toBe(0);
  });
});

describe("withRankedCategories (CORD-03 §4, Vector `sidebar`)", () => {
  it("lists every Category in its order, an empty one where it is allowed", () => {
    const groups = [{ key: "b", name: "B", channels: [{ name: "x" }] }];
    const order = [{ idHex: "a", name: "A" }, { idHex: "b", name: "B" }, { idHex: "c", name: "" }];
    expect(withRankedCategories(groups, order, () => true).map((g) => [g.key, g.channels.length])).toEqual([["a", 0], ["b", 1], ["c", 0]]);
    expect(withRankedCategories(groups, order, (id) => id === "c").map((g) => g.key)).toEqual(["b", "c"]);
  });
});
