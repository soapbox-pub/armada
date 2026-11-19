import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PUSH_PREFS, type UsePushNotificationsReturn } from "@/lib/pushPrefs";

const push: { current: Partial<UsePushNotificationsReturn> } = { current: {} };

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: "a".repeat(64) } }),
}));
vi.mock("@/hooks/useNativeNotifications", () => ({
  useNativeNotifications: () => ({ supported: false }),
}));
vi.mock("@/contexts/WebPushContext", () => ({
  useWebPushNotifications: () => push.current,
}));
vi.mock("@/hooks/useForegroundNotificationSettings", () => ({
  useForegroundNotificationSettings: () => ({
    apiAvailable: true,
    permission: "default",
    intent: true,
    enabled: false,
    setEnabled: vi.fn(),
    prefs: DEFAULT_PUSH_PREFS,
    setPrefs: vi.fn(),
  }),
}));

import { NotificationSettings } from "@/components/NotificationSettings";

function webPush(overrides: Partial<UsePushNotificationsReturn>): Partial<UsePushNotificationsReturn> {
  return {
    supported: true,
    ready: true,
    permission: "default",
    enabled: false,
    busy: false,
    prefs: DEFAULT_PUSH_PREFS,
    enable: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
    setPrefs: vi.fn(async () => {}),
    retry: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  delete (navigator as { brave?: unknown }).brave;
});

describe("NotificationSettings on Brave", () => {
  it("says briefly that Brave's push is off and offers the in-page notifier", () => {
    push.current = webPush({ pushServiceOff: true });
    render(<NotificationSettings />);
    expect(screen.getByText("Brave has background notifications turned off.")).toBeInTheDocument();
    expect(screen.getByText("Notifications while Armada is open")).toBeInTheDocument();
    expect(screen.queryByText(/Check your connection/)).not.toBeInTheDocument();
    // The details wait behind the button.
    expect(screen.queryByText("brave://settings/privacy")).not.toBeInTheDocument();
  });

  it("puts the steps and what Google can see in a dialog", () => {
    push.current = webPush({ pushServiceOff: true });
    render(<NotificationSettings />);
    fireEvent.click(screen.getByRole("button", { name: "How to turn them on" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("brave://settings/privacy")).toBeInTheDocument();
    expect(screen.getByText("Turn on “Use Google services for push messaging”")).toBeInTheDocument();
    expect(screen.getByText(/Google can't read them or see who sent them/)).toBeInTheDocument();
  });

  it("retries from the same tap", () => {
    const enable = vi.fn(async () => {});
    push.current = webPush({ pushServiceOff: true, enable });
    render(<NotificationSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it("says why push turned itself off after a session-only permission lapsed", () => {
    Object.defineProperty(navigator, "brave", { value: {}, configurable: true });
    push.current = webPush({ permissionExpired: true });
    render(<NotificationSettings />);
    expect(screen.getByText(/Brave dropped the permission/)).toBeInTheDocument();
  });

  it("asks for a lasting permission before the first prompt", () => {
    Object.defineProperty(navigator, "brave", { value: {}, configurable: true });
    push.current = webPush({});
    render(<NotificationSettings />);
    expect(screen.getByText(/pick “forever”, or it stops when you close Armada/)).toBeInTheDocument();
  });

  it("adds no Brave advice elsewhere", () => {
    push.current = webPush({});
    render(<NotificationSettings />);
    expect(screen.queryByText(/“forever”/)).not.toBeInTheDocument();
  });
});
