/**
 * One shared `{kinds:[21059], "#p":[me]}` REQ per (relay, recipient) for DM
 * ephemeral wraps (typing indicators). The filter names the recipient, not a
 * conversation, so lingering {@link LINGER_MS} after the last consumer keeps
 * conversation switches off the socket. Wraps are deduped across relays.
 * Nothing is stored, so nothing is replayed after a reopen.
 */
import { KIND_DM_WRAP_EPHEMERAL, openDmWrap, type Dm17Signer, type OpenedDm } from "@/lib/nip17/protocol";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { liveSignalSince } from "@/lib/liveSignal";

interface EphemeralNostr {
  relay(url: string): {
    req(
      filters: NostrFilter[],
      opts?: { signal?: AbortSignal },
    ): AsyncIterable<unknown[]>;
  };
}

type Handler = (wrap: NostrEvent) => void;

interface Line {
  handlers: Set<Handler>;
  controller: AbortController;
  /** Pending close once the last handler left. */
  linger?: ReturnType<typeof setTimeout>;
}

/** How long a line with no consumers stays open, to absorb a conversation switch. */
export const LINGER_MS = 30_000;
/** Per-recipient cap on remembered wrap ids, used to drop other relays' copies. */
const SEEN_CAP = 256;

const lines = new Map<string, Line>();
/** Each ephemeral wrap opened once, by id, for every listener and every relay's copy. */
const opened = new Map<string, Promise<OpenedDm | undefined>>();
const seen = new Map<string, Set<string>>();

function firstSighting(recipient: string, id: string): boolean {
  let ids = seen.get(recipient);
  if (!ids) {
    ids = new Set();
    seen.set(recipient, ids);
  }
  if (ids.has(id)) return false;
  ids.add(id);
  if (ids.size > SEEN_CAP) ids.delete(ids.values().next().value as string);
  return true;
}

function open(nostr: EphemeralNostr, relay: string, recipient: string, key: string): Line {
  const line: Line = { handlers: new Set(), controller: new AbortController() };
  const { signal } = line.controller;
  void (async () => {
    try {
      for await (const msg of nostr.relay(relay).req(
        [{ kinds: [KIND_DM_WRAP_EPHEMERAL], "#p": [recipient], since: liveSignalSince() }],
        { signal },
      )) {
        if (msg[0] !== "EVENT") continue;
        const wrap = msg[2] as NostrEvent;
        if (!firstSighting(recipient, wrap.id)) continue;
        for (const handler of [...line.handlers]) {
          try {
            handler(wrap);
          } catch {
            // One consumer's throw must not starve the others.
          }
        }
      }
    } catch (err) {
      // Only a real failure is worth reporting: a relay rejecting kind 21059 otherwise looks like nobody typing.
      if (!signal.aborted) console.warn(`[dm-ephemeral] subscription to ${relay} ended:`, err);
    } finally {
      // A line whose REQ ended on its own is rebuilt by the next subscribe.
      if (lines.get(key) === line) lines.delete(key);
    }
  })();
  return line;
}

/**
 * Open an ephemeral DM wrap, once per wrap however many listeners and relays hand it
 * over: on a signer that prompts, each open is two `nip44_decrypt` requests. Uncached
 * on disk, as before; held in memory only for the last {@link SEEN_CAP} wraps.
 */
export function openDmEphemeral(wrap: NostrEvent, signer: Dm17Signer, self: string): Promise<OpenedDm | undefined> {
  const key = `${self}\u0000${wrap.id}`;
  let hit = opened.get(key);
  if (!hit) {
    hit = openDmWrap(wrap, signer, self, { wrapKind: KIND_DM_WRAP_EPHEMERAL, cache: false }).catch(() => undefined);
    opened.set(key, hit);
    if (opened.size > SEEN_CAP) opened.delete(opened.keys().next().value as string);
  }
  return hit;
}

/** Receive raw ephemeral DM wraps for `recipient` on `relay`. Returns an unsubscribe. */
export function subscribeDmEphemeral(
  nostr: EphemeralNostr,
  relay: string,
  recipient: string,
  handler: Handler,
): () => void {
  const key = `${relay}\u0000${recipient}`;
  let line = lines.get(key);
  if (!line) {
    line = open(nostr, relay, recipient, key);
    lines.set(key, line);
  }
  if (line.linger) {
    clearTimeout(line.linger);
    line.linger = undefined;
  }
  line.handlers.add(handler);

  const held = line;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.handlers.delete(handler);
    if (held.handlers.size > 0 || lines.get(key) !== held) return;
    held.linger = setTimeout(() => {
      if (held.handlers.size > 0) return;
      held.controller.abort();
      if (lines.get(key) === held) lines.delete(key);
    }, LINGER_MS);
  };
}

/** Close every line now — logout must not keep the old account's REQs open. */
export function closeDmEphemeralSubs(): void {
  for (const line of lines.values()) {
    if (line.linger) clearTimeout(line.linger);
    line.controller.abort();
  }
  lines.clear();
  seen.clear();
  opened.clear();
}
