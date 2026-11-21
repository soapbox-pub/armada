import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNotificationNavigation } from "@/hooks/useNotificationNavigation";

const mocks = vi.hoisted(() => ({
  desktop: vi.fn(),
  isDesktop: vi.fn(() => false),
  onDeepLink: vi.fn(),
}));

vi.mock("@/lib/desktop", () => ({
  desktop: mocks.desktop,
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
  mocks.desktop.mockReturnValue(undefined);
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
  it("opens a background desktop push through the native window and acknowledges it without a browser", async () => {
    mocks.isDesktop.mockReturnValue(true);
    const openNotification = vi.fn(async (path: string) => {
      for (const listener of deepLinkListeners) listener(path);
      return true;
    });
    mocks.desktop.mockReturnValue({ openNotification });
    mount();
    const path = "/dm/alice?from=push#message";
    const reply = click(path);
    await waitFor(() => expect(reply).toHaveBeenCalledExactlyOnceWith({ routed: path }));
    expect(openNotification).toHaveBeenCalledExactlyOnceWith(path);
    expect(screen.getByRole("status")).toHaveTextContent(path);
  });

  it("routes desktop pushes in older shells and focuses their existing window", () => {
    mocks.isDesktop.mockReturnValue(true);
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    mount();
    const reply = click("/dm/alice");
    expect(screen.getByRole("status")).toHaveTextContent("/dm/alice");
    expect(reply).toHaveBeenCalledExactlyOnceWith({ routed: "/dm/alice" });
    expect(focus).toHaveBeenCalledOnce();
  });

  it("continues routing web pushes through the live router", () => {
    mount();
    const reply = click("/c/community/channel/m/event");
    expect(screen.getByRole("status")).toHaveTextContent("/c/community/channel/m/event");
    expect(reply).toHaveBeenCalledOnce();
  });

  it.each(["https://armada.buzz/dm/alice", "//evil.example/", "/\\evil.example/"])("refuses a non-router destination %j", (path) => {
    mocks.isDesktop.mockReturnValue(true);
    const openNotification = vi.fn();
    mocks.desktop.mockReturnValue({ openNotification });
    mount();
    expect(click(path)).not.toHaveBeenCalled();
    expect(openNotification).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("/dm");
  });

  it.each([false, "reject"])("keeps a click inside the app when the native bridge fails: %s", async (outcome) => {
    mocks.isDesktop.mockReturnValue(true);
    vi.spyOn(window, "focus").mockImplementation(() => {});
    const openNotification = vi.fn(async () => {
      if (outcome === "reject") throw new Error("bridge unavailable");
      return false;
    });
    mocks.desktop.mockReturnValue({ openNotification });
    mount();
    const reply = click("/dm/alice");
    await waitFor(() => expect(reply).toHaveBeenCalledExactlyOnceWith({ routed: "/dm/alice" }));
    expect(screen.getByRole("status")).toHaveTextContent("/dm/alice");
    click("/dm/alice", false);
    expect(openNotification).toHaveBeenCalledOnce();
  });

  it("removes the worker click listener on unmount", () => {
    const { unmount } = mount();
    unmount();
    expect(click("/dm/alice")).not.toHaveBeenCalled();
  });
});
