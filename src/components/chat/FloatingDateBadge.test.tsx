import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FloatingDateBadge } from "@/components/chat/FloatingDateBadge";

const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);

/** Rows at the given offsets; jsdom lays nothing out, so `offsetTop` is stubbed. */
function Timeline({ rows }: { rows: { top: number; ts?: number; dayStart?: boolean }[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={scrollRef} data-testid="scroller">
        <div ref={contentRef}>
          {rows.map((row, i) => (
            <div
              key={i}
              data-ts={row.ts}
              data-day-start={row.dayStart || undefined}
              ref={(el) => {
                if (el) Object.defineProperty(el, "offsetTop", { configurable: true, value: row.top });
              }}
            />
          ))}
        </div>
      </div>
      <FloatingDateBadge scrollRef={scrollRef} contentRef={contentRef} belowPill={false} />
    </div>
  );
}

function readerScroll() {
  const scroller = screen.getByTestId("scroller");
  fireEvent.wheel(scroller);
  fireEvent.scroll(scroller);
  act(() => {
    vi.advanceTimersToNextFrame();
  });
}

function badge() {
  return screen.queryByText(/Today|Yesterday/)?.parentElement ?? null;
}

describe("FloatingDateBadge", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the day of the row under it while the reader scrolls, then fades", () => {
    render(<Timeline rows={[{ top: 0, ts: now - DAY }, { top: 500, ts: now }]} />);
    expect(badge()).toBeNull();
    readerScroll();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
    expect(badge()).toHaveClass("opacity-100");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(badge()).toHaveClass("opacity-0");
  });

  it("ignores scrolls the reader didn't make", () => {
    render(<Timeline rows={[{ top: 0, ts: now }]} />);
    fireEvent.scroll(screen.getByTestId("scroller"));
    act(() => {
      vi.advanceTimersToNextFrame();
    });
    expect(badge()).toBeNull();
  });

  it("waits until the reader is past the opening screenful to name today or yesterday", () => {
    render(<Timeline rows={[{ top: 0, ts: now - DAY }, { top: 500, ts: now }]} />);
    const scroller = screen.getByTestId("scroller");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 500 });
    scroller.scrollTop = 1200;
    readerScroll();
    expect(badge()).toBeNull();
    scroller.scrollTop = 900;
    readerScroll();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
  });

  it("names an older day even on the opening screenful", () => {
    render(<Timeline rows={[{ top: 0, ts: now - 7 * DAY }]} />);
    const scroller = screen.getByTestId("scroller");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 500 });
    scroller.scrollTop = 100;
    readerScroll();
    expect(document.querySelector(".clip-corner")?.parentElement).toHaveClass("opacity-100");
  });

  it("stays out of the way of a day separator already under it", () => {
    render(<Timeline rows={[{ top: 0, ts: now - DAY }, { top: 20, ts: now, dayStart: true }, { top: 60, ts: now }]} />);
    readerScroll();
    expect(badge()).toBeNull();
  });
});
