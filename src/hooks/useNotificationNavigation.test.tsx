import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNotificationNavigation } from "@/hooks/useNotificationNavigation";

const mocks = vi.hoisted(() => ({
  isDesktop: vi.fn(() => false),
  onDeepLink: vi.fn(),
}));

vi.mock("@/lib/desktop", () => ({
  isDesktop: mocks.isDesktop,
  onDesktopDeepLink: mocks.onDeepLink,
}));
vi.mock("@/lib/platform", () => ({ isNativeRuntime: () => false }));
vi.mock("@/lib/nativePush", () => ({
  ArmadaPush: {}, hasIosPush: () => false, reportActiveRoute: vi.fn(),
}));
vi.mock("@/lib/coldLaunchDeepLink", () => ({ onLateColdLaunchDeepLink: vi.fn() }));
vi.mock("@/lib/deepLinkNav", () => ({ markDeepLinkNavigation: vi.fn() }));
vi.mock("@/lib/webReady", () => ({ signalDeepLinkNavigated: vi.fn() }));

let worker: EventTarget;
const deepLinkListeners = new Set<(path: string) => void>();

function Harness() {
  useNotificationNavigation();
  const location = useLocation();
  return <output>{location.pathname + location.search + location.hash}</output>;
}

function mount() {
  return render(<MemoryRouter initialEntries={["/dm"]}><Harness /></MemoryRouter>);
}

function click(path: string, withPort = true) {
  const postMessage = vi.fn();
  const event = new MessageEvent("message", { data: { type: "armada-open-route", path } });
  Object.defineProperty(event, "ports", { value: withPort ? [{ postMessage }] : [] });
  act(() => worker.dispatchEvent(event));
  return postMessage;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isDesktop.mockReturnValue(false);
  mocks.onDeepLink.mockImplementation((handler: (path: string) => void) => {
    deepLinkListeners.add(handler);
    return () => deepLinkListeners.delete(handler);
  });
  worker = new EventTarget();
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
});

afterEach(() => {
  cleanup();
  deepLinkListeners.clear();
  Reflect.deleteProperty(navigator, "serviceWorker");
  vi.restoreAllMocks();
});

describe("notification click navigation", () => {
  it("leaves worker clicks alone on desktop, which presents no worker notifications", () => {
    mocks.isDesktop.mockReturnValue(true);
    mount();
    expect(click("/dm/alice")).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("/dm");
  });

  it("continues routing web pushes through the live router", () => {
    mount();
    const reply = click("/c/community/channel/m/event");
    expect(screen.getByRole("status")).toHaveTextContent("/c/community/channel/m/event");
    expect(reply).toHaveBeenCalledOnce();
  });

  it.each(["https://armada.buzz/dm/alice", "//evil.example/"])("refuses a non-router destination %j", (path) => {
    mount();
    expect(click(path)).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("/dm");
  });

  it("removes the worker click listener on unmount", () => {
    const { unmount } = mount();
    unmount();
    expect(click("/dm/alice")).not.toHaveBeenCalled();
  });
});
