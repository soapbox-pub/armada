import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  missing: true,
  publish: vi.fn(),
  show: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/useDmInboxSetup", () => ({
  useDmInboxSetup: () => ({
    missing: h.missing,
    dismissed: false,
    publishing: false,
    publish: h.publish,
    dismiss: vi.fn(),
  }),
}));
vi.mock("@/hooks/useToast", () => ({ useToast: () => ({ toast: h.toast }) }));

import { DmInboxNotice } from "@/components/DmInboxNotice";
import { SettingsOverlayContext } from "@/lib/settingsOverlay";

beforeEach(() => {
  h.missing = true;
  h.publish.mockReset().mockImplementation(async () => {
    h.missing = false;
    return ["wss://inbox.example/"];
  });
  h.show.mockReset();
  h.toast.mockReset();
});

describe("DmInboxNotice", () => {
  it("stays after publishing to name the relays it listed", async () => {
    render(<DmInboxNotice dismissible />);
    fireEvent.click(screen.getByRole("button", { name: "Let them message me" }));
    expect(await screen.findByText("Other apps can message you now")).toBeInTheDocument();
    expect(screen.getByText("inbox.example")).toBeInTheDocument();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("points to Settings › Relays and offers no undo", async () => {
    render(
      <SettingsOverlayContext.Provider value={{ open: false, section: "", show: h.show, close: () => {} }}>
        <DmInboxNotice dismissible />
      </SettingsOverlayContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Let them message me" }));
    fireEvent.click(await screen.findByRole("button", { name: "Change in Settings" }));
    expect(h.show).toHaveBeenCalledWith("app-relays");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});
