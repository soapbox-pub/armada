import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppContext, defaultConfig, type AppContextType, type AppConfig } from "@/contexts/AppContext";
import { PaneResizeHandle } from "@/components/layout/PaneResizeHandle";

// jsdom has no PointerEvent; a MouseEvent carries the button and coordinates.
globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent;
HTMLElement.prototype.setPointerCapture ??= () => {};

afterEach(() => {
  document.documentElement.style.removeProperty("--member-list-w");
  document.documentElement.style.removeProperty("--channel-list-w");
});

function mount(pane: "channel" | "member") {
  let config: AppConfig = { ...defaultConfig };
  const updateConfig = vi.fn((fn: (c: AppConfig) => AppConfig) => {
    config = fn(config);
  });
  render(
    <AppContext.Provider value={{ config, updateConfig } as unknown as AppContextType}>
      <PaneResizeHandle pane={pane} />
    </AppContext.Provider>,
  );
  return { handle: screen.getByRole("separator"), config: () => config };
}

describe("PaneResizeHandle", () => {
  it("drags the member list wider leftward, live, and commits once on release", () => {
    const { handle, config } = mount("member");
    fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 450, pointerId: 1 });
    expect(document.documentElement.style.getPropertyValue("--member-list-w")).toBe("314px");
    expect(config().memberListWidth).toBeUndefined();
    fireEvent.pointerUp(handle, { clientX: 400, pointerId: 1 });
    expect(config().memberListWidth).toBe(364);
  });

  it("writes nothing for a click that doesn't move", () => {
    const { handle, config } = mount("member");
    fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 500, pointerId: 1 });
    expect(config().memberListWidth).toBeUndefined();
  });

  it("ends a drag whose handle unmounts or loses capture mid-drag, reverting to the saved width", () => {
    const first = mount("member");
    fireEvent.pointerDown(first.handle, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(first.handle, { clientX: 450, pointerId: 1 });
    // The member list hides mid-drag (its toggle, a narrower window): the handle goes with it.
    cleanup();
    expect(document.documentElement.dataset.paneResizing).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--member-list-w")).toBe("");

    const second = mount("member");
    fireEvent.pointerDown(second.handle, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(second.handle, { clientX: 450, pointerId: 1 });
    fireEvent(second.handle, new MouseEvent("lostpointercapture", { bubbles: true }));
    expect(document.documentElement.dataset.paneResizing).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--member-list-w")).toBe("");
  });

  it("clamps, and double-click restores the default", () => {
    const { handle, config } = mount("channel");
    fireEvent.pointerDown(handle, { button: 0, clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 9999, pointerId: 1 });
    expect(config().channelListWidth).toBe(400);
    fireEvent.doubleClick(handle);
    expect(config().channelListWidth).toBeUndefined();
  });
});
