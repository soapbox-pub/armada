/**
 * CORD-06 conformance ledger — same charter as `cord04.conformance.test.ts`:
 * one `it` per normative obligation, in spec order, named by clause. Verified
 * rules assert; unverified rules are `it.todo` (some with a pointer to the
 * suite that exercises the behavior end-to-end — the todo stands until the
 * rule is pinned HERE at the obligation level, where a reviewer can find it).
 * The spec (`concord/06.md`) is the authority; this file is the index.
 */

import { describe, expect, it } from "vitest";

import { epochKeyCommitment, random32 } from "./derive";
import {
  buildRekeyRumors,
  checkContinuity,
  decodeWrappedKey,
  encodeWrappedKey,
  lowerKeyWins,
  REKEY_BASE_BLOBS_PER_EVENT,
  REKEY_BLOBS_PER_EVENT,
  rekeyScopeId,
  ROOT_SCOPE_HEX,
  type RekeyBlob,
} from "./rekey";

const ROTATOR = "a".repeat(64);

// ── §1 Rekey Blobs — the 3303 event ─────────────────────────────────────────

describe("CORD-06 §1 — Rekey Blobs", () => {
  it("O-1: a scope is a Channel id or the all-zero community_root id — which never collide", () => {
    const channelId = random32();
    channelId[0] = 1; // ensure non-zero
    expect(Buffer.from(rekeyScopeId({ kind: "channel", channelId })).toString("hex")).not.toBe(
      ROOT_SCOPE_HEX,
    );
    expect(Buffer.from(rekeyScopeId({ kind: "root" })).toString("hex")).toBe(ROOT_SCOPE_HEX);
  });

  it("O-2: at most 80 blobs per event, 60 for a base rotation; a larger rotation spans chunked events", () => {
    const blob = (): RekeyBlob => ({ locator: "ab".repeat(16), wrapped: "x" });
    const blobs = Array.from({ length: REKEY_BASE_BLOBS_PER_EVENT + 1 }, blob);
    const rumors = buildRekeyRumors(
      ROTATOR,
      { scope: { kind: "root" }, newEpoch: 1n, prevEpoch: 0n, prevCommit: "00".repeat(32) },
      blobs,
      Date.now(),
    );
    expect(REKEY_BLOBS_PER_EVENT).toBe(80);
    expect(REKEY_BASE_BLOBS_PER_EVENT).toBe(60);
    expect(rumors).toHaveLength(2);
    // Every chunk names its place in the set: ["chunk", i, n] — 1-indexed
    // ("chunk 1 of 2"; the spec fixes the shape, not the base, and receivers
    // correlate by holding all n, never by arithmetic on i).
    for (const [i, rumor] of rumors.entries()) {
      const chunk = rumor.tags.find((t) => t[0] === "chunk");
      expect(chunk?.slice(1)).toEqual([String(i + 1), "2"]);
    }
  });

  it("O-3: the wrapped plaintext is 72 fixed bytes — scope ‖ epoch ‖ key — and a recipient verifies scope and epoch against the ciphertext, not the tags", () => {
    const scopeId = random32();
    const key = random32();
    const encoded = encodeWrappedKey(scopeId, 7n, key);
    expect(encoded).toHaveLength(72);
    expect(decodeWrappedKey(encoded, scopeId, 7n)).toEqual(key);
    // A blob minted for another channel, or replayed at another epoch, is
    // unspliceable: the binding lives INSIDE the ciphertext.
    expect(() => decodeWrappedKey(encoded, random32(), 7n)).toThrow();
    expect(() => decodeWrappedKey(encoded, scopeId, 8n)).toThrow();
  });

  it.todo("O-4: the blob wrap key is the rotator↔recipient NIP-44 conversation key (one ECDH either side)");
  it.todo("O-5: the rumor is kind 3303 carrying scope/newepoch/prevepoch/prevcommit/chunk tags");
});

// ── §2 Receiving & Processing ────────────────────────────────────────────────

describe("CORD-06 §2 — Receiving & Processing", () => {
  it.todo("O-6: rekeys are subscribed by precomputing the NEXT rekey addresses (channel + base)");
  it.todo("O-7: the locator derives from rotator‖recipient pubkeys, scope and epoch — public inputs only");
  it.todo(
    "O-8: a rekey is validated against a role-authorized administrator before acceptance " +
      "(useRekey.test.tsx: 'an unauthorized rotator's channel rotation is ignored')",
  );
  it.todo("O-9: chunks correlate by (rotator, newepoch, prevcommit) — two rotators never merge into one set");
  it.todo("O-10: any chunk carrying my locator → decrypt and shift to the new epoch");
  it.todo(
    "O-11: removal only once ALL n chunks are held and none carries my locator — a missing chunk is never a removal " +
      "(useRekey.test.tsx channel-watch suite)",
  );

  it("O-12: continuity — prevcommit must recompute over the key I hold; a higher prevepoch is a GAP to fetch, anything else is a fork to reject", () => {
    const held = random32();
    const good = { prevEpoch: 3n, prevCommit: Buffer.from(epochKeyCommitment(3n, held)).toString("hex") };
    expect(checkContinuity(good, 3n, held)).toEqual({ ok: true });
    // Same epoch, different key: a fork, never adopted.
    expect(checkContinuity(good, 3n, random32())).toEqual({ ok: false, reason: "fork" });
    // The rotation extends an epoch AHEAD of mine: a gap — fetch it first.
    expect(checkContinuity({ ...good, prevEpoch: 5n }, 3n, held)).toEqual({ ok: false, reason: "gap" });
    // The rotation extends an epoch BEHIND mine: stale or garbage.
    expect(checkContinuity({ ...good, prevEpoch: 1n }, 3n, held)).toEqual({ ok: false, reason: "fork" });
  });

  it.todo("O-13: all chunks of one rotation carry identical continuity fields");
});

// ── §3 Refounding ────────────────────────────────────────────────────────────

describe("CORD-06 §3 — Refounding", () => {
  it.todo("O-14: a Refounder that cannot fold the complete Control Plane aborts");
  it.todo("O-15: the compacted Control Plane republishes only AFTER the confirmed root roll");
  it.todo(
    "O-16: channel rekeys are sealed under the PRIOR community_root, never the fresh one " +
      "(useRekey.test.tsx: useRefound suite)",
  );
  it.todo("O-17: the Guestbook snapshot is best-effort — a Refounding succeeds without it");
  it.todo("O-18: compaction re-wraps signed heads verbatim; signatures survive (plaintext seals)");
});

// ── §Authority ───────────────────────────────────────────────────────────────

describe("CORD-06 §Authority", () => {
  it.todo(
    "O-19: a single-channel Rekey requires MANAGE_CHANNELS; a Refounding requires BAN " +
      "(useRekey.test.tsx rotation filters)",
  );
  it.todo(
    "O-20: the Rotator must STRICTLY OUTRANK every removed target — a receiver refuses its own " +
      "removal by a peer or subordinate (useRekey.test.tsx: the two 'EQUAL-RANK' tests)",
  );
  it.todo("O-21: a rotation cites the Grant it acts under; a lagging client never honors a demoted admin's rotation");
  it.todo(
    "O-22: key possession is never authority — a removed member's well-formed rotation is dropped " +
      "(useRekey.test.tsx: 'an unauthorized rotator's channel rotation is ignored')",
  );
});

// ── §Failure and races ───────────────────────────────────────────────────────

describe("CORD-06 §Failure and races", () => {
  it.todo("O-23: a Refounding is resumable — every step idempotent, state acquired before the first publish");

  it("O-24: two rotations racing to one epoch converge on the lexicographically lowest new key", () => {
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);
    expect(lowerKeyWins(a, b)).toBe(a);
    expect(lowerKeyWins(b, a)).toBe(a);
    expect(lowerKeyWins(a, a)).toBe(a);
  });

  it.todo("O-25: both forks' keys are retained so the losing branch's messages stay readable (communityList.test.ts race case)");
  it.todo("O-26: the same-epoch heal is DOWN-ONLY — a held epoch re-converges only to a strictly lower sibling");
});
