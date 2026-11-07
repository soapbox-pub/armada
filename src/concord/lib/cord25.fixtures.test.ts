/**
 * Conformance against Vector: each fixture is a Community Vector built through
 * its own service code on an in-memory relay (every event it published, and the
 * keys a member holds), with the Roster and permissions Vector folded from it.
 * Armada must fold the same events to the same answer.
 */
import type { NostrEvent } from "@nostrify/nostrify";
import { describe, expect, it } from "vitest";

import { controlGroupKey, hex32, type StreamKeyView } from "@/concord/lib/derive";
import { channelsView, visibleChannels } from "@/concord/lib/community";
import { foldControlState, openControlWraps } from "@/concord/lib/control";
import type { Community } from "@/concord/lib/types";
import { BENEATH_EVERY_ROLE, channelPermissions, effectivePermissions } from "@/concord/lib/roles";
import { foldRankedRoster, rosterActivated } from "@/concord/lib/roster";

import guild from "./fixtures/cord25/guild.json";
import switched from "./fixtures/cord25/switched.json";

interface Fixture {
  community: { id: string; owner: string; root: string; root_epoch: number; control_pk: string | null };
  events: NostrEvent[];
  vector: {
    activated: boolean;
    roles: {
      roles: Array<{ role_id: string; name: string; rank?: string; permissions: number | string; position: number }>;
      grants: Array<{ member: string; role_ids: string[] }>;
      everyone?: number | string;
      legacy_channels?: string[];
      overwrites?: unknown[];
      syncs?: Record<string, string>;
    };
    channels: VectorChannel[];
    categories: Array<{ id: string; name: string; position?: string }>;
    members: Record<string, { pubkey: string; server: string; channels: Record<string, string> }>;
  };
}

function controlView(f: Fixture): StreamKeyView {
  const read = controlGroupKey(hex32(f.community.root), hex32(f.community.id), BigInt(f.community.root_epoch));
  if (!f.community.control_pk) return read;
  return { pk: f.community.control_pk, get convKey() { return read.convKey; }, restricted: true };
}

function editionsOf(f: Fixture) {
  return openControlWraps(f.events, [controlView(f)]);
}

interface VectorChannel {
  id: string;
  name: string;
  private: boolean;
  key: string | null;
  epoch: number;
  extra: Record<string, unknown>;
}

/** The Community as the owner holds it: every Private Channel key Vector's owner held. */
function ownerCommunity(f: Fixture): Community {
  const epoch = BigInt(f.community.root_epoch);
  return {
    id: hex32(f.community.id),
    idHex: f.community.id,
    owner: f.community.owner,
    ownerSalt: new Uint8Array(32),
    root: hex32(f.community.root),
    rootEpoch: epoch,
    ...(f.community.control_pk ? { controlPk: f.community.control_pk } : {}),
    heldRoots: [{ epoch, key: hex32(f.community.root), ...(f.community.control_pk ? { controlPk: f.community.control_pk } : {}) }],
    privateChannels: f.vector.channels
      .filter((c) => c.private && c.key)
      .map((c) => ({ id: hex32(c.id), key: hex32(c.key!), epoch: BigInt(c.epoch), name: "" })),
    relays: [],
    name: "",
  };
}

describe.each([["guild", guild as unknown as Fixture], ["switched", switched as unknown as Fixture]])("%s (Vector fixture)", (_name, f) => {
  const editions = editionsOf(f);
  const cid = hex32(f.community.id);

  it("opens the Control Plane", () => {
    expect(editions.length).toBeGreaterThan(0);
  });

  it("agrees the Community is on the vsk-13 Roster", () => {
    expect(rosterActivated(editions, cid, f.community.owner, new Map())).toBe(f.vector.activated);
  });

  it("folds the same Roles, @everyone and Grants", () => {
    const { roles, converged } = foldRankedRoster(editions, cid, f.community.owner, new Map());
    expect(converged).toBe(true);
    expect(roles.everyone?.toString()).toBe(f.vector.roles.everyone?.toString());
    const mine = roles.roles.map((r) => ({ id: r.roleId, name: r.name, rank: r.rank, bits: r.permissions.toString() })).sort((a, b) => (a.id < b.id ? -1 : 1));
    const theirs = f.vector.roles.roles
      .map((r) => ({ id: r.role_id, name: r.name, rank: r.rank, bits: r.permissions.toString() }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(mine).toEqual(theirs);
    const grants = (gs: Array<{ member: string; roleIds: string[] }>) =>
      gs.map((g) => `${g.member}:${[...g.roleIds].sort().join(",")}`).sort();
    expect(grants(roles.grants)).toEqual(grants(f.vector.roles.grants.map((g) => ({ member: g.member, roleIds: g.role_ids }))));
    expect(roles.legacyChannels).toEqual(f.vector.roles.legacy_channels);
    for (const r of roles.roles) expect(r.position).toBeLessThan(BENEATH_EVERY_ROLE);
  });

  it("gives every member the same server permissions", () => {
    const { roles } = foldRankedRoster(editions, cid, f.community.owner, new Map());
    for (const [label, m] of Object.entries(f.vector.members)) {
      expect(effectivePermissions(roles, m.pubkey).toString(), label).toBe(m.server);
    }
  });

  it("gives every member the same permissions in every Channel", () => {
    const roles = foldControlState(editions, cid, f.community.owner).roster;
    for (const [label, m] of Object.entries(f.vector.members)) {
      for (const ch of f.vector.channels) {
        expect(channelPermissions(roles, f.community.owner, m.pubkey, ch.id, ch.private).toString(), `${label} in #${ch.name}`).toBe(m.channels[ch.id]);
      }
    }
  });

  it("folds the same Categories, and the same place, topic and view for every public Channel", () => {
    const folded = foldControlState(editions, cid, f.community.owner);
    expect(folded.rankedRoster).toBe(true);
    const cats = [...(folded.categories?.values() ?? [])].filter((c) => !c.deleted).map((c) => ({ id: c.idHex, name: c.name, position: c.position })).sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(cats).toEqual([...f.vector.categories].sort((a, b) => (a.id < b.id ? -1 : 1)));
    for (const ch of f.vector.channels) {
      const mine = folded.channels.get(ch.id);
      expect(mine, ch.name).toBeDefined();
      expect(mine!.isPrivate).toBe(ch.private);
      if (ch.private) {
        // One made on the vsk-13 Roster is sealed; one the switch carried across keeps its plaintext head.
        if (!(f.vector.roles.legacy_channels ?? []).includes(ch.id)) expect(mine!.sealed, "a Private Channel's details are sealed").toBeDefined();
        continue;
      }
      expect(mine!.name).toBe(ch.name);
      for (const k of ["category", "position", "topic", "view"]) expect(mine!.metadata[k], `${ch.name}.${k}`).toEqual(ch.extra[k]);
    }
  });

  it("opens sealed Private Channels, files and orders the sidebar, and hides what a member can't view", () => {
    const folded = foldControlState(editions, cid, f.community.owner);
    const view = channelsView(ownerCommunity(f), folded);
    for (const ch of f.vector.channels) {
      const mine = view.find((c) => c.idHex === ch.id);
      expect(mine?.name, ch.id).toBe(ch.name);
      expect(mine?.categoryId).toEqual(ch.extra.category);
      expect(mine?.view).toBe(ch.extra.view ?? "chat");
    }
    // Uncategorized first, then each Category by its rank key, Channels by theirs.
    const cats = new Map(f.vector.categories.map((c) => [c.id, c.position ?? "~"]));
    const order = view.map((c) => [c.categoryId ? cats.get(c.categoryId)! : "", c.positionKey ?? "~", c.name].join("/"));
    expect(order).toEqual([...order].sort((a, b) => (a < b ? -1 : 1)));
    for (const [label, m] of Object.entries(f.vector.members)) {
      const shown = visibleChannels(view, folded, m.pubkey).map((c) => c.idHex).sort();
      const viewable = f.vector.channels.filter((c) => (BigInt(m.channels[c.id]) & (1n << 13n)) !== 0n).map((c) => c.id).sort();
      expect(shown, label).toEqual(viewable);
    }
  });
});
