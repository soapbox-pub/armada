import { describe, expect, it } from "vitest";

import { isGitContinuation, mergeChannelTimeline } from "./channelTimeline";
import { parseCIRun } from "@/lib/ci";
import type { ChatMsg } from "./transport";
import type { GitStatusKind, GitTicket, GitTimelineActivity } from "@/lib/gitActivity";

const pk = "a".repeat(64);
const chat = (id: string, created_at: number): ChatMsg => ({ id, pubkey: pk, created_at, kind: 9, content: "chat", tags: [] });
const repository = { kind: 30617 as const, owner: pk, identifier: "repo", coordinate: `30617:${pk}:repo` };
const ticketWith = (id: string): GitTicket => ({ id, kind: 1621 as const, type: "issue" as const, subject: "Ticket", content: "", labels: [], repositoryAddresses: [], author: pk, createdAt: 10, event: { id, pubkey: pk, created_at: 10, kind: 1621, content: "", tags: [] } });
const ticket = ticketWith("b".repeat(64));
const git = (id: string, createdAt: number): GitTimelineActivity => ({ type: "comment", createdAt, ticket, repository, comment: { id, ticketId: ticket.id, ticketKind: 1621, content: "comment", author: pk, createdAt, event: { id, pubkey: pk, created_at: createdAt, kind: 1111, content: "comment", tags: [] } } });
const status = (kind: GitStatusKind, createdAt: number, on: GitTicket = ticket): GitTimelineActivity => ({ type: "status-change", createdAt, ticket: on, repository, status: { kind, ticketId: on.id, author: pk, createdAt, event: { id: `s${kind}${createdAt}`.padEnd(64, "0"), pubkey: pk, created_at: createdAt, kind, content: "", tags: [["e", on.id]] } } });
const ciRun = (workflow: string, createdAt: number): GitTimelineActivity => ({
  type: "ci-run",
  createdAt,
  repository,
  run: parseCIRun({ id: `${workflow}${createdAt}`.padEnd(64, "0"), pubkey: pk, created_at: createdAt, kind: 9842, content: "", tags: [["a", repository.coordinate], ["w", `${workflow}.yml`], ["conclusion", "success"]] })!,
});

describe("mixed channel timeline", () => {
  it("slots Git into chat chronologically with a deterministic id tie-break", () => {
    expect(mergeChannelTimeline([chat("a", 10), chat("z", 20)], [git("d", 20), git("c", 20), git("b", 15)]).map((entry) => entry.id))
      .toEqual(["chat:a", "git:b", "chat:z", "git:c", "git:d"]);
  });

  it("keeps the chat order it is given, even within one second", () => {
    // The fold orders by ms and lifts a reply after its parent; whole seconds can't.
    expect(mergeChannelTimeline([chat("z", 20), chat("a", 20), chat("reply", 19)], [git("c", 19)]).map((entry) => entry.id))
      .toEqual(["git:c", "chat:z", "chat:a", "chat:reply"]);
  });

  it("groups only adjacent comments on the same ticket", () => {
    const comments = mergeChannelTimeline([], [git("c", 20), git("d", 21)]);
    expect(isGitContinuation(comments[0], comments[1])).toBe(true);
    const interrupted = mergeChannelTimeline([chat("x", 21)], [git("c", 20), git("d", 22)]);
    expect(isGitContinuation(interrupted[0], interrupted[1])).toBe(false);
  });

  it("groups adjacent status changes on the same ticket, but not across tickets", () => {
    // Closed then reopened is one fact about one ticket: it is open.
    const changes = mergeChannelTimeline([], [status(1632, 30), status(1630, 31)]);
    expect(isGitContinuation(changes[0], changes[1])).toBe(true);
    const across = mergeChannelTimeline([], [status(1632, 30), status(1632, 31, ticketWith("c".repeat(64)))]);
    expect(isGitContinuation(across[0], across[1])).toBe(false);
  });

  it("groups adjacent CI runs across workflows", () => {
    // A push fires every workflow at once; grouping per workflow would
    // interleave runs that then never collapse.
    const runs = mergeChannelTimeline([], [ciRun("test", 40), ciRun("desktop", 41)]);
    expect(isGitContinuation(runs[0], runs[1])).toBe(true);
  });

  it("never groups unlike activity", () => {
    const mixed = mergeChannelTimeline([], [git("c", 50), status(1632, 51), ciRun("test", 52)]);
    expect(isGitContinuation(mixed[0], mixed[1])).toBe(false);
    expect(isGitContinuation(mixed[1], mixed[2])).toBe(false);
  });
});
