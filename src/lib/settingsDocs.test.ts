import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CANONICAL_LIST_CONFIG_KEYS,
  DM_CONFIG_KEYS,
  METADATA_CONFIG_KEYS,
  NOTIF_CONFIG_KEYS,
  PER_DEVICE_CONFIG_KEYS,
  RAIL_CONFIG_KEYS,
  SYNCED_CONFIG_KEYS,
  defaultConfig,
} from "@/contexts/AppContext";
import { APP_ID } from "@/lib/platform";
import {
  MIGRATED_KEYS,
  SETTINGS_DOC_NAMES,
  SETTINGS_DOC_SCHEMAS,
  SETTINGS_DTAGS,
  hasMigratedKeys,
  parseSettingsDoc,
  railLayoutOf,
  resolveLegacy,
  settingsDTag,
  settingsDocForDTag,
  stripMigratedKeys,
} from "@/lib/settingsDocs";

import type { NostrRumor } from "@/lib/nostrRumor";

function rumor(id: string, createdAt: number): NostrRumor {
  return { id, pubkey: "a".repeat(64), kind: 30078, created_at: createdAt, content: "", tags: [] };
}

describe("settings document naming", () => {
  it("names every document `${APP_ID}/<name>`", () => {
    expect(settingsDTag("metadata")).toBe(`${APP_ID}/metadata`);
    expect(SETTINGS_DTAGS).toEqual(SETTINGS_DOC_NAMES.map((n) => `${APP_ID}/${n}`));
  });

  it("keeps the default build's metadata tag at its shipped spelling", () => {
    // Existing installs read `armada/metadata`. The APP_ID default is what
    // makes parameterizing the tag cost no migration; changing it would strand
    // every user's settings.
    expect(APP_ID).toBe("armada");
    expect(settingsDTag("metadata")).toBe("armada/metadata");
  });

  it("round-trips a `d` tag back to its document, and rejects a foreign one", () => {
    for (const name of SETTINGS_DOC_NAMES) {
      expect(settingsDocForDTag(settingsDTag(name))).toBe(name);
    }
    expect(settingsDocForDTag("ditto/metadata")).toBeUndefined();
    expect(settingsDocForDTag("armada/gif-favorites/abc")).toBeUndefined();
  });

  it("has a schema for every document", () => {
    expect(Object.keys(SETTINGS_DOC_SCHEMAS).sort()).toEqual([...SETTINGS_DOC_NAMES].sort());
  });
});

describe("config key partition", () => {
  /**
   * Every synced key belongs to exactly one document. Two would mean two
   * writers for one field, racing; zero means a setting the user changes and
   * that never leaves the device.
   */
  it("assigns each synced key to exactly one document", () => {
    const all = [
      ...METADATA_CONFIG_KEYS,
      ...RAIL_CONFIG_KEYS,
      ...NOTIF_CONFIG_KEYS,
      ...DM_CONFIG_KEYS,
    ];
    expect(new Set(all).size).toBe(all.length);
    expect([...SYNCED_CONFIG_KEYS].sort()).toEqual([...all].sort());
  });

  it("only names keys that exist in AppConfig", () => {
    // `customTheme`, `memberListVisible`, `sendOnEnter` and `powDifficulty` are optional
    // and so absent from `defaultConfig`; everything else must be there.
    const known = new Set([...Object.keys(defaultConfig), "customTheme", "memberListVisible", "sendOnEnter", "powDifficulty"]);
    for (const key of SYNCED_CONFIG_KEYS) expect(known).toContain(key);
  });

  it("classifies every config field as encrypted, canonical-list, or per-device", () => {
    const known = new Set([...Object.keys(defaultConfig), "customTheme", "memberListVisible", "channelListWidth", "memberListWidth", "sendOnEnter", "powDifficulty"]);
    const classified = [
      ...SYNCED_CONFIG_KEYS,
      ...CANONICAL_LIST_CONFIG_KEYS,
      ...PER_DEVICE_CONFIG_KEYS,
    ];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...new Set(classified)].sort()).toEqual([...known].sort());
  });

  /**
   * A key a split document claims has to be the same key the document
   * actually carries, or the migration reads out of metadata into nothing.
   */
  it("claims from metadata exactly what each document carries", () => {
    expect([...MIGRATED_KEYS.rail]).toEqual(expect.arrayContaining([...RAIL_CONFIG_KEYS]));
    expect([...MIGRATED_KEYS.notifications]).toEqual([
      "notifLevels",
      "mutedCommunities",
      "mutedChannels",
    ]);
    expect(NOTIF_CONFIG_KEYS).toContain("pushPrefs");
    expect([...MIGRATED_KEYS.dms].sort()).toEqual([...DM_CONFIG_KEYS].sort());
    expect(MIGRATED_KEYS["read-state"]).toEqual(["readState"]);
    expect(MIGRATED_KEYS.reactions).toEqual(["frequentReactions"]);
  });
});

describe("stripMigratedKeys", () => {
  it("drops every split field and keeps the rest", () => {
    const stripped = stripMigratedKeys({
      theme: "dark",
      lastSync: 5,
      railLayout: [],
      railOrder: ["a"],
      readState: { a: 1 },
      notifLevels: {},
      mutedChannels: [],
      startedDms: [],
      frequentReactions: [],
    });
    expect(stripped).toEqual({ theme: "dark", lastSync: 5 });
  });

  it("leaves the legacy relay-list mirrors alone", () => {
    // Those aren't a split; they're read once by useInitialSync to rescue a
    // user whose canonical 10007/10050/10063 doesn't exist yet.
    const doc = { searchRelays: ["wss://s"], dmRelays: ["wss://d"] };
    expect(stripMigratedKeys(doc)).toEqual(doc);
  });
});

describe("resolveLegacy", () => {
  const split = { doc: { railLayout: [{ type: "item" as const, key: "new" }] }, event: rumor("s", 200) };
  const legacyDoc = { railLayout: [{ type: "item" as const, key: "old" }] };

  it("uses the split document when metadata carries nothing", () => {
    expect(resolveLegacy("rail", split, { doc: { theme: "dark" }, event: rumor("m", 999) }))
      .toEqual(split);
  });

  it("uses the split document when there is no metadata at all", () => {
    expect(resolveLegacy("rail", split, null)).toEqual(split);
  });

  it("falls back to metadata's copy when no split document exists yet", () => {
    const resolved = resolveLegacy("rail", null, { doc: legacyDoc, event: rumor("m", 100) });
    expect(resolved?.doc).toEqual(legacyDoc);
    // Identified by the metadata event, so the applied-guard re-fires when the
    // legacy source is superseded.
    expect(resolved?.event.id).toBe("m");
  });

  /**
   * Both builds are legitimate writers during the window, so the newer wins —
   * which self-heals in both directions rather than letting either one
   * permanently shadow the other.
   */
  it("prefers whichever document is newer", () => {
    expect(resolveLegacy("rail", split, { doc: legacyDoc, event: rumor("m", 100) })).toEqual(split);
    expect(
      resolveLegacy("rail", split, { doc: legacyDoc, event: rumor("m", 300) })?.doc,
    ).toEqual(legacyDoc);
  });

  it("keeps the split document on a tie", () => {
    expect(resolveLegacy("rail", split, { doc: legacyDoc, event: rumor("m", 200) })).toEqual(split);
  });

  it("returns null when neither source has anything", () => {
    expect(resolveLegacy("rail", null, null)).toBeNull();
  });

  it("detects a legacy carrier only by the keys that document claims", () => {
    expect(hasMigratedKeys({ railOrder: ["a"] }, "rail")).toBe(true);
    expect(hasMigratedKeys({ railOrder: ["a"] }, "dms")).toBe(false);
    expect(hasMigratedKeys(null, "rail")).toBe(false);
  });
});

describe("railLayoutOf", () => {
  it("prefers a stored layout", () => {
    const railLayout = [{ type: "item" as const, key: "a" }];
    expect(railLayoutOf({ railLayout, railOrder: ["b"] })).toEqual(railLayout);
  });

  it("seeds a layout from the pre-folder flat order", () => {
    expect(railLayoutOf({ railOrder: ["a", "b"] })).toEqual([
      { type: "item", key: "a" },
      { type: "item", key: "b" },
    ]);
  });

  it("has nothing to say about a document holding neither", () => {
    expect(railLayoutOf({})).toBeUndefined();
    expect(railLayoutOf(null)).toBeUndefined();
  });
});

/**
 * The Android notification service subscribes to and stores these documents
 * while the app is dead, and it needs the tag set before any WebView has run —
 * so it carries a hardcoded default alongside the set the plugin config
 * supplies. A default that has drifted from this catalogue costs background
 * delivery for whichever documents it is missing, silently, in the release
 * build only. Same shape of guard as `downloads.test.ts` reading the CI
 * workflows.
 */
describe("SelfState.kt default `d` tags", () => {
  it("matches the default-APP_ID root plus the legacy document set", () => {
    const kotlin = readFileSync("android/app/src/main/java/buzz/armada/app/db/SelfState.kt", "utf8");
    const block = kotlin.match(/DEFAULT_D_TAGS[^=]*=\s*setOf\(([^)]*)\)/s);
    expect(block, "SelfState.DEFAULT_D_TAGS not found").not.toBeNull();

    const tags = [...block![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(tags.sort()).toEqual(["armada", ...SETTINGS_DOC_NAMES.map((n) => `armada/${n}`)].sort());
  });
});

describe("parseSettingsDoc", () => {
  it("passes a valid document through untouched", () => {
    expect(parseSettingsDoc("metadata", { theme: "light", zapsEnabled: true })).toEqual({
      doc: { theme: "light", zapsEnabled: true },
      dropped: [],
    });
  });

  it("drops only the fields that fail, keeping the theme", () => {
    const parsed = parseSettingsDoc("metadata", {
      theme: "light",
      defaultZapMethod: "not-a-method",
      currencyDisplay: "btc",
      future: { kept: true },
    });
    expect(parsed?.doc).toEqual({ theme: "light", future: { kept: true } });
    expect(parsed?.dropped.sort()).toEqual(["currencyDisplay", "defaultZapMethod"]);
  });

  it("rejects a value that is not a document at all", () => {
    expect(parseSettingsDoc("metadata", "nope")).toBeNull();
    expect(parseSettingsDoc("metadata", [1, 2])).toBeNull();
    expect(parseSettingsDoc("metadata", null)).toBeNull();
  });
});
