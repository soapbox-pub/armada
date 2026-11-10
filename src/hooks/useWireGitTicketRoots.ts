import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useEventStore } from "@/hooks/useEventStore";
import {
  GIT_ISSUE_KIND,
  GIT_PULL_REQUEST_KIND,
  GIT_STATUS_KINDS,
  NIP22_COMMENT_KIND,
  parseGitComment,
  parseGitStatusEvent,
  matchGitTicketRepository,
  parseGitTicket,
} from "@/lib/gitActivity";
import { isGitAnnouncementDiscoveryRelay, normalizeRelayUrl } from "@/lib/platform";
import { bootLedgers, recordUnits, rootsUnit, ticketChildrenCovered, unitMark, type BootLedger } from "@/wire/bootLedger";
import { useWireScopes } from "@/wire/useWireScopes";

import type { GitRepositoryWireInput } from "@/wire/spec";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { NostrFilter } from "@nostrify/nostrify";
import { nowSecs } from "@/lib/relayClock";

/** A bounded bootstrap is enough to construct dynamic comment/status filters. */
const ROOT_DISCOVERY_LIMIT = 500;
const ROOT_DISCOVERY_TIMEOUT_MS = 8_000;
/** Resume slack behind a covered read's mark: tickets are stamped by other clocks. */
const ROOT_RESUME_OVERLAP_SECONDS = 600;
/** Keep direct child backfill requests at the same conservative size as wire REQs. */
const ROOT_FILTER_CHUNK_SIZE = 100;

/**
 * The roots whose children one relay's backfill must read: those the wire
 * watches there and whose children no past round covered. A root tagging
 * several repositories belongs to the first one the client knows and is
 * watched on that repository's relays only (wire/spec.ts); a read on any other
 * relay can never be marked covered.
 */
export function childBackfillRootIds(
  roots: Iterable<NostrRumor>,
  relayAddresses: ReadonlySet<string>,
  known: ReadonlySet<string>,
  ledger: BootLedger | undefined,
): string[] {
  const out: string[] = [];
  for (const root of roots) {
    const ticket = parseGitTicket(root);
    const owner = ticket ? matchGitTicketRepository(ticket, known)?.coordinate : undefined;
    if (owner !== undefined && relayAddresses.has(owner) && !ticketChildrenCovered(ledger, root.id)) out.push(root.id);
  }
  return out.sort();
}

/**
 * Cache-first root discovery for every actively attached repository. Ignores
 * attachment intervals: older roots' ids are still needed to subscribe to new children.
 */
export function useWireGitTicketRoots(repositories: readonly GitRepositoryWireInput[]): NostrRumor[] {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const active = useMemo(() => repositories
    .filter((repository) => repository.attachments.some(({ attachment }) => attachment.detachedAt === undefined))
    .map((repository) => ({
      address: repository.address,
      relays: [...new Set(repository.relays)].filter((relay) => !isGitAnnouncementDiscoveryRelay(relay)).sort(),
    }))
    .sort((a, b) => a.address.localeCompare(b.address)), [repositories]);
  const signature = active.map((repository) => `${repository.address}:${repository.relays.join(",")}`).join("|");
  const queryKey = ["wire", "git-ticket-roots", signature] as const;

  const query = useQuery<NostrRumor[]>({
    queryKey,
    enabled: active.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const store = await eventStore;
      const addresses = active.map((repository) => repository.address);
      const received = await store.query([{ kinds: [GIT_PULL_REQUEST_KIND, GIT_ISSUE_KIND], "#a": addresses, limit: ROOT_DISCOVERY_LIMIT }]);
      const addressesByRelay = new Map<string, Set<string>>();
      for (const repository of active) {
        for (const relay of repository.relays) {
          let atRelay = addressesByRelay.get(relay);
          if (!atRelay) addressesByRelay.set(relay, (atRelay = new Set()));
          atRelay.add(repository.address);
        }
      }
      // Roots a past read covered come from its mark; the wire streams new ones live.
      await bootLedgers.ready();
      await Promise.all([...addressesByRelay].map(async ([relay, atRelay]) => {
          const ledgerKey = normalizeRelayUrl(relay) ?? relay;
          const startedAt = nowSecs();
          const fresh: string[] = [];
          const covered: string[] = [];
          let oldest = Infinity;
          for (const address of [...atRelay].sort()) {
            const mark = unitMark(bootLedgers.get(ledgerKey), rootsUnit(address));
            if (mark === undefined) fresh.push(address);
            else {
              covered.push(address);
              oldest = Math.min(oldest, mark);
            }
          }
          const filters: NostrFilter[] = [
            ...(fresh.length > 0 ? [{ kinds: [GIT_PULL_REQUEST_KIND, GIT_ISSUE_KIND], "#a": fresh, limit: ROOT_DISCOVERY_LIMIT }] : []),
            ...(covered.length > 0
              ? [{ kinds: [GIT_PULL_REQUEST_KIND, GIT_ISSUE_KIND], "#a": covered, since: oldest - ROOT_RESUME_OVERLAP_SECONDS, limit: ROOT_DISCOVERY_LIMIT }]
              : []),
          ];
          try {
            let complete = false;
            for await (const msg of nostr.relay(relay).req(filters, { signal: AbortSignal.timeout(ROOT_DISCOVERY_TIMEOUT_MS) })) {
              if (msg[0] === "EOSE") {
                complete = true;
                break;
              }
              if (msg[0] !== "EVENT") continue;
              const event = msg[2];
              const ticket = parseGitTicket(event);
              if (!ticket || !matchGitTicketRepository(ticket, atRelay)) continue;
              await store.event(event).catch(() => undefined);
              received.push(event);
            }
            // `req` ends quietly on CLOSED, so only a real EOSE vouches for the read.
            if (complete) {
              const ledger = recordUnits(
                bootLedgers.get(ledgerKey),
                new Set([...atRelay].map(rootsUnit)),
                startedAt,
                nowSecs(),
              );
              if (ledger) bootLedgers.set(ledgerKey, ledger);
            }
          } catch {
            // Cache data and other activity relays remain useful.
          }
      }));
      const roots = new Map<string, NostrRumor>();
      const activeAddresses = new Set(active.map((repository) => repository.address));
      for (const event of received) {
        const ticket = parseGitTicket(event);
        if (ticket && matchGitTicketRepository(ticket, activeAddresses)) roots.set(event.id, event);
      }

      // Standing child filters' cursor replay can't recover children predating
      // the relay cursor, so backfill children directly — for roots the wire's
      // ledger hasn't covered on this relay (covered ones resume from their mark).
      await bootLedgers.ready();
      const known = new Set(repositories.map((repository) => repository.address));
      await Promise.all([...addressesByRelay].map(async ([relay, atRelay]) => {
        const ledger = bootLedgers.get(normalizeRelayUrl(relay) ?? relay);
        const rootIds = childBackfillRootIds(roots.values(), atRelay, known, ledger);
        for (let offset = 0; offset < rootIds.length; offset += ROOT_FILTER_CHUNK_SIZE) {
          const ids = rootIds.slice(offset, offset + ROOT_FILTER_CHUNK_SIZE);
          try {
            const children = await nostr.relay(relay).query(
              [
                { kinds: [NIP22_COMMENT_KIND], "#E": ids, limit: ROOT_DISCOVERY_LIMIT },
                { kinds: [...GIT_STATUS_KINDS], "#e": ids, limit: ROOT_DISCOVERY_LIMIT },
              ],
              { signal: AbortSignal.timeout(ROOT_DISCOVERY_TIMEOUT_MS) },
            );
            for (const child of children) {
              const comment = parseGitComment(child);
              const status = parseGitStatusEvent(child);
              if ((!comment || !roots.has(comment.ticketId)) && (!status || !roots.has(status.ticketId))) continue;
              await store.event(child).catch(() => undefined);
            }
          } catch {
            // The standing child subscription and other activity relays remain useful.
          }
        }
      }));
      // Backfill bypasses wire ingestion, so refresh activity queries explicitly.
      await queryClient.invalidateQueries({ queryKey: ["git", "channel-activity"] });
      return [...roots.values()].sort((a, b) => a.id.localeCompare(b.id));
    },
  });

  useWireScopes((scopes) => {
    // Not `git:`: every comment, status and CI run fires that, and each refetch
    // re-reads every root and child from every relay.
    if (active.some((repository) => scopes.has(`gitroot:${repository.address}`))) {
      void queryClient.invalidateQueries({ queryKey });
    }
  });

  return query.data ?? [];
}
