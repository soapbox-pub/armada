import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopNotificationTest } from "@/components/DesktopNotificationTest";

type ArmadaDesktopBridge = NonNullable<Window["armadaDesktop"]>;

afterEach(() => { delete window.armadaDesktop; });

describe("macOS notification delivery check", () => {
  it("offers a preview test and an OS settings shortcut, and reports native rejection", async () => {
    const showNotification = vi.fn().mockRejectedValue(new Error("UNErrorDomain error 1"));
    const openNotificationSettings = vi.fn(async () => true);
    window.armadaDesktop = { isDesktop: true, showNotification, openNotificationSettings } as unknown as ArmadaDesktopBridge;
    render(<DesktopNotificationTest />);
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("macOS couldn't deliver"));
    expect(showNotification).toHaveBeenCalledWith(expect.objectContaining({ body: "Message previews will appear here.", url: "/settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Open macOS settings" }));
    expect(openNotificationSettings).toHaveBeenCalledOnce();
  });

  it("does not claim a visible banner when macOS only accepted the request", async () => {
    window.armadaDesktop = { isDesktop: true, showNotification: vi.fn(async () => {}) } as unknown as ArmadaDesktopBridge;
    render(<DesktopNotificationTest />);
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("If no banner appears"));
  });

  it("is absent on browsers and older shells", () => {
    const { container } = render(<DesktopNotificationTest />);
    expect(container).toBeEmptyDOMElement();
  });
});
