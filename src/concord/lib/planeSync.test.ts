/**
 * Tests for the plane-sweep discipline (planeSync.ts):
 * batching, single-flight, auth-gating, completeness modes (control =
 * whole-plane refetch, guestbook = paged reads with epoch-keyed state), retry.
 */

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { controlGroups } from "@/concord/lib/control";
import { bytesToHex, controlGroupKey, guestbookGroupKey } from "@/concord/lib/derive";
import { guestbookGroups } from "@/concord/lib/guestbook";
import { KIND_SEAL_PLAINTEXT } from "@/concord/lib/kinds";
import {
  _configureAuthWaitForTests,
  _configureSweepCadenceForTests,
  _coldStartPlaneFloorsForTests,
  _configureSweepPagingForTests,
  _resetPlaneSweepMemoForTests,
  controlScope,
  controlSweepAnswered,
  controlSweepTruncated,
  controlSweepQuorum,
  controlSweepReach,
  controlSweepRelays,
  controlSweepUnreadable,
  guestbookScope,
  markControlPlaneStale,
  sweepControl,
  sweepGuestbook,
  sweepRelayScopes,
  whenAuthSettled,
} from "@/concord/lib/planeSync";
import { pruneControlSnapshots, readControlSnapshot, updateStreamCursor } from "@/concord/lib/rumorStore";
import {
  _resetStreamAuthRegistry,
  noteAuthResult,
  noteRelayChallenged,
  noteStreamAuthSent,
  registerStreamKeys,
} from "@/concord/lib/streamAuth";
import { buildRumor, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { Community } from "@/concord/lib/types";

// ── Fake relay ───────────────────────────────────────────────────────────────

interface Filter {
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

class FakeRelay {
  events: NostrEvent[] = [];
  /** Each `.query()` call's filter set, in arrival order. */
  calls: Filter[][] = [];
  /** Artificial answer latency, so concurrent sweeps genuinely overlap. */
  delayMs = 0;
  /** Fail this many queries before answering (socket-swap/timeout stand-in). */
  failNext = 0;

  async query(filters: Filter[]): Promise<NostrEvent[]> {
    this.calls.push(filters);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("relay round lost");
    }
    const out = new Map<string, NostrEvent>();
    for (const f of filters) {
      // Per-filter matching with a PER-FILTER limit (NIP-01), like a real relay.
      const matched = this.events
        .filter(
          (ev) =>
            (!f.kinds || f.kinds.includes(ev.kind)) &&
            (!f.authors || f.authors.includes(ev.pubkey)) &&
            (f.since === undefined || ev.created_at >= f.since) &&
            (f.until === undefined || ev.created_at <= f.until),
        )
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, f.limit);
      for (const ev of matched) out.set(ev.id, ev);
    }
    return [...out.values()];
  }
}

/**
 * REQs that opened a sweep, excluding the pager's follow-ups. The batching and
 * single-flight tests are about how many rounds a sweep OPENS; the completeness
 * pager then issues its own `until`-bearing probes on top, which are not what
 * those tests measure.
 */
function openingCalls(relay: FakeRelay): number {
  return relay.calls.filter((fs) => !fs.some((f) => f.until !== undefined)).length;
}

function poolOf(relays: Record<string, FakeRelay>) {
  return { relay: (url: string) => relays[url] };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RELAY_A = "wss://relay-a.test";
const RELAY_B = "wss://relay-b.test";

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

function communityOf(fill: number, owner: string): Community {
  const root = new Uint8Array(32).fill(fill);
  const id = new Uint8Array(32).fill(fill + 1);
  return {
    id,
    idHex: bytesToHex(id),
    owner,
    ownerSalt: new Uint8Array(32),
    root,
    rootEpoch: 0n,
    heldRoots: [{ epoch: 0n, key: root }],
    privateChannels: [],
    relays: [RELAY_A],
    name: "test",
  } as Community;
}

/** A plane wrap (edition-shaped rumor) with a controlled outer created_at. */
async function wrapAt(
  group: ReturnType<typeof controlGroupKey>,
  s: ReturnType<typeof signer>,
  eid: string,
  createdAt: number,
): Promise<{ wrap: NostrEvent; rumor: NostrRumor }> {
  const rumor = buildRumor({
    kind: 3308,
    content: "{}",
    tags: [["vsk", "0"], ["eid", eid], ["ev", "1"]],
    pubkey: s.pubkey,
    ms: null,
    createdAtSecs: createdAt,
  });
  const seal = await sealRumor(rumor, KIND_SEAL_PLAINTEXT, group, s);
  const w = await wrapSeal(seal, group);
  const wrap = finalizeEvent({ kind: w.kind, content: w.content, tags: w.tags, created_at: createdAt }, group.sk);
  return { wrap, rumor };
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetStreamAuthRegistry();
  _resetPlaneSweepMemoForTests();
  _configureSweepPagingForTests({ pageLimit: 500, maxEvents: 15_000, wallPage: 10_000, queryTimeoutMs: 25_000 });
  _configureSweepCadenceForTests({ fullSweepIntervalMs: 6 * 60 * 60_000, deltaOverlapSecs: 3600 });
  // Most tests exercise the fetch discipline, not the auth gate — let sweeps
  // proceed immediately (maxWaitMs 0 = the cap expires at once).
  _configureAuthWaitForTests({ maxWaitMs: 0 });
});

describe("sweepRelayScopes — stream-auth gate", () => {
  it("holds every caller's REQ until the stream keys register, then fires", async () => {
    _configureAuthWaitForTests({ maxWaitMs: 5_000 });
    const owner = signer();
    const community = communityOf(20, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    // The hook fires before useRegisterAllStreamKeys has registered the keys.
    const sweep = sweepControl(nostr, community);
    await new Promise((r) => setTimeout(r, 250));
    expect(relay.calls.length, "an unauthenticatable REQ must never leave the client").toBe(0);

    // Keys register (an unchallenged relay needs no AUTH acks)…
    registerStreamKeys(controlGroups(community), community.relays);
    const fresh = await sweep;

    // …and only then does the REQ go out.
    expect(openingCalls(relay)).toBe(1);
    expect(fresh.map((e) => e.rumorId)).toContain(e1.rumor.id);
  });

  it("on a CHALLENGED relay, holds the REQ until the relay ACKS the stream AUTHs", async () => {
    _configureAuthWaitForTests({ maxWaitMs: 5_000 });
    const owner = signer();
    const community = communityOf(22, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    // The relay issued a NIP-42 challenge on the live socket; AUTH frames for
    // the community's groups are in flight but not yet acked.
    noteRelayChallenged(RELAY_A);
    const groups = controlGroups(community);
    registerStreamKeys(groups, community.relays);
    groups.forEach((g, i) => noteStreamAuthSent(RELAY_A, `auth-ev-${i}`, g.pk));

    const sweep = sweepControl(nostr, community);
    await new Promise((r) => setTimeout(r, 250));
    expect(relay.calls.length, "a REQ must wait for the relay's AUTH acks").toBe(0);

    // The relay acks each AUTH (["OK", id, true]) — the gate opens.
    groups.forEach((_, i) => noteAuthResult(RELAY_A, `auth-ev-${i}`, true));
    const fresh = await sweep;

    expect(openingCalls(relay)).toBe(1);
    expect(fresh.map((e) => e.rumorId)).toContain(e1.rumor.id);
  });

  it("whenAuthSettled: an UNCHALLENGED relay never waits (backfills/warm-up proceed at once)", async () => {
    _configureAuthWaitForTests({ maxWaitMs: 5_000 });
    const owner = signer();
    const community = communityOf(26, owner.pubkey);
    const groups = controlGroups(community);

    const started = Date.now();
    await whenAuthSettled(RELAY_A, () => groups);
    expect(Date.now() - started, "no challenge ⇒ nothing to wait for").toBeLessThan(200);
  });

  it("whenAuthSettled: a CHALLENGED relay holds until its AUTH acks land", async () => {
    _configureAuthWaitForTests({ maxWaitMs: 5_000 });
    const owner = signer();
    const community = communityOf(30, owner.pubkey);
    const groups = controlGroups(community);

    noteRelayChallenged(RELAY_A);
    registerStreamKeys(groups, community.relays);
    groups.forEach((g, i) => noteStreamAuthSent(RELAY_A, `settle-ev-${i}`, g.pk));

    let settled = false;
    const wait = whenAuthSettled(RELAY_A, () => groups).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(settled, "must hold while AUTHs are unacked").toBe(false);

    groups.forEach((_, i) => noteAuthResult(RELAY_A, `settle-ev-${i}`, true));
    await wait;
    expect(settled).toBe(true);
  });

  it("proceeds after the wait cap even if keys never register (cursor discipline still heals)", async () => {
    _configureAuthWaitForTests({ maxWaitMs: 300 });
    const owner = signer();
    const community = communityOf(24, owner.pubkey);
    const relay = new FakeRelay();
    const nostr = poolOf({ [RELAY_A]: relay });

    const fresh = await sweepControl(nostr, community);

    expect(openingCalls(relay), "the cap must not let a sweep hang forever").toBe(1);
    expect(fresh).toEqual([]);
  });

  it("sweeps arriving while the gate is closed coalesce into ONE REQ when it opens", async () => {
    _configureAuthWaitForTests({ maxWaitMs: 5_000 });
    const owner = signer();
    const a = communityOf(28, owner.pubkey);
    const b = communityOf(32, owner.pubkey);
    const now = Math.floor(Date.now() / 1000);
    const aCtl = await wrapAt(controlGroupKey(a.root, a.id, 0), owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [aCtl.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    // Two communities' hooks fire independently pre-registration.
    const sweeps = Promise.all([
      sweepControl(nostr, a),
      sweepGuestbook(nostr, a),
      sweepControl(nostr, b),
      sweepGuestbook(nostr, b),
    ]);
    registerStreamKeys(
      [...controlGroups(a), ...guestbookGroups(a), ...controlGroups(b), ...guestbookGroups(b)],
      [RELAY_A],
    );
    const [aFresh] = await sweeps;

    expect(openingCalls(relay), "held sweeps must merge into one REQ per relay").toBe(1);
    expect(relay.calls[0].length, "one filter per scope").toBe(4);
    expect(aFresh.map((e) => e.rumorId)).toContain(aCtl.rumor.id);
  });
  it("splits a batch past 16 scopes into REQs of at most 16 filters", async () => {
    _configureAuthWaitForTests({ maxWaitMs: 5_000 });
    const owner = signer();
    const communities = Array.from({ length: 10 }, (_, i) => communityOf(100 + i * 4, owner.pubkey));
    const now = Math.floor(Date.now() / 1000);
    const last = communities[9];
    const lastGb = await wrapAt(guestbookGroupKey(last.root, last.id, 0), owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [lastGb.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    // 20 scopes held behind the gate, then an exhaustive twin of one already in the full batch.
    const sweeps = Promise.all(communities.flatMap((c) => [sweepControl(nostr, c), sweepGuestbook(nostr, c)]));
    const twin = sweepControl(nostr, communities[0], { exhaustive: true });
    registerStreamKeys(communities.flatMap((c) => [...controlGroups(c), ...guestbookGroups(c)]), [RELAY_A]);
    const fresh = await sweeps;
    await twin;

    expect(openingCalls(relay), "20 scopes take two REQs").toBe(2);
    expect(relay.calls.map((fs) => fs.length).sort((x, y) => x - y)).toEqual([4, 16]);
    expect(fresh[19].map((e) => e.rumorId), "the scope past the cap still gets its events").toContain(lastGb.rumor.id);
  });

  it("registrations irrelevant to the batch's scopes never hold its gate", { timeout: 15_000 }, async () => {
    _configureAuthWaitForTests({ maxWaitMs: 3_000 });
    const owner = signer();
    const community = communityOf(36, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    // Keep the registry PERMANENTLY noisy with keys foreign to this batch.
    const churn = setInterval(() => {
      registerStreamKeys([
        {
          pk: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
          sk: new Uint8Array(32),
          convKey: new Uint8Array(32),
        },
      ]);
    }, 100);
    try {
      registerStreamKeys(controlGroups(community), community.relays);
      const started = Date.now();
      const fresh = await sweepControl(nostr, community);
      const took = Date.now() - started;

      expect(openingCalls(relay)).toBe(1);
      expect(fresh.map((e) => e.rumorId)).toContain(e1.rumor.id);
      // The gate tracks the batch's own keys, so foreign churn (other
      // communities registering) must not delay the sweep toward the cap.
      expect(took, "the gate must track the batch's own keys, not global churn").toBeLessThan(2_000);
    } finally {
      clearInterval(churn);
    }
  });
});

describe("sweepRelayScopes — resilience", () => {
  it("retries a lost relay round once, in place", async () => {
    const owner = signer();
    const community = communityOf(72, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    relay.failNext = 1; // the swap eats the first round
    const nostr = poolOf({ [RELAY_A]: relay });

    const fresh = await sweepControl(nostr, community);

    expect(openingCalls(relay), "one retry after the lost round").toBe(2);
    expect(fresh.map((e) => e.rumorId)).toContain(e1.rumor.id);
  });

  it("gives up after the retry — cursors stay put so the next sweep re-asks in full", async () => {
    const owner = signer();
    const community = communityOf(76, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    relay.failNext = 2; // both rounds lost
    const nostr = poolOf({ [RELAY_A]: relay });

    const fresh = await sweepControl(nostr, community);
    expect(openingCalls(relay)).toBe(2);
    expect(fresh).toEqual([]);

    // The next sweep must re-ask from scratch — no cursor advanced.
    const healed = await sweepControl(nostr, community);
    expect(relay.calls[2][0].since).toBeUndefined();
    expect(healed.map((e) => e.rumorId)).toContain(e1.rumor.id);
  });
});

describe("sweepRelayScopes — one REQ per relay, per-scope filters", () => {
  it("sweeps many communities' planes through ONE relay REQ, demuxed per scope", async () => {
    const owner = signer();
    const a = communityOf(40, owner.pubkey);
    const b = communityOf(44, owner.pubkey);
    const now = Math.floor(Date.now() / 1000);
    const aCtl = await wrapAt(controlGroupKey(a.root, a.id, 0), owner, "ab".repeat(32), now - 100);
    const bGb = await wrapAt(guestbookGroupKey(b.root, b.id, 0), owner, "cd".repeat(32), now - 90);

    const relay = new FakeRelay();
    relay.events = [aCtl.wrap, bGb.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    const scopes = [
      controlScope(a, RELAY_A),
      guestbookScope(a, RELAY_A),
      controlScope(b, RELAY_A),
      guestbookScope(b, RELAY_A),
    ];
    const result = await sweepRelayScopes(nostr, RELAY_A, scopes);

    expect(openingCalls(relay), "the whole catch-up must be one REQ").toBe(1);
    expect(relay.calls[0].length, "one filter per community-plane").toBe(4);
    expect(result.get(scopes[0].scope)?.map((e) => e.rumorId)).toContain(aCtl.rumor.id);
    expect(result.get(scopes[3].scope)?.map((e) => e.rumorId)).toContain(bGb.rumor.id);
    expect(result.get(scopes[1].scope)).toEqual([]);
    expect(result.get(scopes[2].scope)).toEqual([]);
  });

  it("keeps each guestbook scope's place independently inside one batch (issue #19 isolation)", async () => {
    const owner = signer();
    const a = communityOf(48, owner.pubkey);
    const b = communityOf(52, owner.pubkey);
    const now = Math.floor(Date.now() / 1000);
    // A's plane fits one page; B's runs past the sweep budget.
    const aGb = await wrapAt(guestbookGroupKey(a.root, a.id, 0), owner, "ab".repeat(32), now - 100);
    const bGroup = guestbookGroupKey(b.root, b.id, 0);
    const bGb = await Promise.all([1, 2, 3, 4, 5].map((n) => wrapAt(bGroup, owner, `${n}${n}`.repeat(32), now - 100 - n)));

    const relay = new FakeRelay();
    relay.events = [aGb.wrap, ...bGb.map((e) => e.wrap)];
    const nostr = poolOf({ [RELAY_A]: relay });

    _configureSweepPagingForTests({ pageLimit: 2, maxEvents: 4 });
    const scopesOf = () => [guestbookScope(a, RELAY_A), guestbookScope(b, RELAY_A)];
    await sweepRelayScopes(nostr, RELAY_A, scopesOf());
    const before = relay.calls.length;
    await sweepRelayScopes(nostr, RELAY_A, scopesOf());

    const [aFilter, bFilter] = relay.calls[before];
    expect(aFilter.since, "A was read to its end — it reads on from its cursor").toBeGreaterThan(now - 3700);
    expect(aFilter.until).toBeUndefined();
    // A's finished read must NEVER move B past wraps B hasn't read (the issue-#19 skip).
    expect(bFilter.since, "B stopped short — it is still reading from the top").toBeUndefined();
    expect(bFilter.until, "B goes on from where its budget ran out").toBe(bGb[3].wrap.created_at);
  });

  it("a community hook's sweep joins a batched sweep already in flight (no duplicate fetch)", async () => {
    const owner = signer();
    const a = communityOf(56, owner.pubkey);
    const b = communityOf(60, owner.pubkey);
    const now = Math.floor(Date.now() / 1000);
    const aCtl = await wrapAt(controlGroupKey(a.root, a.id, 0), owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [aCtl.wrap];
    relay.delayMs = 150; // the hook's sweep starts while the batch is mid-flight
    const nostr = poolOf({ [RELAY_A]: relay });

    // The global background sweep and useControlEvents's queryFn fire together.
    const [batch, hook] = await Promise.all([
      sweepRelayScopes(nostr, RELAY_A, [controlScope(a, RELAY_A), controlScope(b, RELAY_A)]),
      sweepControl(nostr, a),
    ]);

    expect(openingCalls(relay), "the hook must join the in-flight batch, not re-fetch").toBe(1);
    expect(batch.get(controlScope(a, RELAY_A).scope)?.map((e) => e.rumorId)).toContain(aCtl.rumor.id);
    expect(hook.map((e) => e.rumorId), "the joining sweep must receive the shared result").toContain(
      aCtl.rumor.id,
    );
  });

  it("different planes of the same community are NOT deduped against each other", async () => {
    const owner = signer();
    const community = communityOf(64, owner.pubkey);
    const now = Math.floor(Date.now() / 1000);
    const ctl = await wrapAt(controlGroupKey(community.root, community.id, 0), owner, "ab".repeat(32), now - 100);
    const gb = await wrapAt(guestbookGroupKey(community.root, community.id, 0), owner, "cd".repeat(32), now - 90);

    const relay = new FakeRelay();
    relay.events = [ctl.wrap, gb.wrap];
    relay.delayMs = 100;
    const nostr = poolOf({ [RELAY_A]: relay });

    const [c, g] = await Promise.all([
      sweepControl(nostr, community),
      sweepGuestbook(nostr, community),
    ]);

    expect(c.map((e) => e.rumorId)).toContain(ctl.rumor.id);
    expect(g.map((e) => e.rumorId)).toContain(gb.rumor.id);
  });

  it("reads a Guestbook deeper than one page down to its end (CORD-02 §5's whole plane)", async () => {
    const owner = signer();
    const community = communityOf(69, owner.pubkey);
    const guestbook = guestbookGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const wraps = await Promise.all([1, 2, 3, 4, 5].map((n) => wrapAt(guestbook, owner, `${n}${n}`.repeat(32), now - 100 - n)));
    const relay = new FakeRelay();
    relay.events = wraps.map((e) => e.wrap);
    const nostr = poolOf({ [RELAY_A]: relay });

    _configureSweepPagingForTests({ pageLimit: 2 });
    let walked = 0;
    const fresh = await sweepGuestbook(nostr, community, { onWalked: () => walked++ });

    expect(fresh.map((e) => e.rumorId).sort(), "every page of the plane is opened").toEqual(wraps.map((e) => e.rumor.id).sort());
    expect(walked).toBe(1);
  });

  it("a Guestbook read that runs out of budget keeps its place and is not walked until it ends", async () => {
    const owner = signer();
    const community = communityOf(70, owner.pubkey);
    const guestbook = guestbookGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const wraps = await Promise.all([1, 2, 3, 4, 5].map((n) => wrapAt(guestbook, owner, `${n}${n}`.repeat(32), now - 100 - n)));
    const relay = new FakeRelay();
    relay.events = wraps.map((e) => e.wrap);
    const nostr = poolOf({ [RELAY_A]: relay });

    _configureSweepPagingForTests({ pageLimit: 2, maxEvents: 4 });
    let walked = 0;
    const first = await sweepGuestbook(nostr, community, { onWalked: () => walked++ });
    expect(first.length).toBe(4);
    expect(walked, "the oldest wrap is still unread").toBe(0);

    const before = relay.calls.length;
    const second = await sweepGuestbook(nostr, community, { onWalked: () => walked++ });
    expect(relay.calls[before][0].until, "the read goes on from where it stopped").toBe(wraps[3].wrap.created_at);
    expect(relay.calls[before][0].since).toBeUndefined();
    expect(second.map((e) => e.rumorId)).toEqual([wraps[4].rumor.id]);
    expect(walked).toBe(1);
  });

  it("a Guestbook is walked only when every relay that answered was read to its end", async () => {
    const owner = signer();
    const now = Math.floor(Date.now() / 1000);
    _configureSweepPagingForTests({ pageLimit: 2, maxEvents: 4 });

    // One relay holds a short plane; the other holds more than the budget reads.
    const split = { ...communityOf(71, owner.pubkey), relays: [RELAY_A, RELAY_B] };
    const gb = guestbookGroupKey(split.root, split.id, 0);
    const wraps = await Promise.all([1, 2, 3, 4, 5].map((n) => wrapAt(gb, owner, `${n}${n}`.repeat(32), now - 100 - n)));
    const short = new FakeRelay();
    short.events = [wraps[0].wrap];
    const deep = new FakeRelay();
    deep.events = wraps.map((e) => e.wrap);
    let walked = 0;
    await sweepGuestbook(poolOf({ [RELAY_A]: short, [RELAY_B]: deep }), split, { onWalked: () => walked++ });
    expect(walked, "the deep relay's oldest Join may be nobody else's").toBe(0);

    // A relay that never answers doesn't hold the others back.
    const lone = { ...communityOf(72, owner.pubkey), relays: [RELAY_A, RELAY_B] };
    const up = new FakeRelay();
    up.events = [(await wrapAt(guestbookGroupKey(lone.root, lone.id, 0), owner, "ab".repeat(32), now - 100)).wrap];
    const down = new FakeRelay();
    down.failNext = 2;
    await sweepGuestbook(poolOf({ [RELAY_A]: up, [RELAY_B]: down }), lone, { onWalked: () => walked++ });
    expect(walked).toBe(1);

    // No relay answering is not a walk.
    const dark = communityOf(73, owner.pubkey);
    const dead = new FakeRelay();
    dead.failNext = 2;
    await sweepGuestbook(poolOf({ [RELAY_A]: dead }), dark, { onWalked: () => walked++ });
    expect(walked).toBe(1);
  });

  it("sequential guestbook sweeps read on from when the last one began, less an overlap", async () => {
    const owner = signer();
    const community = communityOf(68, owner.pubkey);
    const guestbook = guestbookGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(guestbook, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    await sweepGuestbook(nostr, community);
    await sweepGuestbook(nostr, community);

    expect(openingCalls(relay)).toBe(2);
    expect(relay.calls[0][0].since, "first sweep is a whole read").toBeUndefined();
    const since = relay.calls[1][0].since!;
    expect(since, "the cursor is when the read began, not the newest wrap's date").toBeGreaterThanOrEqual(now - 3600);
    expect(since).toBeLessThanOrEqual(now - 3600 + 5);
  });
});

describe("control completeness — whole-plane reads with a session delta", () => {
  it("never trusts a persisted cursor: the session opens whole, repeats ride a short-overlap delta", async () => {
    const owner = signer();
    const community = communityOf(80, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    const first = await sweepControl(nostr, community);
    const second = await sweepControl(nostr, community);

    expect(openingCalls(relay)).toBe(2);
    expect(relay.calls[0][0].since, "the session's first sweep is a whole-plane read").toBeUndefined();
    // A clean full read licenses a short-overlap delta for the repeats — the
    // whole-plane re-fetch every background tick was pure duplicate ciphertext
    // (the seen-memo only ever skipped the re-decrypt, not the transfer).
    // Anchored on when the full read started, not on the plane's newest edition.
    expect(relay.calls[1][0].since, "a repeat sweep is delta-gated off the full read").toBeGreaterThanOrEqual(now - 3600);
    expect(relay.calls[1][0].since).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 3600);
    expect(first.map((e) => e.rumorId)).toContain(e1.rumor.id);
    expect(second, "a re-received wrap is not fresh — the session memo keeps repeats quiet").toEqual([]);

    // A genuinely new edition landing between sweeps still surfaces alone.
    const e2 = await wrapAt(control, owner, "cd".repeat(32), now - 50);
    relay.events.push(e2.wrap);
    const third = await sweepControl(nostr, community);
    expect(third.map((e) => e.rumorId)).toEqual([e2.rumor.id]);
  });

  it("a clean full read still licenses a delta after a relaunch inside its window", async () => {
    const owner = signer();
    const community = communityOf(83, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    await sweepControl(nostr, community);
    await _coldStartPlaneFloorsForTests();
    await sweepControl(nostr, community);

    expect(relay.calls[1][0].since, "the restored floor gates the relaunch's sweep").toBeGreaterThanOrEqual(now - 3600);
  });

  it("a restored floor past its interval re-asks the whole plane", async () => {
    const owner = signer();
    const community = communityOf(84, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    await sweepControl(nostr, community);
    await _coldStartPlaneFloorsForTests();
    _configureSweepCadenceForTests({ fullSweepIntervalMs: 0 });
    await sweepControl(nostr, community);

    expect(relay.calls[1][0].since).toBeUndefined();
  });

  it("markControlPlaneStale also drops the stored floor", async () => {
    const owner = signer();
    const community = communityOf(85, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    await sweepControl(nostr, community);
    markControlPlaneStale(community);
    await _coldStartPlaneFloorsForTests();
    await sweepControl(nostr, community);

    expect(relay.calls[1][0].since).toBeUndefined();
  });

  it("an old edition burst is not re-fetched: the delta starts an overlap before the last read", async () => {
    const owner = signer();
    const community = communityOf(86, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    // A burst of editions from yesterday — the plane's newest.
    const burst = await Promise.all([1, 2, 3].map((n) => wrapAt(control, owner, String(n).repeat(64), now - 86_400 + n)));

    const relay = new FakeRelay();
    relay.events = burst.map((b) => b.wrap);
    const nostr = poolOf({ [RELAY_A]: relay });

    await sweepControl(nostr, community);
    await sweepControl(nostr, community);

    expect(relay.calls[1][0].since, "a day-old burst is below the delta").toBeGreaterThan(now - 86_400 + 3);
  });

  describe("controlSweepRelays — rotating delta reads", () => {
    afterEach(() => vi.useRealTimers());

    it("reads every relay until each has a floor, then the two read longest ago", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const owner = signer();
      const relays = ["wss://r1.test", "wss://r2.test", "wss://r3.test", "wss://r4.test"];
      const community = { ...communityOf(87, owner.pubkey), relays };
      const control = controlGroupKey(community.root, community.id, 0);
      const e1 = await wrapAt(control, owner, "ab".repeat(32), Math.floor(Date.now() / 1000) - 100);
      const fakes = Object.fromEntries(relays.map((r) => {
        const f = new FakeRelay();
        f.events = [e1.wrap];
        return [r, f];
      }));
      const nostr = poolOf(fakes);

      expect(await controlSweepRelays(community, 2), "no floors: every relay reads whole").toEqual(relays);
      await sweepControl(nostr, community);
      const first = await controlSweepRelays(community, 2);
      expect(first).toEqual(["wss://r1.test", "wss://r2.test"]);

      // Read those two later: the other two are now the ones read longest ago.
      vi.setSystemTime(Date.now() + 60_000);
      for (const url of first) await sweepRelayScopes(nostr, url, [controlScope(community, url)]);
      expect(await controlSweepRelays(community, 2)).toEqual(["wss://r3.test", "wss://r4.test"]);

      // An invalidated plane reads whole again on every relay.
      markControlPlaneStale(community);
      expect(await controlSweepRelays(community, 2)).toEqual(relays);
    });
  });

  it("an aged delta floor re-asks the whole plane", async () => {
    _configureSweepCadenceForTests({ fullSweepIntervalMs: 0 });
    const owner = signer();
    const community = communityOf(81, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    await sweepControl(nostr, community);
    await sweepControl(nostr, community);

    expect(openingCalls(relay)).toBe(2);
    expect(relay.calls[1][0].since, "a floor past its interval licenses nothing").toBeUndefined();
  });

  it("markControlPlaneStale drops the floor, so a below-floor edition is recovered by the next sweep", async () => {
    const owner = signer();
    const community = communityOf(82, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    await sweepControl(nostr, community);

    // An edition BELOW the delta floor lands on the relay (the shape of an
    // unban recovered on rejoin): a delta sweep's `since` can never see it.
    const buried = await wrapAt(control, owner, "cd".repeat(32), now - 10_000);
    relay.events.push(buried.wrap);
    const missed = await sweepControl(nostr, community);
    expect(missed, "the delta window cannot reach below the floor").toEqual([]);

    // The fold's `incomplete` verdict calls this, forcing the next sweep whole.
    markControlPlaneStale(community);
    const healed = await sweepControl(nostr, community);
    expect(relay.calls.at(-1)?.[0].since, "a stale plane re-asks whole").toBeUndefined();
    expect(healed.map((e) => e.rumorId)).toContain(buried.rumor.id);
  });

  it("a stale persisted cursor (pre-fix state) cannot starve the control fold", async () => {
    const owner = signer();
    const community = communityOf(84, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    // The regression this guards: an unban edition sits BELOW a high-water
    // cursor persisted across a leave/ban/rejoin — the old `since` discipline
    // could never fetch it again, so the rejoiner folded a stale banlist.
    const unban = await wrapAt(control, owner, "ab".repeat(32), now - 500);
    await updateStreamCursor(`control:${community.idHex}|${RELAY_A}`, { newest: now - 10 });

    const relay = new FakeRelay();
    relay.events = [unban.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    const fresh = await sweepControl(nostr, community);

    expect(relay.calls[0][0].since, "the poisoned cursor must be ignored").toBeUndefined();
    expect(fresh.map((e) => e.rumorId), "the below-cursor edition must be recovered").toContain(unban.rumor.id);
  });

  it("pages past the relay's per-filter limit instead of silently truncating the plane", async () => {
    _configureSweepPagingForTests({ pageLimit: 2 });
    const owner = signer();
    const community = communityOf(88, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const wraps = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => wrapAt(control, owner, i.toString(16).padStart(2, "0").repeat(32), now - 100 - i * 10)),
    );

    const relay = new FakeRelay();
    relay.events = wraps.map((w) => w.wrap);
    const nostr = poolOf({ [RELAY_A]: relay });

    const fresh = await sweepControl(nostr, community);

    expect(relay.calls.length, "a full first page must trigger `until` paging").toBeGreaterThan(1);
    for (const w of wraps) {
      expect(fresh.map((e) => e.rumorId), "every page's editions must be recovered").toContain(w.rumor.id);
    }
  });

  it("flags truncation ONLY when it hits our own event budget", async () => {
    // The single honest completeness claim: not "the relay ran out" (which no
    // client can establish) but "we stopped". A Refounding aborts on it, and
    // the login warm-up refuses to persist the fold it produced.
    _configureSweepPagingForTests({ pageLimit: 2, maxEvents: 2 });
    const owner = signer();
    const community = communityOf(90, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const wraps = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) => wrapAt(control, owner, i.toString(16).padStart(2, "0").repeat(32), now - 100 - i * 10)),
    );

    const relay = new FakeRelay();
    relay.events = wraps.map((w) => w.wrap);
    const nostr = poolOf({ [RELAY_A]: relay });

    expect(controlSweepTruncated(community), "nothing is claimed before a sweep runs").toBe(false);
    await sweepControl(nostr, community);
    expect(controlSweepTruncated(community), "the budget was spent with plane left over").toBe(true);
    expect(controlSweepAnswered(community), "the relay still answered — a short read is not silence").toBe(true);
  });

  it("clears a prior truncation verdict once the plane fits the budget again", async () => {
    const owner = signer();
    const community = communityOf(91, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const wraps = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) => wrapAt(control, owner, i.toString(16).padStart(2, "0").repeat(32), now - 100 - i * 10)),
    );
    const relay = new FakeRelay();
    relay.events = wraps.map((w) => w.wrap);
    const nostr = poolOf({ [RELAY_A]: relay });

    _configureSweepPagingForTests({ pageLimit: 2, maxEvents: 2 });
    await sweepControl(nostr, community);
    expect(controlSweepTruncated(community)).toBe(true);

    // A generous budget on the next round reaches the whole plane: the verdict
    // must lift (a transient deep-plane must not wedge future refounds).
    _resetPlaneSweepMemoForTests();
    _configureSweepPagingForTests({ pageLimit: 500, maxEvents: 15_000 });
    await sweepControl(nostr, community);
    expect(controlSweepTruncated(community)).toBe(false);
    expect(controlSweepAnswered(community)).toBe(true);
  });

  it("leaves NO verdict standing when the sweep never got an answer", async () => {
    // A stale "reached, not truncated" from the round before would let a
    // Refounding compact against a picture this sweep never established.
    const owner = signer();
    const community = communityOf(89, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    await sweepControl(nostr, community);
    expect(controlSweepQuorum(community), "one good round reaches the relay").toBe(true);

    relay.failNext = 2; // both attempts
    await sweepControl(nostr, community);
    expect(controlSweepQuorum(community), "a dead round must invalidate the prior verdict").toBe(false);
    expect(controlSweepAnswered(community)).toBe(false);
  });

  it("ignores events a relay slips into a later page that the filter never asked for", async () => {
    // Page one is demuxed by wrap author upstream; pages after it were not, so
    // a relay could inject an off-filter event to (a) drag the `until` cursor
    // below the rest of the plane and (b) get that event's id memoed as
    // processed — which would permanently stop the real wrap behind it from
    // ever being decrypted, by this pager or the live wire that shares the memo.
    _configureSweepPagingForTests({ pageLimit: 2 });
    const owner = signer();
    const community = communityOf(97, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const wraps = await Promise.all(
      [0, 1, 2, 3].map((i) => wrapAt(control, owner, i.toString(16).padStart(2, "0").repeat(32), now - 100 - i * 10)),
    );
    // A foreign event, far older, authored by a key this scope never asked for.
    const foreign = finalizeEvent({ kind: 1059, content: "x", tags: [], created_at: 1_000 }, generateSecretKey());

    // A relay that does NOT honour the filter — the only kind this defends
    // against. FakeRelay filters faithfully, so it cannot express the attack.
    const honest = new FakeRelay();
    honest.events = wraps.map((w) => w.wrap);
    const relay = {
      calls: honest.calls,
      async query(filters: Filter[]) {
        const real = await honest.query(filters);
        // Slip the off-filter event into every page after the first.
        return honest.calls.length > 1 ? [...real, foreign] : real;
      },
    } as unknown as FakeRelay;
    const nostr = poolOf({ [RELAY_A]: relay });

    const fresh = await sweepControl(nostr, community);

    for (const w of wraps) {
      expect(fresh.map((e) => e.rumorId), "the cursor must not be dragged past the real plane").toContain(w.rumor.id);
    }
    expect(controlSweepTruncated(community), "and the sweep never claims it fell short").toBe(false);
  });

  it("counts wraps it fetched but could not open", async () => {
    // The cheapest flood is junk that never decrypts: no encryption to do, just
    // a signature with a key every member holds. It never becomes an opened
    // event, so NOTHING downstream can see it — the sweep is the only witness,
    // and it still spends the fetch budget on every sync.
    const owner = signer();
    const community = communityOf(96, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const real = await wrapAt(control, owner, "ab".repeat(32), now - 100);
    // Authored by the plane key (so the filter returns it) but not a wrap.
    const junk = [0, 1, 2].map((i) =>
      finalizeEvent({ kind: 1059, content: `garbage-${i}`, tags: [], created_at: now - 50 + i }, control.sk),
    );

    const relay = new FakeRelay();
    relay.events = [real.wrap, ...junk];
    const nostr = poolOf({ [RELAY_A]: relay });

    const fresh = await sweepControl(nostr, community);

    expect(fresh.map((e) => e.rumorId), "the real edition still lands").toContain(real.rumor.id);
    expect(controlSweepUnreadable(community), "every unopenable wrap is counted").toBe(junk.length);
  });

  it("sweeps only the CURRENT epoch's control plane, not retired ones", async () => {
    // Concord's control plane is compaction-bounded: a Refounding re-wraps
    // every head into the new epoch, so prior planes are history, not
    // authority. Still sweeping them would let a plane any member can inflate
    // follow the community through every future rotation — defeating the one
    // operation that escapes a flood.
    const owner = signer();
    const community = communityOf(95, owner.pubkey);
    const oldRoot = community.root;
    const newRoot = new Uint8Array(32).fill(0x7e);
    const rotated: Community = {
      ...community,
      root: newRoot,
      rootEpoch: 1n,
      heldRoots: [
        { epoch: 1n, key: newRoot },
        { epoch: 0n, key: oldRoot },
      ],
    };
    const now = Math.floor(Date.now() / 1000);
    const retired = await wrapAt(controlGroupKey(oldRoot, community.id, 0), owner, "aa".repeat(32), now - 500);
    const current = await wrapAt(controlGroupKey(newRoot, community.id, 1), owner, "bb".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [retired.wrap, current.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    const fresh = await sweepControl(nostr, rotated);
    const ids = fresh.map((e) => e.rumorId);

    expect(ids, "the current epoch's plane must be swept").toContain(current.rumor.id);
    expect(ids, "a retired plane must not be swept").not.toContain(retired.rumor.id);
    const authors = relay.calls.flat().flatMap((f) => f.authors ?? []);
    expect(authors, "the retired plane's address must not even be asked for").not.toContain(
      controlGroupKey(oldRoot, community.id, 0).pk,
    );
  });

  it("an exhaustive sweep reaches the whole plane however deep it is", async () => {
    // The Refounding path's escape from the deadlock: a member can flood the
    // plane past the event budget, and a capped sweep would then refuse to
    // rotate — the one operation that retires the flood. Exhaustive pays the
    // depth instead of giving up.
    _configureSweepPagingForTests({ pageLimit: 2, maxEvents: 2 });
    const owner = signer();
    const community = communityOf(94, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const wraps = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) => wrapAt(control, owner, i.toString(16).padStart(2, "0").repeat(32), now - 100 - i * 10)),
    );

    const relay = new FakeRelay();
    relay.events = wraps.map((w) => w.wrap);
    const nostr = poolOf({ [RELAY_A]: relay });

    const fresh = await sweepControl(nostr, community, { exhaustive: true });

    expect(controlSweepTruncated(community), "exhaustive ignores the budget").toBe(false);
    for (const w of wraps) {
      expect(fresh.map((e) => e.rumorId), "every edition must be reached").toContain(w.rumor.id);
    }
  });

  it("drains a same-second wall, then steps below it", async () => {
    // `until` is INCLUSIVE, so a block of identical timestamps wider than a
    // page is a cursor no `until` steps past — a full page of nothing new,
    // forever. That is the cheapest silent starve: a wrap's created_at is the
    // publisher's to choose, so bury a ban under one second's worth of wraps
    // and a naive pager never sees past it. One wide ask for that second
    // recovers it; the cursor then steps below.
    _configureSweepPagingForTests({ pageLimit: 2, wallPage: 10_000 });
    const owner = signer();
    const community = communityOf(92, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const wall = await Promise.all(
      [0, 1, 2, 3].map((i) => wrapAt(control, owner, i.toString(16).padStart(2, "0").repeat(32), now - 100)),
    );
    const buried = await wrapAt(control, owner, "ee".repeat(32), now - 900);

    const relay = new FakeRelay();
    relay.events = [...wall.map((w) => w.wrap), buried.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    const ids = (await sweepControl(nostr, community)).map((e) => e.rumorId);

    for (const w of wall) {
      expect(ids, "the wall itself must be drained, not stepped over").toContain(w.rumor.id);
    }
    expect(ids, "and what is buried behind it must be reached").toContain(buried.rumor.id);
    expect(controlSweepTruncated(community), "a drainable second costs nothing").toBe(false);
  });

  it("reports a shortfall when a CAPPED relay cannot serve a whole second", async () => {
    // The residual case, and the one that must never be silent: a relay whose
    // own limit sits below the second's size answers a wide ask with its cap,
    // which looks exactly like a drained second. Comparing the answer to the
    // limit we ASKED for reads a capped relay as an exhausted one and loses
    // the remainder with no signal at all. The honest test is whether the wide
    // ask taught us anything new.
    _configureSweepPagingForTests({ pageLimit: 2, wallPage: 2 });
    const owner = signer();
    const community = communityOf(98, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const wall = await Promise.all(
      [0, 1, 2, 3].map((i) => wrapAt(control, owner, i.toString(16).padStart(2, "0").repeat(32), now - 100)),
    );
    const buried = await wrapAt(control, owner, "ee".repeat(32), now - 900);

    const relay = new FakeRelay();
    relay.events = [...wall.map((w) => w.wrap), buried.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    await sweepControl(nostr, community);

    expect(controlSweepTruncated(community), "a second we cannot read whole is a short read").toBe(true);
    expect(controlSweepAnswered(community), "a short read is still an answer — it IS the alarm").toBe(true);
  });

  it("an exhaustive sweep never JOINS a budgeted one already in flight", async () => {
    // The rotation path's whole guarantee. Scope keys are shared, so without a
    // separate flight identity the Refounding's exhaustive read silently
    // inherits a capped one — and compacts a plane it never saw the end of.
    _configureSweepPagingForTests({ pageLimit: 2, maxEvents: 2 });
    const owner = signer();
    const community = communityOf(85, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const wraps = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) => wrapAt(control, owner, i.toString(16).padStart(2, "0").repeat(32), now - 100 - i * 10)),
    );

    const relay = new FakeRelay();
    relay.delayMs = 20;
    relay.events = wraps.map((w) => w.wrap);
    const nostr = poolOf({ [RELAY_A]: relay });

    const budgeted = sweepControl(nostr, community);
    const exhaustive = sweepControl(nostr, community, { exhaustive: true });
    await Promise.all([budgeted, exhaustive]);

    expect(controlSweepTruncated(community), "the exhaustive read must settle the verdict").toBe(false);
    const stored = (await exhaustive).map((e) => e.rumorId);
    for (const w of wraps) {
      expect(stored, "every edition must be reached").toContain(w.rumor.id);
    }
  });

  it("reports truncation when ANY relay came up short, not just all of them", async () => {
    // Relays hold different depths. A shallow one that answers everything it
    // has proves nothing about the year another holds, so one relay hitting
    // the budget is enough to say we did not read the union.
    _configureSweepPagingForTests({ pageLimit: 2, maxEvents: 2 });
    const owner = signer();
    const community: Community = { ...communityOf(86, owner.pubkey), relays: [RELAY_A, RELAY_B] };
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const deep = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) => wrapAt(control, owner, i.toString(16).padStart(2, "0").repeat(32), now - 100 - i * 10)),
    );

    const shallow = new FakeRelay();
    shallow.events = [deep[0].wrap];
    const flooded = new FakeRelay();
    flooded.events = deep.map((w) => w.wrap);
    const nostr = poolOf({ [RELAY_A]: shallow, [RELAY_B]: flooded });

    await sweepControl(nostr, community);

    expect(controlSweepTruncated(community), "one short relay is a short read").toBe(true);
    expect(controlSweepQuorum(community), "but both relays answered").toBe(true);
  });

  it("loses quorum when half the relays go silent, keeps it when a majority answer", async () => {
    // The Refounding gate. Compaction rewrites the whole community, so reading
    // too few sources drops state for everyone — but demanding EVERY relay
    // would let one permanently dead entry in the list block rotation forever,
    // which is the same wedge an attacker was after.
    const owner = signer();
    const three = [RELAY_A, RELAY_B, "wss://relay-c.test"];
    const community: Community = { ...communityOf(87, owner.pubkey), relays: three };
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const live = () => {
      const r = new FakeRelay();
      r.events = [e1.wrap];
      return r;
    };
    const dead = () => {
      const r = new FakeRelay();
      r.failNext = 2;
      return r;
    };

    // 2 of 3 answer: a majority, so rotation may proceed.
    await sweepControl(poolOf({ [three[0]]: live(), [three[1]]: live(), [three[2]]: dead() }), community);
    expect(controlSweepReach(community)).toEqual({ reached: 2, total: 3 });
    expect(controlSweepQuorum(community), "2 of 3 is a majority").toBe(true);
    expect(controlSweepTruncated(community), "silence is not the same as a short read").toBe(false);

    // 1 of 3 answers: too little of the union to compact around.
    _resetPlaneSweepMemoForTests();
    await sweepControl(poolOf({ [three[0]]: live(), [three[1]]: dead(), [three[2]]: dead() }), community);
    expect(controlSweepQuorum(community), "1 of 3 is not").toBe(false);
    expect(controlSweepAnswered(community), "but the watchdog still gets its junk tally").toBe(true);
  });

  it("does not mistake a relay's OWN cap for a drained second", async () => {
    // The silent-loss case. A relay that caps at 3 answers a 10,000-wide ask
    // with 3, which is indistinguishable from a second that holds exactly 3.
    // Judging the answer against the limit we ASKED for reads the capped relay
    // as exhausted and drops the remainder with no signal at all — strictly
    // worse than the stall it replaced, because nothing downstream can tell.
    _configureSweepPagingForTests({ pageLimit: 2, wallPage: 10_000 });
    const owner = signer();
    const community = communityOf(84, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const wall = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => wrapAt(control, owner, i.toString(16).padStart(2, "0").repeat(32), now - 100)),
    );

    const honest = new FakeRelay();
    honest.events = wall.map((w) => w.wrap);
    // A relay with a hard ceiling of 2, whatever the filter asks for.
    const capped = {
      calls: honest.calls,
      async query(filters: Filter[]) {
        return (await honest.query(filters.map((f) => ({ ...f, limit: Math.min(f.limit ?? 2, 2) })))).slice(0, 2);
      },
    } as unknown as FakeRelay;
    const nostr = poolOf({ [RELAY_A]: capped });

    await sweepControl(nostr, community);

    expect(
      controlSweepTruncated(community),
      "a cap we cannot see past must never read as a complete second",
    ).toBe(true);
  });

  it("never claims truncation when the last page is simply the end of the plane", async () => {
    // A short page is the ordinary end of a read. Treating it as a shortfall
    // would wedge refounds on perfectly healthy communities.
    _configureSweepPagingForTests({ pageLimit: 2 });
    const owner = signer();
    const community = communityOf(93, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const wraps = await Promise.all(
      [0, 1].map((i) => wrapAt(control, owner, i.toString(16).padStart(2, "0").repeat(32), now - 100 - i * 10)),
    );

    const relay = new FakeRelay();
    relay.events = wraps.map((w) => w.wrap);
    const nostr = poolOf({ [RELAY_A]: relay });

    const fresh = await sweepControl(nostr, community);

    expect(controlSweepTruncated(community)).toBe(false);
    for (const w of wraps) {
      expect(fresh.map((e) => e.rumorId)).toContain(w.rumor.id);
    }
  });
});

describe("control snapshot rebuild — a lost id-set is re-recorded despite the memo", () => {
  it("re-ingests a Refounded plane whose snapshot set was pruned away", async () => {
    // The cross-account hazard: pruneControlSnapshots keeps only the pks the
    // CURRENT account's list entry holds, so another logged-in account's
    // warm-up (holding different epochs of the same community) can delete the
    // set this account's fold anchors on. The set is only recorded for FRESH
    // wraps, and after the first sweep every wrap is in the seen memo — so
    // without the rebuild pass the deletion is permanent and the fold anchors
    // a Refounded community on an empty snapshot.
    const owner = signer();
    const base = communityOf(100, owner.pubkey);
    const newRoot = new Uint8Array(32).fill(0x66);
    const community: Community = {
      ...base,
      root: newRoot,
      rootEpoch: 1n,
      heldRoots: [
        { epoch: 1n, key: newRoot },
        { epoch: 0n, key: base.root },
      ],
    };
    const control = controlGroupKey(newRoot, community.id, 1);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    const first = await sweepControl(nostr, community);
    expect(first.map((e) => e.rumorId)).toContain(e1.rumor.id);
    expect(
      [...((await readControlSnapshot(community.idHex, control.pk)) ?? [])],
      "the first sweep records which stream each edition arrived on",
    ).toContain(e1.rumor.id);

    // Another account's warm-up, whose entry holds none of these epochs.
    await pruneControlSnapshots(community.idHex, []);
    expect(await readControlSnapshot(community.idHex, control.pk)).toBeUndefined();

    const healed = await sweepControl(nostr, community);
    expect(
      [...((await readControlSnapshot(community.idHex, control.pk)) ?? [])],
      "the missing set must force a re-ingest that re-records it",
    ).toContain(e1.rumor.id);
    expect(healed.map((e) => e.rumorId), "the re-ingested editions re-announce").toContain(e1.rumor.id);
  });
});

describe("guestbook read state — epoch-keyed scope", () => {
  it("an epoch advance re-baselines: the first sweep at the new epoch is a whole read", async () => {
    const owner = signer();
    const base = communityOf(92, owner.pubkey);
    const now = Math.floor(Date.now() / 1000);
    const gb0 = await wrapAt(guestbookGroupKey(base.root, base.id, 0), owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [gb0.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    await sweepGuestbook(nostr, base);
    await sweepGuestbook(nostr, base);
    expect(relay.calls[1][0].since, "steady state stays cursor-gated").toBeGreaterThanOrEqual(now - 3600);

    // A rekey adoption / rejoin: the member now reads MORE (epoch 1 + retained
    // epoch 0). The old cursor was minted under a narrower read scope — the
    // first sweep at the new epoch must be a full backfill, not since-gated.
    const root1 = new Uint8Array(32).fill(93);
    const adopted = {
      ...base,
      root: root1,
      rootEpoch: 1n,
      heldRoots: [{ epoch: 1n, key: root1 }, ...base.heldRoots],
    };
    await sweepGuestbook(nostr, adopted);

    const filter = relay.calls[2][0];
    expect(filter.since, "a cursor from another epoch's read scope must not gate this sweep").toBeUndefined();
    expect(filter.authors?.length, "the sweep must span every held epoch's group").toBe(2);
  });
});
