// @vitest-environment node
/**
 * A Locked Channel's writer key (CORD-03 §1 at concord#27, Vector v0.5.2
 * `a_locked_channel_takes_every_write_only_from_whom_it_lets_write`): its mint is Locked,
 * a member who may react but not post is handed a scoped certificate, and with it reacts
 * at the writer address but never posts.
 */
import { IDBFactory } from "fake-indexeddb";
import { getConversationKey, decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

const { adoptWriterDeliveries, canReactIn, sendTarget, usableWriter, writerKeysReady } = await import("@/concord/lib/writerKeys");
const { buildMint } = await import("@/concord/lib/writerMint");
const { postersOf, writerCandidates } = await import("@/concord/lib/writerDuty");
const { parseDelivery } = await import("@/concord/lib/delivery");
const { foldControlState } = await import("@/concord/lib/control");
const { channelGroupKey, hex32, random32, bytesToHex } = await import("@/concord/lib/derive");
const { KIND_DELETE, KIND_MESSAGE, KIND_REACTION, KIND_REKEY, KIND_TYPING, KIND_VOICE_PRESENCE } = await import("@/concord/lib/kinds");
const { overwriteLocator, overwriteToJSON } = await import("@/concord/lib/roster");
const { Permissions } = await import("@/concord/lib/roles");
const { ledgerLocked, parseLedger } = await import("@/concord/lib/writers");
const { rankedCommunity, hexKey } = await import("@/test/concordEditions");

describe("a Locked Channel's writers", () => {
  it("hands a reactor a scoped certificate it reacts with and can't post with", async () => {
    await writerKeysReady();
    const ownerSk = generateSecretKey();
    const reactorSk = generateSecretKey();
    const [owner, reactor] = [getPublicKey(ownerSk), getPublicKey(reactorSk)];
    const { c, base } = rankedCommunity(0n, { owner });
    const id = random32();
    const ch = bytesToHex(id);
    const role = hexKey();
    const rule = (target: { kind: "everyone" } | { kind: "role"; id: string }, allow: bigint, deny: bigint) => {
      const o = { scope: ch, target, allow, deny };
      return c.edition({ vsk: "14", eid: overwriteLocator(c.id, o), author: c.owner, content: overwriteToJSON(o) });
    };
    const nothing = Permissions.SEND_MESSAGES | Permissions.ADD_REACTIONS | Permissions.CONNECT;
    const before = [
      ...base,
      c.edition({ vsk: "2", eid: id, author: c.owner, content: { name: "rules", private: false } }),
      c.role(role, "r", 0n),
      c.grant(reactor, [role]),
      rule({ kind: "role", id: role }, Permissions.ADD_REACTIONS, 0n),
      rule({ kind: "everyone" }, 0n, nothing),
    ];
    const folded = foldControlState(before, c.id, c.owner);
    const members = new Set([owner, reactor]);
    const now = Date.now();
    const mint = (await buildMint({
      communityId: c.id,
      control: folded,
      rootEpoch: 0,
      channelIdHex: ch,
      me: owner,
      posters: postersOf(folded, members, ch),
      candidates: writerCandidates([reactor], owner, owner),
      cut: [],
      secrets: () => ({ secret: random32(), certifier: random32() }),
      entryAtMs: now,
      nowMs: now,
      encrypt: async (pk, plain) => nip44Encrypt(plain, getConversationKey(ownerSk, pk)),
    }))!;
    const ledger = parseLedger(mint.edition.content)!;
    expect(ledgerLocked(ledger)).toBe(true);
    const deliveries = mint.deliveries.map((r) => parseDelivery({ ...r, rumorId: r.id, author: owner, ms: r.created_at * 1000, createdAt: r.created_at, kind: KIND_REKEY }));
    const scoped = deliveries.flatMap((d) => d?.scoped ?? []);
    expect(scoped.map(([w, , r]) => [w, r])).toEqual([[reactor, Permissions.ADD_REACTIONS]]);
    expect(deliveries.flatMap((d) => d?.certs ?? []).map(([w]) => w)).toEqual([owner]);

    // Folded with the Locked ledger, the reactor takes the key and its certificate.
    const held = { ...folded, writers: new Map([[ch, ledger]]) };
    const decrypt = async (deliverer: string, wrapped: string) => nip44Decrypt(wrapped, getConversationKey(reactorSk, deliverer));
    expect(await adoptWriterDeliveries(deliveries.filter((d) => d !== undefined), held, c.id, ch, reactor, decrypt)).toBe(true);

    expect(usableWriter(held, c.id, ch, reactor, undefined, KIND_REACTION)?.scoped?.rights).toBe(Permissions.ADD_REACTIONS);
    expect(usableWriter(held, c.id, ch, reactor, undefined, KIND_DELETE)).toBeDefined();
    expect(usableWriter(held, c.id, ch, reactor, undefined, KIND_MESSAGE)).toBeUndefined();
    expect(usableWriter(held, c.id, ch, reactor, undefined, KIND_TYPING)).toBeUndefined();
    expect(usableWriter(held, c.id, ch, reactor, undefined, KIND_VOICE_PRESENCE)).toBeUndefined();
    expect(canReactIn(held, c.id, ch, reactor)).toBe(true);

    const read = channelGroupKey(random32(), hex32(ch), 0);
    const at = sendTarget(read, KIND_REACTION, held, c.id, ch, reactor)!;
    expect(at.group.pk).not.toBe(read.pk);
    expect(at.tags.find((t) => t[0] === "rcert")?.[2]).toBe(Permissions.ADD_REACTIONS.toString());
    expect(sendTarget(read, KIND_MESSAGE, held, c.id, ch, reactor)).toBeUndefined();
    // Someone with no write right holds nothing that reaches readers.
    expect(sendTarget(read, KIND_REACTION, held, c.id, ch, hexKey())).toBeUndefined();
    expect(canReactIn(held, c.id, ch, hexKey())).toBe(false);
  });
});
