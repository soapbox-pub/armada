/**
 * Differential conformance against Vector: random Control Planes of Roles,
 * Grants, `@everyone`, Tenures, deletions, forks and Banlists that Vector built
 * and folded with `fold_authority`, once with no floors and twice over a withheld
 * slice floored at the full fold's heads (`scripts/vector-fixtures/armada_roster_fuzz.rs`).
 * Armada must fold every slice to the same Roster, Banlist and heads.
 */
import type { NostrEvent } from "@nostrify/nostrify";
import { describe, expect, it } from "vitest";

import { foldControlState, openControlWraps, storedControlOf, type EntityHead, type StoredControl } from "@/concord/lib/control";
import { bytesToHex, controlGroupKey, hex32, type StreamKeyView } from "@/concord/lib/derive";
import type { ParsedEdition } from "@/concord/lib/edition";
import { channelPermissions } from "@/concord/lib/roles";
import { AUTHORITY_VSKS } from "@/concord/lib/roster";

import cases from "./fixtures/cord25/roster_fuzz.json";

interface Fold {
  overwrites: string[];
  syncs: Record<string, string>;
  perms: Record<string, string[]>;
  everyone: string | null;
  legacy: string[] | null;
  roles: Array<{ id: string; rank: string | null; permissions: string; name: string }>;
  grants: string[];
  banned: string[];
  banned_at: Record<string, number>;
  heads: Array<{ eid: string; version: number; hash: string; id: string; rebased: boolean }>;
  converged: boolean;
  complete: boolean;
}

interface Case {
  seed: number;
  community: { id: string; owner: string; root: string; root_epoch: number; control_pk: string | null };
  scopes: string[];
  actors: string[];
  events: NostrEvent[];
  floors: Array<{ eid: string; version: number; hash: string; id: string; author: string }>;
  /** `anon`: the floors this slice holds without their author, as an older stored head does. */
  /** `floor_rows`: this slice's own floors, an author null where none was recorded. */
  slices: Array<{ floors: boolean; anon?: string[]; floor_rows?: Array<{ eid: string; version: number; hash: string; id: string; author: string | null }>; served: string[]; vector: Fold }>;
}

function view(c: Case["community"]): StreamKeyView {
  const read = controlGroupKey(hex32(c.root), hex32(c.id), BigInt(c.root_epoch));
  if (!c.control_pk) return read;
  return { pk: c.control_pk, get convKey() { return read.convKey; }, restricted: true };
}

function armadaFold(c: Case, editions: ParsedEdition[], floors: boolean, stored?: StoredControl, anon: readonly string[] = [], rows: Case["slices"][number]["floor_rows"] = undefined, vskOf: (id: string) => string | undefined = () => undefined): Fold {
  // A stored head records its kind, as `headOf` does, so floors are judged by family.
  const kind = (id: string) => {
    const vsk = vskOf(id);
    return vsk === undefined ? {} : { vsk };
  };
  const prior = new Map<string, EntityHead>(
    !floors ? [] : rows
      ? rows.map((f) => [f.eid, { version: BigInt(f.version), hash: hex32(f.hash), rumorId: f.id, ...kind(f.id), ...(f.author ? { author: f.author } : {}) }])
      : c.floors.map((f) => [f.eid, { version: BigInt(f.version), hash: hex32(f.hash), rumorId: f.id, ...kind(f.id), ...(anon.includes(f.eid) ? {} : { author: f.author }) }]),
  );
  const folded = foldControlState(editions, hex32(c.community.id), c.community.owner, floors ? prior : undefined, undefined, stored);
  const rosterEids = new Set([...editions.filter((e) => ["1", "3", "4", "13", "14", "16", "17"].includes(e.vsk)).map((e) => bytesToHex(e.entityId)), ...prior.keys()]);
  const target = (t: { kind: string; id?: string }) => (t.kind === "everyone" ? "Everyone" : `${t.kind === "role" ? "Role" : "Member"}("${t.id}")`);
  return {
    overwrites: (folded.roster.overwrites ?? []).map((o) => `${o.scope}|${target(o.target)}|${o.allow}|${o.deny}`).sort(),
    syncs: { ...(folded.roster.syncs ?? {}) },
    perms: Object.fromEntries(
      c.actors.map((a) => [a, c.scopes.flatMap((ch) => [false, true].map((p) => channelPermissions(folded.roster, folded.ownerHex, a, ch, p).toString()))]),
    ),
    everyone: folded.roster.everyone?.toString() ?? null,
    legacy: folded.roster.legacyChannels ?? null,
    roles: folded.roster.roles.map((r) => ({ id: r.roleId, rank: r.rank ?? null, permissions: r.permissions.toString(), name: r.name })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    grants: folded.roster.grants.map((g) => `${g.member}:${[...g.roleIds].sort().join(",")}`).sort(),
    banned: [...folded.banned].sort(),
    banned_at: Object.fromEntries([...folded.bannedAt].sort(([a], [b]) => (a < b ? -1 : 1))),
    // The Roster's heads: a Channel squatting a Roster coordinate heads the Control fold there, not this one.
    heads: [...folded.heads]
      .filter(([eid, h]) => rosterEids.has(eid) && (h.vsk === undefined || AUTHORITY_VSKS.has(h.vsk)))
      .map(([eid, h]) => ({ eid, version: Number(h.version), hash: bytesToHex(h.hash), id: h.rumorId ?? "", rebased: h.rebased === true }))
      .sort((a, b) => (a.eid < b.eid ? -1 : 1)),
    converged: true,
    complete: folded.rosterComplete ?? true,
  };
}

describe.each((cases as unknown as Case[]).map((c) => [c.seed, c] as const))("Vector roster fuzz case %i", (_seed, c) => {
  const all = openControlWraps(c.events, [view(c.community)]);
  const byId = new Map(all.map((e) => [bytesToHex(e.rumorId), e]));

  // A tracking reader stored what the full fold settled on, as the generator does.
  const full = foldControlState(all, hex32(c.community.id), c.community.owner);
  // Vector's generator stores the Roster and the Banlist only; its ban marks are kept apart from the fold.
  const { banMarks: _marks, ...stored } = storedControlOf(full) ?? {};

  it.each(c.slices.map((s, i) => [i, s] as const))("slice %i folds as Vector does", (_i, slice) => {
    const editions = slice.served.map((id) => byId.get(id)).filter((e): e is ParsedEdition => e !== undefined);
    expect(editions.length).toBe(slice.served.length);
    const mine = armadaFold(c, editions, slice.floors, slice.floors ? stored : undefined, slice.anon, slice.floor_rows, (id) => byId.get(id)?.vsk);
    const theirs = slice.vector;
    expect(mine.everyone).toBe(theirs.everyone);
    expect(mine.overwrites).toEqual(theirs.overwrites);
    expect(mine.syncs).toEqual(theirs.syncs);
    expect(mine.perms).toEqual(theirs.perms);
    expect(mine.roles).toEqual(theirs.roles.map((r) => ({ ...r })).sort((a, b) => (a.id < b.id ? -1 : 1)));
    expect(mine.grants).toEqual(theirs.grants);
    expect(mine.banned).toEqual([...theirs.banned].sort());
    expect(mine.banned_at).toEqual(theirs.banned_at);
    expect(mine.heads).toEqual(theirs.heads.map((h) => ({ eid: h.eid, version: h.version, hash: h.hash, id: h.id, rebased: h.rebased })));
    expect(mine.legacy).toEqual(theirs.legacy);
    expect(mine.complete).toBe(theirs.complete);
  });
});
