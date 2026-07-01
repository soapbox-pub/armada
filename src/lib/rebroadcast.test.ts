import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { describe, expect, it } from "vitest";

import {
  REBROADCAST_KIND,
  REBROADCAST_PREFIX,
  encodeRebroadcast,
  isRebroadcastEnvelope,
  parseRebroadcast,
} from "./rebroadcast";

function signedNote(content = "GM ✌️") {
  const sk = generateSecretKey();
  return finalizeEvent(
    { kind: REBROADCAST_KIND, content, tags: [], created_at: Math.floor(Date.now() / 1000) },
    sk,
  );
}

describe("rebroadcast envelope", () => {
  it("round-trips a signed event through encode/parse", () => {
    const event = signedNote();
    const wire = encodeRebroadcast(event);

    expect(wire.startsWith(REBROADCAST_PREFIX)).toBe(true);
    expect(isRebroadcastEnvelope(wire)).toBe(true);

    const parsed = parseRebroadcast(wire);
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe(event.id);
    expect(parsed!.pubkey).toBe(event.pubkey);
    expect(parsed!.sig).toBe(event.sig);
    expect(parsed!.content).toBe(event.content);
  });

  it("returns null for plain (non-envelope) mesh content", () => {
    expect(isRebroadcastEnvelope("hello world")).toBe(false);
    expect(parseRebroadcast("hello world")).toBeNull();
  });

  it("returns null for a malformed envelope body", () => {
    expect(parseRebroadcast(`${REBROADCAST_PREFIX}{not json`)).toBeNull();
    expect(parseRebroadcast(`${REBROADCAST_PREFIX}{"id":"x"}`)).toBeNull();
  });

  it("rejects a tampered event (bad signature)", () => {
    const event = signedNote("GM");
    const tampered = { ...event, content: "GN" }; // sig no longer matches content/id
    const wire = REBROADCAST_PREFIX + JSON.stringify(tampered);
    expect(parseRebroadcast(wire)).toBeNull();
  });

  it("a parsed event must be relayed UNMUTATED — appending a tag breaks the signature", () => {
    // Regression: the receive path once appended a `mesh_carrier` tag to the
    // verified event before rendering. The id/sig are computed over the exact
    // tags, so that mutation made every relay reject the rebroadcast with
    // "signature verification failed". The event must reach the relay as-is.
    const event = signedNote("GM");
    const parsed = parseRebroadcast(encodeRebroadcast(event));
    expect(parsed).not.toBeNull();

    // What we actually send on Rebroadcast must equal what was signed.
    expect(parsed).toEqual(event);

    // And the mutation that caused the bug must NOT re-verify.
    const mutated = { ...parsed!, tags: [...parsed!.tags, ["mesh_carrier", "peerX"]] };
    expect(parseRebroadcast(REBROADCAST_PREFIX + JSON.stringify(mutated))).toBeNull();
  });
});
