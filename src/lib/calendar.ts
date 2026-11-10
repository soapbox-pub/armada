/**
 * Transport-agnostic NIP-52 calendar logic shared by NIP-29 and Concord
 * (CORD.md "Calendar Events"), mirroring `polls.ts`: only event sourcing and
 * publishing differ per transport; the math agrees bit-for-bit.
 */

import type { NostrRumor } from "@/lib/nostrRumor";

import {
  type CalendarEvent,
  type CalendarEventInput,
  KIND_CALENDAR_TIME,
  parseCalendarEvent,
  type RsvpStatus,
} from "@/lib/nip29";
import { nowSecs } from "@/lib/relayClock";

export {
  KIND_CALENDAR_DATE,
  KIND_CALENDAR_TIME,
  KIND_CALENDAR_RSVP,
  randomCalendarId,
  parseCalendarEvent,
  parseRsvpStatus,
  formatCalendarEventWhen,
  calendarEventCoord,
} from "@/lib/nip29";
export type { CalendarEvent, CalendarEventInput, CalendarParticipant, RsvpStatus } from "@/lib/nip29";

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * NIP-52 tags for a calendar event (kind 31922/31923) without transport binding;
 * each transport adds its own (`h` or sealed `channel`/`epoch`).
 */
export function buildCalendarTags(input: CalendarEventInput): string[][] {
  const tags: string[][] = [
    ["d", input.identifier],
    ["title", input.title],
    ["start", input.start],
  ];
  if (input.end) tags.push(["end", input.end]);
  if (input.kind === KIND_CALENDAR_TIME && input.startTzid) tags.push(["start_tzid", input.startTzid]);
  if (input.summary) tags.push(["summary", input.summary]);
  if (input.image) tags.push(["image", input.image]);
  if (input.location) tags.push(["location", input.location]);
  for (const t of input.hashtags ?? []) if (t.trim()) tags.push(["t", t.trim()]);
  for (const r of input.references ?? []) if (r.trim()) tags.push(["r", r.trim()]);
  for (const p of input.participants ?? []) {
    if (!HEX64.test(p.pubkey)) continue;
    const t = ["p", p.pubkey, p.relay ?? ""];
    if (p.role) t.push(p.role);
    tags.push(t);
  }
  return tags;
}

/** Sort key for a calendar event: its start as an epoch second. */
export function startEpoch(e: CalendarEvent): number {
  if (e.kind === KIND_CALENDAR_TIME) return Number(e.start) || 0;
  // Date-based: parse YYYY-MM-DD as UTC midnight.
  const ms = Date.parse(`${e.start}T00:00:00Z`);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

/** End of an event in epoch seconds, falling back to its start. */
export function endEpoch(e: CalendarEvent): number {
  if (!e.end) return startEpoch(e);
  if (e.kind === KIND_CALENDAR_TIME) return Number(e.end) || startEpoch(e);
  const ms = Date.parse(`${e.end}T00:00:00Z`);
  return Number.isNaN(ms) ? startEpoch(e) : Math.floor(ms / 1000);
}

/** True if the event has not yet ended (upcoming or in progress). */
export function isUpcoming(e: CalendarEvent, now = nowSecs()): boolean {
  return endEpoch(e) >= now;
}

/**
 * Parse a batch of calendar-kind events into {@link CalendarEvent}s: keep the
 * newest per addressable coordinate (`kind:pubkey:d`), drop malformed ones, and
 * sort soonest-first. Shared by the relay query and the sealed-fold adapter.
 */
export function parseCalendarEvents(events: NostrRumor[]): CalendarEvent[] {
  const newest = new Map<string, NostrRumor>();
  for (const event of events) {
    const d = event.tags.find(([n]) => n === "d")?.[1] ?? "";
    const coord = `${event.kind}:${event.pubkey}:${d}`;
    const existing = newest.get(coord);
    if (!existing || existing.created_at < event.created_at) newest.set(coord, event);
  }
  const parsed: CalendarEvent[] = [];
  for (const event of newest.values()) {
    const c = parseCalendarEvent(event);
    if (c) parsed.push(c);
  }
  parsed.sort((a, b) => startEpoch(a) - startEpoch(b));
  return parsed;
}

/** A single member's RSVP, normalized off the underlying event/rumor shape. */
export interface RsvpVote {
  pubkey: string;
  status: RsvpStatus;
  /** Epoch milliseconds; latest per pubkey wins. */
  ms: number;
}

/** The tallied RSVPs for one event. */
export interface RsvpTally {
  accepted: string[];
  declined: string[];
  tentative: string[];
  mine?: RsvpStatus;
}

/** Tally RSVPs: latest per pubkey wins, bucketed by status. Deterministic across members. */
export function tallyRsvps(votes: RsvpVote[], selfPubkey: string | undefined): RsvpTally {
  const latest = new Map<string, RsvpVote>();
  for (const vote of votes) {
    const existing = latest.get(vote.pubkey);
    if (!existing || vote.ms > existing.ms) latest.set(vote.pubkey, vote);
  }
  const out: RsvpTally = { accepted: [], declined: [], tentative: [] };
  for (const vote of latest.values()) {
    out[vote.status].push(vote.pubkey);
    if (selfPubkey && vote.pubkey === selfPubkey) out.mine = vote.status;
  }
  return out;
}

/** The calendar analog of `ChatTransport`, implemented by NIP-29 and Concord. */
export interface CalendarTransport {
  events: CalendarEvent[];
  canModerate: boolean;
  canRsvp: boolean;
  isSaving: boolean;
  isSettingRsvp: boolean;
  /** Create a new event (or, for addressable transports, replace `prev`). */
  save: (input: CalendarEventInput, prev?: NostrRumor) => Promise<void>;
  /** Delete an event (author always; others require moderation). */
  remove: (event: CalendarEvent) => Promise<void>;
  /** The resolved RSVP tally for one event (precomputed; no I/O). */
  rsvpsFor: (event: CalendarEvent) => RsvpTally;
  setRsvp: (event: CalendarEvent, status: RsvpStatus) => void;
}
