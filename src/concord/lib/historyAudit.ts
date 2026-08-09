/**
 * Concord history audit — the completeness gate behind "ensure perfect history
 * before acting".
 *
 * A serverless, E2EE community has no authoritative backend to ask "did I get
 * everything?", and — as `planeSync.ts` states outright — NO client can prove a
 * relay handed over every event it holds: an EOSE is the relay's word, not a
 * proof of exhaustion. So this module deliberately does NOT claim mathematical
 * completeness. It produces the honest, actionable thing instead: a report that
 *
 *   1. names the coverage actually achieved — every channel across every held
 *      epoch, which relays answered, which epochs paged to their floor — from
 *      facts the orchestrator collected while it swept (this file is pure and
 *      does no I/O; the hook feeds it what the sweeps learned);
 *   2. names every gap this client CAN prove intrinsically — a reply whose
 *      thread root we never fetched, or an edit to a message we don't hold, is
 *      hard evidence of missing history regardless of what any relay claims —
 *      plus the fold's own data-availability self-facts (`FoldedControl.
 *      incomplete`, control-sweep truncation, relay quorum);
 *   3. reduces the two to a single {@link HistoryReport.ready} verdict with
 *      explicit {@link Blocker}s, so an action gate refuses on a KNOWN-incomplete
 *      view rather than on an empty read it can't tell from a failed one — the
 *      hazard the whole codebase keeps flagging (an empty read is
 *      indistinguishable from a cold-pool / AUTH / wrong-relay-set failure).
 *
 * "As complete as this client can establish, with every provable gap named" is
 * the strongest true claim available, and it is the one a moderator, a rekey, a
 * compaction, or a replaceable-list publish should be gated on.
 */

import { eTargetOf, replyTargetOf, type OpenedChat } from "@/concord/lib/chat";
import { KIND_COMMENT, KIND_EDIT } from "@/concord/lib/kinds";

// ── Coverage facts (collected by the orchestrator, judged here) ──────────────

/** One relay's participation in a sweep — what it answered, not what it holds. */
export interface RelayCoverage {
  url: string;
  /** The relay responded to at least one REQ (an EOSE or events); silence is not. */
  answered: boolean;
  /** A REQ to it errored or timed out — its slice of the address space is unread. */
  failed: boolean;
}

/** One held epoch's coverage for a single channel. */
export interface EpochCoverage {
  /** The epoch, as a decimal string (bigint doesn't survive JSON, and this is a key). */
  epoch: string;
  /** Opened rumors (all kinds) attributed to this epoch in the collected set. */
  messageCount: number;
  /** A REQ was issued at this epoch's stream address (vs. skipped as unheld). */
  queried: boolean;
  /**
   * The epoch's address paged to its floor on at least a quorum of relays — the
   * orchestrator kept requesting older pages until a page came back short. This
   * is the strongest exhaustion signal available, and still not a proof (a relay
   * that under-serves a full page reads as a floor); it is why the report treats
   * a non-exhausted queried epoch as a blocker rather than trusting a first EOSE.
   */
  exhausted: boolean;
}

/**
 * References a channel's collected rumors make to rumors NOT in the collected
 * set — the intrinsic, relay-independent evidence of missing history.
 *
 * Only the two forms that name a MESSAGE are counted, because only they prove a
 * hole: a reply's thread root and an edit's target are both messages that must
 * exist. Reactions, zaps, votes, and deletes are deliberately excluded — their
 * target may have been legitimately deleted (a delete physically removes its
 * target from the store), so an absent target there is expected, not a gap, and
 * counting it would cry wolf on every healthy community.
 */
export interface DanglingRefs {
  /** kind-1111 thread roots (`E`) absent from the set — a missing parent message. */
  replyTargets: string[];
  /** kind-3302 edit targets (`e`) absent from the set — a missing edited message. */
  editTargets: string[];
}

/** Everything the orchestrator collected for one channel, for the audit to judge. */
export interface ChannelCollection {
  channelIdHex: string;
  name: string;
  isPrivate: boolean;
  deleted: boolean;
  /** Raw opened rumors, ALL kinds (pre-fold) — the dangling analysis needs the side events. */
  opened: OpenedChat[];
  /** Surviving timeline messages after {@link foldTimeline} — the export/count basis. */
  messageCount: number;
  /** Every held epoch a REQ was issued at, as decimal strings. */
  queriedEpochs: string[];
  /** The subset of {@link queriedEpochs} that paged to their floor on a quorum. */
  exhaustedEpochs: string[];
  /** Per-relay participation for this channel's sweep. */
  relays: RelayCoverage[];
}

/** Control-plane completeness facts, mostly lifted from the sweep + fold. */
export interface ControlCollection {
  /**
   * `FoldedControl.incomplete` — entities the served editions could not account
   * for (gap-held chains, or zero served editions). A Refounding MUST NOT
   * compact while this is non-empty (CORD-06 §3), so it is a hard blocker.
   */
  incompleteEntities: string[];
  /** The control sweep stopped on this client's own event budget, not at a floor. */
  truncated: boolean;
  /** Enough of the community's relays answered the control sweep to trust coverage. */
  quorum: boolean;
  relays: RelayCoverage[];
  /** Folded channel count (deleted included) — reported for the human summary. */
  channelCount: number;
  /** Folded grant count — reported for the human summary. */
  memberCount: number;
}

// ── The report ───────────────────────────────────────────────────────────────

export type BlockerKind =
  | "no-relays"
  | "control-incomplete"
  | "control-truncated"
  | "control-no-quorum"
  | "control-relay-failures"
  | "channel-not-exhausted"
  | "channel-relay-failures"
  | "dangling-references";

/** One reason the collected view is (or might be) incomplete. */
export interface Blocker {
  kind: BlockerKind;
  /** Human-readable specifics for the report UI. */
  detail: string;
  /** Set when the blocker is scoped to one channel. */
  channelIdHex?: string;
}

/** One channel's audited coverage. */
export interface ChannelAudit {
  channelIdHex: string;
  name: string;
  isPrivate: boolean;
  deleted: boolean;
  messageCount: number;
  /** All opened rumors including reactions/edits/deletes (the raw volume swept). */
  rawCount: number;
  epochs: EpochCoverage[];
  relays: RelayCoverage[];
  dangling: DanglingRefs;
  /**
   * Every queried epoch reached its floor AND no relay failed this channel.
   * A `false` here is a {@link BlockerKind} `"channel-not-exhausted"`.
   */
  exhausted: boolean;
}

/** The control plane's audited coverage. */
export interface ControlAudit {
  incompleteEntities: string[];
  truncated: boolean;
  quorum: boolean;
  relays: RelayCoverage[];
  channelCount: number;
  memberCount: number;
}

export interface HistoryReport {
  communityIdHex: string;
  /** When the audit was computed (epoch ms). */
  generatedAtMs: number;
  control: ControlAudit;
  channels: ChannelAudit[];
  /** Sum of surviving timeline messages across channels. */
  totalMessages: number;
  /**
   * No blockers: the collected view is as complete as this client can
   * establish, and it is safe to act on. Warnings may still be present — they
   * are disclosed, not disqualifying.
   */
  ready: boolean;
  /** Reasons the view is known-incomplete; a non-empty list makes `ready` false. */
  blockers: Blocker[];
  /** Disclosed-but-non-fatal facts (e.g. dangling refs, when not gated as blocking). */
  warnings: Blocker[];
}

export interface AuditOptions {
  /**
   * Treat dangling references as a hard blocker rather than a warning. Off by
   * default: a healthy community can carry a reply into an epoch this member
   * was never given (a private channel's pre-join history), so a dangling ref
   * is disclosed but does not by itself block ordinary actions. A caller about
   * to COMPACT (which drops anything it can't fold) sets this true.
   */
  danglingIsBlocker?: boolean;
  /**
   * Require every queried epoch to have paged to its floor. On by default; a
   * caller that only wants a coverage snapshot (not a gate) can turn it off.
   */
  requireChannelExhaustion?: boolean;
}

export interface AuditInput {
  communityIdHex: string;
  control: ControlCollection;
  channels: ChannelCollection[];
  /** Clock injection for deterministic tests; defaults to `Date.now()`. */
  now?: number;
  options?: AuditOptions;
}

// ── The audit ────────────────────────────────────────────────────────────────

/**
 * Compute a channel's dangling references: reply thread roots and edit targets
 * that name a rumor absent from the channel's own collected set. Scoped per
 * channel because the Chat-plane binding (CORD-03 §3) keeps a rumor's
 * references within the channel that sealed it — a cross-channel target would
 * itself be a binding violation, not a completeness gap.
 */
export function danglingRefsOf(opened: OpenedChat[]): DanglingRefs {
  const present = new Set(opened.map((o) => o.rumorId));
  const replyTargets = new Set<string>();
  const editTargets = new Set<string>();
  for (const ev of opened) {
    if (ev.kind === KIND_COMMENT) {
      const root = replyTargetOf(ev);
      if (root && !present.has(root)) replyTargets.add(root);
    } else if (ev.kind === KIND_EDIT) {
      const target = eTargetOf(ev);
      if (target && !present.has(target)) editTargets.add(target);
    }
  }
  return { replyTargets: [...replyTargets], editTargets: [...editTargets] };
}

/** Tally opened rumors per epoch, from each rumor's verified `epoch` coordinate. */
function epochCounts(opened: OpenedChat[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ev of opened) {
    const key = ev.epoch.toString();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function auditChannel(c: ChannelCollection, opts: Required<AuditOptions>): ChannelAudit {
  const counts = epochCounts(c.opened);
  const queried = new Set(c.queriedEpochs);
  const exhaustedEpochs = new Set(c.exhaustedEpochs);
  // Union every epoch we have evidence of: one we issued a REQ at, plus any an
  // opened rumor claims (a rumor from an epoch we didn't think to query is
  // itself coverage worth reporting).
  const epochKeys = new Set<string>([...queried, ...counts.keys()]);
  const epochs: EpochCoverage[] = [...epochKeys]
    .sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : BigInt(a) > BigInt(b) ? -1 : 0))
    .map((epoch) => ({
      epoch,
      messageCount: counts.get(epoch) ?? 0,
      queried: queried.has(epoch),
      exhausted: exhaustedEpochs.has(epoch),
    }));

  const dangling = danglingRefsOf(c.opened);
  // A channel is exhausted when every epoch we QUERIED reached its floor and no
  // relay failed. Epochs we merely observed rumors from (never queried) don't
  // gate — we can't be asked to exhaust an address we didn't sweep.
  const allQueriedExhausted = c.queriedEpochs.every((e) => exhaustedEpochs.has(e));
  const exhausted =
    !opts.requireChannelExhaustion ||
    (allQueriedExhausted && !c.relays.some((r) => r.failed));

  return {
    channelIdHex: c.channelIdHex,
    name: c.name,
    isPrivate: c.isPrivate,
    deleted: c.deleted,
    messageCount: c.messageCount,
    rawCount: c.opened.length,
    epochs,
    relays: c.relays,
    dangling,
    exhausted,
  };
}

/**
 * Judge a collected view into a {@link HistoryReport}. Pure and deterministic:
 * the same collected facts always yield the same verdict, so two members (or the
 * app and a test) never disagree about whether it is safe to act.
 */
export function auditHistory(input: AuditInput): HistoryReport {
  const opts: Required<AuditOptions> = {
    danglingIsBlocker: input.options?.danglingIsBlocker ?? false,
    requireChannelExhaustion: input.options?.requireChannelExhaustion ?? true,
  };
  const now = input.now ?? Date.now();

  const channels = input.channels.map((c) => auditChannel(c, opts));
  const blockers: Blocker[] = [];
  const warnings: Blocker[] = [];

  // ── Control plane ──
  const control: ControlAudit = {
    incompleteEntities: input.control.incompleteEntities,
    truncated: input.control.truncated,
    quorum: input.control.quorum,
    relays: input.control.relays,
    channelCount: input.control.channelCount,
    memberCount: input.control.memberCount,
  };
  if (control.relays.length === 0) {
    blockers.push({ kind: "no-relays", detail: "the community has no readable relays" });
  }
  if (control.incompleteEntities.length > 0) {
    blockers.push({
      kind: "control-incomplete",
      detail: `${control.incompleteEntities.length} control entit${control.incompleteEntities.length === 1 ? "y is" : "ies are"} gap-held or unserved`,
    });
  }
  if (control.truncated) {
    blockers.push({
      kind: "control-truncated",
      detail: "the control sweep stopped on the local event budget before reaching the plane floor",
    });
  }
  if (!control.quorum) {
    blockers.push({
      kind: "control-no-quorum",
      detail: "too few of the community's relays answered the control sweep to trust coverage",
    });
  } else if (control.relays.some((r) => r.failed)) {
    warnings.push({
      kind: "control-relay-failures",
      detail: `${control.relays.filter((r) => r.failed).length} relay(s) failed the control sweep (quorum still met)`,
    });
  }

  // ── Channels ──
  for (const ch of channels) {
    if (opts.requireChannelExhaustion && !ch.exhausted) {
      const unreached = ch.epochs.filter((e) => e.queried && !e.exhausted).map((e) => e.epoch);
      blockers.push({
        kind: unreached.length ? "channel-not-exhausted" : "channel-relay-failures",
        detail: unreached.length
          ? `#${ch.name}: epoch(s) ${unreached.join(", ")} did not page to their floor`
          : `#${ch.name}: a relay failed mid-sweep, leaving part of the channel unread`,
        channelIdHex: ch.channelIdHex,
      });
    }
    const danglingCount = ch.dangling.replyTargets.length + ch.dangling.editTargets.length;
    if (danglingCount > 0) {
      const b: Blocker = {
        kind: "dangling-references",
        detail: `#${ch.name}: ${danglingCount} reference(s) to message(s) not in the collected history`,
        channelIdHex: ch.channelIdHex,
      };
      (opts.danglingIsBlocker ? blockers : warnings).push(b);
    }
  }

  const totalMessages = channels.reduce((n, c) => n + c.messageCount, 0);
  return {
    communityIdHex: input.communityIdHex,
    generatedAtMs: now,
    control,
    channels,
    totalMessages,
    ready: blockers.length === 0,
    blockers,
    warnings,
  };
}

/** A one-line human summary of a report's verdict, for logs and toasts. */
export function summarizeReport(report: HistoryReport): string {
  const scope = `${report.channels.length} channel(s), ${report.totalMessages} message(s)`;
  if (report.ready) {
    const warn = report.warnings.length ? `, ${report.warnings.length} warning(s)` : "";
    return `history complete for this client: ${scope}${warn}`;
  }
  return `history INCOMPLETE (${report.blockers.length} blocker(s)): ${scope}`;
}
