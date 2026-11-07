/**
 * Synthetic Control editions for fold tests: ParsedEditions built directly, with
 * the marked hash a real seal would give them, so a test can lay out exactly the
 * slice of the plane a reader holds without signing or wrapping anything.
 */
import { bytesToHex as nobleHex, hexToBytes } from "@noble/hashes/utils.js";

import { banlistLocator, editionBinding, everyoneLocator, grantLocator, hex32, random32, tenureLocator } from "@/concord/lib/derive";
import { buildEditionRumor, parseEdition, type AuthorityCitation, type ParsedEdition } from "@/concord/lib/edition";
import { KIND_SEAL_PLAINTEXT } from "@/concord/lib/kinds";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { EVERYONE_DEFAULT } from "@/concord/lib/roles";
import type { OpenedEvent } from "@/concord/lib/stream";
import type { Community, PrivateChannelKey } from "@/concord/lib/types";
import { editionHash, markedEditionHash } from "@/concord/lib/version";

export function hexKey(): string {
  return nobleHex(random32());
}

let rumorCounter = 0;

/** A rumor id that sorts after every one minted before it (a tie-break the test controls). */
function nextRumorId(): string {
  rumorCounter++;
  return rumorCounter.toString(16).padStart(64, "0");
}

export interface EditionOpts {
  vsk: string;
  eid: string | Uint8Array;
  version?: bigint;
  prev?: ParsedEdition;
  content: string | object;
  author: string;
  marked?: boolean;
  cite?: ParsedEdition;
  createdAt?: number;
  rumorId?: string;
}

export class TestCommunity {
  readonly id = random32();
  readonly idHex = nobleHex(this.id);
  constructor(readonly owner: string = hexKey()) {}
  readonly binding = editionBinding(this.id);
  readonly everyoneHex = nobleHex(everyoneLocator(this.id));

  grantEid(member: string): string {
    return nobleHex(grantLocator(this.id, hex32(member)));
  }

  banlistHex(): string {
    return nobleHex(banlistLocator(this.id));
  }

  tenureEid(member: string, sealer: string): string {
    return nobleHex(tenureLocator(this.id, hex32(member), hex32(sealer)));
  }

  edition(o: EditionOpts): ParsedEdition {
    const entityId = typeof o.eid === "string" ? hexToBytes(o.eid) : o.eid;
    const version = o.version ?? (o.prev ? o.prev.version + 1n : 1n);
    const prevHash = o.prev?.selfHash;
    const content = typeof o.content === "string" ? o.content : JSON.stringify(o.content);
    const marked = o.marked ?? true;
    const bytes = new TextEncoder().encode(content);
    const selfHash = marked
      ? markedEditionHash(entityId, version, prevHash, bytes, hexToBytes(o.author))
      : editionHash(entityId, version, prevHash, bytes);
    const rumorId = o.rumorId ?? nextRumorId();
    const authority: AuthorityCitation | undefined = o.cite
      ? { entityId: o.cite.entityId, version: o.cite.version, editionHash: o.cite.selfHash }
      : undefined;
    const createdAt = o.createdAt ?? 1_700_000_000;
    return {
      author: o.author,
      vsk: o.vsk,
      entityId,
      version,
      ...(prevHash ? { prevHash } : {}),
      content,
      selfHash,
      ...(marked ? { binding: this.binding } : {}),
      createdAt,
      rumorId: hexToBytes(rumorId),
      ...(authority ? { authority } : {}),
      opened: { rumorId, kind: 3308, tags: [], content, author: o.author, createdAt } as unknown as OpenedEvent,
    };
  }

  /** The owner's switching `@everyone` (CORD-04 §2). */
  everyone(permissions: bigint, opts: { legacy?: string[]; prev?: ParsedEdition; author?: string } = {}): ParsedEdition {
    return this.edition({
      vsk: "13",
      eid: this.everyoneHex,
      prev: opts.prev,
      author: opts.author ?? this.owner,
      content: { permissions: permissions.toString(), ...(opts.legacy ? { legacy: opts.legacy } : {}) },
    });
  }

  role(roleId: string, rank: string, permissions: bigint, opts: { prev?: ParsedEdition; author?: string; name?: string; cite?: ParsedEdition; mentionable?: boolean } = {}): ParsedEdition {
    return this.edition({
      vsk: "13",
      eid: roleId,
      prev: opts.prev,
      author: opts.author ?? this.owner,
      cite: opts.cite,
      content: { role_id: roleId, name: opts.name ?? "role", rank, permissions: permissions.toString(), color: 0, display: false, mentionable: opts.mentionable ?? false },
    });
  }

  grant(member: string, roleIds: string[], opts: { prev?: ParsedEdition; author?: string; cite?: ParsedEdition; content?: object } = {}): ParsedEdition {
    return this.edition({
      vsk: "3",
      eid: this.grantEid(member),
      prev: opts.prev,
      author: opts.author ?? this.owner,
      cite: opts.cite,
      content: opts.content ?? { member, role_ids: roleIds },
    });
  }
}

/** Owner, `@everyone` at its defaults, and an admin Role (rank "a") holding `adminBits` granted to `admin`. */
export function rankedCommunity(adminBits: bigint, keys: { owner?: string; admin?: string } = {}) {
  const c = new TestCommunity(keys.owner);
  const admin = keys.admin ?? hexKey();
  const adminRole = hexKey();
  const everyone = c.everyone(EVERYONE_DEFAULT);
  const role = c.role(adminRole, "a", adminBits);
  const grant = c.grant(admin, [adminRole]);
  return { c, admin, adminRole, everyone, role, grant, base: [everyone, role, grant] };
}

/** The Community a member holds: the root at epoch 0 and the given Private Channel keys. */
export function heldCommunity(c: TestCommunity, privateChannels: PrivateChannelKey[] = [], root = random32()): Community {
  return {
    id: c.id,
    idHex: c.idHex,
    owner: c.owner,
    ownerSalt: new Uint8Array(32),
    root,
    rootEpoch: 0n,
    heldRoots: [{ epoch: 0n, key: root }],
    privateChannels,
    relays: ["wss://relay.test"],
    name: "",
  };
}

/**
 * A Control edition as the rumor store holds it: a real rumor under a real,
 * signed plaintext seal, for code that folds from the store or re-wraps seals.
 */
export function sealedEdition(
  c: TestCommunity,
  sk: Uint8Array,
  o: { vsk: string; eid: string | Uint8Array; content: string | object; prev?: OpenedEvent; version?: bigint; createdAt?: number },
): OpenedEvent {
  const entityId = typeof o.eid === "string" ? hexToBytes(o.eid) : o.eid;
  const prev = o.prev ? parseEdition(o.prev) : undefined;
  const rumor = buildEditionRumor({
    vsk: o.vsk,
    entityId,
    version: o.version ?? (prev ? prev.version + 1n : 1n),
    ...(prev ? { prevHash: prev.selfHash } : {}),
    content: typeof o.content === "string" ? o.content : JSON.stringify(o.content),
    actorPubkey: getPublicKey(sk),
    binding: c.binding,
    createdAtSecs: o.createdAt ?? Math.floor(Date.now() / 1000),
  });
  const seal = finalizeEvent({ kind: KIND_SEAL_PLAINTEXT, content: JSON.stringify(rumor), tags: [], created_at: rumor.created_at }, sk);
  return { rumorId: rumor.id, author: rumor.pubkey, kind: rumor.kind, content: rumor.content, tags: rumor.tags, ms: rumor.created_at * 1000, createdAt: rumor.created_at, sealKind: KIND_SEAL_PLAINTEXT, seal };
}

export function eidHex(p: ParsedEdition): string {
  return nobleHex(p.entityId);
}

export function headFloor(p: ParsedEdition) {
  return { version: p.version, hash: p.selfHash, rumorId: nobleHex(p.rumorId), author: p.author };
}
