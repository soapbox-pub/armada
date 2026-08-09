/**
 * Sybil flood against a public Concord channel — the threat, and what actually
 * blunts it.
 *
 * The property this file establishes first is a NEGATIVE one, because every
 * mitigation below is judged against it: chat write access is key possession
 * and nothing else (CORD-04 §1). A public community's invite link is
 * unlimited-use and carries the `community_root`, so `channelGroupKey` is
 * available to anyone who ever opened the link. An attacker mints keypairs for
 * free, seals under their own real key (which proves authorship, not
 * entitlement), wraps under the channel key, and every honest client decodes
 * and renders the result. `openOne` refuses splices and forged ids; it has no
 * opinion on WHO.
 *
 * That leaves the receiver as the only place a defense can live, so the
 * candidates here are pure functions over an already-opened batch. They are
 * deliberately NOT in `src/` yet — this file exists to measure them (spam
 * caught vs. honest messages harmed) before any of them earns a place on the
 * read path. Each returns rumor ids to QUARANTINE, never to drop: the fold's
 * only author-identity drop is the Banlist, and a heuristic must not quietly
 * become the second one.
 *
 * The content signals model attack shapes that have actually been observed on
 * open, membership-free public channels rather than imagined ones — the
 * nonce-suffix template below is a real campaign, and the false-positive corpus
 * the shape score is held back by is drawn from the same traffic. The framing
 * is deliberately different, though: with no membership at all such a channel
 * can only score content, and pays for it in hand-tuned regexes. Here the
 * author being unknown is a real signal, so content only ever breaks a tie.
 *
 * Read `an adaptive attacker` before building on any of this. Every membership
 * signal keys on the author being UNKNOWN, and an attacker who warms their keys
 * first is known — so these bound the cost of a naive flood and buy time, and
 * none of them is a defense against someone who has read them.
 */

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { foldTimeline, openChatBatch, type OpenedChat } from "@/concord/lib/chat";
import { channelWriteGroup, mintCommunity } from "@/concord/lib/community";
import {
  bytesToHex,
  channelGroupKey,
  random32,
  voiceGroupKey,
  voiceMediaKey,
} from "@/concord/lib/derive";
import { FLOOD_ECHO_MIN, floodClusters, shapeKey } from "@/concord/lib/floodCluster";
import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { Channel } from "@/concord/lib/types";

// ── Harness ──────────────────────────────────────────────────────────────────

interface Signer {
  sk: Uint8Array;
  pubkey: string;
}

function member(): Signer {
  const sk = generateSecretKey();
  return { sk, pubkey: getPublicKey(sk) };
}

/** A public channel: its stream derives from the community_root every member holds. */
function publicChannel(root: Uint8Array, epoch = 0n): Channel {
  const id = random32();
  const group = channelGroupKey(root, id, epoch);
  return {
    id,
    idHex: bytesToHex(id),
    name: "general",
    isPrivate: false,
    isAnnouncement: false,
    get voice() {
      return { room: voiceGroupKey(root, id, epoch), mediaKey: voiceMediaKey(root, id, epoch) };
    },
    streams: [{ epoch, group }],
    current: { epoch, group },
  };
}

/**
 * Publish as `who`. Note what this function does NOT need: a Join, a Grant, a
 * roster entry, or any relationship to the community beyond `channel`, whose
 * key came out of the invite bundle. That is the whole attack.
 */
async function post(who: Signer, channel: Channel, content: string, ms: number): Promise<NostrEvent> {
  const rumor = buildRumor({
    kind: KIND_MESSAGE,
    content,
    pubkey: who.pubkey,
    ms,
    tags: channelBindingTags(channel.idHex, channel.current.epoch),
  });
  const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channelWriteGroup(channel), {
    signEvent: async (t: EventTemplate) => finalizeEvent(t, who.sk),
  });
  return wrapSeal(seal, channelWriteGroup(channel));
}

// ── The corpus ───────────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000;
const HONEST_MEMBERS = 12;
const MSGS_EACH = 3;
const SYBILS = 60;
/** The flood lands inside this window, well after the honest backlog. */
const FLOOD_START = T0 + 800_000;
const FLOOD_SPAN_MS = 30_000;
const BURST = { windowMs: 300_000, distinctAuthors: 20 };
const ECHO = { distinctAuthors: 5 };

/** Inside the window that still sees the flood — see the "refractory tail" test. */
const JOINER_IN_TAIL = FLOOD_START + FLOOD_SPAN_MS + 120_000;
/** Far enough out that no window holds both them and 20 sybils. */
const JOINER_AFTER_TAIL = FLOOD_START + 600_000;

/** Realistic backlog: several phrasings, so ordinary chat forms no one bucket. */
const CHATTER = [
  "anyone got the link to the notes?",
  "just pushed the fix, should be live shortly",
  "morning all",
  "that worked, thanks",
  "I'll take a look after lunch",
  "did the build go green?",
];

interface Corpus {
  events: OpenedChat[];
  /** Authors with prior local history — what a client already knew before this batch. */
  known: Set<string>;
  /** The regulars all saying one identical thing, when `regularsEcho` is set. */
  echoIds: string[];
  honestIds: string[];
  sybilIds: string[];
  sybilAuthors: string[];
  /** A real person's genuine first message. The false-positive canary. */
  joinerId: string;
}

async function buildCorpus(opts: {
  payload: (i: number) => string;
  joinerMs: number;
  /** How the flood is SHAPED. A patient sybil is many keys × 1; a mindless bot
   *  is 1 key × many; a small botnet sits between. The signals that catch each
   *  are different, which is the whole reason this is a parameter. */
  floodAuthors?: number;
  msgsPerAuthor?: number;
  /** Every regular also posts this, after their ordinary chatter. */
  regularsEcho?: { content: string; ms: number };
}): Promise<Corpus> {
  const floodAuthors = opts.floodAuthors ?? SYBILS;
  const msgsPerAuthor = opts.msgsPerAuthor ?? 1;
  const owner = member();
  const { community } = mintCommunity("Test Fleet", owner.pubkey, []);
  const channel = publicChannel(community.root);

  const regulars = Array.from({ length: HONEST_MEMBERS }, () => member());
  const joiner = member();
  const sybils = Array.from({ length: floodAuthors }, () => member());

  const honest: Promise<NostrEvent>[] = [];
  for (let i = 0; i < MSGS_EACH; i++) {
    for (let m = 0; m < regulars.length; m++) {
      const n = i * regulars.length + m;
      honest.push(post(regulars[m], channel, CHATTER[n % CHATTER.length], T0 + n * 20_000));
    }
  }
  // Optionally, every regular then says the SAME thing — the hardest honest
  // case for a content bucket, and the one their history has to carry.
  const echo = opts.regularsEcho;
  const echoed = echo
    ? regulars.map((r, m) => post(r, channel, echo.content, echo.ms + m * 1000))
    : [];

  const total = floodAuthors * msgsPerAuthor;
  const flood = Array.from({ length: total }, (_, i) =>
    post(
      sybils[i % floodAuthors],
      channel,
      opts.payload(i),
      FLOOD_START + Math.floor((i * FLOOD_SPAN_MS) / total),
    ),
  );

  const joinerWrap = post(joiner, channel, "hi everyone, just joined", opts.joinerMs);

  const [honestWraps, echoWraps, floodWraps, joined] = await Promise.all([
    Promise.all(honest),
    Promise.all(echoed),
    Promise.all(flood),
    joinerWrap,
  ]);

  const events = await openChatBatch(
    [...honestWraps, ...echoWraps, ...floodWraps, joined],
    channel,
  );
  const byWrap = new Map(events.map((e) => [e.wrapId, e]));

  return {
    events,
    known: new Set(regulars.map((r) => r.pubkey)),
    echoIds: echoWraps.map((w) => byWrap.get(w.id)!.rumorId),
    honestIds: honestWraps.map((w) => byWrap.get(w.id)!.rumorId),
    sybilIds: floodWraps.map((w) => byWrap.get(w.id)!.rumorId),
    sybilAuthors: sybils.map((s) => s.pubkey),
    joinerId: byWrap.get(joined.id)!.rumorId,
  };
}

const SPAM_PAYLOAD = "🚀 FREE AIRDROP — claim now at https://free-airdrop.xyz";

/**
 * A per-message random suffix, the anti-dedup nonce from the "SANTA CLAUS"
 * campaign observed on open public channels. Its whole purpose is to make every
 * copy of one broadcast a distinct string.
 */
function nonce(i: number): string {
  return (i * 2_654_435_761 % 2_176_782_336).toString(36).padStart(6, "0").slice(0, 6);
}

/** Memoized — signing ~100 events is the expensive part, and every candidate
 *  should be judged against the identical batch anyway. */
function memo(build: () => Promise<Corpus>): () => Promise<Corpus> {
  let p: Promise<Corpus> | undefined;
  return () => (p ??= build());
}

/** One payload, 60 fresh keys, 30 seconds. The naive flood. */
const identicalFlood = memo(() =>
  buildCorpus({ payload: () => SPAM_PAYLOAD, joinerMs: JOINER_AFTER_TAIL }),
);
/** Same, but a real person speaks up shortly after it ends. */
const floodThenJoiner = memo(() =>
  buildCorpus({ payload: () => SPAM_PAYLOAD, joinerMs: JOINER_IN_TAIL }),
);
/** A payload varied per key, defeating any content signal. */
const variedFlood = memo(() =>
  buildCorpus({ payload: (i) => `hey check out my page ${i} <link${i}>`, joinerMs: JOINER_AFTER_TAIL }),
);
/** One broadcast wearing 60 different suffixes — the real observed shape. */
const nonceFlood = memo(() =>
  buildCorpus({
    payload: (i) => `SANTA CLAUS WAS>SANTA CLAUS 2025! ${nonce(i)}`,
    joinerMs: JOINER_AFTER_TAIL,
  }),
);
/**
 * NOT an attack: a link gets posted somewhere popular and 60 real people
 * arrive at once, all saying the same unremarkable thing. Identical to a flood
 * in every structural signal available to the client — which is the point.
 */
const newcomerWave = memo(() =>
  buildCorpus({ payload: () => "gm", joinerMs: JOINER_AFTER_TAIL }),
);

/** Established members all saying one identical thing, alongside a real flood. */
const regularsEcho = memo(() =>
  buildCorpus({
    payload: () => SPAM_PAYLOAD,
    joinerMs: JOINER_AFTER_TAIL,
    regularsEcho: { content: "gm", ms: T0 + 700_000 },
  }),
);

/** Total messages in the two hammer shapes, so they are comparable. */
const HAMMER = 100;
/** One key, hammering. The actually-common mindless bot. */
const singleHammer = memo(() =>
  buildCorpus({
    payload: () => SPAM_PAYLOAD,
    joinerMs: JOINER_AFTER_TAIL,
    floodAuthors: 1,
    msgsPerAuthor: HAMMER,
  }),
);
/** Five keys sharing the load — under any per-author budget worth setting. */
const smallBotnet = memo(() =>
  buildCorpus({
    payload: () => SPAM_PAYLOAD,
    joinerMs: JOINER_AFTER_TAIL,
    floodAuthors: 5,
    msgsPerAuthor: HAMMER / 5,
  }),
);

const NO_MODERATION = { banned: new Set<string>(), canDelete: () => false };

// ── Candidate mitigations ────────────────────────────────────────────────────

/**
 * A receive-side mirror of `sendRateLimit`'s token bucket, per author.
 * Included to be disproved: it is the obvious first idea and it does nothing
 * here, because a bucket keyed on identity costs an attacker one
 * `generateSecretKey`.
 */
function perAuthorBudget(events: OpenedChat[], opts: { burst: number; refillMs: number }): Set<string> {
  const flagged = new Set<string>();
  const state = new Map<string, { tokens: number; last: number }>();
  for (const ev of [...events].sort((a, b) => a.ms - b.ms)) {
    const s = state.get(ev.author) ?? { tokens: opts.burst, last: ev.ms };
    s.tokens = Math.min(opts.burst, s.tokens + (ev.ms - s.last) / opts.refillMs);
    s.last = ev.ms;
    if (s.tokens < 1) flagged.add(ev.rumorId);
    else s.tokens -= 1;
    state.set(ev.author, s);
  }
  return flagged;
}

/**
 * Budget the CLASS of authors this client has never seen, not each author —
 * the same shape `auditLog.hasBurst` already applies to unrecognised control
 * editions. Minting more keys cannot escape it, because minting more keys is
 * precisely the trigger. Members with prior history are never touched,
 * whatever their volume.
 */
function newcomerBurst(
  events: OpenedChat[],
  known: ReadonlySet<string>,
  opts: { windowMs: number; distinctAuthors: number },
): Set<string> {
  const unknown = events.filter((e) => !known.has(e.author)).sort((a, b) => a.ms - b.ms);
  const flagged = new Set<string>();
  const counts = new Map<string, number>();
  let lo = 0;
  for (let hi = 0; hi < unknown.length; hi++) {
    counts.set(unknown[hi].author, (counts.get(unknown[hi].author) ?? 0) + 1);
    while (unknown[hi].ms - unknown[lo].ms > opts.windowMs) {
      const a = unknown[lo].author;
      const n = (counts.get(a) ?? 0) - 1;
      if (n <= 0) counts.delete(a);
      else counts.set(a, n);
      lo++;
    }
    if (counts.size >= opts.distinctAuthors) {
      for (let i = lo; i <= hi; i++) flagged.add(unknown[i].rumorId);
    }
  }
  return flagged;
}

function normalizeContent(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One payload, many brand-new authors. Restricted to unknown authors on
 * purpose: "gm" from twenty regulars is a morning; from twenty keys nobody has
 * ever seen, it is a flood.
 */
function contentEcho(
  events: OpenedChat[],
  known: ReadonlySet<string>,
  opts: { distinctAuthors: number },
): Set<string> {
  const byContent = new Map<string, OpenedChat[]>();
  for (const ev of events) {
    if (known.has(ev.author)) continue;
    const key = normalizeContent(ev.content);
    if (!key) continue;
    let list = byContent.get(key);
    if (!list) byContent.set(key, (list = []));
    list.push(ev);
  }
  const flagged = new Set<string>();
  for (const list of byContent.values()) {
    if (new Set(list.map((e) => e.author)).size >= opts.distinctAuthors) {
      for (const ev of list) flagged.add(ev.rumorId);
    }
  }
  return flagged;
}

/** `shapeKey` is the shipped one — the harness must measure what ships. */
function templateEcho(
  events: OpenedChat[],
  known: ReadonlySet<string>,
  opts: { distinctAuthors: number },
): Set<string> {
  const byShape = new Map<string, OpenedChat[]>();
  for (const ev of events) {
    if (known.has(ev.author)) continue;
    const key = shapeKey(ev.content);
    if (!key) continue;
    let list = byShape.get(key);
    if (!list) byShape.set(key, (list = []));
    list.push(ev);
  }
  const flagged = new Set<string>();
  for (const list of byShape.values()) {
    if (new Set(list.map((e) => e.author)).size >= opts.distinctAuthors) {
      for (const ev of list) flagged.add(ev.rumorId);
    }
  }
  return flagged;
}

const LINK = /(https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|xyz|top|ru|app|link|me)\b)/i;

/**
 * Membership-free structural spamminess, at weights and a threshold taken from
 * a content-only filter tuned against real public traffic. Only the signals
 * whose false-positive behaviour is already settled are carried over; a
 * spam-KEYWORD list is deliberately absent, having been tried and walked back
 * there — "FREE!" and "WIN!" are things people say.
 *
 * This is the only signal here that survives an attacker with warmed keys, so
 * it is worth having even though it is the weakest.
 */
function shapeScore(content: string): number {
  const s = content.trim();
  let n = 0;
  const alnum = (s.match(/[a-z0-9]/gi) ?? []).length;
  if (s.length > 3 && alnum / s.length < 0.15) n += 3; // ";  ;  ;  ;  ;"
  if (/^(.)\1{6,}$/.test(s)) n += 3; // "!!!!!!!!"
  if (/(.{3,})\1{2,}/.test(s.toLowerCase())) n += 3; // "buy nowbuy nowbuy now"
  if (s.length > 10 && s === s.toUpperCase() && /[A-Z]/.test(s)) n += 2;
  if (/[!?.]{6,}/.test(s)) n += 2;
  // The nonce-suffix templates, in the form the observed campaigns take.
  if (/>.*!\s*[a-z0-9]{4,9}$/i.test(s) || /[A-Z\s]+!\s*[a-z0-9]{4,9}$/i.test(s)) n += 3;
  return n;
}

/** Confident enough to act on content alone, with no membership signal at all. */
const SHAPE_ALONE = 5;
/** Corroborating weight, once a burst and an echo already agree. */
const SHAPE_CORROBORATING = 3;

type Verdict = "allow" | "collapse" | "spam";

/**
 * The composite the other functions exist to feed. Two tiers, because the
 * interesting case is not spam-vs-ham but SPAM vs A CROWD: 60 strangers
 * arriving at once and all saying the same thing is a flood or a welcome wave,
 * and no timing or repetition signal can tell those apart — only what was
 * actually said can.
 */
function classify(
  events: OpenedChat[],
  known: ReadonlySet<string>,
  opts: { burst: { windowMs: number; distinctAuthors: number }; echo: { distinctAuthors: number } },
): Map<string, Verdict> {
  const burst = newcomerBurst(events, known, opts.burst);
  const echo = templateEcho(events, known, opts.echo);
  const out = new Map<string, Verdict>();
  for (const ev of events) {
    const shape = shapeScore(ev.content);
    const clustered = burst.has(ev.rumorId) && echo.has(ev.rumorId);
    if (clustered && (shape >= SHAPE_CORROBORATING || LINK.test(ev.content))) out.set(ev.rumorId, "spam");
    else if (shape >= SHAPE_ALONE) out.set(ev.rumorId, "spam");
    else if (clustered) out.set(ev.rumorId, "collapse");
    else out.set(ev.rumorId, "allow");
  }
  return out;
}


function tally(v: Map<string, Verdict>, ids: readonly string[]) {
  const counts = { allow: 0, collapse: 0, spam: 0 };
  for (const id of ids) counts[v.get(id) ?? "allow"]++;
  return counts;
}

function score(flagged: ReadonlySet<string>, c: Corpus) {
  return {
    sybils: c.sybilIds.filter((id) => flagged.has(id)).length,
    honest: c.honestIds.filter((id) => flagged.has(id)).length,
    joiner: flagged.has(c.joinerId),
  };
}

// ── 1. The vulnerability ─────────────────────────────────────────────────────

describe("a sybil flood on a public channel", () => {
  it("passes every gate the read path has", async () => {
    const c = await identicalFlood();

    // Not one was rejected by openOne: the seals verify, the bindings match,
    // the epoch is live. These events are exactly as authentic as the regulars'.
    expect(c.sybilIds).toHaveLength(SYBILS);
    expect(new Set(c.sybilAuthors).size).toBe(SYBILS);

    const folded = foldTimeline(c.events, NO_MODERATION);
    expect(folded.messages).toHaveLength(HONEST_MEMBERS * MSGS_EACH + SYBILS + 1);
    // The flood is the majority of the visible channel.
    const spam = folded.messages.filter((m) => c.sybilIds.includes(m.rumorId));
    expect(spam.length / folded.messages.length).toBeGreaterThan(0.5);
  });

  it("is untouched by the send-side rate limiter", async () => {
    // `sendRateLimit` is not imported by this file, and could not have been
    // consulted: it guards `useSendMessage`, which an attacker simply does not
    // call. Nothing between the wire and the fold asks it anything.
    const c = await identicalFlood();
    expect(foldTimeline(c.events, NO_MODERATION).messages).toHaveLength(
      HONEST_MEMBERS * MSGS_EACH + SYBILS + 1,
    );
  });

  it("costs one ban per message to clean up by hand", async () => {
    const c = await identicalFlood();
    const base = foldTimeline(c.events, NO_MODERATION).messages.length;

    // Banning the loudest account removes exactly its own message. The Banlist
    // is per-npub and the attacker's npubs are free, so the honest side pays a
    // Control edition per unit of attacker entropy.
    const one = foldTimeline(c.events, { ...NO_MODERATION, banned: new Set([c.sybilAuthors[0]]) });
    expect(one.messages).toHaveLength(base - 1);

    // Only banning all 60 clears it.
    const all = foldTimeline(c.events, { ...NO_MODERATION, banned: new Set(c.sybilAuthors) });
    expect(all.messages).toHaveLength(HONEST_MEMBERS * MSGS_EACH + 1);
  });
});

// ── 2. Candidate mitigations ─────────────────────────────────────────────────

describe("per-author budget (the obvious idea)", () => {
  it("catches nothing, because each sybil sends exactly once", async () => {
    const c = await identicalFlood();
    // Same parameters as the send-side limiter.
    const s = score(perAuthorBudget(c.events, { burst: 5, refillMs: 3000 }), c);
    expect(s.sybils).toBe(0);
    expect(s.honest).toBe(0);
    expect(s.joiner).toBe(false);
  });
});

describe("newcomer burst", () => {
  it("quarantines the whole flood and no established member", async () => {
    const c = await identicalFlood();
    const s = score(newcomerBurst(c.events, c.known, BURST), c);
    expect(s.sybils).toBe(SYBILS);
    expect(s.honest).toBe(0);
    expect(s.joiner).toBe(false);
  });

  it("still catches a flood whose payload is varied per key", async () => {
    // Content heuristics degrade here; a class budget does not care what was said.
    const c = await variedFlood();
    const s = score(newcomerBurst(c.events, c.known, BURST), c);
    expect(s.sybils).toBe(SYBILS);
    expect(s.honest).toBe(0);
    expect(score(contentEcho(c.events, c.known, ECHO), c).sybils).toBe(0);
  });

  it("does not fire on organic growth (a few newcomers, spread out)", async () => {
    const c = await identicalFlood();
    const organic = c.events.filter((e) => !c.sybilIds.includes(e.rumorId));
    const s = score(newcomerBurst(organic, c.known, BURST), { ...c, sybilIds: [] });
    expect(s.sybils).toBe(0);
    expect(s.honest).toBe(0);
    expect(s.joiner).toBe(false);
  });

  it("has a refractory tail: it quarantines real arrivals for a full window after the flood", async () => {
    // The headline cost, and it is not obvious from the parameters. The verdict
    // is a property of the WINDOW, not of the message: any window holding both
    // the newcomer and 20 sybils condemns the newcomer, so a genuine arrival is
    // swept up for `windowMs` AFTER the last spam message — five minutes here.
    // By arrival time alone there is nothing to tell them apart; they really do
    // look like sybil #61.
    //
    // This is the argument for a collapsed, expandable section rather than a
    // drop, and for tuning `windowMs` as a blackout duration rather than as a
    // detection window.
    const tail = await floodThenJoiner();
    expect(JOINER_IN_TAIL - (FLOOD_START + FLOOD_SPAN_MS)).toBeLessThan(BURST.windowMs);
    expect(score(newcomerBurst(tail.events, tail.known, BURST), tail).joiner).toBe(true);

    // Past the tail, the same person is untouched.
    const clear = await identicalFlood();
    expect(JOINER_AFTER_TAIL - FLOOD_START).toBeGreaterThan(BURST.windowMs);
    expect(score(newcomerBurst(clear.events, clear.known, BURST), clear).joiner).toBe(false);
  });

  it("content distinctness exonerates the newcomer caught in the tail", async () => {
    // A cheap release valve for the cost above: the newcomer is in the window
    // but shares no payload with the burst, so the intersection of the two
    // signals clears them while still condemning all 60.
    const c = await floodThenJoiner();
    const both = new Set(
      [...newcomerBurst(c.events, c.known, BURST)].filter((id) =>
        contentEcho(c.events, c.known, ECHO).has(id),
      ),
    );
    const s = score(both, c);
    expect(s.sybils).toBe(SYBILS);
    expect(s.joiner).toBe(false);
    expect(s.honest).toBe(0);
  });
});

describe("content echo", () => {
  it("catches a single-payload flood with no time signal at all", async () => {
    const c = await identicalFlood();
    const s = score(contentEcho(c.events, c.known, ECHO), c);
    expect(s.sybils).toBe(SYBILS);
    expect(s.honest).toBe(0);
    expect(s.joiner).toBe(false);
  });

  it("catches a slow drip the burst window would miss", async () => {
    // The same payload spread over hours: no window sees 20 new authors.
    const c = await identicalFlood();
    const dripped = c.events.map((ev, i) =>
      c.sybilIds.includes(ev.rumorId) ? { ...ev, ms: FLOOD_START + i * 240_000 } : ev,
    );
    expect(score(newcomerBurst(dripped, c.known, BURST), c).sybils).toBe(0);
    expect(score(contentEcho(dripped, c.known, ECHO), c).sybils).toBe(SYBILS);
  });
});

describe("the nonce-suffix template (the shape actually seen in the wild)", () => {
  it("walks straight through exact content matching", async () => {
    // 60 copies of one broadcast, each with its own random suffix. Every pair
    // differs, so byte-equality — and the whole family of dedup filters built
    // on it — sees 60 unrelated messages.
    const c = await nonceFlood();
    expect(score(contentEcho(c.events, c.known, ECHO), c).sybils).toBe(0);
  });

  it("collapses under a template fingerprint", async () => {
    const c = await nonceFlood();
    const s = score(templateEcho(c.events, c.known, ECHO), c);
    expect(s.sybils).toBe(SYBILS);
    expect(s.honest).toBe(0);
    expect(s.joiner).toBe(false);
  });

  it("subsumes exact matching, and also catches the varied-payload flood", async () => {
    // A strictly better bucket key: identical content has an identical shape,
    // and `hey check out my page 7 <link7>` collapses too — which plain
    // `contentEcho` could not do.
    const identical = await identicalFlood();
    expect(score(templateEcho(identical.events, identical.known, ECHO), identical).sybils).toBe(SYBILS);

    const varied = await variedFlood();
    const s = score(templateEcho(varied.events, varied.known, ECHO), varied);
    expect(s.sybils).toBe(SYBILS);
    expect(s.honest).toBe(0);
  });
});

describe("structural shape score", () => {
  it("fires on the shapes with no legitimate use", () => {
    expect(shapeScore("; ; ; ; ; ; ; ; ;")).toBeGreaterThanOrEqual(SHAPE_ALONE);
    expect(shapeScore(";;;;;;;;;")).toBeGreaterThanOrEqual(SHAPE_ALONE);
    expect(shapeScore("!!!!!!!!!!")).toBeGreaterThanOrEqual(SHAPE_ALONE);
    expect(shapeScore("SANTA CLAUS WAS>SANTA CLAUS 2025! 2zs5g9")).toBeGreaterThanOrEqual(
      SHAPE_CORROBORATING,
    );
  });

  it("leaves ordinary chat alone", () => {
    // The negatives matter more than the positives here: these are the cases a
    // content-only filter had to be tuned back against. The reference/ID ones
    // are why the template rules require delimiter scaffolding instead of just
    // "ends in a random-looking token".
    for (const ok of [
      "hello there",
      "How are you doing today?",
      "Check out this cool thing I found!",
      "Meeting at 3pm > conference room",
      "Error code: 404",
      "Reference: def456",
      "Order ref: ABC1234",
      "My meeting ID is abc123",
      "Your PIN is: 1234",
      "HELLO! How are you?",
      "I have 2 cats and 3 dogs",
      "gm",
      "a b c d e f g",
      "hi !!!",
    ]) {
      expect(shapeScore(ok), ok).toBeLessThan(SHAPE_CORROBORATING);
    }
  });

  it("does not fire on the honest backlog or the joiner", async () => {
    const c = await identicalFlood();
    for (const ev of c.events) {
      if (c.sybilIds.includes(ev.rumorId)) continue;
      expect(shapeScore(ev.content), ev.content).toBeLessThan(SHAPE_CORROBORATING);
    }
  });
});

// ── 3. The composite ─────────────────────────────────────────────────────────

describe("classify", () => {
  const OPTS = { burst: BURST, echo: ECHO };

  it("calls the airdrop flood spam and leaves the regulars alone", async () => {
    const c = await identicalFlood();
    const v = classify(c.events, c.known, OPTS);
    expect(tally(v, c.sybilIds)).toEqual({ allow: 0, collapse: 0, spam: SYBILS });
    expect(tally(v, c.honestIds)).toEqual({ allow: HONEST_MEMBERS * MSGS_EACH, collapse: 0, spam: 0 });
    expect(v.get(c.joinerId)).toBe("allow");
  });

  it("calls the nonce-template campaign spam", async () => {
    const c = await nonceFlood();
    expect(tally(classify(c.events, c.known, OPTS), c.sybilIds)).toEqual({
      allow: 0,
      collapse: 0,
      spam: SYBILS,
    });
  });

  it("COLLAPSES a wave of real newcomers rather than calling them spam", async () => {
    // The discrimination the second tier exists for. 60 strangers all saying
    // "gm" inside 30 seconds trips the burst and the echo exactly as hard as
    // the flood does — timing and repetition genuinely cannot separate them.
    // What separates them is that one of the two is selling something.
    const c = await newcomerWave();
    expect(tally(classify(c.events, c.known, OPTS), c.sybilIds)).toEqual({
      allow: 0,
      collapse: SYBILS,
      spam: 0,
    });
  });

  it("catches a warmed-key attacker when the content is structurally bad", async () => {
    // The membership signals are gone (see below), but the shape score never
    // needed them: it acts on content alone at a deliberately higher bar.
    const c = await identicalFlood();
    const junk = c.events.map((ev) =>
      c.sybilIds.includes(ev.rumorId) ? { ...ev, content: ";;;;;;;;;;;;" } : ev,
    );
    const v = classify(junk, new Set([...c.known, ...c.sybilAuthors]), OPTS);
    expect(tally(v, c.sybilIds)).toEqual({ allow: 0, collapse: 0, spam: SYBILS });
  });
});

// ── 4. The render-layer rule ─────────────────────────────────────────────────

/**
 * The corpora below are SIGNED — every message is a real seal + wrap — so each
 * test spends a second or two in secp256k1 before the rule under test runs at
 * all (the rule itself is ~1ms on these sets). That sits far enough under the
 * 5s default to pass alone and close enough to it to time out under a full
 * suite's CPU contention, which is a flake about the harness rather than
 * anything about flood detection.
 */
describe("floodClusters — the shape a timeline would actually collapse", { timeout: 30_000 }, () => {
  /** The shipped rule reads a ms-ordered timeline, as `foldTimeline` returns. */
  const timeline = (c: Corpus) => [...c.events].sort((a, b) => a.ms - b.ms);
  const run = (c: Corpus) => score(floodClusters(timeline(c)), c);

  it("collapses one key hammering", async () => {
    // The common case, and the one the sybil-shaped corpus above misses
    // entirely: 100 messages, one author, one template.
    const c = await singleHammer();
    expect(c.sybilIds).toHaveLength(HAMMER);
    expect(c.sybilAuthors).toHaveLength(1);
    expect(run(c)).toEqual({ sybils: HAMMER, honest: 0, joiner: false });
  });

  it("collapses a five-key botnet splitting the load", async () => {
    // 20 messages each — under any per-author budget anyone would actually set,
    // which is exactly why the trigger has to be the content bucket.
    const c = await smallBotnet();
    expect(c.sybilAuthors).toHaveLength(5);
    expect(run(c)).toEqual({ sybils: HAMMER, honest: 0, joiner: false });
  });

  it("collapses the many-key sybil flood with the same rule", async () => {
    expect(run(await identicalFlood())).toEqual({ sybils: SYBILS, honest: 0, joiner: false });
  });

  it("collapses the nonce-template campaign and the varied-payload flood", async () => {
    expect(run(await nonceFlood()).sybils).toBe(SYBILS);
    expect(run(await variedFlood()).sybils).toBe(SYBILS);
  });

  it("collapses a newcomer wave too — it is a visual flood either way", async () => {
    // Not a false positive at this layer. 60 strangers saying "gm" in half a
    // minute is exactly the wall of noise the row exists to fold up, and
    // folding it is friendlier than either dropping it or scrolling it.
    expect(run(await newcomerWave()).sybils).toBe(SYBILS);
  });

  it("leaves regulars who all say the same thing alone", async () => {
    // The mirror image of the wave above, and the reason the rule asks WHO
    // rather than only how many: twelve identical messages, but from people who
    // were already talking before the window opened.
    const c = await regularsEcho();
    expect(c.echoIds).toHaveLength(HONEST_MEMBERS);
    expect(new Set(timeline(c).filter((e) => c.echoIds.includes(e.rumorId)).map((e) => shapeKey(e.content))).size).toBe(1);

    const flagged = floodClusters(timeline(c));
    expect(c.echoIds.filter((id) => flagged.has(id))).toEqual([]);
    // The flood in the same corpus still goes.
    expect(c.sybilIds.every((id) => flagged.has(id))).toBe(true);
  });

  it("catches a member with history who starts hammering", async () => {
    // Two-or-fewer authors is not about trust, it is about one voice repeating.
    // Here the hammer has been present since the start of the backlog, so the
    // stranger test exonerates them and the author count condemns them anyway.
    const c = await singleHammer();
    const hammer = c.sybilAuthors[0];
    const sorted = timeline(c);
    const withHistory = sorted.map((ev, i) => (i === 0 ? { ...ev, author: hammer } : ev));
    const flagged = floodClusters(withHistory);
    expect(c.sybilIds.filter((id) => flagged.has(id))).toHaveLength(HAMMER);
  });

  it("never fires below BOTH rules' minimums, however new the author", async () => {
    // Density needs FLOOD_MIN_MESSAGES in a window; the echo rule needs far
    // fewer (FLOOD_ECHO_MIN) but demands the pitch be spread across
    // FLOOD_ECHO_MIN_AUTHORS keys — so the floor is the smaller of the two,
    // and a handful of sybil messages is still just a handful.
    const c = await identicalFlood();
    const keep = new Set(c.sybilIds.slice(0, FLOOD_ECHO_MIN - 1));
    const short = timeline(c).filter((e) => !c.sybilIds.includes(e.rumorId) || keep.has(e.rumorId));
    expect(score(floodClusters(short), c).sybils).toBe(0);

    // One more copy, on a third key, is where the echo rule starts.
    const atEcho = new Set(c.sybilIds.slice(0, FLOOD_ECHO_MIN));
    const echo = timeline(c).filter((e) => !c.sybilIds.includes(e.rumorId) || atEcho.has(e.rumorId));
    expect(score(floodClusters(echo), c).sybils).toBe(FLOOD_ECHO_MIN);
  });

  it("ignores messages with nothing to repeat", async () => {
    // An attachment-only post is empty after shaping. Bucketing them together
    // would collapse a photo dump into "N similar messages" — so one author
    // posting sixty of them is left alone by every content rule.
    const c = await identicalFlood();
    const dump = timeline(c).map((ev) =>
      c.sybilIds.includes(ev.rumorId) ? { ...ev, content: "   ", author: c.sybilAuthors[0] } : ev,
    );
    expect(score(floodClusters(dump), c).sybils).toBe(0);

    // Sixty KEYS posting one blank message each in the same half minute is a
    // different fact about the world, and the arrival rule reads it without
    // looking at the content at all.
    const blanked = timeline(c).map((ev) =>
      c.sybilIds.includes(ev.rumorId) ? { ...ev, content: "   " } : ev,
    );
    expect(score(floodClusters(blanked), c).sybils).toBe(SYBILS);
  });
});

// ── 5. What none of it does ──────────────────────────────────────────────────

describe("an adaptive attacker", () => {
  it("disarms every membership signal by warming the keys first", async () => {
    // Burst and echo both key on the author being UNKNOWN. Nothing makes a key
    // expensive, so the attacker joins with 60 keys, has each say something
    // unremarkable a week early, and waits. By flood time every one of them has
    // local history on every client that was online — they are "known", and all
    // three budgets exempt them by construction.
    const c = await variedFlood();
    const warmed = new Set([...c.known, ...c.sybilAuthors]);

    expect(score(newcomerBurst(c.events, warmed, BURST), c).sybils).toBe(0);
    expect(score(contentEcho(c.events, warmed, ECHO), c).sybils).toBe(0);
    expect(score(templateEcho(c.events, warmed, ECHO), c).sybils).toBe(0);
    expect(score(perAuthorBudget(c.events, { burst: 5, refillMs: 3000 }), c).sybils).toBe(0);
  });

  it("is invisible once the payload also reads like a person wrote it", async () => {
    // Warmed keys plus prose leaves nothing on the table: the shape score is
    // the last signal standing and it only speaks to structure, which ordinary
    // sentences satisfy. This is the honest floor of receiver-side defence.
    const c = await variedFlood();
    const warmed = new Set([...c.known, ...c.sybilAuthors]);
    const v = classify(c.events, warmed, { burst: BURST, echo: ECHO });
    expect(tally(v, c.sybilIds)).toEqual({ allow: SYBILS, collapse: 0, spam: 0 });
  });

  it("can future-date the flood to pin it under every honest message", async () => {
    // `created_at` is chosen by the author and nothing on the read path bounds
    // it: `openOne` checks the binding and the retirement cutoff, `foldTimeline`
    // sorts by `ms`. So a flood dated an hour ahead sits at the newest end of
    // the timeline and stays there for an hour, below everything real.
    //
    // It also walks a sliding window that has no lower bound — the reason to
    // clamp against local time when scoring, and to clamp before sorting.
    const c = await identicalFlood();
    const future = c.events.map((ev) =>
      c.sybilIds.includes(ev.rumorId) ? { ...ev, ms: ev.ms + 3_600_000 } : ev,
    );
    const folded = foldTimeline(future, NO_MODERATION);
    const tail = folded.messages.slice(-SYBILS).map((m) => m.rumorId);
    expect(new Set(tail)).toEqual(new Set(c.sybilIds));

    // The content signals do not care about the clock, which is the argument
    // for not leaning on timing alone.
    expect(score(templateEcho(future, c.known, ECHO), c).sybils).toBe(SYBILS);
  });

  it("leaves the Banlist as the only remaining tool, at one edition per key", async () => {
    // Which is where this bottoms out: every receiver-side heuristic here
    // prices a flood in attacker PATIENCE, not in anything scarce. Making the
    // 61st key cost something (proof-of-work on the seal, or an invite-bound
    // credential the link cannot mint in bulk) is a protocol change, and it is
    // the only thing on this list that an adaptive attacker cannot simply wait
    // out. Closing the public link is the other answer, and the only one
    // available today.
    const c = await variedFlood();
    const folded = foldTimeline(c.events, { ...NO_MODERATION, banned: new Set(c.sybilAuthors) });
    expect(folded.messages).toHaveLength(HONEST_MEMBERS * MSGS_EACH + 1);
    expect(c.sybilAuthors).toHaveLength(SYBILS);
  });
});
