/**
 * Differential conformance against Vector: random Control Planes of Channel and
 * Category editions (renames, re-filing, positions, topics, forks, deletions) from
 * managers and non-managers, with a manager Role that may be stripped midway, that
 * Vector built and folded with `apply_control_fold`, once whole and twice over a
 * withheld slice floored at the full fold's heads
 * (`scripts/vector-fixtures/armada_channel_fuzz.rs`). Armada must fold every slice to
 * the same live Channels and Categories.
 */
import type { NostrEvent } from "@nostrify/nostrify";
import { describe, expect, it } from "vitest";

import { foldControlState, openControlWraps, storedControlOf, type EntityHead, type FoldedControl } from "@/concord/lib/control";
import { bytesToHex, controlGroupKey, hex32, type StreamKeyView } from "@/concord/lib/derive";
import type { ParsedEdition } from "@/concord/lib/edition";

import cases from "./fixtures/cord25/channel_fuzz.json";

interface Dump {
  channels: Array<{ id: string; name: string; private: boolean; category: string | null; position: string | null; topic: string | null }>;
  categories: Array<{ id: string; name: string; position: string | null }>;
}

interface Case {
  seed: number;
  community: { id: string; owner: string; root: string; root_epoch: number; control_pk: string | null };
  events: NostrEvent[];
  floors: Array<{ eid: string; version: number; hash: string; id: string; author: string }>;
  slices: Array<{ floors: boolean; served: string[]; vector: Dump }>;
}

function view(c: Case["community"]): StreamKeyView {
  const read = controlGroupKey(hex32(c.root), hex32(c.id), BigInt(c.root_epoch));
  if (!c.control_pk) return read;
  return { pk: c.control_pk, get convKey() { return read.convKey; }, restricted: true };
}

function dump(folded: FoldedControl): Dump {
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    channels: [...folded.channels.values()]
      .filter((c) => !c.deleted)
      .map((c) => ({
        id: c.channelIdHex,
        name: c.metadata.name,
        private: c.isPrivate,
        category: str(c.metadata.category),
        position: str(c.metadata.position),
        topic: str(c.metadata.topic),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    categories: [...(folded.categories?.values() ?? [])]
      .filter((k) => !k.deleted)
      .map((k) => ({ id: k.idHex, name: k.name, position: k.position ?? null }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

describe.each((cases as unknown as Case[]).map((c) => [c.seed, c] as const))("Vector channel fuzz case %i", (_seed, c) => {
  const all = openControlWraps(c.events, [view(c.community)]);
  const byId = new Map(all.map((e) => [bytesToHex(e.rumorId), e]));
  // A tracking reader stored what the full fold settled on, as the generator's does.
  const full = foldControlState(all, hex32(c.community.id), c.community.owner);
  const stored = storedControlOf(full);
  const prior = new Map<string, EntityHead>(c.floors.map((f) => [f.eid, { version: BigInt(f.version), hash: hex32(f.hash), rumorId: f.id, author: f.author }]));

  it.each(c.slices.map((s, i) => [i, s] as const))("slice %i folds as Vector does", (_i, slice) => {
    const editions = slice.served.map((id) => byId.get(id)).filter((e): e is ParsedEdition => e !== undefined);
    expect(editions.length).toBe(slice.served.length);
    const folded = slice.floors
      ? foldControlState(editions, hex32(c.community.id), c.community.owner, new Map(prior), undefined, stored)
      : foldControlState(editions, hex32(c.community.id), c.community.owner);
    const mine = dump(folded);
    const theirs = slice.vector;
    expect(mine.categories).toEqual(theirs.categories);
    expect(mine.channels).toEqual(theirs.channels.map((ch) => ({ ...ch, topic: ch.topic ?? null })));
  });
});
