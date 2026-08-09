/**
 * Regression tests for issue #19 — "Notifications arrive for messages that
 * never render in the timeline (desktop + mobile)".
 *
 * The messages exist on the relays and decrypt cleanly (a headless client
 * renders the full timeline), yet every UI client with a saved sync cursor is
 * missing the same messages. These tests pin the two client-side mechanisms:
 *
 * 1. THE BACKFILL MIDDLE-GAP. `backfillAndRefresh` fetches one newest page
 *    (pass 1) and then resumes OLDER paging from the saved `cursor.oldest`
 *    (pass 2) — the bottom of already-seen history. When more than one page of
 *    wraps arrived while the app was closed, the region between the old
 *    `cursor.newest` and pass 1's oldest is never fetched from any relay, and
 *    the cursor's `newest` then advances to now, sealing the hole permanently.
 *
 * 2. THE DESTRUCTIVE PENDING-WRAP DRAIN. The queryFn drains wraps parked by
 *    the native notification service (removing them from the pending store)
 *    BEFORE decrypting them. If the decrypt round is aborted (channel switch
 *    mid-read), the undecoded wraps are gone locally — recoverable only via
 *    relay backfill, which has the gap above.
 *
 * These tests assert the DESIRED behavior, so they fail until the bugs are
 * fixed.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { openChatBatch } from "@/concord/lib/chat";
import { bytesToHex, channelGroupKey, voiceGroupKey, voiceMediaKey } from "@/concord/lib/derive";
import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import {
  ackPendingWraps,
  parkPendingWraps,
  peekPendingWraps,
  queryChannelRumors,
  updateChannelCursor,
  writeRumors,
} from "@/concord/lib/rumorStore";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal } from "@/concord/lib/stream";
import { getSyncTasks } from "@/lib/syncActivity";
import { syncState } from "@/sync/syncManager";
import type { Channel, Community } from "@/concord/lib/types";
import type { NostrRumor } from "@/lib/nostrRumor";

import { useChannelTimeline, useChatModeration } from "./useChannel";
import { channelWriteGroup } from "@/concord/lib/community";

/**
 * The community every channel in this file belongs to — the rumor-store tenant
 * its messages are written to and read back from.
 */
const CID = "cc".repeat(32);

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  pool: undefined as unknown,
  folded: undefined as unknown,
  dissolved: null as number | null,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: h.pool }),
}));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: h.folded }),
  useDissolved: () => ({ data: h.dissolved }),
  citationFor: () => undefined,
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: undefined }),
}));
vi.mock("@/hooks/useSendStatusMap", () => ({
  useSendStatusMap: () => ({ setStatus: () => {} }),
  useSendStatusMapValue: () => ({}),
}));

// ── Fake relay ───────────────────────────────────────────────────────────────

interface Filter {
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

/** An in-memory relay honoring kinds/authors/since/until/limit, newest-first. */
class FakeRelay {
  events: NostrEvent[] = [];
  queries: Filter[] = [];
  /** Simulated response latency (cold TLS+WS+NIP-42 AUTH round-trips). */
  delayMs = 0;

  match(f: Filter): NostrEvent[] {
    let evs = this.events.filter(
      (ev) =>
        (!f.kinds || f.kinds.includes(ev.kind)) &&
        (!f.authors || f.authors.includes(ev.pubkey)) &&
        (f.since === undefined || ev.created_at >= f.since) &&
        (f.until === undefined || ev.created_at <= f.until),
    );
    evs = [...evs].sort((a, b) => b.created_at - a.created_at);
    if (f.limit !== undefined) evs = evs.slice(0, f.limit);
    return evs;
  }

  async query(filters: Filter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]> {
    this.queries.push(...filters);
    if (this.delayMs > 0) {
      // Honor the abort signal during the latency window, as NRelay1 does.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        opts?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
    const out = new Map<string, NostrEvent>();
    for (const f of filters) for (const ev of this.match(f)) out.set(ev.id, ev);
    return [...out.values()];
  }

  /** Live subscription: emits nothing, parks until aborted. */
  // eslint-disable-next-line require-yield
  async *req(_filters: Filter[], opts?: { signal?: AbortSignal }): AsyncGenerator<unknown> {
    await new Promise<void>((resolve) => {
      if (opts?.signal?.aborted) return resolve();
      opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  async event(): Promise<void> {}
}

function makePool(relays: Record<string, FakeRelay>) {
  return { relay: (url: string) => relays[url] };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RELAY = "wss://test.relay";
const root = new Uint8Array(32).fill(3);

/** Each test gets a distinct channel id so the shared stores can't cross-talk. */
let nextChannelByte = 40;
function makeChannel(): { channel: Channel; idHex: string } {
  const channelId = new Uint8Array(32).fill(nextChannelByte++);
  const idHex = bytesToHex(channelId);
  const group = channelGroupKey(root, channelId, 0);
  const stream = { epoch: 0n, group };
  const voice = { room: voiceGroupKey(root, channelId, 0), mediaKey: voiceMediaKey(root, channelId, 0) };
  return {
    channel: {
      id: channelId,
      idHex,
      name: "general",
      isPrivate: false,
      isAnnouncement: false,
      voice,
      streams: [stream],
      current: stream,
    },
    idHex,
  };
}

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

/**
 * A chat wrap with a CONTROLLED outer `created_at` (what the relay pagination
 * and sync cursors operate on). `wrapSeal` stamps "now", so re-finalize the
 * identical wrap payload with the chosen timestamp under the stream key —
 * byte-equivalent to a wrap genuinely published at that time (CORD-01: wrap
 * timestamps are not tweaked).
 */
async function wrapChatAt(
  channel: Channel,
  s: ReturnType<typeof signer>,
  content: string,
  createdAt: number,
): Promise<NostrEvent> {
  const rumor = buildRumor({
    kind: KIND_MESSAGE,
    content,
    tags: [...channelBindingTags(channel.idHex, 0n)],
    pubkey: s.pubkey,
    ms: createdAt * 1000,
  });
  const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channelWriteGroup(channel), s);
  const w = wrapSeal(seal, channelWriteGroup(channel));
  return finalizeEvent(
    { kind: w.kind, content: w.content, tags: w.tags, created_at: createdAt },
    channelWriteGroup(channel).sk,
  );
}

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("useChannelTimeline — issue #19 (notified but never rendered)", () => {
  it(
    "renders EVERY message that arrived while the app was closed, even when the offline burst exceeds one backfill page",
    { timeout: 40_000 },
    async () => {
      const { channel, idHex } = makeChannel();
      const alice = signer();
      const now = Math.floor(Date.now() / 1000);
      const base = now - 60_000; // far enough back that the live sub (since now-5) never matches

      // ── Prior session: 10 messages seen and decrypted, sync cursor saved.
      const oldWraps: NostrEvent[] = [];
      for (let i = 0; i < 10; i++) oldWraps.push(await wrapChatAt(channel, alice, `old-${i}`, base + i));
      writeRumors(CID, await openChatBatch(oldWraps, channel));
      await updateChannelCursor(idHex, { newest: base + 9, oldest: base });
      await waitFor(async () => {
        expect((await queryChannelRumors(CID, idHex, { limit: 200 })).length).toBe(10);
      });

      // ── While the app was closed: 80 new messages (> BACKFILL_PAGE = 50).
      // The user was notified about all of them; they all live on the relay.
      const newWraps: NostrEvent[] = [];
      for (let i = 0; i < 80; i++) {
        newWraps.push(await wrapChatAt(channel, alice, `new-${i}`, base + 1000 + i));
      }

      const relay = new FakeRelay();
      relay.events = [...oldWraps, ...newWraps];
      h.pool = makePool({ [RELAY]: relay });

      const community = { idHex: CID, relays: [RELAY] } as unknown as Community;
      const { wrapper } = makeWrapper();
      const { result } = renderHook(() => useChannelTimeline(community, channel), { wrapper });

      // The newest page lands (pass 1 of the backfill completed and painted).
      await waitFor(
        () => {
          expect(result.current.folded.messages.map((m) => m.content)).toContain("new-79");
        },
        { timeout: 15_000 },
      );

      // …and every notified message must land too: the backfill must bridge
      // the region between the saved cursor's `newest` and pass 1's oldest.
      // (Bug: pass 2 resumes from cursor.oldest — BELOW already-seen history —
      // so new-0..new-29 are never fetched from any relay, and the advanced
      // cursor seals the gap permanently.)
      await waitFor(
        () => {
          const contents = new Set(result.current.folded.messages.map((m) => m.content));
          const missing: string[] = [];
          for (let i = 0; i < 80; i++) if (!contents.has(`new-${i}`)) missing.push(`new-${i}`);
          expect(missing, `messages on the relay but never rendered: ${missing.join(", ")}`).toEqual([]);
        },
        { timeout: 8_000 },
      );
    },
  );

  it(
    "a fast EMPTY relay must not starve a slower relay that carries the messages (EOSE-grace race)",
    { timeout: 30_000 },
    async () => {
      // Live-data topology (issue #19): the platform relay is unioned into
      // every Concord community's relay set but stores NO wraps — it answers
      // every REQ instantly with an empty EOSE. The real community relays gate
      // kind 1059 behind NIP-42, so a cold query costs extra round-trips
      // (REQ → CLOSED auth-required → AUTH → REQ → EOSE), easily >500ms.
      //
      // backfillStore arms a 500ms abort-grace as soon as the FIRST relay
      // returns a page. The empty platform relay always wins that race, the
      // real relays are aborted mid-AUTH, and the backfill completes with
      // ZERO events (and marks the channel exhausted) — precisely on a cold
      // open, the moment the user taps a notification.
      const { channel, idHex } = makeChannel();
      const alice = signer();
      const now = Math.floor(Date.now() / 1000);
      const base = now - 60_000;

      // Prior session: 5 messages seen, cursor saved.
      const oldWraps: NostrEvent[] = [];
      for (let i = 0; i < 5; i++) oldWraps.push(await wrapChatAt(channel, alice, `old-${i}`, base + i));
      writeRumors(CID, await openChatBatch(oldWraps, channel));
      await updateChannelCursor(idHex, { newest: base + 4, oldest: base });
      await waitFor(async () => {
        expect((await queryChannelRumors(CID, idHex, { limit: 200 })).length).toBe(5);
      });

      // While the app was closed: 10 new messages — well under one page, so
      // the ONLY failure mode in play is the grace race.
      const newWraps: NostrEvent[] = [];
      for (let i = 0; i < 10; i++) newWraps.push(await wrapChatAt(channel, alice, `new-${i}`, base + 1000 + i));

      const platform = new FakeRelay(); // instant, empty — never stores wraps
      const real = new FakeRelay();
      real.events = [...oldWraps, ...newWraps];
      real.delayMs = 900; // cold AUTH round-trips
      h.pool = makePool({ "wss://platform.test": platform, "wss://real.test": real });

      const community = {
        idHex: CID,
        relays: ["wss://platform.test", "wss://real.test"],
      } as unknown as Community;
      const { wrapper } = makeWrapper();
      const { result } = renderHook(() => useChannelTimeline(community, channel), { wrapper });

      // Desired: every notified message lands — a relay that answered EMPTY
      // must not abort the relay that actually has the data.
      await waitFor(
        () => {
          const contents = new Set(result.current.folded.messages.map((m) => m.content));
          const missing: string[] = [];
          for (let i = 0; i < 10; i++) if (!contents.has(`new-${i}`)) missing.push(`new-${i}`);
          expect(missing, `messages on the slow relay but never rendered: ${missing.join(", ")}`).toEqual([]);
        },
        { timeout: 8_000 },
      );
    },
  );

  it("keeps parked wraps recoverable when the decrypt round is interrupted (no destructive drain)", async () => {
    const { channel, idHex } = makeChannel();
    const alice = signer();
    const now = Math.floor(Date.now() / 1000);

    // The native notification service parked three wraps it notified about.
    const wraps = await Promise.all(
      [0, 1, 2].map((i) => wrapChatAt(channel, alice, `lost-${i}`, now - 100 + i)),
    );
    parkPendingWraps(wraps);

    // The queryFn's ingest sequence (useChannel), with an adversarial
    // interruption: the decode round produces nothing (aborted signal), so
    // NOTHING may be acknowledged — the wraps must stay parked.
    const pks = channel.streams.map((s) => s.group.pk);
    const parked: NostrRumor[] = [];
    await waitFor(async () => {
      parked.length = 0;
      parked.push(...(await peekPendingWraps(pks)));
      expect(parked.length).toBe(3);
    });
    const controller = new AbortController();
    controller.abort();
    const interrupted = await openChatBatch(parked, channel, { signal: controller.signal });
    writeRumors(CID, interrupted);
    ackPendingWraps(parked.filter((w) => interrupted.some((o) => o.wrapId === w.id)).map((w) => w.id));

    // The notified messages are still recoverable locally — decoded into the
    // rumor store, or still parked for the next read.
    const decoded = await queryChannelRumors(CID, idHex, { limit: 10 });
    const stillParked = await peekPendingWraps(pks);
    expect(decoded.length + stillParked.length).toBeGreaterThanOrEqual(3);

    // …and the next (uninterrupted) round consumes them fully: decoded to the
    // store, acked out of the pending store.
    const opened = await openChatBatch(stillParked, channel);
    writeRumors(CID, opened);
    ackPendingWraps(stillParked.filter((w) => opened.some((o) => o.wrapId === w.id)).map((w) => w.id));
    await waitFor(async () => {
      expect((await queryChannelRumors(CID, idHex, { limit: 10 })).length).toBe(3);
      expect((await peekPendingWraps(pks)).length).toBe(0);
    });
  });

  it("does not paint the previous channel's messages when switching channels", async () => {
    const chanA = makeChannel();
    const chanB = makeChannel();
    const alice = signer();
    const now = Math.floor(Date.now() / 1000);

    // Channel A has decrypted history in the rumor store.
    const wraps = [await wrapChatAt(chanA.channel, alice, "a-msg", now - 100)];
    writeRumors(CID, await openChatBatch(wraps, chanA.channel));
    await waitFor(async () => {
      expect((await queryChannelRumors(CID, chanA.idHex, { limit: 10 })).length).toBe(1);
    });

    // Channel B is empty and its relay is cold (auth round-trips), so B's first
    // read stays pending for a while after the switch.
    const relay = new FakeRelay();
    relay.delayMs = 800;
    h.pool = makePool({ [RELAY]: relay });
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;

    const { wrapper } = makeWrapper();
    const { result, rerender } = renderHook(
      ({ channel }: { channel: Channel }) => useChannelTimeline(community, channel),
      { wrapper, initialProps: { channel: chanA.channel } },
    );
    await waitFor(() => {
      expect(result.current.folded.messages.map((m) => m.content)).toContain("a-msg");
    });

    // Switch to channel B: A's timeline must never paint into B — not on the
    // switch render, and not on any LATER re-render while B's first read is
    // still pending. (Regression: an effect-updated ref re-admitted the old
    // channel's data through `placeholderData` one render after the switch —
    // the inline placeholder closure defeats TanStack's memoization, so any
    // re-render re-invokes it with the previous query's data, and by then the
    // ref already pointed at the new channel.)
    rerender({ channel: chanB.channel });
    expect(result.current.folded.messages.map((m) => m.content)).not.toContain("a-msg");
    rerender({ channel: chanB.channel });
    expect(result.current.folded.messages.map((m) => m.content)).not.toContain("a-msg");

    // …and B settles empty.
    await waitFor(
      () => {
        expect(result.current.isLoading).toBe(false);
        expect(result.current.folded.messages).toEqual([]);
      },
      { timeout: 8_000 },
    );
  });

  it("reports a cold channel's backfill as sync activity, never as a bare empty timeline", async () => {
    const chanA = makeChannel();
    const chanB = makeChannel();
    const alice = signer();
    const now = Math.floor(Date.now() / 1000);

    // Channel A has history in the store; channel B has history ONLY on the
    // relay (cold — never opened this session), so B's store read returns [].
    writeRumors(CID, await openChatBatch([await wrapChatAt(chanA.channel, alice, "a-msg", now - 100)], chanA.channel));
    const bWrap = await wrapChatAt(chanB.channel, alice, "b-msg", now - 50);
    await waitFor(async () => {
      expect((await queryChannelRumors(CID, chanA.idHex, { limit: 10 })).length).toBe(1);
    });

    // B's relay is slow, so the window between the empty store read and the
    // backfill paint is wide — exactly where the flash happened.
    const relay = new FakeRelay();
    relay.events = [bWrap];
    relay.delayMs = 600;
    h.pool = makePool({ [RELAY]: relay });
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;

    // Record EVERY render's (isLoading, message-count, in-flight sync scope) so
    // a single transient uncovered "loaded + empty" frame can't slip between
    // polls.
    const frames: Array<{ loading: boolean; count: number; syncing: boolean; channel: string }> = [];
    let watched = chanA.idHex;

    const { wrapper } = makeWrapper();
    const { result, rerender } = renderHook(
      ({ channel }: { channel: Channel }) => {
        const t = useChannelTimeline(community, channel);
        frames.push({
          loading: t.isLoading,
          count: t.folded.messages.length,
          // The production derivation (ConcordPage's `channelSyncing`): the
          // channel's sync TOPIC is pending, or a sync task is scoped to it.
          syncing:
            syncState(`c2:${watched}`).status === "pending" ||
            getSyncTasks().some((task) => task.scope === `c2:${watched}`),
          channel: watched,
        });
        return t;
      },
      { wrapper, initialProps: { channel: chanA.channel } },
    );
    await waitFor(() => {
      expect(result.current.folded.messages.map((m) => m.content)).toContain("a-msg");
    });

    // Switch to the cold channel B; wait until b-msg paints from the backfill.
    watched = chanB.idHex;
    frames.length = 0;
    rerender({ channel: chanB.channel });
    await waitFor(
      () => {
        expect(result.current.folded.messages.map((m) => m.content)).toContain("b-msg");
      },
      { timeout: 8_000 },
    );

    // The invariant: a render that is not-loading AND empty must never be
    // UNACCOUNTED FOR — that pairing is what paints "No messages yet".
    //
    // `isLoading` covers the local store read only, so on a cold channel it
    // clears the moment ArmadaDB answers empty (that is the point: a channel
    // whose history IS cached must not wait on relays). What keeps the empty
    // frame from reading as a verdict is the channel's sync TOPIC: pending
    // from the moment the hook declares interest until the scheduler's round
    // settles (plus the round's own sync-activity task) — the timeline
    // renders "Catching up…" from it and shows its empty state only once the
    // topic resolves.
    const uncovered = frames.find((f) => !f.loading && f.count === 0 && !f.syncing);
    expect(uncovered).toBeUndefined();
    expect(result.current.folded.messages.map((m) => m.content)).toContain("b-msg");
  });
});


describe("useChatModeration — the tombstone seal (CORD-02 §9)", () => {
  const owner = "0".repeat(64);
  const member = "2".repeat(64);
  const community = { idHex: CID, id: new Uint8Array(32).fill(0xcc), owner } as unknown as Community;
  const GRAVE = 5_000_000;

  beforeEach(() => {
    h.dissolved = null;
    // The owner moderating: authorized, and cites nothing by construction, so
    // the tombstone is the only variable under test.
    h.folded = { roster: { roles: [], grants: [] }, ownerHex: owner, banned: new Set<string>(), heads: new Map() };
  });

  it("honors a moderation delete while the community lives", () => {
    const { result } = renderHook(() => useChatModeration(community));
    expect(result.current.canDelete(owner, member, { ms: GRAVE + 1 })).toBe(true);
  });

  it("refuses one published AFTER the tombstone", () => {
    h.dissolved = GRAVE;
    const { result } = renderHook(() => useChatModeration(community));
    expect(result.current.canDelete(owner, member, { ms: GRAVE + 1 })).toBe(false);
  });

  it("still honors one published BEFORE the tombstone", () => {
    // The fold replays history, so a global "is dissolved" test would
    // retroactively un-hide every moderation delete the community ever honored
    // the instant it was dissolved. Death wins every RACE — it does not reach
    // backwards.
    h.dissolved = GRAVE;
    const { result } = renderHook(() => useChatModeration(community));
    expect(result.current.canDelete(owner, member, { ms: GRAVE - 1 })).toBe(true);
  });
});
