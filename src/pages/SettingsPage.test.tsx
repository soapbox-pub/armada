import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: "a".repeat(64) } }),
}));
vi.mock("@/hooks/useAuthor", () => ({
  useAuthor: () => ({ data: { metadata: { name: "pixelwitch" } }, isLoading: false }),
}));
vi.mock("@/hooks/useUltra", () => ({ useMyUltra: () => ({ ultra: undefined }) }));
vi.mock("@/hooks/useInstallPrompt", () => ({
  useInstallPrompt: () => ({ canInstall: false, install: vi.fn(), needsManualInstall: false }),
}));

// The pages themselves are covered elsewhere; this is the navigation around them.
const { stub } = vi.hoisted(() => ({
  stub: (name: string) => () => <p>{name} body</p>,
}));
vi.mock("@/components/NotificationSettings", () => ({ NotificationSettings: stub("Notifications") }));
vi.mock("@/components/ProfileSettings", () => ({ ProfileSettings: stub("Profile") }));
vi.mock("@/components/ThemeSelector", () => ({ ThemeSelector: stub("Theme") }));
vi.mock("@/components/settings/FontScaleSettings", () => ({ FontScaleSettings: stub("Font") }));
vi.mock("@/components/settings/MotionSettings", () => ({ MotionSettings: stub("Motion") }));
vi.mock("@/components/settings/AccountSettings", () => ({ AccountSettings: stub("Account") }));
vi.mock("@/components/settings/ChatSettings", () => ({ ChatSettings: stub("Chats") }));
vi.mock("@/components/settings/DirectMessageSettings", () => ({ DirectMessageSettings: stub("DMs") }));
vi.mock("@/components/settings/VoiceSettings", () => ({ VoiceSettings: stub("Voice") }));
vi.mock("@/components/settings/RelaysSettings", () => ({ RelaysSettings: stub("Relays") }));
vi.mock("@/components/settings/EmojiPackSettings", () => ({ EmojiPackSettings: stub("Emoji") }));
vi.mock("@/components/settings/UltraSettings", () => ({ UltraSettings: stub("Ultra") }));
vi.mock("@/components/settings/WalletSettings", () => ({ WalletSettings: stub("Wallet") }));
vi.mock("@/components/settings/MutedWordsSettings", () => ({ MutedWordsSettings: stub("Muted words") }));
vi.mock("@/components/settings/MutedPeopleSettings", () => ({ MutedPeopleSettings: stub("Blocked") }));
vi.mock("@/components/settings/AboutSettings", () => ({ AboutSettings: stub("About"), SupportSettings: stub("Support") }));
vi.mock("@/components/settings/PrivacySettings", async () => {
  const { useContext } = await import("react");
  const { SettingsNavContext } = await import("@/components/settings/settingsNav");
  return {
    PrivacySettings: () => {
      const nav = useContext(SettingsNavContext);
      return <button type="button" onClick={() => nav.open("blocked")}>Open blocked</button>;
    },
  };
});

import { SettingsPage } from "@/pages/SettingsPage";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

function mount(section?: string, onClose = vi.fn()) {
  render(
    <MemoryRouter>
      <SettingsPage section={section} onClose={onClose} />
    </MemoryRouter>,
  );
  return onClose;
}

const heading = () => screen.getByRole("heading", { level: 1 }).textContent;

describe("SettingsPage navigation", () => {
  it("drills into a page from the root list and steps back out", () => {
    const onClose = mount();
    expect(heading()).toBe("Settings");
    expect(screen.getByText("pixelwitch")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Chats/ }));
    expect(heading()).toBe("Chats");
    expect(screen.getByText("Chats body")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(heading()).toBe("Settings");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("steps back on Escape before the overlay can close", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Voice/ }));
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(escape);
    });
    expect(escape.defaultPrevented).toBe(true);
    expect(heading()).toBe("Settings");
  });

  it("pushes a nested page over its parent", () => {
    mount("privacy");
    fireEvent.click(screen.getByRole("button", { name: "Open blocked" }));
    expect(heading()).toBe("Blocked people");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(heading()).toBe("Privacy & safety");
  });

  it("opens a deep-linked group's page under its parent", () => {
    mount("muted");
    expect(heading()).toBe("Blocked people");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(heading()).toBe("Privacy & safety");
  });
});
