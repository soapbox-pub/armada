/**
 * Post-login Concord warm-up: make a fresh device's communities real before the
 * SyncGate lifts — rehydrate memberships, register stream keys and sweep control
 * + guestbook planes, persist the control fold snapshot, then pull + decrypt each
 * channel's newest page with progress. Best-effort throughout; normal runtime
 * paths re-cover anything missed.
 */

import { channelsView } from "@/concord/lib/community";
import { rehydrateCommunity, type CommunityListEntry } from "@/concord/lib/communityList";
import { controlGroups, foldControlState, openControlEditions, controlFoldKey, type FoldedControl } from "@/concord/lib/control";
import { guestbookGroups } from "@/concord/lib/guestbook";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { openChatBatch } from "@/concord/lib/chat";
import { controlSweepTruncated, sweepControl, sweepGuestbook, whenAuthSettled } from "@/concord/lib/planeSync";
import { pruneControlSnapshots, queryPlane, writeRumors } from "@/concord/lib/rumorStore";
import { registerStreamKeys } from "@/concord/lib/streamAuth";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import { beginSyncTask } from "@/lib/syncActivity";
import { t } from "@/i18n/intl";
import { logSync } from "@/lib/syncLog";
import { emitWireScopes } from "@/wire/bus";

import type { Channel, Community } from "@/concord/lib/types";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** Minimal relay-capable Nostr client the warm-up needs (batcher-backed). */
interface NostrLike {
  relay(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  };
}

/**
 * Safety bound on channels decrypted at login (not a working limit); the rest
 * heal via the on-open backfill.
 */
const MAX_WARMUP_CHANNELS = 200;
/** Channel filters per batched REQ; relays commonly cap around 10-20. */
const FILTERS_PER_REQ = 10;
/** Newest-page size per channel per relay (mirrors the channel backfill page). */
const WARMUP_PAGE = 50;
/** Per-REQ network budget. */
const CHANNEL_TIMEOUT_MS = 8_000;

export interface WarmupResult {
  communities: number;
  channels: number;
  /** Rumors decrypted into the store across all channels. */
  messages: number;
}

/**
 * Warm every live community for a freshly logged-in device. Best-effort;
 * `signal` aborts only the channel pulls.
 */
export async function warmupCommunities(
  nostr: NostrLike,
  entries: CommunityListEntry[],
  opts: {
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
    /**
     * Whether retired control-snapshot sets may be dropped. Pass FALSE when
     * several accounts are logged in: pruning by this account's epochs would
     * delete another account's fold anchor.
     */
    pruneSnapshots?: boolean;
  } = {},
): Promise<WarmupResult> {
  const communities: Community[] = [];
  for (const entry of entries) {
    const community = rehydrateCommunity(entry);
    if (community && community.relays.length > 0) communities.push(community);
  }
  const result: WarmupResult = { communities: communities.length, channels: 0, messages: 0 };
  if (communities.length === 0) return result;

  // Also report on the sync-activity signal, so the in-chat bar carries on past the gate's budget.
  const task = beginSyncTask(t({ id: "loginWarmup.messageHistory", defaultMessage: "message history" }));
  try {
    // Keys must register BEFORE the sweeps so NIP-42 challenges cover them.
    for (const c of communities) {
      registerStreamKeys([...controlGroups(c), ...guestbookGroups(c)], c.relays);
    }
    await Promise.all(
      communities.flatMap((c) => [
        sweepControl(nostr, c).catch(() => []),
        sweepGuestbook(nostr, c).catch(() => []),
      ]),
    );

    const jobs = new Map<Community, Channel[]>();
    let totalChannels = 0;
    for (const c of communities) {
      try {
        // Once per session, drop snapshot sets of epochs with no keys (only if
        // this account is the device's sole reader).
        if (opts.pruneSnapshots !== false) {
          void pruneControlSnapshots(c.idHex, controlGroups(c).map((g) => g.pk));
        }
        const stored = await queryPlane(c.idHex, "control");
        // The `@everyone` the last fold held keeps a partial read from demoting the Roster.
        const prior = await readFolded<FoldedControl>(controlFoldKey(c.idHex));
        const held = prior?.rankedRoster && prior.roster.everyone !== undefined ? { everyone: prior.roster.everyone } : undefined;
        const folded = foldControlState(openControlEditions(stored), c.id, c.owner, undefined, undefined, held);
        // Never persist a sweep known to be truncated: it would freeze a partial
        // banlist/roster on disk (plane depth is attacker-controlled).
        if (!controlSweepTruncated(c)) {
          await writeFolded(controlFoldKey(c.idHex), folded);
        }
        emitWireScopes([`c2ctl:${c.idHex}`]);
        for (const channel of channelsView(c, folded)) {
          if (channel.streams.length === 0) continue;
          if (totalChannels >= MAX_WARMUP_CHANNELS) break;
          registerStreamKeys(channel.streams.map((s) => s.group), c.relays);
          const list = jobs.get(c) ?? [];
          list.push(channel);
          jobs.set(c, list);
          totalChannels++;
        }
      } catch (err) {
        logSync("gate", `warmup fold ${c.idHex.slice(0, 8)} FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Newest page per channel: one filter per channel, chunked into batched REQs
    // per relay; results demux by wrap author.
    result.channels = totalChannels;
    let done = 0;
    opts.onProgress?.(0, totalChannels);
    const chunkJobs: Array<Promise<void>> = [];
    for (const [community, channels] of jobs) {
      for (let i = 0; i < channels.length; i += FILTERS_PER_REQ) {
        const chunk = channels.slice(i, i + FILTERS_PER_REQ);
        chunkJobs.push(
          (async () => {
            const groupsOf = () => chunk.flatMap((ch) => ch.streams.map((s) => s.group));
            const filters: NostrFilter[] = chunk.map((ch) => ({
              kinds: [KIND_WRAP],
              authors: ch.streams.map((s) => s.group.pk),
              limit: WARMUP_PAGE,
            }));
            /**
             * Pull one relay's pages, gated on NIP-42: a kind-1059 REQ racing the
             * AUTHs gets CLOSED and reads as empty. If the first round is empty,
             * wait for the acks and re-ask once.
             */
            const pull = async (url: string): Promise<NostrEvent[]> => {
              for (let attempt = 1; attempt <= 2; attempt++) {
                await whenAuthSettled(url, groupsOf);
                try {
                  const events = await nostr.relay(url).query(filters, {
                    signal: AbortSignal.any([
                      ...(opts.signal ? [opts.signal] : []),
                      AbortSignal.timeout(CHANNEL_TIMEOUT_MS),
                    ]),
                  });
                  if (events.length > 0 || attempt === 2) return events;
                } catch {
                  if (attempt === 2) return [];
                }
                await new Promise((r) => setTimeout(r, 250));
              }
              return [];
            };
            try {
              const wraps = (await Promise.all(community.relays.map(pull))).flat();
              // Demux by wrap author, deduped across relays by wrap id.
              const channelByPk = new Map<string, Channel>();
              for (const ch of chunk) for (const s of ch.streams) channelByPk.set(s.group.pk, ch);
              const seen = new Set<string>();
              const byChannel = new Map<Channel, NostrEvent[]>();
              for (const wrap of wraps) {
                if (seen.has(wrap.id)) continue;
                seen.add(wrap.id);
                const ch = channelByPk.get(wrap.pubkey);
                if (!ch) continue;
                const list = byChannel.get(ch) ?? [];
                list.push(wrap);
                byChannel.set(ch, list);
              }
              for (const [ch, chWraps] of byChannel) {
                const opened = await openChatBatch(chWraps, ch);
                if (opened.length > 0) {
                  writeRumors(community.idHex, opened);
                  result.messages += opened.length;
                }
              }
            } catch {
              // Best-effort per chunk — rooms backfill on open.
            } finally {
              done += chunk.length;
              opts.onProgress?.(done, totalChannels);
              task.update({
                detail: t(
                  { id: "loginWarmup.channelProgress", defaultMessage: "{done}/{total} channels" },
                  { done, total: totalChannels },
                ),
              });
            }
          })(),
        );
      }
    }
    await Promise.all(chunkJobs);
    logSync(
      "gate",
      `concord warmup: ${result.communities} community(ies), ${result.channels} channel(s), ${result.messages} rumor(s) decrypted`,
    );
    return result;
  } finally {
    task.end();
  }
}
