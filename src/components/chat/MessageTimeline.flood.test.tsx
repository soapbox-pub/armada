/**
 * A flood folds into one row, and stays reachable.
 *
 * The distinction this file exists to hold is between HIDDEN and REMOVED. The
 * detector upstream (`floodCluster.ts`) is a heuristic over content and arrival
 * time, so it will sometimes fold up a wave of real newcomers — which is
 * acceptable only for as long as one click gets them back. If any assertion
 * here ever has to be relaxed to "the message is gone", the feature has turned
 * into a second author-identity drop beside the Banlist and should be removed
 * instead.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { MessageTimeline } from "@/components/chat/MessageTimeline";
import { MutedPubkeysContext } from "@/contexts/MutedPubkeysContext";

import type { ChannelTimelineEntry } from "@/components/chat/channelTimeline";
import type { ChatMsg, ChatTransport } from "@/components/chat/transport";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

const DAY = 86_400;

function message(id: string, createdAt: number, pubkey: string): ChatMsg {
  return { id, pubkey, created_at: createdAt, kind: 9, content: `msg ${id}`, tags: [], sig: "" } as unknown as ChatMsg;
}

function chatEntry(msg: ChatMsg): ChannelTimelineEntry {
  return { type: "chat", id: `chat:${msg.id}`, createdAt: msg.created_at, message: msg } as ChannelTimelineEntry;
}

/** `n` messages from distinct authors, one second apart from `from`. */
function flood(n: number, from: number, prefix = "f") {
  return Array.from({ length: n }, (_, i) =>
    message(`${prefix}${i}`, from + i, `${prefix}${i}`.padEnd(64, "0")),
  );
}

function renderTimeline(
  msgs: ChatMsg[],
  quarantined: string[],
  newDividerId?: string,
  why: { ruled?: string[]; paused?: string[] } = {},
) {
  const transport: ChatTransport = {
    messages: msgs,
    isLoading: false,
    canWrite: true,
    canModerate: false,
    quarantinedIds: new Set(quarantined),
    ...(why.ruled ? { ruledIds: new Set(why.ruled) } : {}),
    ...(why.paused ? { pausedIds: new Set(why.paused) } : {}),
  };
  return render(
    <MutedPubkeysContext.Provider value={{ mutedPubkeys: new Set<string>(), ready: true }}>
      <MessageTimeline
        transport={transport}
        entries={msgs.map(chatEntry)}
        newDividerId={newDividerId}
        renderMessage={(msg) => <span>chat:{msg.id}</span>}
        emptyState={<span>nothing here</span>}
      />
    </MutedPubkeysContext.Provider>,
  );
}

describe("MessageTimeline flood collapse", () => {
  it("folds a run into one row that names what it is holding", async () => {
    const msgs = flood(10, 1000);
    renderTimeline(msgs, msgs.map((m) => m.id));

    expect(await screen.findByRole("button", { name: /10 similar messages from 10 accounts/i })).toBeInTheDocument();
    for (const m of msgs) expect(screen.queryByText(`chat:${m.id}`)).not.toBeInTheDocument();
  });

  it("gives them all back on one click, and folds them away again", async () => {
    const msgs = flood(10, 1000);
    renderTimeline(msgs, msgs.map((m) => m.id));

    fireEvent.click(await screen.findByRole("button", { name: /10 similar messages/i }));
    for (const m of msgs) expect(screen.getByText(`chat:${m.id}`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /hide similar messages/i }));
    expect(screen.queryByText("chat:f0")).not.toBeInTheDocument();
  });

  it("leaves unquarantined messages around it untouched", async () => {
    const before = message("before", 500, "a".repeat(64));
    const after = message("after", 5000, "b".repeat(64));
    const msgs = [before, ...flood(10, 1000), after];
    renderTimeline(msgs, flood(10, 1000).map((m) => m.id));

    expect(await screen.findByText("chat:before")).toBeInTheDocument();
    expect(screen.getByText("chat:after")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /10 similar messages/i })).toBeInTheDocument();
  });

  it("breaks the run where ordinary conversation interrupts it", async () => {
    // Two separate walls with someone talking in between is two rows, not one
    // spanning their message — the reader's attention broke there too.
    const spam = [...flood(4, 1000, "x"), ...flood(4, 3000, "y")];
    const human = message("human", 2000, "h".repeat(64));
    const msgs = [...flood(4, 1000, "x"), human, ...flood(4, 3000, "y")];
    renderTimeline(msgs, spam.map((m) => m.id));

    expect(await screen.findByText("chat:human")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /4 similar messages from 4 accounts/i })).toHaveLength(2);
  });

  it("does not fold a run too short to be worth a click", async () => {
    const msgs = flood(2, 1000);
    renderTimeline(msgs, msgs.map((m) => m.id));

    expect(await screen.findByText("chat:f0")).toBeInTheDocument();
    expect(screen.getByText("chat:f1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /similar messages/i })).not.toBeInTheDocument();
  });

  it("counts one account when a single key is doing the flooding", async () => {
    const solo = "s".repeat(64);
    const msgs = Array.from({ length: 6 }, (_, i) => message(`s${i}`, 1000 + i, solo));
    renderTimeline(msgs, msgs.map((m) => m.id));

    expect(await screen.findByRole("button", { name: /6 similar messages from 1 account\b/i })).toBeInTheDocument();
  });

  it("never folds the message carrying the unread divider", async () => {
    // The "NEW" line has to land somewhere the reader can see, or their first
    // unread sits behind a click they have no reason to make.
    const msgs = flood(10, 1000);
    renderTimeline(msgs, msgs.map((m) => m.id), msgs[5].id);

    expect(await screen.findByText("chat:f5")).toBeInTheDocument();
  });

  it("splits the run on a day boundary so the date separator has a row", async () => {
    const msgs = [...flood(4, 1000, "x"), ...flood(4, 1000 + DAY * 2, "y")];
    renderTimeline(msgs, msgs.map((m) => m.id));

    expect(await screen.findAllByRole("button", { name: /4 similar messages/i })).toHaveLength(2);
  });

  it("renders nothing special when the transport has no flood detection", async () => {
    const msgs = flood(10, 1000);
    const transport: ChatTransport = { messages: msgs, isLoading: false, canWrite: true, canModerate: false };
    render(
      <MutedPubkeysContext.Provider value={{ mutedPubkeys: new Set<string>(), ready: true }}>
        <MessageTimeline
          transport={transport}
          entries={msgs.map(chatEntry)}
          renderMessage={(msg) => <span>chat:{msg.id}</span>}
        />
      </MutedPubkeysContext.Provider>,
    );

    expect(await screen.findByText("chat:f0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /similar messages/i })).not.toBeInTheDocument();
  });
});

describe("MessageTimeline permission and pause collapse", () => {
  it("folds a single post the community's permissions collapse, and gives it back on one click", async () => {
    const before = message("before", 500, "a".repeat(64));
    const stray = message("stray", 1000, "s".repeat(64));
    renderTimeline([before, stray], ["stray"], undefined, { ruled: ["stray"] });

    expect(await screen.findByText("chat:before")).toBeInTheDocument();
    expect(screen.queryByText("chat:stray")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /1 message from members who can't post here/i }));
    expect(screen.getByText("chat:stray")).toBeInTheDocument();
  });

  it("folds a single post sent while the community was paused", async () => {
    const msgs = [message("p0", 1000, "p".repeat(64))];
    renderTimeline(msgs, ["p0"], undefined, { paused: ["p0"] });

    expect(await screen.findByRole("button", { name: /1 message sent while the community was paused/i })).toBeInTheDocument();
    expect(screen.queryByText("chat:p0")).not.toBeInTheDocument();
  });

  it("keeps a permission collapse and a flood in separate rows", async () => {
    const spam = flood(4, 1000);
    const stray = message("stray", 2000, "s".repeat(64));
    renderTimeline([...spam, stray], [...spam.map((m) => m.id), "stray"], undefined, { ruled: ["stray"] });

    expect(await screen.findByRole("button", { name: /4 similar messages from 4 accounts/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1 message from members who can't post here/i })).toBeInTheDocument();
  });
});
