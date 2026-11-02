/**
 * The relay inbox's contract, pinned:
 *
 *  1. wire ORDER survives the asynchronous verify — an EVENT is never
 *     overtaken by the EOSE/CLOSED behind it, since `NRelay1.query()` stops at
 *     the first EOSE and would lose the event;
 *  2. an event that fails verification is dropped, and nothing behind it is;
 *  3. messages carrying no subscription order (AUTH, OK) are delivered at
 *     once, so a NIP-42 challenge is never held behind a verify backlog;
 *  4. messages arriving while a verify round is in flight are verified as ONE
 *     batch — the coalescing that gets a burst onto the worker pool;
 *  5. `skipVerify` kinds pass untouched, and a memo hit costs no EC verify.
 *
 * The verifier is injected, so the tests observe exactly what reaches the EC
 * step; the real inline verifier proves the signatures are genuinely checked.
 */
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { _resetVerifyCacheForTests, type EcVerifyBatch, verifyEventOnce } from "./verifyCache";
import { ecVerifyBatch as inlineEcVerify } from "./verifyPool";
import { RelayInbox, VerifiedRelay } from "./verifiedRelay";

import type { NostrEvent, NostrRelayMsg } from "@nostrify/types";

function signed(content = "hello", kind = 1): NostrEvent {
  return finalizeEvent({ kind, content, tags: [], created_at: 1000 }, generateSecretKey());
}

/** A verifier the test releases by hand, recording each batch it was handed. */
function heldVerifier() {
  const batches: number[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const verify: EcVerifyBatch = async (triples) => {
    batches.push(triples.length);
    await gate;
    return inlineEcVerify(triples);
  };
  return { verify, batches, release: () => release?.() };
}

async function settle(): Promise<void> {
  // Enough turns for a drain round plus the inline verifier's own yields.
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => _resetVerifyCacheForTests());

describe("RelayInbox", () => {
  it("delivers EVENT before the EOSE behind it, even though the verify is asynchronous", async () => {
    const out: NostrRelayMsg[] = [];
    const inbox = new RelayInbox((msg) => out.push(msg), { ecVerify: inlineEcVerify });
    const ev = signed();

    inbox.push(["EVENT", "s", ev]);
    inbox.push(["EOSE", "s"]);
    expect(out, "nothing is delivered synchronously — the verify has not run").toEqual([]);

    await settle();
    expect(out.map((m) => m[0])).toEqual(["EVENT", "EOSE"]);
    expect(out[0][2]).toBe(ev);
  });

  it("drops an event with a bad signature and still delivers what follows", async () => {
    const out: NostrRelayMsg[] = [];
    const inbox = new RelayInbox((msg) => out.push(msg), { ecVerify: inlineEcVerify });
    const good = signed("good");
    const forged = { ...signed("forged"), sig: "00".repeat(64) };
    const tampered = { ...signed("tampered"), content: "changed" };

    inbox.push(["EVENT", "s", forged]);
    inbox.push(["EVENT", "s", tampered]);
    inbox.push(["EVENT", "s", good]);
    inbox.push(["CLOSED", "s", "done"]);
    await settle();

    expect(out.map((m) => (m[0] === "EVENT" ? m[2].content : m[0]))).toEqual(["good", "CLOSED"]);
  });

  it("delivers AUTH and OK immediately, ahead of a held verify", async () => {
    const out: NostrRelayMsg[] = [];
    const held = heldVerifier();
    const inbox = new RelayInbox((msg) => out.push(msg), { ecVerify: held.verify });

    inbox.push(["EVENT", "s", signed()]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held.batches, "the verify is in flight").toEqual([1]);

    inbox.push(["AUTH", "challenge"]);
    inbox.push(["OK", "id", true, ""]);
    inbox.push(["NOTICE", "hi"]);
    expect(out.map((m) => m[0]), "no subscription order to keep — delivered at once").toEqual([
      "AUTH",
      "OK",
      "NOTICE",
    ]);

    held.release();
    await settle();
    expect(out.map((m) => m[0])).toEqual(["AUTH", "OK", "NOTICE", "EVENT"]);
  });

  it("verifies everything that arrived during a round as the next single batch", async () => {
    const out: NostrRelayMsg[] = [];
    const held = heldVerifier();
    const inbox = new RelayInbox((msg) => out.push(msg), { ecVerify: held.verify });
    const events = Array.from({ length: 5 }, (_, i) => signed(`e${i}`));

    inbox.push(["EVENT", "s", events[0]]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The burst lands while the first round is awaited.
    for (const ev of events.slice(1)) inbox.push(["EVENT", "s", ev]);
    inbox.push(["EOSE", "s"]);
    expect(inbox.busy).toBe(true);

    held.release();
    await settle();

    // One round for the first message, ONE for the four that queued behind it
    // — never one round per message.
    expect(held.batches).toEqual([1, 4]);
    expect(out.map((m) => (m[0] === "EVENT" ? m[2].content : m[0]))).toEqual([
      "e0", "e1", "e2", "e3", "e4", "EOSE",
    ]);
    expect(inbox.busy).toBe(false);
  });

  it("passes skipVerify kinds through untouched and answers memo hits without EC", async () => {
    const out: NostrRelayMsg[] = [];
    const ecVerify = vi.fn<EcVerifyBatch>(inlineEcVerify);
    const inbox = new RelayInbox((msg) => out.push(msg), {
      skipVerify: (event) => event.kind === 1059,
      ecVerify,
    });
    const wrap = { ...signed("wrap", 1059), sig: "00".repeat(64) };
    const seen = signed("seen");
    expect(verifyEventOnce(seen)).toBe(true); // already in the memo

    inbox.push(["EVENT", "s", wrap]);
    inbox.push(["EVENT", "s", seen]);
    await settle();

    expect(out.map((m) => (m[0] === "EVENT" ? m[2].content : m[0]))).toEqual(["wrap", "seen"]);
    expect(ecVerify, "a wrap is never verified; a memo hit needs no EC").not.toHaveBeenCalled();
  });

  it("drops a skipVerify event whose id is not its hash", async () => {
    const out: NostrRelayMsg[] = [];
    const inbox = new RelayInbox((msg) => out.push(msg), {
      skipVerify: (event) => event.kind === 1059,
      ecVerify: inlineEcVerify,
    });
    const real = signed("real", 1059);
    // A relay squatting the real wrap's id over junk content.
    const squat = { ...signed("junk", 1059), id: real.id };

    inbox.push(["EVENT", "s", squat]);
    inbox.push(["EVENT", "s", real]);
    inbox.push(["EOSE", "s"]);
    await settle();

    expect(out.map((m) => (m[0] === "EVENT" ? m[2].content : m[0]))).toEqual(["real", "EOSE"]);
  });

  it("a throwing dispatch does not stall the messages queued behind it", async () => {
    const out: string[] = [];
    const inbox = new RelayInbox((msg) => {
      if (msg[0] === "EVENT" && msg[2].content === "boom") throw new Error("listener failed");
      out.push(msg[0] === "EVENT" ? msg[2].content : msg[0]);
    }, { ecVerify: inlineEcVerify });

    inbox.push(["EVENT", "s", signed("boom")]);
    inbox.push(["EVENT", "s", signed("after")]);
    inbox.push(["EOSE", "s"]);
    await settle();

    expect(out).toEqual(["after", "EOSE"]);
  });
});

describe("VerifiedRelay", () => {
  it("routes NRelay1's EVENT delivery through the inbox: a query sees verified events, in order, before EOSE", async () => {
    // A port nothing listens on: the socket fails fast and, with backoff off,
    // stays failed. `receive` is driven by hand, which is all this test needs.
    const relay = new VerifiedRelay("ws://127.0.0.1:9", {
      backoff: false,
      idleTimeout: false,
      skipVerify: (event) => event.kind === 1059,
      ecVerify: inlineEcVerify,
    });
    const receive = (msg: NostrRelayMsg) =>
      (relay as unknown as { receive(msg: NostrRelayMsg): void }).receive(msg);
    try {
      const good = signed("good");
      const forged = { ...signed("forged"), sig: "00".repeat(64) };
      const wrap = { ...signed("wrap", 1059), sig: "00".repeat(64) };

      const result = relay.query([{ kinds: [1, 1059], limit: 10 }]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const [sub] = relay.subscriptions;
      expect(sub).toBeDefined();
      const id = sub[1];

      receive(["EVENT", id, forged]);
      receive(["EVENT", id, good]);
      receive(["EVENT", id, wrap]);
      receive(["EOSE", id]);

      const events = await result;
      expect(events.map((e) => e.content).sort()).toEqual(["good", "wrap"]);
    } finally {
      // Not awaited: `close()` waits for the socket's close event, which a
      // socket that never connected does not fire under Node. Marking it
      // closed-by-user (synchronous, inside `close()`) is what stops it.
      void relay.close();
    }
  });
});
