/**
 * useHistoryAudit — the orchestrator that turns the pure {@link auditHistory}
 * verifier and the {@link historyExport} writers into a working in-app tool.
 *
 * Running it does the exhaustive, all-or-name-the-gap collection that "ensure
 * perfect history before acting" requires:
 *
 *   1. an EXHAUSTIVE control sweep (`sweepControl(…, { exhaustive: true })` —
 *      the same primitive the Refounding path runs before it compacts), so the
 *      roster/channels/banlist are folded from the whole plane, not a delta;
 *   2. per channel, a backfill paged to its floor across every community relay
 *      (`backfillStore` looped on the oldest cursor), decrypted with
 *      `openChatBatch`, merged with what the store already holds, and written
 *      back so the pull is also a durable fill;
 *   3. a fold (`foldTimeline`) into the surviving timeline, profiles resolved
 *      from kind-0, and — for the offline HTML export — image attachments and
 *      avatars fetched, decrypted, and inlined as `data:` URIs under a byte
 *      budget;
 *   4. the collected facts handed to {@link auditHistory}, whose verdict and
 *      the assembled {@link ExportModel} are returned together.
 *
 * The hook is deliberately imperative (`run()`), not a `useQuery`: it is a
 * seconds-to-minutes operation a user starts explicitly and watches, exactly
 * like the rotation dialog it sits beside.
 */

import { useNostr } from "@nostrify/react";
import { useCallback, useMemo, useRef, useState } from "react";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import {
  foldTimeline,
  openChatBatch,
  replyTargetOf,
  type OpenedChat,
} from "@/concord/lib/chat";
import { backfillStore } from "@/concord/lib/channelSync";
import { useChannels, useControlFold } from "@/concord/hooks/useControlPlane";
import {
  auditHistory,
  type AuditOptions,
  type ChannelCollection,
  type ControlCollection,
  type HistoryReport,
  type RelayCoverage,
} from "@/concord/lib/historyAudit";
import {
  type ExportAttachment,
  type ExportChannel,
  type ExportMessage,
  type ExportModel,
  type ExportProfile,
} from "@/concord/lib/historyExport";
import { sniffImageMime } from "@/concord/lib/image";
import {
  controlSweepQuorum,
  controlSweepRelayReached,
  controlSweepTruncated,
  sweepControl,
} from "@/concord/lib/planeSync";
import { queryChannelRumors, writeRumors } from "@/concord/lib/rumorStore";
import type { Channel, Community } from "@/concord/lib/types";
import { parseAuthorEvent } from "@/lib/authorCache";
import { decryptBytes } from "@/lib/encryptedMedia";
import { parseImetaMap, type ImetaEntry } from "@/lib/imeta";

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Backfill rounds per channel; each round pages up to 20×50 wraps oldest-ward. */
const MAX_BACKFILL_ROUNDS = 60;
/** Total bytes of decrypted media a single export may embed (keeps a huge room's export sane). */
const ASSET_TOTAL_BUDGET = 40 * 1024 * 1024;
/** No single asset larger than this is embedded (it stays a link instead). */
const ASSET_MAX_EACH = 8 * 1024 * 1024;
/** kind-0 authors per relay query. */
const PROFILE_BATCH = 100;

// ── Progress ─────────────────────────────────────────────────────────────────

export type AuditPhase = "idle" | "control" | "channels" | "profiles" | "assets" | "done" | "error";

export interface AuditProgress {
  phase: AuditPhase;
  /** Channel currently being swept (phase "channels") or the active step's label. */
  label?: string;
  done: number;
  total: number;
}

export interface HistoryAuditResult {
  report: HistoryReport;
  model: ExportModel;
}

export interface RunOptions {
  /** Fetch + decrypt + inline images/avatars as data URIs (needed for a self-contained HTML). */
  embedAssets?: boolean;
  /** Passed through to {@link auditHistory} (e.g. `danglingIsBlocker` for a pre-compaction gate). */
  auditOptions?: AuditOptions;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** An imeta attachment worth trying to embed inline (an image, or unknown-but-likely). */
function isEmbeddableImage(entry: ImetaEntry): boolean {
  return !entry.mime || entry.mime.startsWith("image/");
}

/**
 * Fetch a URL (decrypting AES-GCM ciphertext when `enc` is present) and encode
 * it as a `data:` URI, or report failure. Never throws: a leak-free export
 * would rather drop or link an asset than abort over one bad blob.
 */
async function fetchImageDataUri(
  url: string,
  enc: ImetaEntry["encryption"],
  signal: AbortSignal,
  budget: { left: number },
): Promise<{ dataUri?: string; mime?: string; failed: boolean }> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let bytes = new Uint8Array(await res.arrayBuffer());
    if (enc) bytes = await decryptBytes(bytes, enc.key, enc.nonce);
    if (bytes.length > ASSET_MAX_EACH || bytes.length > budget.left) {
      // Too big to embed — a plaintext one stays a link, an encrypted one can't.
      return { failed: Boolean(enc) };
    }
    budget.left -= bytes.length;
    const mime = bytes.length ? sniffImageMime(bytes) : "application/octet-stream";
    return { dataUri: `data:${mime};base64,${bytesToBase64(bytes)}`, mime, failed: false };
  } catch {
    // An encrypted attachment we couldn't fetch/decrypt is unviewable; a
    // plaintext one is still a working link.
    return { failed: Boolean(enc) };
  }
}

/** Exhaustively backfill one channel's wraps across every relay. */
async function collectChannelWraps(
  nostr: { relay(url: string): { query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]> } },
  community: Community,
  channel: Channel,
  signal: AbortSignal,
): Promise<{ wraps: NostrEvent[]; exhausted: boolean; failed: boolean }> {
  const wraps: NostrEvent[] = [];
  let until: number | undefined;
  let exhausted = false;
  let failed = false;
  for (let round = 0; round < MAX_BACKFILL_ROUNDS; round++) {
    if (signal.aborted) break;
    const r = await backfillStore(nostr, community.relays, channel, signal, { until, maxPages: 20 });
    wraps.push(...r.events);
    if (r.failed) failed = true;
    if (r.exhausted) {
      exhausted = true;
      break;
    }
    if (r.oldest === undefined) break; // nothing came back — no deeper history to page
    const next = r.oldest - 1;
    if (until !== undefined && next >= until) break; // cursor didn't advance
    until = next;
  }
  return { wraps, exhausted, failed };
}

function buildExportMessages(timeline: ReturnType<typeof foldTimeline>): {
  messages: ExportMessage[];
  pending: Array<{ ref: ExportAttachment; entry: ImetaEntry }>;
} {
  const pending: Array<{ ref: ExportAttachment; entry: ImetaEntry }> = [];
  const messages = timeline.messages.map((m): ExportMessage => {
    const byEmoji = timeline.reactions.get(m.rumorId);
    const reactions = byEmoji
      ? [...byEmoji.entries()].map(([emoji, entry]) => ({ emoji, count: entry.reactors.size }))
      : [];
    const attachments: ExportAttachment[] = [];
    for (const entry of parseImetaMap(m.tags).values()) {
      const ref: ExportAttachment = { url: entry.url, ...(entry.mime ? { mime: entry.mime } : {}) };
      attachments.push(ref);
      if (isEmbeddableImage(entry)) pending.push({ ref, entry });
    }
    const replyTo = replyTargetOf(m);
    return {
      rumorId: m.rumorId,
      author: m.author,
      ms: m.ms,
      kind: m.kind,
      content: m.content,
      ...(m.tags.some(([n]) => n === "edited") ? { edited: true } : {}),
      ...(replyTo ? { replyTo } : {}),
      reactions,
      attachments,
    };
  });
  return { messages, pending };
}

// ── The hook ─────────────────────────────────────────────────────────────────

export function useHistoryAudit(community: Community | undefined) {
  const { nostr } = useNostr();
  const channels = useChannels(community);
  const { data: folded } = useControlFold(community);

  const [progress, setProgress] = useState<AuditProgress>({ phase: "idle", done: 0, total: 0 });
  const [result, setResult] = useState<HistoryAuditResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const canRun = Boolean(community && folded);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const run = useCallback(
    async (opts?: RunOptions): Promise<HistoryAuditResult | undefined> => {
      if (!community || !folded) return undefined;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const signal = controller.signal;
      const embedAssets = opts?.embedAssets ?? true;

      setError(null);
      setResult(null);
      try {
        // 1. Control plane — exhaustive sweep, then read its coverage self-facts.
        setProgress({ phase: "control", done: 0, total: 1, label: "Reading the control plane" });
        await sweepControl(nostr, community, { exhaustive: true });
        const control: ControlCollection = {
          incompleteEntities: folded.incomplete,
          truncated: controlSweepTruncated(community),
          quorum: controlSweepQuorum(community),
          relays: community.relays.map((url): RelayCoverage => {
            const reached = controlSweepRelayReached(community, url);
            return { url, answered: reached, failed: !reached };
          }),
          channelCount: folded.channels.size,
          memberCount: folded.roster.grants.length,
        };

        // 2. Chat plane — every channel, every epoch, paged to the floor.
        const collections: ChannelCollection[] = [];
        const exportChannels: ExportChannel[] = [];
        const pendingAssets: Array<{ ref: ExportAttachment; entry: ImetaEntry }> = [];
        const authors = new Set<string>();

        for (let i = 0; i < channels.length; i++) {
          if (signal.aborted) throw new Error("cancelled");
          const channel = channels[i];
          setProgress({ phase: "channels", done: i, total: channels.length, label: `#${channel.name}` });

          const { wraps, exhausted, failed } = await collectChannelWraps(nostr, community, channel, signal);
          const openedWire = await openChatBatch(wraps, channel, { signal });
          // Merge with what the store already decrypted on earlier syncs, then
          // persist the freshly-opened ones so the pull is also a durable fill.
          const stored = await queryChannelRumors(community.idHex, channel.idHex, { limit: 1_000_000, signal });
          if (openedWire.length) void writeRumors(community.idHex, openedWire);
          const byId = new Map<string, OpenedChat>();
          for (const o of stored) byId.set(o.rumorId, o);
          for (const o of openedWire) byId.set(o.rumorId, o);
          const merged = [...byId.values()];

          const timeline = foldTimeline(merged, { banned: folded.banned, canDelete: () => false });
          for (const m of timeline.messages) authors.add(m.author);

          const queriedEpochs = channel.streams.map((s) => s.epoch.toString());
          collections.push({
            channelIdHex: channel.idHex,
            name: channel.name,
            isPrivate: channel.isPrivate,
            deleted: false,
            opened: merged,
            messageCount: timeline.messages.length,
            queriedEpochs,
            exhaustedEpochs: exhausted ? queriedEpochs : [],
            relays: community.relays.map((url): RelayCoverage => ({ url, answered: true, failed })),
          });

          const { messages, pending } = buildExportMessages(timeline);
          pendingAssets.push(...pending);
          exportChannels.push({
            channelIdHex: channel.idHex,
            name: channel.name,
            isPrivate: channel.isPrivate,
            messages,
          });
        }

        // 3. Profiles — kind-0 for every author seen.
        setProgress({ phase: "profiles", done: 0, total: 1, label: "Resolving members" });
        const profiles: Record<string, ExportProfile> = {};
        const authorList = [...authors];
        for (const batch of chunk(authorList, PROFILE_BATCH)) {
          if (signal.aborted) throw new Error("cancelled");
          const events = await nostr.query([{ kinds: [0], authors: batch }], { signal });
          const newest = new Map<string, NostrEvent>();
          for (const ev of events) {
            const prev = newest.get(ev.pubkey);
            if (!prev || ev.created_at > prev.created_at) newest.set(ev.pubkey, ev);
          }
          for (const [pk, ev] of newest) {
            const { metadata } = parseAuthorEvent(ev);
            const name = metadata?.name || metadata?.display_name || "";
            profiles[pk] = { pubkey: pk, name, ...(metadata?.picture ? { picture: metadata.picture } : {}) };
          }
        }
        for (const pk of authorList) profiles[pk] ??= { pubkey: pk, name: "" };

        // 4. Assets — embed the icon, avatars + image attachments as data URIs (offline HTML).
        let iconDataUri: string | undefined;
        if (embedAssets) {
          const budget = { left: ASSET_TOTAL_BUDGET };
          const icon = folded.metadata?.icon;
          if (icon) {
            const r = await fetchImageDataUri(icon.url, { algorithm: "aes-gcm", key: icon.key, nonce: icon.nonce }, signal, budget);
            if (r.dataUri) iconDataUri = r.dataUri;
          }
          const total = authorList.length + pendingAssets.length;
          let done = 0;
          setProgress({ phase: "assets", done, total, label: "Embedding media" });
          for (const pk of authorList) {
            if (signal.aborted) throw new Error("cancelled");
            const pic = profiles[pk].picture;
            if (pic && /^https?:\/\//i.test(pic)) {
              const r = await fetchImageDataUri(pic, undefined, signal, budget);
              // Drop a remote avatar we couldn't inline: a self-contained file
              // must not phone home for it on open.
              if (r.dataUri) {
                profiles[pk] = { ...profiles[pk], picture: r.dataUri };
              } else {
                const { picture: _drop, ...rest } = profiles[pk];
                profiles[pk] = rest;
              }
            }
            setProgress({ phase: "assets", done: ++done, total, label: "Embedding media" });
          }
          for (const { ref, entry } of pendingAssets) {
            if (signal.aborted) throw new Error("cancelled");
            const r = await fetchImageDataUri(entry.url, entry.encryption, signal, budget);
            if (r.dataUri) {
              ref.dataUri = r.dataUri;
              if (r.mime) ref.mime = r.mime;
            } else if (r.failed) {
              ref.failed = true;
            }
            setProgress({ phase: "assets", done: ++done, total, label: "Embedding media" });
          }
        }

        // 5. Verdict + model.
        const now = Date.now();
        const report = auditHistory({
          communityIdHex: community.idHex,
          control,
          channels: collections,
          now,
          ...(opts?.auditOptions ? { options: opts.auditOptions } : {}),
        });
        const model: ExportModel = {
          communityName: folded.metadata?.name || community.name,
          communityIdHex: community.idHex,
          generatedAtMs: now,
          ...(iconDataUri ? { icon: iconDataUri } : {}),
          profiles,
          channels: exportChannels,
          report,
        };
        const out = { report, model };
        setResult(out);
        setProgress({ phase: "done", done: 1, total: 1 });
        return out;
      } catch (e) {
        if (signal.aborted) {
          setProgress({ phase: "idle", done: 0, total: 0 });
          return undefined;
        }
        setError(e instanceof Error ? e.message : "The history audit failed.");
        setProgress({ phase: "error", done: 0, total: 0 });
        return undefined;
      }
    },
    [community, folded, channels, nostr],
  );

  const channelCount = useMemo(() => channels.length, [channels]);

  return { run, cancel, canRun, progress, result, error, channelCount };
}
