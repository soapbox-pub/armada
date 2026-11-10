/**
 * Visual flood suppression for the Chat Plane. Chat write access is key
 * possession (CORD-04 §1) and invite links are unlimited-use, so anyone can flood
 * a public channel. This only answers the RENDER question — which messages fold
 * into one expandable row. NOT a security boundary: nothing here drops a message
 * or feeds moderation; the Banlist remains the only author-identity drop.
 *
 * Shape rules bucket by CONTENT first (so 1×100 and 100×1 need one rule), with
 * near-duplicate clustering ({@link normalizeTokens}) because real campaigns
 * rotate templates. A message folds if ANY rule fires:
 *
 * 1. **Density** — one template {@link FLOOD_MIN_MESSAGES} times in
 *    {@link FLOOD_WINDOW_MS}, by ≤2 authors or all first-time authors.
 * 2. **Echo** — a substantial template {@link FLOOD_ECHO_MIN} times across
 *    ≥{@link FLOOD_ECHO_MIN_AUTHORS} keys in {@link FLOOD_ECHO_WINDOW_MS}.
 * 3. **Arrival burst** ({@link markArrivalBurst}) — many first-time keys at once.
 * 4. **Cohort** ({@link markCohortFlood}) — a crowd that arrived together and
 *    drowned the channel, content ignored.
 * 5. **Gibberish** ({@link markGibberish}) — one key posting low-originality noise.
 * 6. **Untrusted drown** ({@link markUntrustedDrown}) — keys the reader has no
 *    earned trust in ({@link computeTrusted}: reachable from the reader via
 *    replies/quotes/mentions) who together drown the channel. This closes the
 *    shape rules' arms race (established keys posting fluent, unique spam).
 *
 * Trusted authors (incl. self and staff) are exempt from every rule, so pasting a
 * regular's line folds only the spammer's copy.
 */

import type { OpenedChat } from "@/concord/lib/chat";
import { DEFAULT_FLOOD_POLICY, floodExempt, type FloodPolicy, type FloodSensitivity } from "@/concord/lib/floodPolicy";
import { KIND_COMMENT, KIND_MESSAGE, KIND_POLL } from "@/concord/lib/kinds";

export { DEFAULT_FLOOD_POLICY, floodExempt, floodPolicy, type FloodPolicy, type FloodSensitivity } from "@/concord/lib/floodPolicy";

/** Messages sharing a template within one window before it reads as a flood. */
export const FLOOD_MIN_MESSAGES = 8;
/** How close together those messages must fall. */
export const FLOOD_WINDOW_MS = 300_000;
/**
 * Above this author count, density requires ALL authors to be strangers (a dozen
 * regulars converging on a phrase is a conversation).
 */
export const FLOOD_MAX_FAMILIAR_AUTHORS = 2;
/**
 * Words a template needs for the ordinary density threshold; shorter ones need
 * {@link FLOOD_SHORT_FACTOR}× as many (a chorus of `gm` isn't a flood).
 */
export const FLOOD_MIN_WORDS = 2;
/** How much denser a sub-{@link FLOOD_MIN_WORDS} template must be to fold. */
export const FLOOD_SHORT_FACTOR = 3;

/** Copies of one substantial template, from ≥2 authors, before it reads as an echo. */
export const FLOOD_ECHO_MIN = 4;
/**
 * Distinct keys before a template reads as a campaign: one pitch across many keys
 * is what sybil sets are for; honest repetition doesn't do that.
 */
export const FLOOD_ECHO_MIN_AUTHORS = 3;
/** The echo rule's window — long, because a rotating campaign is not dense. */
export const FLOOD_ECHO_WINDOW_MS = 3_600_000;
/**
 * Words a template needs before the echo rule judges it — the rule's whole
 * safety. Measured: campaign templates ran 8-13 words; honest repeated phrases
 * are short. Placeholders (`@` URL, `#` number) don't count.
 */
export const FLOOD_ECHO_MIN_WORDS = 8;
/** Lower bar for linked templates (their honest twin is rare); still a template match, not a URL match. */
export const FLOOD_ECHO_MIN_WORDS_LINKED = 5;
/** Token overlap at which two templates are treated as one campaign. */
export const FLOOD_SIMILARITY = 0.6;

const SENSITIVITY_SCALE: Record<FloodSensitivity, { min: number; echo: number }> = {
  relaxed: { min: 12, echo: 6 },
  standard: { min: FLOOD_MIN_MESSAGES, echo: FLOOD_ECHO_MIN },
  strict: { min: 5, echo: 3 },
};

export interface FloodOptions {
  /** The reader's tuning; absent = {@link DEFAULT_FLOOD_POLICY}. */
  policy?: FloodPolicy;
  minMessages?: number;
  windowMs?: number;
  echoMin?: number;
  echoWindowMs?: number;
  /** The reader's pubkey; their own messages never fold. */
  self?: string;
  /**
   * When each author was first heard IN THIS CHANNEL (`queryChannelFirstSeen`),
   * since a flood fills the batch window. Can only move arrivals earlier or add
   * authors, so partial answers are safe.
   */
  firstSeen?: ReadonlyMap<string, number>;
  /**
   * Whether an author is STAFF (owner or `STAFF_MASK` holder). Staff never fold;
   * they join the trusted set ({@link computeTrusted}). Absent in bare lib folds.
   */
  staff?: (author: string) => boolean;
  /**
   * Lower bound (ms) on the room's existence, an alternative precedent for the drown
   * rule when a TOTAL nuke leaves no non-drowner speaker. Prefer an unforgeable
   * source (`HeldRoot.retiredAt`); the chat-plane fallback can only be pushed
   * EARLIER by a flood. Absent in bare lib folds.
   */
  establishedSinceMs?: number;
}

const URL_RUN = /https?:\/\/\S+/g;
const TRAILING_NONCE = /([>!])\s*[a-z0-9]{4,9}$/;
const DIGIT_TOKEN = /[\p{L}\p{N}]*\p{N}[\p{L}\p{N}]*/gu;
/** Three-plus of one letter: elongation (`nooo`), laughter (`kkkk`), mash (`ggggg`). */
const LETTER_RUN = /(\p{L})\1{2,}/gu;
const INVISIBLE = /[\u200b-\u200f\u2060\ufeff]/g;
/** Words, in any script. Emoji and punctuation are deliberately not words. */
const WORD = /[\p{L}][\p{L}\p{N}_]*/gu;

/**
 * A template fingerprint with per-copy variations collapsed. The trailing nonce
 * is found POSITIONALLY (the `>`/`!` scaffolding campaigns use), not by looking
 * random, which would leak or eat real words.
 */
export function shapeKey(content: string): string {
  return content
    .toLowerCase()
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(URL_RUN, "@")
    .replace(TRAILING_NONCE, "$1#")
    .replace(DIGIT_TOKEN, "#")
    // A letter run is one held key: `ggg` = `g`, `noooo` = `no`.
    .replace(LETTER_RUN, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The words of a template. Placeholders aren't words, so link/photo-only messages
 * have none and are ignored by density and echo (an album isn't a flood; a
 * link-only flood is left to the Banlist).
 */
export function normalizeTokens(shape: string): string[] {
  return shape.match(WORD) ?? [];
}

/** One template and every message that shares it. */
interface Bucket {
  shape: string;
  words: Set<string>;
  wordCount: number;
  linked: boolean;
  idx: number[];
}

/** Is this template substantial enough for the echo rule to judge it? */
function echoEligible(wordCount: number, linked: boolean): boolean {
  return wordCount >= (linked ? FLOOD_ECHO_MIN_WORDS_LINKED : FLOOD_ECHO_MIN_WORDS);
}

/**
 * Jaccard overlap of sorted interned token ids ({@link internWords}); a linear
 * merge, since this is the hot path on rotating campaigns.
 */
function similarityIds(a: Int32Array, b: Int32Array): number {
  let i = 0;
  let j = 0;
  let shared = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      shared++;
      i++;
      j++;
    } else if (a[i] < b[j]) {
      i++;
    } else {
      j++;
    }
  }
  return shared / (a.length + b.length - shared);
}

/** Intern eligible buckets' words to sorted `Int32Array`s, indexed by bucket id. */
function internWords(buckets: Bucket[], ids: Iterable<number>): (Int32Array | undefined)[] {
  const wordId = new Map<string, number>();
  const out: (Int32Array | undefined)[] = new Array(buckets.length);
  for (const i of ids) {
    const arr = new Int32Array(buckets[i].words.size);
    let k = 0;
    for (const w of buckets[i].words) {
      let id = wordId.get(w);
      if (id === undefined) wordId.set(w, (id = wordId.size));
      arr[k++] = id;
    }
    out[i] = arr.sort();
  }
  return out;
}

/** Document frequency above which a word isn't used to find candidates (avoids O(n²)). */
const DF_CAP = 64;
/** Most candidate buckets one bucket will be compared against. */
const CANDIDATE_CAP = 48;

/**
 * Merge near-duplicate buckets into campaigns (union-find parents). Only
 * echo-eligible buckets take part; short templates make "similar" meaningless.
 */
function mergeSimilar(buckets: Bucket[]): number[] {
  const parent = buckets.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const eligible = buckets
    .map((_, i) => i)
    .filter((i) => echoEligible(buckets[i].wordCount, buckets[i].linked));
  if (eligible.length < 2) return parent;

  const df = new Map<string, number>();
  for (const i of eligible) for (const w of buckets[i].words) df.set(w, (df.get(w) ?? 0) + 1);

  const index = new Map<string, number[]>();
  for (const i of eligible) {
    for (const w of buckets[i].words) {
      if ((df.get(w) ?? 0) > DF_CAP) continue;
      let list = index.get(w);
      if (!list) index.set(w, (list = []));
      list.push(i);
    }
  }

  const wordIds = internWords(buckets, eligible);
  const examine = (i: number, j: number) => {
    if (find(i) !== find(j) && similarityIds(wordIds[i]!, wordIds[j]!) >= FLOOD_SIMILARITY) {
      union(i, j);
    }
  };

  // Reused typed array rather than a Map per bucket (hot loop); `touched` keeps
  // clearing O(touched).
  const count = new Int32Array(buckets.length);
  const touched: number[] = [];
  for (const i of eligible) {
    touched.length = 0;
    let maxShared = 0;
    for (const w of buckets[i].words) {
      const list = index.get(w);
      if (!list) continue;
      for (const j of list) {
        if (j >= i) continue; // each pair once
        if (count[j] === 0) touched.push(j);
        const c = ++count[j];
        if (c > maxShared) maxShared = c;
      }
    }
    // At most CANDIDATE_CAP candidates. Below the cap order is irrelevant (union is
    // commutative); above it, keep the most-shared via a counting sort.
    if (touched.length <= CANDIDATE_CAP) {
      for (const j of touched) examine(i, j);
    } else {
      const byCount: number[][] = [];
      for (const j of touched) (byCount[count[j]] ??= []).push(j);
      let examined = 0;
      for (let c = maxShared; c >= 1 && examined < CANDIDATE_CAP; c--) {
        const tier = byCount[c];
        if (!tier) continue;
        for (const j of tier) {
          examine(i, j);
          if (++examined >= CANDIDATE_CAP) break;
        }
      }
    }
    for (const j of touched) count[j] = 0;
  }
  return parent;
}

/** Per-message normalization, memoized on the row itself (folds re-run often). */
const normCache = new WeakMap<OpenedChat, { shape: string; words: string[]; gibberish: boolean }>();
function normalize(ev: OpenedChat): { shape: string; words: string[]; gibberish: boolean } {
  let n = normCache.get(ev);
  if (!n) {
    const shape = shapeKey(ev.content);
    normCache.set(ev, (n = { shape, words: normalizeTokens(shape), gibberish: isGibberish(shape) }));
  }
  return n;
}

/**
 * The rumor ids belonging to a visual flood. `messages` must be ms-ordered. An
 * author is a STRANGER to a window if their first message falls inside it
 * (relative, not an absolute age, so a channel's opening stays judgeable). Needs
 * no store read or roster.
 */
export function floodClusters(messages: readonly OpenedChat[], opts: FloodOptions = {}): Set<string> {
  return floodVerdict(messages, opts).flagged;
}

/**
 * {@link floodClusters} plus the earned-trust set it judged by
 * ({@link computeTrusted}), which the media hold reuses (`mediaTrust.ts`).
 */
export function floodVerdict(
  all: readonly OpenedChat[],
  opts: FloodOptions = {},
): { flagged: Set<string>; trusted: Set<string> } {
  const policy = opts.policy ?? DEFAULT_FLOOD_POLICY;
  const scale = SENSITIVITY_SCALE[policy.sensitivity];
  const minMessages = opts.minMessages ?? scale.min;
  const windowMs = opts.windowMs ?? FLOOD_WINDOW_MS;
  const echoMin = opts.echoMin ?? scale.echo;
  const echoWindowMs = opts.echoWindowMs ?? FLOOD_ECHO_WINDOW_MS;
  const contentOnly = policy.sensitivity === "relaxed";

  const flagged = new Set<string>();
  // Trust is computed once: the drown rule reads it and the immunity pass applies it.
  // Over every message, so an exempt one still earns its replies' authors trust.
  const trusted = computeTrusted(all, opts.self, opts.staff);
  const messages = policy.exemptBridged ? all.filter((m) => !floodExempt(m, policy)) : all;
  if (messages.length < Math.min(minMessages, echoMin)) return { flagged, trusted };

  // First-seen spans every message, the reader's included.
  const firstSeen = new Map<string, number>();
  for (const ev of messages) {
    const seen = firstSeen.get(ev.author);
    if (seen === undefined || ev.ms < seen) firstSeen.set(ev.author, ev.ms);
  }
  // Merged store entries can only move arrivals earlier; partial maps are safe.
  if (opts.firstSeen) {
    for (const [author, ms] of opts.firstSeen) {
      const seen = firstSeen.get(author);
      if (seen === undefined || ms < seen) firstSeen.set(author, ms);
    }
  }

  const byShape = new Map<string, Bucket>();
  for (let i = 0; i < messages.length; i++) {
    const ev = messages[i];
    if (opts.self !== undefined && ev.author === opts.self) continue;
    const { shape, words } = normalize(ev);
    // No words (attachment, bare link, emoji): nothing to repeat, so neither rule
    // judges it.
    if (!shape || words.length === 0) continue;
    let bucket = byShape.get(shape);
    if (!bucket) {
      byShape.set(
        shape,
        (bucket = {
          shape,
          words: new Set(words),
          wordCount: words.length,
          linked: shape.includes("@"),
          idx: [],
        }),
      );
    }
    bucket.idx.push(i);
  }
  const buckets = [...byShape.values()];

  // Fold near-duplicate templates so a rotating pitch is one campaign.
  const parent = mergeSimilar(buckets);
  const campaigns = new Map<number, number[]>();
  for (let b = 0; b < buckets.length; b++) {
    let root = b;
    while (parent[root] !== root) root = parent[root];
    const list = campaigns.get(root);
    if (list) list.push(b);
    else campaigns.set(root, [b]);
  }

  for (const members of campaigns.values()) {
    let idx = buckets[members[0]].idx;
    if (members.length > 1) {
      idx = members.flatMap((b) => buckets[b].idx).sort((a, b) => a - b);
    }
    const short = members.every((b) => buckets[b].wordCount < FLOOD_MIN_WORDS);
    markDensity(
      messages,
      idx,
      short ? minMessages * FLOOD_SHORT_FACTOR : minMessages,
      windowMs,
      firstSeen,
      flagged,
    );
    // Eligible if any member template is (merging only joins eligible ones).
    if (members.some((b) => echoEligible(buckets[b].wordCount, buckets[b].linked))) {
      markEcho(messages, idx, echoMin, echoWindowMs, flagged);
    }
  }
  if (!contentOnly) {
    markArrivalBurst(messages, firstSeen, flagged, opts.self);
    markCohortFlood(messages, firstSeen, flagged, opts.self);
    markUntrustedDrown(messages, firstSeen, trusted, flagged, opts.self, opts.establishedSinceMs);
    markGibberish(messages, flagged, opts.self);
  }
  sweepParticipants(messages, flagged, opts.self);

  // Earned-trust immunity, LAST, overriding every rule (defeats copy-a-regular;
  // `self` is in `trusted`).
  if (trusted.size > 0) {
    for (const ev of messages) if (trusted.has(ev.author)) flagged.delete(ev.rumorId);
  }
  return { flagged, trusted };
}

/** One batch's quarantine, keyed on the batch itself (see {@link quarantinedIn}). */
const quarantineCache = new WeakMap<
  readonly OpenedChat[],
  { self: string | undefined; staff: FloodOptions["staff"]; policy: FloodPolicy; ids: Set<string> }
>();

const SPEECH_KINDS: ReadonlySet<number> = new Set([KIND_MESSAGE, KIND_POLL, KIND_COMMENT]);

/**
 * Flood quarantine for one channel's cached batch, memoized on the batch's
 * IDENTITY (the shared scan replaces a channel's array only when it changes), so
 * read-state changes are cache hits. The BADGE path: pure, no `firstSeen`; sorts
 * since the batch isn't ms-ordered. `staff` is part of the cache key and must be a
 * stable reference. Side events are dropped first: a reaction must not date its
 * author as present or count toward a wave's share.
 */
export function quarantinedIn(
  rumors: readonly OpenedChat[],
  self?: string,
  staff?: FloodOptions["staff"],
  policy: FloodPolicy = DEFAULT_FLOOD_POLICY,
): Set<string> {
  const cached = quarantineCache.get(rumors);
  if (cached && cached.self === self && cached.staff === staff && cached.policy === policy) return cached.ids;
  const ids = floodClusters(rumors.filter((r) => SPEECH_KINDS.has(r.kind)).sort((a, b) => a.ms - b.ms), {
    ...(self !== undefined ? { self } : {}),
    ...(staff !== undefined ? { staff } : {}),
    policy,
  });
  quarantineCache.set(rumors, { self, staff, policy, ids });
  return ids;
}

/** Keys arriving within this of the previous one chain into a single cohort. */
export const FLOOD_COHORT_WINDOW_MS = 600_000;
/** Keys a wave needs to fold on BREADTH alone, at any pace. */
export const FLOOD_COHORT_AUTHORS = 8;
/**
 * …or this many at {@link FLOOD_COHORT_RATE_PER_MIN}, since breadth alone catches
 * a campaign introducing a key every 40s only after minutes.
 */
export const FLOOD_COHORT_RATE_AUTHORS = 3;
/** The pace that lets {@link FLOOD_COHORT_RATE_AUTHORS} stand in for breadth. */
export const FLOOD_COHORT_RATE_PER_MIN = 10;
/** Messages one wave of a cohort must carry before it reads as a flood. */
export const FLOOD_COHORT_MESSAGES = 24;
/**
 * Messages a cohort member must itself carry in the wave before its rows fold
 * (drowning is collective, the fold individual), sparing honest newcomers who
 * arrive mid-attack. Keys posting once each are {@link markArrivalBurst}'s job.
 */
export const FLOOD_COHORT_MIN_PER_AUTHOR = 3;
/**
 * Share of the channel a cohort's wave must occupy to fold — THE discriminator
 * between a flood and an influx (regulars keep talking during an influx).
 */
export const FLOOD_COHORT_SHARE = 0.75;
/** Silence that ends a cohort's wave — the "until it stops" of the rule. */
export const FLOOD_COHORT_TAIL_MS = 3_600_000;
/**
 * How long before a cohort's arrival someone OUTSIDE it must have spoken, else
 * it's a launch, not an invasion. Relative per cohort on purpose: anchoring to the
 * batch's earliest message gave a flood hitting a quiet channel founder immunity.
 */
export const FLOOD_COHORT_PRECEDENT_MS = 600_000;

/**
 * Rule 4: a crowd of keys that arrived together and then drowned the channel —
 * for per-message generated content where no template repeats. Reads no content;
 * asks how much of the channel comes from keys that hadn't earned a place.
 *
 * Kept off honest influxes by: a CROWD ({@link FLOOD_COHORT_AUTHORS}) chained
 * arrival-to-arrival; a wave that DROWNS the channel ({@link FLOOD_COHORT_SHARE});
 * and precedent ({@link FLOOD_COHORT_PRECEDENT_MS}). Membership is fixed at
 * ARRIVAL and waves end at {@link FLOOD_COHORT_TAIL_MS} silence, so a key returning
 * tomorrow renders normally.
 */
function markCohortFlood(
  messages: readonly OpenedChat[],
  firstSeen: ReadonlyMap<string, number>,
  flagged: Set<string>,
  self: string | undefined,
): void {
  // Only batch authors can join a cohort, but arrival comes from the merged map, so
  // a regular inside a flood window chains into none.
  const inBatch = new Set<string>();
  for (const ev of messages) inBatch.add(ev.author);
  const arrivals = [...firstSeen]
    .filter(([author]) => author !== self && inBatch.has(author))
    .sort((a, b) => a[1] - b[1]);
  // The lower bar; breadth vs pace is decided per wave in markCohortWaves.
  if (arrivals.length < FLOOD_COHORT_RATE_AUTHORS) return;

  // Precedent must include store-remembered authors the window pushed out.
  const allArrivals = [...firstSeen.values()].sort((a, b) => a - b);

  for (let start = 0; start < arrivals.length; ) {
    let end = start;
    while (
      end + 1 < arrivals.length &&
      arrivals[end + 1][1] - arrivals[end][1] <= FLOOD_COHORT_WINDOW_MS
    ) {
      end++;
    }
    if (end - start + 1 >= FLOOD_COHORT_RATE_AUTHORS) {
      const cohort = new Set(arrivals.slice(start, end + 1).map(([a]) => a));
      // Anyone (reader included) arriving early enough proves the channel predates the cohort.
      const bar = arrivals[start][1] - FLOOD_COHORT_PRECEDENT_MS;
      if (allArrivals[0] <= bar) {
        markCohortWaves(messages, cohort, flagged);
      }
    }
    start = end + 1;
  }
}

/** First index whose ms is >= `ms` (messages are ms-ascending). */
function lowerBound(messages: readonly OpenedChat[], ms: number): number {
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid].ms < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Fold each cohort wave that carries enough messages and drowns the channel; a
 * wave ends at {@link FLOOD_COHORT_TAIL_MS} of cohort silence.
 */
function markCohortWaves(
  messages: readonly OpenedChat[],
  members: ReadonlySet<string>,
  flagged: Set<string>,
): void {
  const idx: number[] = [];
  for (let i = 0; i < messages.length; i++) if (members.has(messages[i].author)) idx.push(i);

  let waveStart = 0;
  for (let k = 1; k <= idx.length; k++) {
    const ends = k === idx.length || messages[idx[k]].ms - messages[idx[k - 1]].ms > FLOOD_COHORT_TAIL_MS;
    if (!ends) continue;
    const wave = idx.slice(waveStart, k);
    waveStart = k;
    if (wave.length < FLOOD_COHORT_MESSAGES) continue;

    const from = messages[wave[0]].ms;
    const to = messages[wave[wave.length - 1]].ms;
    const total = lowerBound(messages, to + 1) - lowerBound(messages, from);
    if (wave.length < total * FLOOD_COHORT_SHARE) continue;

    const carried = new Map<string, number>();
    for (const i of wave) carried.set(messages[i].author, (carried.get(messages[i].author) ?? 0) + 1);

    // Breadth OR pace; a zero-span wave counts as infinitely fast.
    const minutes = (to - from) / 60_000;
    const perMinute = minutes > 0 ? wave.length / minutes : Number.POSITIVE_INFINITY;
    const broad = carried.size >= FLOOD_COHORT_AUTHORS;
    const fast = carried.size >= FLOOD_COHORT_RATE_AUTHORS && perMinute >= FLOOD_COHORT_RATE_PER_MIN;
    if (!broad && !fast) continue;
    for (const i of wave) {
      if ((carried.get(messages[i].author) ?? 0) >= FLOOD_COHORT_MIN_PER_AUTHOR) {
        flagged.add(messages[i].rumorId);
      }
    }
  }
}

/**
 * Authors this reader has EARNED reason to trust, from the batch. Roots: the
 * reader and community STAFF. Trust flows from the reader through inbound
 * attention (reply/quote/mention edges src → dst) — the one signal a flood can't
 * manufacture. Directed, so a spammer mentioning a regular grants nothing.
 *
 * Staff are trusted but NOT propagation roots: moderating means replying to and
 * mentioning spammers, which must not whitelist them. With neither self nor staff
 * the set is empty (trustless-room behavior).
 */
function computeTrusted(
  messages: readonly OpenedChat[],
  self: string | undefined,
  staff: ((author: string) => boolean) | undefined,
): Set<string> {
  const trusted = new Set<string>();
  const roots: string[] = [];
  if (self !== undefined) {
    trusted.add(self);
    roots.push(self); // the reader is the one root that spreads trust outward
  }
  // Seed speaking staff as trusted (not roots).
  if (staff) for (const ev of messages) if (staff(ev.author)) trusted.add(ev.author);
  // No spreading root: the seeds are the whole set.
  if (roots.length === 0) return trusted;

  // author → pubkeys they directed attention at (resolved through the batch).
  const authorOf = new Map<string, string>();
  for (const ev of messages) authorOf.set(ev.rumorId, ev.author);
  const attends = new Map<string, Set<string>>();
  const addEdge = (src: string, dst: string) => {
    if (dst === src) return;
    let s = attends.get(src);
    if (!s) attends.set(src, (s = new Set()));
    s.add(dst);
  };
  for (const ev of messages) {
    for (const t of ev.tags) {
      if (t.length < 2 || !t[1]) continue;
      if (t[0] === "e" || t[0] === "E" || t[0] === "q") {
        const target = authorOf.get(t[1]);
        if (target) addEdge(ev.author, target);
      } else if (t[0] === "p" && /^[0-9a-f]{64}$/.test(t[1])) {
        addEdge(ev.author, t[1]);
      }
    }
  }

  const queue = [...roots];
  while (queue.length) {
    const src = queue.pop()!;
    const outs = attends.get(src);
    if (!outs) continue;
    for (const dst of outs) if (!trusted.has(dst)) { trusted.add(dst); queue.push(dst); }
  }
  return trusted;
}

/**
 * Rule 6: UNTRUSTED speakers who together drown the channel — the case every
 * shape rule loses (a few aged keys posting fluent, distinct spam, faking chatter
 * among themselves). Asks only how much of the channel comes from keys with no
 * earned trust ({@link computeTrusted}); cliques can't vouch for themselves.
 *
 * Same discriminators as the cohort rule, over the untrusted subset: **drown**
 * ({@link FLOOD_COHORT_SHARE}), **pace** ({@link FLOOD_COHORT_RATE_PER_MIN}), and
 * **precedent** (an outside speaker {@link FLOOD_COHORT_PRECEDENT_MS} earlier, or
 * {@link FloodOptions.establishedSinceMs} for a TOTAL nuke). Waves end at
 * {@link FLOOD_COHORT_TAIL_MS}; each key must carry
 * {@link FLOOD_COHORT_MIN_PER_AUTHOR}. One trusted reply clears a key.
 */
function markUntrustedDrown(
  messages: readonly OpenedChat[],
  firstSeen: ReadonlyMap<string, number>,
  trusted: ReadonlySet<string>,
  flagged: Set<string>,
  self: string | undefined,
  establishedSinceMs: number | undefined,
): void {
  const idx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const a = messages[i].author;
    if (a !== self && !trusted.has(a)) idx.push(i);
  }
  if (idx.length < FLOOD_COHORT_MESSAGES) return;

  let waveStart = 0;
  for (let k = 1; k <= idx.length; k++) {
    const ends = k === idx.length || messages[idx[k]].ms - messages[idx[k - 1]].ms > FLOOD_COHORT_TAIL_MS;
    if (!ends) continue;
    const wave = idx.slice(waveStart, k);
    waveStart = k;
    if (wave.length < FLOOD_COHORT_MESSAGES) continue;

    const from = messages[wave[0]].ms;
    const to = messages[wave[wave.length - 1]].ms;

    // Drown: if trusted voices still get a word in, it's a conversation.
    const total = lowerBound(messages, to + 1) - lowerBound(messages, from);
    if (wave.length < total * FLOOD_COHORT_SHARE) continue;

    // Pace; a zero-span wave counts as infinitely fast.
    const minutes = (to - from) / 60_000;
    const perMinute = minutes > 0 ? wave.length / minutes : Number.POSITIVE_INFINITY;
    if (perMinute < FLOOD_COHORT_RATE_PER_MIN) continue;

    // The group is keys past FLOOD_COHORT_MIN_PER_AUTHOR; bystanders aren't counted.
    const carried = new Map<string, number>();
    for (const i of wave) carried.set(messages[i].author, (carried.get(messages[i].author) ?? 0) + 1);
    const group = new Set<string>();
    for (const [a, n] of carried) if (n >= FLOOD_COHORT_MIN_PER_AUTHOR) group.add(a);
    if (group.size === 0) continue;

    // Precedent, either source: a non-drowner speaker a clear margin before the wave
    // (from the store's `firstSeen`, so the pre-flood quiet is visible), or the room
    // itself predating the wave (`establishedSinceMs`, the only precedent a TOTAL
    // nuke leaves).
    const cutoff = from - FLOOD_COHORT_PRECEDENT_MS;
    let othersEarliest = Number.POSITIVE_INFINITY;
    for (const [a, ms] of firstSeen) if (!group.has(a) && ms < othersEarliest) othersEarliest = ms;
    const hasPrecedent =
      othersEarliest <= cutoff || (establishedSinceMs !== undefined && establishedSinceMs <= cutoff);
    if (!hasPrecedent) continue;

    for (const i of wave) if (group.has(messages[i].author)) flagged.add(messages[i].rumorId);
  }
}

/** Messages by first-time keys inside {@link FLOOD_BURST_WINDOW_MS} to read as an arrival. */
export const FLOOD_BURST_MIN = 8;
/** …spread across at least this many of them. */
export const FLOOD_BURST_AUTHORS = 6;
/** Deliberately tighter than the density window: this is a burst, not a trend. */
export const FLOOD_BURST_WINDOW_MS = 120_000;

/**
 * Rule 3: many never-before-seen keys arriving at once, one message each (no
 * template repeats). Folds only FIRST-TIMERS, and only with history before the
 * window (the batch head reads as all-new). A genuine influx folds too — an
 * accepted one-click cost.
 */
function markArrivalBurst(
  messages: readonly OpenedChat[],
  firstSeen: Map<string, number>,
  flagged: Set<string>,
  self: string | undefined,
): void {
  const lastSeen = new Map<string, number>();
  for (const ev of messages) lastSeen.set(ev.author, ev.ms);

  // Mark each author's introducing message, so arrivals in a window are counted
  // incrementally.
  const introduces = new Uint8Array(messages.length);
  const seen = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].author === self || seen.has(messages[i].author)) continue;
    seen.add(messages[i].author);
    introduces[i] = 1;
  }

  let lo = 0;
  let arrivals = 0;
  for (let hi = 0; hi < messages.length; hi++) {
    arrivals += introduces[hi];
    while (messages[hi].ms - messages[lo].ms > FLOOD_BURST_WINDOW_MS) arrivals -= introduces[lo++];
    // Nothing before the window: the batch head, nothing to judge.
    if (lo === 0) continue;
    // Cheap necessary condition that keeps this pass linear.
    if (arrivals < FLOOD_BURST_AUTHORS) continue;

    const from = messages[lo].ms;
    const to = messages[hi].ms;
    /**
     * A key whose ENTIRE presence is inside the window (arrived, spoke, vanished) — the
     * burner shape. "New" alone would fold the start of every batch.
     */
    const burner = (a: string) => a !== self && (firstSeen.get(a) ?? 0) >= from && (lastSeen.get(a) ?? 0) <= to;

    let burners = 0;
    for (let i = lo; i <= hi; i++) if (burner(messages[i].author)) burners++;
    if (burners < FLOOD_BURST_MIN) continue;

    for (let i = lo; i <= hi; i++) if (burner(messages[i].author)) flagged.add(messages[i].rumorId);
  }
}

/** Distinct letters at or under which a message reads as low-originality. */
export const FLOOD_GIBBERISH_MAX_LETTERS = 2;
/**
 * Low-originality messages one key may post in the window before the run folds;
 * sized against honest laughs and `gg`s.
 */
export const FLOOD_GIBBERISH_MIN = 12;
/** Long, like the echo window: mash is a drizzle, not a burst. */
export const FLOOD_GIBBERISH_WINDOW_MS = 3_600_000;

/**
 * Does this shape draw on too few letters to be saying anything? One distinct
 * letter is mash at any length; two is mash from three letters up (`lol`,
 * `kkkk`), but exactly two letters (`ok`, `gm`) is language and never counts.
 */
export function isGibberish(shape: string): boolean {
  const letters = shape.match(/\p{L}/gu);
  if (!letters) return false;
  const distinct = new Set(letters).size;
  if (distinct > FLOOD_GIBBERISH_MAX_LETTERS) return false;
  return distinct === 1 || letters.length >= 3;
}

/**
 * Rule 5: one key spending its messages on noise — the lone-key wall the other
 * rules can't see. Noise is either LETTERS ({@link isGibberish}) or VOCABULARY: a
 * single word no other author in the batch uses (random strings are foreign to
 * the room; real one-word messages are shared vocabulary). Vocabulary is judged
 * only when another author is present.
 *
 * An allowance: {@link FLOOD_GIBBERISH_MIN} within {@link FLOOD_GIBBERISH_WINDOW_MS}
 * from one key folds (knowingly including heavy laughers). Per key on purpose:
 * cross-key choruses aren't folded.
 */
function markGibberish(
  messages: readonly OpenedChat[],
  flagged: Set<string>,
  self: string | undefined,
): void {
  // Each token's sole author (null once shared); the reader's words count as room vocabulary.
  const soleUser = new Map<string, string | null>();
  const authors = new Set<string>();
  for (const ev of messages) {
    authors.add(ev.author);
    for (const w of normalize(ev).words) {
      const cur = soleUser.get(w);
      if (cur === undefined) soleUser.set(w, ev.author);
      else if (cur !== null && cur !== ev.author) soleUser.set(w, null);
    }
  }
  const compareAuthors = authors.size >= 2;

  const byAuthor = new Map<string, number[]>();
  for (let i = 0; i < messages.length; i++) {
    const ev = messages[i];
    if (ev.author === self) continue;
    const n = normalize(ev);
    const foreign =
      compareAuthors && n.words.length === 1 && soleUser.get(n.words[0]) === ev.author;
    if (!n.gibberish && !foreign) continue;
    let list = byAuthor.get(ev.author);
    if (!list) byAuthor.set(ev.author, (list = []));
    list.push(i);
  }
  for (const idx of byAuthor.values()) {
    if (idx.length < FLOOD_GIBBERISH_MIN) continue;
    let lo = 0;
    let marked = 0;
    for (let hi = 0; hi < idx.length; hi++) {
      while (messages[idx[hi]].ms - messages[idx[lo]].ms > FLOOD_GIBBERISH_WINDOW_MS) lo++;
      if (hi - lo + 1 < FLOOD_GIBBERISH_MIN) continue;
      for (let i = Math.max(lo, marked); i <= hi; i++) flagged.add(messages[idx[i]].rumorId);
      marked = hi + 1;
    }
  }
}

/**
 * A key that carried this much of a flood is folded for its whole wave (first to
 * last flood message), so off-template one-offs don't split the wall into many
 * rows. Still a DISPLAY fold; nothing outside the wave is touched.
 */
export const FLOOD_AUTHOR_MESSAGES = 4;

/** Fold the rest of what participants said within their own wave (bounded by their first/last flagged message). */
function sweepParticipants(
  messages: readonly OpenedChat[],
  flagged: Set<string>,
  self: string | undefined,
): void {
  if (flagged.size === 0) return;
  const span = new Map<string, { lo: number; hi: number; n: number }>();
  for (const ev of messages) {
    if (!flagged.has(ev.rumorId)) continue;
    const cur = span.get(ev.author);
    if (!cur) span.set(ev.author, { lo: ev.ms, hi: ev.ms, n: 1 });
    else {
      cur.hi = ev.ms;
      cur.n++;
    }
  }
  for (const [author, s] of span) if (s.n < FLOOD_AUTHOR_MESSAGES) span.delete(author);
  if (span.size === 0) return;
  for (const ev of messages) {
    if (ev.author === self || flagged.has(ev.rumorId)) continue;
    const s = span.get(ev.author);
    if (s && ev.ms >= s.lo && ev.ms <= s.hi) flagged.add(ev.rumorId);
  }
}

/**
 * Rule 1: one template, {@link FLOOD_MIN_MESSAGES} copies inside one window,
 * carried by at most two authors or by authors who had not spoken before.
 */
function markDensity(
  messages: readonly OpenedChat[],
  idx: readonly number[],
  minMessages: number,
  windowMs: number,
  firstSeen: Map<string, number>,
  flagged: Set<string>,
): void {
  if (idx.length < minMessages) return;
  let lo = 0;
  // Everything below this index is already flagged, keeping marking O(n).
  let marked = 0;
  for (let hi = 0; hi < idx.length; hi++) {
    while (messages[idx[hi]].ms - messages[idx[lo]].ms > windowMs) lo++;
    if (hi - lo + 1 < minMessages) continue;

    const windowStart = messages[idx[lo]].ms;
    const authors = new Set<string>();
    let allStrangers = true;
    for (let i = lo; i <= hi; i++) {
      const author = messages[idx[i]].author;
      authors.add(author);
      if (allStrangers && (firstSeen.get(author) ?? windowStart) < windowStart) allStrangers = false;
    }
    if (!allStrangers && authors.size > FLOOD_MAX_FAMILIAR_AUTHORS) continue;

    for (let i = Math.max(lo, marked); i <= hi; i++) flagged.add(messages[idx[i]].rumorId);
    marked = hi + 1;
  }
}

/**
 * Rule 2: the same substantial template from ≥2 authors {@link FLOOD_ECHO_MIN}
 * times in a long window — survives paced, rotating, warmed-up campaigns. Cost: a
 * widely reposted long phrase folds.
 */
function markEcho(
  messages: readonly OpenedChat[],
  idx: readonly number[],
  echoMin: number,
  echoWindowMs: number,
  flagged: Set<string>,
): void {
  if (idx.length < echoMin) return;
  let lo = 0;
  let marked = 0;
  for (let hi = 0; hi < idx.length; hi++) {
    while (messages[idx[hi]].ms - messages[idx[lo]].ms > echoWindowMs) lo++;
    if (hi - lo + 1 < echoMin) continue;

    const authors = new Set<string>();
    for (let i = lo; i <= hi; i++) authors.add(messages[idx[i]].author);
    if (authors.size < FLOOD_ECHO_MIN_AUTHORS) continue;

    for (let i = Math.max(lo, marked); i <= hi; i++) flagged.add(messages[idx[i]].rumorId);
    marked = hi + 1;
  }
}
