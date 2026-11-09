/** Role mentions (CORD-03 §3, CORD-04 §8), against Vector's `community/mentions.rs`. */
import { describe, expect, it } from "vitest";

import { foldControlState } from "@/concord/lib/control";
import { heldRoleMentions, pingableRoles, roleMentionAuthors, roleMentionIds, roleMentionTags, rolePings } from "@/concord/lib/roleMentions";
import { Permissions } from "@/concord/lib/roles";
import { hexKey, TestCommunity } from "@/test/concordEditions";

const MODS = "a".repeat(64);
const QUIET = "b".repeat(64);
const held = [{ id: MODS, name: "Mods", anyone: true }, { id: QUIET, name: "Quiet", anyone: false }];

describe("rolePings", () => {
  it("pings a held mentionable Role named in the text", () => {
    expect(rolePings("hey @Mods", [["role", MODS]], held, false)).toBe(true);
  });

  it("pings nobody for a tag without its name in the text", () => {
    expect(rolePings("hey all", [["role", MODS]], held, false)).toBe(false);
  });

  it("pings a Role that isn't mentionable only from an author who may mention any", () => {
    expect(rolePings("hey @Quiet", [["role", QUIET]], held, false)).toBe(false);
    expect(rolePings("hey @Quiet", [["role", QUIET]], held, true)).toBe(true);
  });

  it("pings nobody for a Role with an empty name, which would match any `@`", () => {
    expect(rolePings("hey @bob", [["role", MODS]], [{ id: MODS, name: "", anyone: true }], true)).toBe(false);
  });

  it("matches the name byte for byte", () => {
    // A precomposed é in the text doesn't name a Role spelled with a combining accent.
    const decomposed = [{ id: MODS, name: "Cafe\u0301", anyone: true }];
    expect(rolePings("@Caf\u00e9", [["role", MODS]], decomposed, false)).toBe(false);
    expect(rolePings("@Cafe\u0301", [["role", MODS]], decomposed, false)).toBe(true);
  });

  it("reads only lowercase ids, the first sixteen distinct", () => {
    expect(roleMentionIds([["role", MODS.toUpperCase()]])).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => ["role", i.toString(16).padStart(64, "0")]);
    expect(roleMentionIds(many)).toHaveLength(16);
    expect(roleMentionIds([["role", MODS], ["role", MODS]])).toEqual([MODS]);
  });
});

describe("the reader's Roles and who may ping any (CORD-04 §8)", () => {
  it("holds the standing Roles granted, mentionable or under an @everyone with MENTION_EVERYONE", () => {
    const c = new TestCommunity();
    const [reader, pinger] = [hexKey(), hexKey()];
    const [mods, quiet, pingers] = [hexKey(), hexKey(), hexKey()];
    const folded = foldControlState([
      c.everyone(Permissions.SEND_MESSAGES),
      c.role(mods, "b", 0n, { name: "Mods", mentionable: true }),
      c.role(quiet, "c", 0n, { name: "Quiet" }),
      c.role(pingers, "a", Permissions.MENTION_EVERYONE, { name: "Pingers" }),
      c.grant(reader, [mods, quiet]),
      c.grant(pinger, [pingers]),
    ], c.id, c.owner);
    expect(heldRoleMentions(folded.roster, reader).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { id: mods, name: "Mods", anyone: true },
      { id: quiet, name: "Quiet", anyone: false },
    ]);
    expect(roleMentionAuthors(folded.roster, c.owner)).toEqual([c.owner, pinger].sort());
    // A writer is offered the mentionable Roles, or every Role with MENTION_EVERYONE.
    expect(pingableRoles(folded.roster, reader, c.owner).map((r) => r.name)).toEqual(["Mods"]);
    expect(pingableRoles(folded.roster, pinger, c.owner).map((r) => r.name).sort()).toEqual(["Mods", "Pingers", "Quiet"]);
  });
});

describe("roleMentionTags (the writer)", () => {
  const roles = [{ id: MODS, name: "Mods" }, { id: QUIET, name: "Quiet" }];
  it("tags each picked Role still named in the text", () => {
    expect(roleMentionTags("hey @Mods", roles, new Set([MODS, QUIET]))).toEqual([["role", MODS]]);
    expect(roleMentionTags("hey @Mods", roles, new Set())).toEqual([]);
  });

  it("writes at most sixteen", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: i.toString(16).padStart(64, "0"), name: `r${i}` }));
    const text = many.map((r) => `@${r.name}`).join(" ");
    expect(roleMentionTags(text, many, new Set(many.map((r) => r.id)))).toHaveLength(16);
  });
});
