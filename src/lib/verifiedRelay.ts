/**
 * A relay whose EVENTs are verified in batches off the socket handler (and,
 * for bursts, off the main thread via verifyPool). NRelay1 otherwise verifies
 * synchronously per message (~2ms each, seconds on a cold sync).
 *
 * Order is the contract: EVENT/EOSE/CLOSED share one FIFO per relay so an EOSE
 * can't overtake a late-verified EVENT. AUTH/OK/NOTICE/COUNT dispatch
 * immediately so NIP-42 challenges aren't stuck behind a backlog.
 */

import { NRelay1, type NRelay1Opts } from "@nostrify/nostrify";
import type { NostrEvent, NostrRelayMsg } from "@nostrify/types";
import { getEventHash } from "nostr-tools/pure";

import { relayMsgSchema } from "./relayMsgParse";
import { type EcVerifyBatch, verifyEventsOnce } from "./verifyCache";
import { ecVerifyBatch } from "./verifyPool";

// Replace NRelay1's zod frame parser app-wide with the hand-written one (same verdicts).
(NRelay1 as unknown as { msgSchema: typeof relayMsgSchema }).msgSchema = relayMsgSchema;

export interface RelayInboxOpts {
  /** Events delivered without a signature check (NIP-59 wraps; decrypt re-checks — see `NostrProvider`). Their id must still be their hash. */
  skipVerify?: (event: NostrEvent) => boolean;
  /** The EC verifier for the memo's residue. Default: the worker pool. */
  ecVerify?: EcVerifyBatch;
}

function idIsHash(event: NostrEvent): boolean {
  try {
    return getEventHash(event) === event.id;
  } catch {
    return false;
  }
}

/** Messages whose delivery must keep wire order relative to one another. */
function isOrdered(msg: NostrRelayMsg): boolean {
  return msg[0] === "EVENT" || msg[0] === "EOSE" || msg[0] === "CLOSED";
}

/** The ordered, batching front of a relay connection; standalone for testability. */
export class RelayInbox {
  private pending: NostrRelayMsg[] = [];
  private draining = false;
  private readonly skipVerify: (event: NostrEvent) => boolean;
  private readonly ecVerify: EcVerifyBatch;

  constructor(
    private readonly dispatch: (msg: NostrRelayMsg) => void,
    opts: RelayInboxOpts = {},
  ) {
    this.skipVerify = opts.skipVerify ?? (() => false);
    this.ecVerify = opts.ecVerify ?? ecVerifyBatch;
  }

  push(msg: NostrRelayMsg): void {
    if (!isOrdered(msg)) {
      this.deliver(msg);
      return;
    }
    this.pending.push(msg);
    if (!this.draining) void this.drain();
  }

  /** Whether anything is queued or a verify round is in flight. */
  get busy(): boolean {
    return this.draining || this.pending.length > 0;
  }

  private deliver(msg: NostrRelayMsg): void {
    try {
      this.dispatch(msg);
    } catch {
      // A listener's failure must not stall the queue.
    }
  }

  private needsVerify(msg: NostrRelayMsg): msg is ["EVENT", string, NostrEvent] {
    return msg[0] === "EVENT" && !this.skipVerify(msg[2]);
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        // Take everything accumulated while the previous verify was awaited.
        const batch = this.pending;
        this.pending = [];
        const events: NostrEvent[] = [];
        for (const msg of batch) if (this.needsVerify(msg)) events.push(msg[2]);
        // Never throws: a dead verifier yields "unverified", dropping those events.
        const verdicts = events.length > 0 ? await verifyEventsOnce(events, this.ecVerify) : [];
        let k = 0;
        for (const msg of batch) {
          if (msg[0] === "EVENT") {
            if (!this.skipVerify(msg[2])) {
              if (verdicts[k++] !== true) continue;
            } else if (!idIsHash(msg[2])) {
              // A skipped event's signature proves nothing, but its id still keys
              // every dedupe and failure memo downstream: an event naming a real
              // wrap's id over junk content would shadow that wrap.
              continue;
            }
          }
          this.deliver(msg);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

export interface VerifiedRelayOpts extends Omit<NRelay1Opts, "verifyEvent">, RelayInboxOpts {}

/** `NRelay1` with its EVENT verification routed through a {@link RelayInbox}. */
export class VerifiedRelay extends NRelay1 {
  private readonly inbox: RelayInbox;

  constructor(url: string, opts: VerifiedRelayOpts = {}) {
    const { skipVerify, ecVerify, ...relayOpts } = opts;
    // Replaced, not disabled: the inbox verifies before `super.receive`.
    super(url, { ...relayOpts, verifyEvent: () => true });
    this.inbox = new RelayInbox((msg) => super.receive(msg), { skipVerify, ecVerify });
  }

  protected override receive(msg: NostrRelayMsg): void {
    this.inbox.push(msg);
  }
}
