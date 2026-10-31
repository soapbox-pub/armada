import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef, useCallback, useRef, useState } from "react";

import { MessageTimeline, type MessageTimelineHandle } from "@/components/chat/MessageTimeline";

import type { ChatMsg, ChatTransport } from "@/components/chat/transport";
import type { RefObject } from "react";

const resizeCallbacks: ResizeObserverCallback[] = [];
const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

// Geometry for every current/future timeline row. Computing from live DOM order
// is important: newly revealed rows exist before the component's layout effect,
// exactly when the anchor restoration reads their offsets.
let growthAfterRow = Number.POSITIVE_INFINITY;
let growthPx = 0;

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: function getBoundingClientRect(this: HTMLElement) {
      const scroller = this.closest<HTMLElement>(".scrollbar-stable");
      if (this.classList.contains("scrollbar-stable")) return domRect(0, this.clientHeight);
      // A message row fills its timeline row.
      if (this.hasAttribute("data-event-id")) {
        return this.closest<HTMLElement>("[data-scroll-anchor]")?.getBoundingClientRect() ?? domRect(0, 0);
      }
      if (!this.hasAttribute("data-scroll-anchor") || !scroller) return domRect(0, 0);
      const rows = [...(this.parentElement?.querySelectorAll<HTMLElement>("[data-scroll-anchor]") ?? [])];
      const index = rows.indexOf(this);
      const absoluteTop = index * 100 + (index >= growthAfterRow ? growthPx : 0);
      return domRect(absoluteTop - scroller.scrollTop, 100);
    },
  });
});

afterAll(() => {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: originalGetBoundingClientRect,
  });
});

beforeEach(() => {
  resizeCallbacks.length = 0;
  growthAfterRow = Number.POSITIVE_INFINITY;
  growthPx = 0;
});

function message(index: number): ChatMsg {
  return {
    id: `m${index}`,
    pubkey: "a".repeat(64),
    created_at: 1_700_000_000 + index,
    kind: 9,
    content: `msg ${index}`,
    tags: [],
    sig: "",
  } as unknown as ChatMsg;
}

function domRect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 100,
    bottom: top + height,
    left: 0,
    width: 100,
    height,
    toJSON: () => ({}),
  };
}

function transportOf(messages: ChatMsg[]): ChatTransport {
  return { messages, isLoading: false, canWrite: true, canModerate: false };
}

async function mountedTimeline(count: number, handleRef?: RefObject<MessageTimelineHandle | null>) {
  const messages = Array.from({ length: count }, (_, index) => message(index));
  const rendered = render(
    <MessageTimeline
      transport={transportOf(messages)}
      handleRef={handleRef}
      renderMessage={(msg) => <span data-event-id={msg.id}>chat:{msg.id}</span>}
    />,
  );
  const oldestOpening = `chat:m${Math.max(0, count - 30)}`;
  await screen.findByText(oldestOpening);
  const scroller = rendered.container.querySelector<HTMLElement>(".scrollbar-stable")!;
  const content = scroller.firstElementChild as HTMLElement;
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: {
      configurable: true,
      get: () => content.querySelectorAll("[data-scroll-anchor]").length * 100 + growthPx,
    },
  });
  return { ...rendered, scroller, content };
}

function scroll(scroller: HTMLElement, top: number): void {
  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
}

function rowViewportOffset(content: HTMLElement, scroller: HTMLElement, key: string): number {
  const row = content.querySelector<HTMLElement>(`[data-scroll-anchor="${key}"]`)!;
  return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

describe("MessageTimeline reading anchor", () => {
  it("preserves the visible row and pixel while revealing older days", async () => {
    const { scroller, content } = await mountedTimeline(100);

    // Establish the same bookkeeping a real opening pin + upward gesture does.
    scroll(scroller, 2_500);
    scroll(scroller, 500);

    // Steps chain until the reader is a full reveal band from the top.
    await waitFor(() => expect(screen.getByText("chat:m38")).toBeInTheDocument());
    expect(screen.queryByText("chat:m37")).toBeNull();
    expect(rowViewportOffset(content, scroller, "m75")).toBe(0);
    // Thirty-two rows were revealed above m75; the viewport followed the row
    // rather than jumping that many messages (often several calendar days).
    expect(scroller.scrollTop).toBe(3_700);
  });

  it("requests the next older page while loaded rows are still hidden above the window", async () => {
    const loadOlder = vi.fn<() => Promise<number>>(async () => 0);
    const messages = Array.from({ length: 100 }, (_, index) => message(index));
    const rendered = render(
      <MessageTimeline
        transport={{ ...transportOf(messages), hasMore: true, loadOlder }}
        renderMessage={(msg) => <span data-event-id={msg.id}>chat:{msg.id}</span>}
      />,
    );
    await screen.findByText("chat:m70");
    const scroller = rendered.container.querySelector<HTMLElement>(".scrollbar-stable")!;
    const content = scroller.firstElementChild as HTMLElement;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, get: () => content.querySelectorAll("[data-scroll-anchor]").length * 100 },
    });

    scroll(scroller, 2_500);
    scroll(scroller, 500);

    // Reveal steps walk the window up; the page is asked for before it reaches m0.
    await waitFor(() => expect(loadOlder).toHaveBeenCalled());
    expect(screen.queryByText("chat:m0")).toBeNull();
  });

  it("preserves the visible row when an image or embed above it grows", async () => {
    // Everything loaded is already rendered (and there's no transport paging), so
    // nothing can extend the window: this isolates asynchronous height changes.
    const { scroller, content } = await mountedTimeline(30);
    scroll(scroller, 2_500);
    scroll(scroller, 1_000);

    expect(rowViewportOffset(content, scroller, "m10")).toBe(0);

    growthAfterRow = 5;
    growthPx = 240;
    act(() => resizeCallbacks.at(-1)?.([], {} as ResizeObserver));

    expect(scroller.scrollTop).toBe(1_240);
    expect(rowViewportOffset(content, scroller, "m10")).toBe(0);
  });

  it("holds a jumped-to message centered while rows around it settle, until the reader scrolls", async () => {
    const handle = createRef<MessageTimelineHandle>();
    const { scroller, content } = await mountedTimeline(30, handle);
    scroll(scroller, 2_500);
    scroll(scroller, 1_500);

    act(() => {
      expect(handle.current?.scrollToMessage("m10")).toBe(true);
    });
    expect(rowViewportOffset(content, scroller, "m10")).toBe(200);

    // Growth between the viewport's top row and the target: the reading anchor
    // alone would stay still and let the target slide down.
    growthAfterRow = 9;
    growthPx = 240;
    act(() => resizeCallbacks.at(-1)?.([], {} as ResizeObserver));
    expect(rowViewportOffset(content, scroller, "m10")).toBe(200);

    // The reader's own gesture ends the hold; later growth keeps their row instead.
    fireEvent.wheel(scroller);
    scroll(scroller, 500);
    growthPx = 480;
    act(() => resizeCallbacks.at(-1)?.([], {} as ResizeObserver));
    expect(scroller.scrollTop).toBe(500);
  });

  it("keeps the rows still when the pane shrinks under a reader just short of the bottom", async () => {
    const { scroller } = await mountedTimeline(40);
    scroll(scroller, 2_500);
    scroll(scroller, 2_460);

    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 478 });
    act(() => resizeCallbacks.at(-1)?.([], {} as ResizeObserver));

    expect(scroller.scrollTop).toBe(2_460);
  });

  it("stays pinned when the pane shrinks under a reader at the bottom", async () => {
    const { scroller } = await mountedTimeline(40);
    scroll(scroller, 2_500);

    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 478 });
    act(() => resizeCallbacks.at(-1)?.([], {} as ResizeObserver));

    expect(scroller.scrollTop).toBe(2_522);
  });

  it("reveals a prior-day backfill at the top without requiring a second gesture", async () => {
    const loadOlder = vi.fn<() => Promise<number>>();

    function DmHistory() {
      const [messages, setMessages] = useState(() =>
        Array.from({ length: 30 }, (_, index) => message(index)),
      );
      // One page of history; the prefetch that follows finds nothing older.
      const served = useRef(false);
      const backfill = useCallback(async () => {
        if (served.current) return 0;
        served.current = true;
        const priorDay = Array.from({ length: 40 }, (_, index) => ({
          ...message(index - 40),
          id: `old${index}`,
          content: `old ${index}`,
          created_at: 1_700_000_000 - 3 * 24 * 60 * 60 + index,
        }));
        setMessages((current) => [...priorDay, ...current]);
        return priorDay.length;
      }, []);
      loadOlder.mockImplementation(backfill);
      return (
        <MessageTimeline
          transport={{
            ...transportOf(messages),
            hasMore: true,
            loadOlder,
          }}
          renderMessage={(msg) => <span data-event-id={msg.id}>chat:{msg.id}</span>}
        />
      );
    }

    const rendered = render(<DmHistory />);
    await screen.findByText("chat:m0");
    const scroller = rendered.container.querySelector<HTMLElement>(".scrollbar-stable")!;
    const content = scroller.firstElementChild as HTMLElement;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: {
        configurable: true,
        get: () => content.querySelectorAll("[data-scroll-anchor]").length * 100,
      },
    });

    scroll(scroller, 2_500);
    scroll(scroller, 0);

    await waitFor(() => expect(screen.getByText("chat:old24")).toBeInTheDocument());
    expect(loadOlder).toHaveBeenCalled();
    expect(content.querySelector('[data-scroll-anchor^="date-"]')).not.toBeNull();
    expect(rowViewportOffset(content, scroller, "m0")).toBe(0);
  });

  it("still reveals the backfill when the boundary row is dropped with it", async () => {
    // The reveal is armed against the oldest entry on screen, and a page can
    // land in the same commit that removes it: a disappearing message hitting
    // its expiry, a delete folding in, a moderation drop. The rows above are
    // real either way, and the reader is still at scrollTop 0 with no upward
    // gesture left to ask for them.
    const loadOlder = vi.fn<() => Promise<number>>();

    function DmHistory() {
      const [messages, setMessages] = useState(() =>
        Array.from({ length: 30 }, (_, index) => message(index)),
      );
      // One page of history; the prefetch that follows finds nothing older.
      const served = useRef(false);
      const backfill = useCallback(async () => {
        if (served.current) return 0;
        served.current = true;
        const priorDay = Array.from({ length: 40 }, (_, index) => ({
          ...message(index - 40),
          id: `old${index}`,
          content: `old ${index}`,
          created_at: 1_700_000_000 - 3 * 24 * 60 * 60 + index,
        }));
        setMessages((current) => [...priorDay, ...current.filter((msg) => msg.id !== "m0")]);
        return priorDay.length;
      }, []);
      loadOlder.mockImplementation(backfill);
      return (
        <MessageTimeline
          transport={{
            ...transportOf(messages),
            hasMore: true,
            loadOlder,
          }}
          renderMessage={(msg) => <span data-event-id={msg.id}>chat:{msg.id}</span>}
        />
      );
    }

    const rendered = render(<DmHistory />);
    await screen.findByText("chat:m0");
    const scroller = rendered.container.querySelector<HTMLElement>(".scrollbar-stable")!;
    const content = scroller.firstElementChild as HTMLElement;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: {
        configurable: true,
        get: () => content.querySelectorAll("[data-scroll-anchor]").length * 100,
      },
    });

    scroll(scroller, 2_500);
    scroll(scroller, 0);

    await waitFor(() => expect(loadOlder).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("chat:old24")).toBeInTheDocument());
    expect(content.querySelector('[data-scroll-anchor^="date-"]')).not.toBeNull();
    // The anchored row is gone, so the anchor falls through to its follower —
    // which keeps the pixel it held while `m0` was still above it. What matters
    // is that the reader is still looking at their own rows and not at the top
    // of a page of prior-day history they never asked to be moved to.
    const offset = rowViewportOffset(content, scroller, "m1");
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(scroller.clientHeight);
  });

  it("drops the newest rows while reading far back, and restores them on jump to present", async () => {
    const { scroller, content } = await mountedTimeline(500);
    const rows = () => content.querySelectorAll("[data-scroll-anchor]").length;

    scroll(scroller, 2_500);
    for (let i = 0; i < 30; i++) {
      scroll(scroller, 0);
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(rows()).toBeLessThanOrEqual(240 + 64 + 16);
    }
    expect(screen.queryByText("chat:m40")).not.toBeNull();
    expect(screen.queryByText("chat:m499")).toBeNull();

    // Reading back down reveals the newer rows again, still bounded.
    for (let i = 0; i < 8; i++) {
      scroll(scroller, scroller.scrollHeight - scroller.clientHeight);
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(rows()).toBeLessThanOrEqual(240 + 64 + 16);
    }
    expect(screen.queryByText("chat:m40")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Jump to the latest messages" }));
    await screen.findByText("chat:m499");
    expect(rows()).toBeLessThanOrEqual(30);
  }, 30_000);

  it("continues from a reveal step into a backfill without a second gesture", async () => {
    // A single scroll to the top can have more to do than one step: the window
    // starts short of everything loaded, so the first `maybeExtend` REVEALS the
    // already-loaded remainder (start → 0) and lands the reader inside the
    // backfill band — but with no downward delta left, no further scroll event
    // is coming to ask the transport for the older page. The reveal→backfill
    // chain has to run itself out. (Test 3 above opens with start already 0, so
    // its gesture reaches the transport directly and never crosses this seam.)
    const loadOlder = vi.fn<() => Promise<number>>();

    function DmHistory() {
      // 40 loaded > INITIAL_WINDOW (30), so the opening window is m10..m39 and
      // one WINDOW_STEP reveal reaches start 0 — the reveal precedes any
      // transport call.
      const [messages, setMessages] = useState(() =>
        Array.from({ length: 40 }, (_, index) => message(index)),
      );
      // One page of history; the prefetch that follows finds nothing older.
      const served = useRef(false);
      const backfill = useCallback(async () => {
        if (served.current) return 0;
        served.current = true;
        const priorDay = Array.from({ length: 40 }, (_, index) => ({
          ...message(index - 40),
          id: `old${index}`,
          content: `old ${index}`,
          created_at: 1_700_000_000 - 3 * 24 * 60 * 60 + index,
        }));
        setMessages((current) => [...priorDay, ...current]);
        return priorDay.length;
      }, []);
      loadOlder.mockImplementation(backfill);
      return (
        <MessageTimeline
          transport={{
            ...transportOf(messages),
            hasMore: true,
            loadOlder,
          }}
          renderMessage={(msg) => <span data-event-id={msg.id}>chat:{msg.id}</span>}
        />
      );
    }

    const rendered = render(<DmHistory />);
    await screen.findByText("chat:m10");
    const scroller = rendered.container.querySelector<HTMLElement>(".scrollbar-stable")!;
    const content = scroller.firstElementChild as HTMLElement;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: {
        configurable: true,
        get: () => content.querySelectorAll("[data-scroll-anchor]").length * 100,
      },
    });

    // One gesture to the top: reveals m0..m9, then must reach the transport on
    // its own. No second scroll is fired.
    scroll(scroller, 2_500);
    scroll(scroller, 0);

    await waitFor(() => expect(loadOlder).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("chat:old39")).toBeInTheDocument());
  });
});

describe("MessageTimeline detached run", () => {
  it("reads forward at the run's bottom, never walks back on arrival, and leaves the run on jump to present", async () => {
    const loadOlder = vi.fn(async () => 0);
    const returnToPresent = vi.fn();
    let setRows: (rows: ChatMsg[]) => void = () => {};
    const loadNewer = vi.fn(async () => {
      setRows(Array.from({ length: 40 }, (_, index) => message(index)));
      return 20;
    });
    function Harness() {
      const [rows, set] = useState(() => Array.from({ length: 20 }, (_, index) => message(index)));
      setRows = set;
      return (
        <MessageTimeline
          transport={{
            ...transportOf(rows),
            hasMore: true,
            loadOlder,
            hasNewer: true,
            loadNewer,
            returnToPresent,
          }}
          renderMessage={(msg) => <span data-event-id={msg.id}>chat:{msg.id}</span>}
        />
      );
    }
    const rendered = render(<Harness />);
    await screen.findByText("chat:m19");
    const scroller = rendered.container.querySelector<HTMLElement>(".scrollbar-stable")!;
    const content = scroller.firstElementChild as HTMLElement;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, get: () => content.querySelectorAll("[data-scroll-anchor]").length * 100 },
    });

    // A run's bottom is history, not the present: the forward read starts on its own.
    await waitFor(() => expect(loadNewer).toHaveBeenCalled());
    await screen.findByText("chat:m39");
    expect(loadOlder).not.toHaveBeenCalled();

    // And the reader is never treated as caught up, so the way back is offered.
    scroll(scroller, 0);
    fireEvent.click(await screen.findByRole("button", { name: "Jump to the latest messages" }));
    expect(returnToPresent).toHaveBeenCalled();
  });
});

describe("MessageTimeline jump to unread", () => {
  function mountWithDivider(dividerId: string) {
    const messages = Array.from({ length: 100 }, (_, index) => message(index));
    return render(
      <MessageTimeline
        transport={transportOf(messages)}
        newDividerId={dividerId}
        renderMessage={(msg) => <span data-event-id={msg.id}>chat:{msg.id}</span>}
      />,
    );
  }

  it("offers a jump to a NEW divider above the rendered window, and goes there", async () => {
    mountWithDivider("m50");
    const pill = await screen.findByRole("button", { name: "Jump to unread" });
    expect(screen.queryByText("chat:m50")).toBeNull();

    fireEvent.click(pill);

    await screen.findByText("chat:m50");
    expect(screen.queryByRole("button", { name: "Jump to unread" })).toBeNull();
  });

  it("goes to a divider that sits on a non-chat entry", async () => {
    const messages = Array.from({ length: 100 }, (_, index) => message(index));
    const entries = messages.map((msg) => ({ type: "chat", id: `chat:${msg.id}`, createdAt: msg.created_at, message: msg }));
    // The first unread item is git activity, between m49 and m50.
    entries.splice(50, 0, {
      type: "git-ticket-opened",
      id: "t1",
      createdAt: messages[49].created_at,
      activity: { id: "t1", ticket: { id: "t1", author: "t1", type: "issue" }, repository: { coordinate: "30617:x:repo" } },
    } as never);
    render(
      <MessageTimeline
        transport={transportOf(messages)}
        entries={entries as never}
        newDividerId="t1"
        renderMessage={(msg) => <span data-event-id={msg.id}>chat:{msg.id}</span>}
        renderEntry={(entry) => <span>git:{entry.id}</span>}
      />,
    );
    const pill = await screen.findByRole("button", { name: "Jump to unread" });
    expect(screen.queryByText("git:t1")).toBeNull();

    fireEvent.click(pill);

    await screen.findByText("git:t1");
  });

  it("offers nothing when the divider is already in view", async () => {
    mountWithDivider("m98");
    await screen.findByText("chat:m98");
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(screen.queryByRole("button", { name: "Jump to unread" })).toBeNull();
  });
});
