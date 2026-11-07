import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import {
  applyDrop,
  dissolveFolder,
  dmRailKey,
  firstRailRoute,
  flattenLayout,
  folderAnchor,
  homeSkippedOf,
  itemAnchor,
  mergeLayout,
  normalizeLayout,
  planDrop,
  railDmPubkeys,
  railKeyDmPubkey,
  railKeyToRoute,
  removeKey,
  renameFolder,
  type RailLayoutNode,
  type RailSlot,
} from "./railLayout";

const PEER = "a".repeat(64);
const OTHER = "b".repeat(64);

const item = (key: string): RailLayoutNode => ({ type: "item", key });
const folder = (id: string, keys: string[], name = ""): RailLayoutNode => ({
  type: "folder",
  id,
  name,
  keys,
});

describe("normalizeLayout", () => {
  it("dedupes keys, first occurrence wins", () => {
    expect(normalizeLayout([item("a"), folder("f", ["a", "b", "c"]), item("b")])).toEqual([
      item("a"),
      folder("f", ["b", "c"]),
    ]);
  });

  it("dissolves single-item folders in place and drops empty ones", () => {
    expect(normalizeLayout([folder("f", ["a"]), folder("g", []), item("b")])).toEqual([
      item("a"),
      item("b"),
    ]);
  });
});

describe("mergeLayout", () => {
  it("appends every live key when no layout has been stored", () => {
    expect(mergeLayout([], ["a", "b", "c"])).toEqual([item("a"), item("b"), item("c")]);
  });

  it("appends unknown live keys and keeps unknown stored keys in place", () => {
    const stored = [folder("f", ["a", "ghost"]), item("b")];
    expect(mergeLayout(stored, ["a", "b", "new"])).toEqual([
      folder("f", ["a", "ghost"]),
      item("b"),
      item("new"),
    ]);
  });
});

describe("applyDrop", () => {
  const layout = [item("a"), folder("f", ["b", "c"]), item("d")];

  it("reorders an item at the top level", () => {
    expect(applyDrop(layout, { kind: "item", key: "d" }, { type: "before", anchor: itemAnchor("a") })).toEqual([
      item("d"),
      item("a"),
      folder("f", ["b", "c"]),
    ]);
  });

  it("moves an item to the end", () => {
    expect(applyDrop(layout, { kind: "item", key: "a" }, { type: "end" })).toEqual([
      folder("f", ["b", "c"]),
      item("d"),
      item("a"),
    ]);
  });

  it("combines two top-level items into a new folder in place", () => {
    const out = applyDrop(layout, { kind: "item", key: "d" }, { type: "combine", withKey: "a" }, "new");
    expect(out).toEqual([folder("new", ["a", "d"]), folder("f", ["b", "c"])]);
  });

  it("drops an item into a folder (append and before-child)", () => {
    expect(applyDrop(layout, { kind: "item", key: "a" }, { type: "into-folder", folderId: "f" })).toEqual([
      folder("f", ["b", "c", "a"]),
      item("d"),
    ]);
    expect(
      applyDrop(layout, { kind: "item", key: "d" }, { type: "into-folder", folderId: "f", beforeKey: "c" }),
    ).toEqual([item("a"), folder("f", ["b", "d", "c"])]);
  });

  it("dragging the second-to-last item out dissolves the folder", () => {
    const out = applyDrop(layout, { kind: "item", key: "b" }, { type: "before", anchor: itemAnchor("a") });
    expect(out).toEqual([item("b"), item("a"), item("c"), item("d")]);
  });

  it("reorders items within a folder", () => {
    const out = applyDrop(layout, { kind: "item", key: "c" }, { type: "into-folder", folderId: "f", beforeKey: "b" });
    expect(out).toEqual([item("a"), folder("f", ["c", "b"]), item("d")]);
  });

  it("moves whole folders at the top level only", () => {
    expect(applyDrop(layout, { kind: "folder", id: "f" }, { type: "before", anchor: itemAnchor("a") })).toEqual([
      folder("f", ["b", "c"]),
      item("a"),
      item("d"),
    ]);
    // Combine / into-folder are ignored for folder sources (no nesting).
    expect(applyDrop(layout, { kind: "folder", id: "f" }, { type: "combine", withKey: "a" })).toEqual(layout);
  });

  it("is a no-op when dropped onto its own anchor", () => {
    expect(applyDrop(layout, { kind: "item", key: "a" }, { type: "before", anchor: itemAnchor("a") })).toEqual(layout);
    expect(applyDrop(layout, { kind: "item", key: "a" }, { type: "combine", withKey: "a" })).toEqual(layout);
  });

  it("falls back to appending when a combine target vanished", () => {
    const out = applyDrop(layout, { kind: "item", key: "a" }, { type: "combine", withKey: "zz" }, "new");
    expect(out).toEqual([folder("f", ["b", "c"]), item("d"), item("a")]);
  });

  it("creates folders without crypto.randomUUID (insecure http contexts)", () => {
    // crypto.randomUUID is secure-context-only: it's undefined when the app is
    // served over plain http on a LAN host. Folder creation must still work.
    const original = crypto.randomUUID;
    // @ts-expect-error — simulating an insecure context.
    crypto.randomUUID = undefined;
    try {
      const out = applyDrop(layout, { kind: "item", key: "d" }, { type: "combine", withKey: "a" });
      expect(out[0]).toMatchObject({ type: "folder", name: "", keys: ["a", "d"] });
      expect((out[0] as { id: string }).id).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      crypto.randomUUID = original;
    }
  });

  it("preserves unknown (not-yet-loaded) keys inside folders", () => {
    const stored = [folder("f", ["ghost", "b"]), item("a")];
    const out = applyDrop(stored, { kind: "item", key: "a" }, { type: "into-folder", folderId: "f" });
    expect(out).toEqual([folder("f", ["ghost", "b", "a"])]);
  });
});

describe("renameFolder / dissolveFolder", () => {
  it("renames", () => {
    expect(renameFolder([folder("f", ["a", "b"])], "f", "Work")).toEqual([
      folder("f", ["a", "b"], "Work"),
    ]);
  });

  it("dissolves in place", () => {
    expect(dissolveFolder([item("x"), folder("f", ["a", "b"]), item("y")], "f")).toEqual([
      item("x"),
      item("a"),
      item("b"),
      item("y"),
    ]);
  });
});

describe("flattenLayout", () => {
  it("flattens folders in place", () => {
    expect(flattenLayout([item("a"), folder("f", ["b", "c"]), item("d")])).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});

describe("railKeyToRoute", () => {
  it("maps a NIP-29 server key (relay URL) to /s/<param>", () => {
    expect(railKeyToRoute("wss://relay.example.com")).toBe(
      "/s/relay.example.com",
    );
  });

  it("maps a Concord key to /c/<id>", () => {
    const id = "deadbeef";
    expect(railKeyToRoute(`c2:${id}`)).toBe(`/c/${id}`);
  });

  it("URL-encodes special characters in community ids", () => {
    expect(railKeyToRoute("c2:with/slash")).toBe("/c/with%2Fslash");
  });

  it("maps a DM key to the peer's THREAD, not the DM list", () => {
    expect(railKeyToRoute(dmRailKey(PEER))).toBe(`/dm/${nip19.npubEncode(PEER)}`);
  });

  it("has no route for a DM key that isn't a pubkey", () => {
    expect(railKeyToRoute("dm:not-a-pubkey")).toBeNull();
  });
});

describe("firstRailRoute", () => {
  const none = () => false;
  const blocked = (id: string) => id === "banned";

  it("lands on the first community or live server in rail order", () => {
    expect(firstRailRoute([item("c2:one"), item("wss://relay.example.com")], ["wss://relay.example.com"], none))
      .toBe("/c/one");
  });

  it("skips servers the user no longer has, and DMs", () => {
    expect(firstRailRoute([item("wss://gone"), item(dmRailKey(PEER)), item("c2:one")], [], none)).toBe("/c/one");
  });

  it("skips a blocked community at the top of the rail", () => {
    expect(firstRailRoute([folder("f", ["c2:banned", "c2:next"]), item("c2:last")], [], blocked)).toBe("/c/next");
  });

  it("has no route when a blocked community is the only one", () => {
    expect(firstRailRoute([item("c2:banned")], [], blocked)).toBeNull();
  });
});

describe("homeSkippedOf", () => {
  it("reads the skipped communities the / redirect handed its landing", () => {
    expect(homeSkippedOf({ homeSkipped: [] })).toEqual([]);
    expect(homeSkippedOf({ homeSkipped: ["left", "gone"] })).toEqual(["left", "gone"]);
  });

  it("is null for any other history state, so only a home landing bounces", () => {
    expect(homeSkippedOf(null)).toBeNull();
    expect(homeSkippedOf(undefined)).toBeNull();
    expect(homeSkippedOf({ background: {} })).toBeNull();
    expect(homeSkippedOf({ homeSkipped: "left" })).toBeNull();
    expect(homeSkippedOf({ homeSkipped: [1] })).toBeNull();
  });
});

describe("DM rail keys", () => {
  it("round-trips a pubkey", () => {
    expect(railKeyDmPubkey(dmRailKey(PEER))).toBe(PEER);
  });

  it("rejects anything that isn't 64 hex chars", () => {
    expect(railKeyDmPubkey("dm:")).toBeNull();
    expect(railKeyDmPubkey(`dm:${PEER.toUpperCase()}`)).toBeNull();
    expect(railKeyDmPubkey(`dm:${PEER}extra`)).toBeNull();
    expect(railKeyDmPubkey("wss://relay.example.com")).toBeNull();
    expect(railKeyDmPubkey(`c2:${PEER}`)).toBeNull();
  });

  it("collects DM peers from the layout in visual order, folders included", () => {
    expect(
      railDmPubkeys([item(dmRailKey(PEER)), folder("f", ["wss://a", dmRailKey(OTHER)])]),
    ).toEqual([PEER, OTHER]);
  });

  it("ignores a stored key that isn't a usable pubkey", () => {
    expect(railDmPubkeys([item("dm:nope"), item(dmRailKey(PEER))])).toEqual([PEER]);
  });
});

describe("planDrop", () => {
  // Three 48px slots at 16px gaps: a (0-48), folder f (64-112), b (128-176).
  const slots: RailSlot[] = [
    { anchor: itemAnchor("a"), top: 0, height: 48 },
    { anchor: folderAnchor("f"), top: 64, height: 48 },
    { anchor: itemAnchor("b"), top: 128, height: 48 },
  ];

  it("combines when over the middle of another item", () => {
    const plan = planDrop(24, slots, { kind: "item", key: "b" });
    expect(plan?.target).toEqual({ type: "combine", withKey: "a" });
    expect(plan?.highlightAnchor).toBe(itemAnchor("a"));
  });

  it("drops into a folder when over its middle", () => {
    const plan = planDrop(88, slots, { kind: "item", key: "b" });
    expect(plan?.target).toEqual({ type: "into-folder", folderId: "f" });
  });

  it("drops into a folder across its FULL rect (forgiving target)", () => {
    // Just inside the folder's top/bottom edges — still an into-folder drop,
    // not a reorder gap (the gaps between icons remain reorder zones).
    expect(planDrop(65, slots, { kind: "item", key: "b" })?.target).toEqual({
      type: "into-folder",
      folderId: "f",
    });
    expect(planDrop(111, slots, { kind: "item", key: "b" })?.target).toEqual({
      type: "into-folder",
      folderId: "f",
    });
  });

  it("targets gaps between slots", () => {
    const plan = planDrop(56, slots, { kind: "item", key: "b" });
    expect(plan?.target).toEqual({ type: "before", anchor: folderAnchor("f") });
    expect(plan?.indicatorY).toBe(62);
  });

  it("targets the end below the last slot", () => {
    const plan = planDrop(300, slots, { kind: "item", key: "a" });
    expect(plan?.target).toEqual({ type: "end" });
  });

  it("ignores the dragged item's own slot", () => {
    const plan = planDrop(24, slots, { kind: "item", key: "a" });
    // Own slot excluded: nearest remaining slot below is the folder.
    expect(plan?.target).toEqual({ type: "before", anchor: folderAnchor("f") });
  });

  it("folders only see top-level gaps (no combine, no nesting)", () => {
    const plan = planDrop(20, slots, { kind: "folder", id: "g" });
    expect(plan?.target).toEqual({ type: "before", anchor: itemAnchor("a") });
  });

  it("positions within an expanded folder's children", () => {
    const expanded: RailSlot[] = [
      { anchor: folderAnchor("f"), top: 0, height: 48 },
      { anchor: itemAnchor("x"), parentFolderId: "f", top: 64, height: 48 },
      { anchor: itemAnchor("y"), parentFolderId: "f", top: 128, height: 48 },
      { anchor: itemAnchor("z"), top: 192, height: 48 },
    ];
    // Middle of child x, lower half → before y.
    expect(planDrop(100, expanded, { kind: "item", key: "z" })?.target).toEqual({
      type: "into-folder",
      folderId: "f",
      beforeKey: "y",
    });
    // Middle of child y, lower half → append (no next sibling).
    expect(planDrop(164, expanded, { kind: "item", key: "z" })?.target).toEqual({
      type: "into-folder",
      folderId: "f",
      beforeKey: undefined,
    });
    // Below the folder entirely → top-level gap before z.
    expect(planDrop(184, expanded, { kind: "item", key: "x" })?.target).toEqual({
      type: "before",
      anchor: itemAnchor("z"),
    });
  });
});

describe("removeKey", () => {
  it("drops a top-level item", () => {
    expect(removeKey([item("a"), item("b"), item("c")], "b")).toEqual([item("a"), item("c")]);
  });

  it("drops an item out of a folder, keeping the folder", () => {
    expect(removeKey([folder("f", ["a", "b", "c"]), item("d")], "b")).toEqual([
      folder("f", ["a", "c"]),
      item("d"),
    ]);
  });

  it("dissolves a folder left with one member", () => {
    // Same Discord rule normalizeLayout applies to a drag-out.
    expect(removeKey([folder("f", ["a", "b"]), item("c")], "b")).toEqual([item("a"), item("c")]);
  });

  it("drops a folder that removal empties", () => {
    expect(removeKey([folder("f", ["a"]), item("c")], "a")).toEqual([item("c")]);
  });

  it("is a no-op for a key the layout doesn't hold", () => {
    const layout = [folder("f", ["a", "b"]), item("c")];
    expect(removeKey(layout, "zzz")).toEqual(layout);
  });

  it("purges the key so a later re-add can't reappear inside its old folder", () => {
    // The whole point: mergeLayout appends unknown live keys at the END, so a
    // rejoined community comes back at the bottom rather than in the folder it
    // was in when the user left.
    const left = removeKey([folder("f", ["a", "b", "c"])], "b");
    expect(flattenLayout(left)).toEqual(["a", "c"]);
    expect(flattenLayout(mergeLayout(left, ["a", "c", "b"]))).toEqual(["a", "c", "b"]);
  });
});
