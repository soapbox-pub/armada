import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";

describe("ContextMenuTrigger touch hold", () => {
  let now = 0;

  beforeEach(() => {
    now = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const onOpenChange = vi.fn();
  const renderMenu = () => {
    onOpenChange.mockClear();
    render(
      <ContextMenu onOpenChange={onOpenChange}>
        <ContextMenuTrigger>row</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Mark as read</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    return screen.getByText("row");
  };

  const elapse = (ms: number) =>
    act(() => {
      now += ms;
      vi.advanceTimersByTime(ms);
    });

  it("opens on a held touch", () => {
    const row = renderMenu();
    fireEvent.pointerDown(row, { pointerType: "touch", clientX: 5, clientY: 5 });
    elapse(700);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("does not open for a tap released during a main-thread stall", () => {
    const row = renderMenu();
    fireEvent.pointerDown(row, { pointerType: "touch", clientX: 5, clientY: 5 });
    // Both hold timers expire inside a long task, ahead of the queued pointerup.
    now += 1500;
    act(() => {
      vi.advanceTimersByTime(700);
    });
    fireEvent.pointerUp(row, { pointerType: "touch", clientX: 5, clientY: 5 });
    elapse(1000);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("opens after a stall when the touch is still held", () => {
    const row = renderMenu();
    fireEvent.pointerDown(row, { pointerType: "touch", clientX: 5, clientY: 5 });
    now += 1500;
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.queryByRole("menu")).toBeNull();
    elapse(50);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("opens at once on a contextmenu event during a press", () => {
    const row = renderMenu();
    fireEvent.pointerDown(row, { pointerType: "touch", clientX: 5, clientY: 5 });
    fireEvent.contextMenu(row, { clientX: 5, clientY: 5 });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});
