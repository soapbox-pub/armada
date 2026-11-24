/**
 * Locked Channels and sealed history (CORD-03 §1 at concord#27), end to end against an
 * in-memory relay, after Vector v0.5.2's `a_locked_channel_*` and `a_sealed_lock_*` tests:
 * what a Locked window's judge stands behind, the seal a manager makes, and a reader
 * paging back through it by id so nothing dated into the sealed past is read.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from "nostr-tools/pure";
import { beforeAll, describe, expect, it } from "vitest";

import { sealHistory } from "@/concord/hooks/sealHistory";
import { writerJudge } from "@/concord/lib/channelJudges";
import { backfillStore } from "@/concord/lib/channelSync";
import { openChatBatch, type OpenedChat } from "@/concord/lib/chat";
import { channelsView } from "@/concord/lib/community";
import { foldControlState } from "@/concord/lib/control";
import { bytesToHex, channelGroupKey, random32, writersLocator, type GroupKey } from "@/concord/lib/derive";
import type { ParsedEdition } from "@/concord/lib/edition";
import { KIND_MESSAGE, KIND_REACTION, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { _configureAuthWaitForTests } from "@/concord/lib/planeSync";
import { Permissions } from "@/concord/lib/roles";
import { MAX_SEAL_IDS, openSealPage, paginate, parseSealPage, sealPageContent, sealPageWrap } from "@/concord/lib/seal";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { Channel } from "@/concord/lib/types";
import { LEDGER_SKEW_MS, type SealRef } from "@/concord/lib/writers";
import { heldCommunity, hexKey, rankedCommunity, type TestCommunity } from "@/test/concordEditions";

const T0 = 1_700_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;

beforeAll(() => _configureAuthWaitForTests({ maxWaitMs: 0 }));

/** A relay holding what it's sent, answering `ids`, `authors`, `since`, `until` and `limit` newest first. */
class MemoryRelay {
  events = new Map<string, NostrEvent>();
  asked: NostrFilter[] = [];
  relay() {
    return {
      query: async (filters: NostrFilter[]) => this.query(filters),
      queryStrict: async (filters: NostrFilter[]) => this.query(filters),
      event: async (e: NostrEvent) => void this.events.set(e.id, e),
    };
  }
  query(filters: NostrFilter[]): NostrEvent[] {
    const out = new Map<string, NostrEvent>();
    for (const f of filters) {
      this.asked.push(f);
      const hits = [...this.events.values()]
        .filter((e) => (!f.ids || f.ids.includes(e.id)) && (!f.authors || f.authors.includes(e.pubkey)) && (!f.kinds || f.kinds.includes(e.kind)))
        .filter((e) => (f.since === undefined || e.created_at >= f.since) && (f.until === undefined || e.created_at <= f.until))
        .sort((a, b) => b.created_at - a.created_at);
      for (const e of f.limit === undefined ? hits : hits.slice(0, f.limit)) out.set(e.id, e);
    }
    return [...out.values()];
  }
}

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

async function chatWrap(author: ReturnType<typeof signer>, channelIdHex: string, group: GroupKey, ms: number, content: string, kind = KIND_MESSAGE, extra: string[][] = []): Promise<NostrEvent> {
  const rumor = buildRumor({ kind, content, tags: [...channelBindingTags(channelIdHex, 0n), ...extra], pubkey: author.pubkey, ms });
  return wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, group, author), group, { createdAt: Math.floor(ms / 1000) });
}

function ledgerEdition(c: TestCommunity, ch: string, content: object, prev?: ParsedEdition, at = T0) {
  return c.edition({ vsk: "18", eid: writersLocator(c.id, hexToBytes(ch)), author: c.owner, prev, createdAt: Math.floor(at / 1000), content: { channel: ch, ...content } });
}

const opened = (author: string, ms: number, kind: number, tags: string[][] = []): OpenedChat => ({
  rumorId: hexKey(),
  author,
  kind,
  content: "x",
  tags,
  ms,
  createdAt: Math.floor(ms / 1000),
  channelIdHex: "",
  epoch: 0n,
});

/** A public Channel Locked at `lock` by the owner, folded with `extra` entries after its lock and, last, `seal`. */
function locked(owner?: string) {
  const k = rankedCommunity(Permissions.MANAGE_CHANNELS, owner ? { owner } : {});
  const { c, base } = k;
  const id = random32();
  const ch = bytesToHex(id);
  const channel = c.edition({ vsk: "2", eid: id, author: c.owner, content: { name: "announcements", private: false } });
  const writerPk = getPublicKey(generateSecretKey());
  const lock = T0 + 100 * SEC;
  const fold = (extra: object[] = [], seal?: SealRef) => {
    const entries: object[] = [{ at: lock, epoch: 1, writer: writerPk, root: 0, by: c.owner, locked: true }, ...extra];
    const eds: ParsedEdition[] = [];
    entries.forEach((e, i) => {
      const last = i === entries.length - 1;
      eds.push(ledgerEdition(c, ch, { ledger: entries.slice(0, i + 1), ...(last && seal ? { seal: { ...seal, page: seal.page ?? null } } : {}) }, eds[i - 1], (e as { at: number }).at));
    });
    return foldControlState([...base, channel, ...eds], c.id, c.owner);
  };
  return { ...k, id, ch, lock, writerPk, folded: fold(), fold };
}

describe("a Locked window's judge (CORD-03 §1)", () => {
  it("takes nothing at the read address past its first minutes but a manager's, and a reaction there not at all", () => {
    const { c, ch, admin, lock, folded } = locked();
    const judge = writerJudge(folded, ch, c.id)!;
    const stranger = hexKey();
    expect(judge.stands(opened(stranger, lock - SEC, KIND_MESSAGE))).toBe(true);
    expect(judge.stands(opened(stranger, lock + 20 * MIN, KIND_MESSAGE))).toBe(false);
    expect(judge.stands(opened(admin, lock + 20 * MIN, KIND_MESSAGE))).toBe(true);
    expect(judge.stands(opened(stranger, lock + 20 * MIN, KIND_REACTION))).toBe(false);
  });

  it("gates the read address on the Channel, and stops listening there", () => {
    const { c, ch, lock, folded } = locked();
    const view = channelsView(heldCommunity(c), folded).find((v) => v.idHex === ch)!;
    expect(view.locked).toBe(true);
    expect(view.readGate!.quiet(lock + LEDGER_SKEW_MS)).toBe(true);
    expect(view.readGate!.quiet(lock + LEDGER_SKEW_MS - 1)).toBe(false);
  });
});

describe("a seal page (CORD-03 §1)", () => {
  const id = (n: number) => n.toString(16).padStart(64, "0");

  it("runs newest first, holds one plane each, and round-trips", () => {
    const pages = paginate(Array.from({ length: MAX_SEAL_IDS * 2 + 5 }, (_, n) => ({ id: id(n), at: 1_000 + n, plane: 1 })));
    expect(pages.map((p) => p.page.ids.length)).toEqual([MAX_SEAL_IDS, MAX_SEAL_IDS, 5]);
    expect(pages[0].page.oldest > pages[1].page.newest).toBe(true);
    const linked = { ...pages[2].page, next: { id: id(7), read: 4 } };
    expect(parseSealPage(sealPageContent(linked))).toEqual(linked);
    const split = paginate([{ id: id(1), at: 50, plane: 2 }, { id: id(2), at: 40, plane: 2 }, { id: id(3), at: 30, plane: 1 }]);
    expect(split.map((p) => [p.page.ids.length, p.plane])).toEqual([[2, 2], [1, 1]]);
  });

  it("refuses a malformed page", () => {
    const good = sealPageContent({ ids: [id(1)], oldest: 5, newest: 5 });
    for (const bad of [good.replace('"ids":"', '"ids":"0'), good.replace("[5,5]", "[6,5]"), good.replace('"next":null', '"next":["zz",1]'), JSON.stringify({ ids: "00".repeat(32 * (MAX_SEAL_IDS + 1)), range: [1, 2], next: null })]) {
      expect(parseSealPage(bad)).toBeUndefined();
    }
  });

  it("fits a relay event when full, and opens only as the page named, on its plane, in its Channel", async () => {
    const ch = "07".repeat(32);
    const group = channelGroupKey(new Uint8Array(32).fill(1), hexToBytes(ch), 1);
    const page = { ids: Array.from({ length: MAX_SEAL_IDS }, (_, n) => id(n + 0x8000)), oldest: 2 ** 40, newest: 2 ** 41, next: { id: id(0xff), read: 2 ** 31 } };
    const wrap = await sealPageWrap(page, ch, 1n, group, 2 ** 41);
    expect(JSON.stringify(wrap).length).toBeLessThanOrEqual(65_536);
    const other = channelGroupKey(new Uint8Array(32).fill(2), hexToBytes(ch), 1);
    expect(openSealPage(wrap, wrap.id, ch, 1n, { pk: group.pk, convKey: other.convKey })).toBeUndefined();
    expect(openSealPage(wrap, wrap.id, ch, 1n, other)).toBeUndefined();
    expect(openSealPage(wrap, wrap.id, ch, 1n, group)).toEqual(page);
    expect(openSealPage(wrap, id(0), ch, 1n, group)).toBeUndefined();
    expect(openSealPage(wrap, wrap.id, "08".repeat(32), 1n, group)).toBeUndefined();
    expect(openSealPage(wrap, wrap.id, ch, 2n, group)).toBeUndefined();
    expect(openSealPage({ ...wrap, id: id(1) }, id(1), ch, 1n, group)).toBeUndefined();
  });
});

describe("a sealed lock (CORD-03 §1)", () => {
  it("reads its history by id, so nothing backdated into it after the seal is read", async () => {
    const owner = signer();
    const { c, ch, id, lock, folded, fold } = locked(owner.pubkey);
    const root = random32();
    const community = heldCommunity(c, [], root);
    const read = channelGroupKey(root, id, 0);
    const relay = new MemoryRelay();
    const total = MAX_SEAL_IDS + 20;
    const start = lock - (total + 10) * SEC;
    for (let i = 0; i < total; i++) {
      const w = await chatWrap(owner, ch, read, start + i * SEC, `m${i}`);
      relay.events.set(w.id, w);
    }
    const channel = channelsView(community, folded).find((v) => v.idHex === ch)!;
    let sealed: SealRef | undefined;
    const added = await sealHistory({
      nostr: relay as never,
      community,
      folded,
      channel,
      history: new Map(),
      nowMs: lock,
      signal: new AbortController().signal,
      publish: async (s) => {
        sealed = s;
        return true;
      },
    });
    expect(added).toBe(total);
    expect(sealed).toMatchObject({ until: lock, run: lock, count: total, read: 0 });

    // Anyone with the read key dates junk into the sealed past, after the seal was made.
    const stranger = signer();
    for (const [i, at] of [start - 5 * SEC, start + 1_500, start + (total / 2) * SEC + 500].entries()) {
      const w = await chatWrap(stranger, ch, read, at, `junk${i}`);
      relay.events.set(w.id, w);
    }
    const sealedView: Channel = channelsView(community, fold([{ at: lock + SEC, sealed: total }], sealed)).find((v) => v.idHex === ch)!;
    expect(sealedView.readGate?.seal?.page).toBe(sealed!.page);
    relay.asked = [];
    const got = await backfillStore(relay as never, ["wss://relay.test"], sealedView, new AbortController().signal, { until: Math.floor(lock / 1000) + 3600, maxPages: 40 });
    const texts = (await openChatBatch(got.events, sealedView, { remember: false })).map((m) => m.content);
    expect(texts.filter((t) => t.startsWith("junk"))).toEqual([]);
    expect(new Set(texts.filter((t) => t.startsWith("m"))).size).toBe(total);
    // The read address is never asked for anything the seal covers by date.
    const floor = Math.floor(sealed!.until / 1000);
    expect(relay.asked.filter((f) => f.authors?.includes(read.pk)).every((f) => (f.since ?? 0) >= floor)).toBe(true);
    // Nor does a live arrival dated there open, nor one in the quiet span, the owner's included.
    const live = [await chatWrap(stranger, ch, read, start + 2_500, "live"), await chatWrap(owner, ch, read, lock + 20 * MIN, "quiet")];
    expect(await openChatBatch(live, sealedView, { remember: false })).toEqual([]);
    // Signs and opens a few hundred real wraps.
  }, 60_000);
});
