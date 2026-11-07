/**
 * Whether `publishEdition` marks an edition (CORD-04 §1) in a Community on the
 * vsk-13 Roster when no folded snapshot is cached: Vector decides from the stored
 * `@everyone` head, not from a cache that can miss.
 */
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type NostrEvent } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import { buildChannelEdition, currentControlWriteGroup } from "@/concord/lib/control";
import { random32 } from "@/concord/lib/derive";
import { openWrap, type OpenedEvent } from "@/concord/lib/stream";
import { heldCommunity, sealedEdition, TestCommunity } from "@/test/concordEditions";

const env = vi.hoisted(() => ({ stored: [] as OpenedEvent[], sent: [] as NostrEvent[], written: false }));

vi.mock("@/concord/lib/control", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/control")>()),
  readControlFold: async () => undefined,
}));
vi.mock("@/concord/lib/rumorStore", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/rumorStore")>()),
  queryPlane: async () => env.stored,
  // Commits a tick later, as IndexedDB does.
  writeOpened: () => new Promise<boolean>((resolve) => setTimeout(() => {
    env.written = true;
    resolve(true);
  }, 20)),
}));

const { publishEdition } = await import("@/concord/hooks/useControlPlane");

describe("marking what Armada publishes (CORD-04 §1)", () => {
  it("marks an edition in a Community whose stored plane seats @everyone, even with no cached fold", async () => {
    const sk = generateSecretKey();
    const owner = getPublicKey(sk);
    const c = new TestCommunity(owner);
    env.stored = [sealedEdition(c, sk, { vsk: "13", eid: c.everyoneHex, content: { permissions: "1" } })];
    const community = heldCommunity(c);
    const nostr = { relay: () => ({ event: async (e: NostrEvent) => void env.sent.push(e) }) };
    const signer = { signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
    const rumor = buildChannelEdition(random32(), { name: "general", private: false }, { actorPubkey: owner, version: 1n });
    await publishEdition(nostr as never, community, signer, rumor);
    const opened = openWrap(env.sent[0], currentControlWriteGroup(community));
    expect(opened.tags.some((t) => t[0] === "eh" && t[1] === "2")).toBe(true);
  });

  it("resolves only once its own edition is stored, so the fold its caller refreshes holds it", async () => {
    const sk = generateSecretKey();
    const owner = getPublicKey(sk);
    const c = new TestCommunity(owner);
    env.stored = [];
    env.written = false;
    const nostr = { relay: () => ({ event: async (e: NostrEvent) => void env.sent.push(e) }) };
    const signer = { signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
    const rumor = buildChannelEdition(random32(), { name: "general", private: false }, { actorPubkey: owner, version: 1n });
    await publishEdition(nostr as never, heldCommunity(c), signer, rumor);
    expect(env.written).toBe(true);
  });
});
