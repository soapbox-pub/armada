import { describe, expect, it, vi } from "vitest";
import type React from "react";

import { MENU_TAP_SLOP_PX, menuPickHandlers } from "./menuPick";

function ev(init: Partial<React.PointerEvent>): React.PointerEvent {
  return { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0, button: 0, preventDefault: vi.fn(), ...init } as unknown as React.PointerEvent;
}

describe("menuPickHandlers", () => {
  it("picks on mouse press and keeps focus", () => {
    const pick = vi.fn();
    const down = ev({ pointerType: "mouse" });
    menuPickHandlers(pick).onPointerDown(down);
    expect(pick).toHaveBeenCalledOnce();
    expect(down.preventDefault).toHaveBeenCalled();
  });

  it("ignores a secondary mouse press", () => {
    const pick = vi.fn();
    menuPickHandlers(pick).onPointerDown(ev({ pointerType: "mouse", button: 2 }));
    expect(pick).not.toHaveBeenCalled();
  });

  it("picks a touch on release, not on press", () => {
    const pick = vi.fn();
    const h = menuPickHandlers(pick);
    const down = ev({ clientX: 50, clientY: 50 });
    h.onPointerDown(down);
    expect(pick).not.toHaveBeenCalled();
    expect(down.preventDefault).toHaveBeenCalled();
    h.onPointerUp(ev({ clientX: 52, clientY: 53 }));
    expect(pick).toHaveBeenCalledOnce();
  });

  it("drops a touch that travelled (a scroll)", () => {
    const pick = vi.fn();
    const h = menuPickHandlers(pick);
    h.onPointerDown(ev({ clientY: 50 }));
    h.onPointerUp(ev({ clientY: 50 + MENU_TAP_SLOP_PX + 1 }));
    expect(pick).not.toHaveBeenCalled();
  });

  it("drops a touch the browser cancelled for panning", () => {
    const pick = vi.fn();
    const h = menuPickHandlers(pick);
    h.onPointerDown(ev({}));
    h.onPointerCancel(ev({}));
    h.onPointerUp(ev({}));
    expect(pick).not.toHaveBeenCalled();
  });

  it("does not pick on a release that began on another row", () => {
    const first = vi.fn();
    const second = vi.fn();
    menuPickHandlers(first).onPointerDown(ev({ pointerId: 7 }));
    menuPickHandlers(second).onPointerUp(ev({ pointerId: 8 }));
    expect(second).not.toHaveBeenCalled();
  });
});
