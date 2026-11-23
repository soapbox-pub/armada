/**
 * One standing kind-21059 REQ per relay, merged across channels. Presence (mounted
 * per sidebar row), reactions, and typing each tail a channel's stream address; a
 * REQ per (channel, relay) cost dozens of REQs at boot, and NostrBatcher can't
 * merge distinct authors. Each relay carries ONE `authors×N` REQ, reopened
 * (debounced) when the set changes; events demux by `event.pubkey` (the wrap
 * signer IS the stream address). Ephemeral wraps are never stored, so a reopen
 * gap only loses a heartbeat the next interval resends.
 */
import { KIND_WRAP_EPHEMERAL } from "@/concord/lib/kinds";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** What this module needs of the app's Nostr client. */
interface EphemeralNostr {
  relay(url: string): {
    req(
      filters: NostrFilter[],
      opts?: { signal?: AbortSignal },
    ): AsyncIterable<unknown[]>;
  };
}

type Handler = (event: NostrEvent) => void;

interface RelayLine {
  authors: Map<string, Set<Handler>>;
  controller?: AbortController;
  /** Sorted author set the open REQ was built from, to skip no-op reopens. */
  openedAuthors: string;
  timer?: ReturnType<typeof setTimeout>;
}

const lines = new Map<string, RelayLine>();

/**
 * Wraps this client published and needs no echo of (its own typing): each relay
 * sends them back, and opening one costs a seal verify and two decryptions only
 * for every handler to discard it. Ids, bounded FIFO.
 */
const OWN_ECHOES_MAX = 256;
const ownEchoes = new Set<string>();

/** Drop the relays' echo of wrap `id`, which this client is about to publish. */
export function ignoreEcho(id: string): void {
  if (ownEchoes.size >= OWN_ECHOES_MAX) ownEchoes.delete(ownEchoes.values().next().value!);
  ownEchoes.add(id);
}

/** How long a (un)subscribe burst may grow before the REQ is (re)opened. */
const REOPEN_MS = 50;

/**
 * Tail ephemeral wraps authored by `author` (a channel's current stream pk) on
 * `relay`. Returns an unsubscribe. Handlers get raw 21059 wraps, only their own
 * channel's.
 */
export function subscribeEphemeral(
  nostr: EphemeralNostr,
  relay: string,
  author: string,
  handler: Handler,
): () => void {
  let line = lines.get(relay);
  if (!line) {
    line = { authors: new Map(), openedAuthors: "" };
    lines.set(relay, line);
  }
  let handlers = line.authors.get(author);
  if (!handlers) {
    handlers = new Set();
    line.authors.set(author, handlers);
  }
  handlers.add(handler);
  schedule(nostr, relay);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = lines.get(relay);
    if (!current) return;
    const set = current.authors.get(author);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) current.authors.delete(author);
    schedule(nostr, relay);
  };
}

function schedule(nostr: EphemeralNostr, relay: string): void {
  const line = lines.get(relay);
  if (!line || line.timer) return;
  line.timer = setTimeout(() => {
    line.timer = undefined;
    reopen(nostr, relay);
  }, REOPEN_MS);
}

function reopen(nostr: EphemeralNostr, relay: string): void {
  const line = lines.get(relay);
  if (!line) return;

  const authors = [...line.authors.keys()].sort();
  const key = authors.join(",");
  if (key === line.openedAuthors && line.controller) return;

  line.controller?.abort();
  line.controller = undefined;
  line.openedAuthors = key;

  if (authors.length === 0) {
    lines.delete(relay);
    return;
  }

  const controller = new AbortController();
  line.controller = controller;
  void (async () => {
    try {
      for await (const msg of nostr.relay(relay).req(
        [{ kinds: [KIND_WRAP_EPHEMERAL], authors }],
        { signal: controller.signal },
      )) {
        if (msg[0] !== "EVENT") continue;
        const event = msg[2] as NostrEvent;
        if (ownEchoes.has(event.id)) continue;
        // Demux strictly by wrap author.
        const handlers = lines.get(relay)?.authors.get(event.pubkey);
        if (!handlers) continue;
        for (const handler of [...handlers]) {
          try {
            handler(event);
          } catch {
            // One consumer's throw must not starve the others.
          }
        }
      }
    } catch {
      // Ended (abort, socket loss): the relay layer re-REQs live sockets; a torn line
      // is rebuilt by the next (un)subscribe.
    }
  })();
}
