import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppContext, defaultConfig } from "@/contexts/AppContext";
import { DONATION_BITCOIN, DONATION_MONERO, readUltra, withUltra, type UltraProfile } from "@/lib/ultra";

import { UltraSettings } from "./UltraSettings";

vi.mock("@/components/Confetti", () => ({ Confetti: () => <div data-testid="confetti" /> }));
vi.mock("@/lib/fanfare", () => ({ playFanfare: vi.fn() }));

const h = vi.hoisted(() => ({
  profile: {} as Record<string, unknown>,
  publish: vi.fn(),
  rerender: () => {},
  sendToChat: vi.fn(),
}));

vi.mock("@/hooks/useUltraGift", () => ({
  useUltraGift: () => ({ url: "https://armada.buzz/gift/npub1x", sendToChat: h.sendToChat }),
}));

vi.mock("@/hooks/useUltra", () => ({
  useMyUltra: () => ({ pubkey: "a".repeat(64), metadata: h.profile, ultra: readUltra(h.profile) }),
  usePublishUltra: () => ({
    publish: async (ultra: UltraProfile | undefined) => {
      h.publish(ultra);
      h.profile = withUltra(h.profile, ultra);
      h.rerender();
    },
    isPending: false,
  }),
}));

function Harness() {
  const [config, setConfig] = useState(defaultConfig);
  const [, setTick] = useState(0);
  h.rerender = () => setTick((n) => n + 1);
  return (
    <AppContext.Provider value={{ config, updateConfig: (fn) => setConfig(fn) }}>
      <UltraSettings />
    </AppContext.Provider>
  );
}

describe("UltraSettings", () => {
  afterEach(() => {
    vi.useRealTimers();
    h.profile = {};
    h.publish.mockReset();
  });

  it("pitches the perks with your own name, then activates for $0.00 into the profile", async () => {
    vi.useFakeTimers();
    h.profile = { name: "pixelwitch", about: "keep me" };
    render(<Harness />);
    expect(screen.getByText("The Ultra badge")).toBeInTheDocument();
    expect(screen.getAllByText("pixelwitch").length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("button", { name: /Get Ultra for \$0\.00/ }));
    fireEvent.click(screen.getByRole("button", { name: "Pay $0.00" }));
    expect(screen.getByText(/Processing your payment/)).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByText("Welcome to Ultra!")).toBeInTheDocument();
    expect(screen.getByTestId("confetti")).toBeInTheDocument();
    expect(h.profile).toMatchObject({ name: "pixelwitch", about: "keep me", armada_ultra: { name: "aurora", frame: "glow", effect: "sparkles" } });
  });

  it("saves a new look and cancels back to the pitch", async () => {
    h.profile = { name: "pixelwitch", armada_ultra: { since: 1, name: "aurora" } };
    render(<Harness />);
    expect(screen.getByText("You're Ultra")).toBeInTheDocument();

    // Name styles come first; "Gold" is a frame too.
    fireEvent.click(screen.getAllByRole("button", { name: "Gold" })[0]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save my look" })); });
    expect(h.publish).toHaveBeenLastCalledWith(expect.objectContaining({ since: 1, name: "gold" }));

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel Ultra" })); });
    expect(h.profile).toEqual({ name: "pixelwitch" });
    expect(screen.getByRole("button", { name: /Get Ultra/ })).toBeInTheDocument();
  });

  it("keeps the donation addresses behind one quiet link", () => {
    render(<Harness />);
    expect(screen.queryByTitle(DONATION_BITCOIN)).not.toBeInTheDocument();
    expect(screen.queryByText(/Soapbox/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Chip in" }));
    expect(screen.getByText("Support Armada")).toBeInTheDocument();
    expect(screen.getByTitle(DONATION_BITCOIN)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Monero" }));
    expect(screen.getByTitle(DONATION_MONERO)).toBeInTheDocument();
  });

  it("gifts Ultra from one button, sending the link to a chat from its dialog", () => {
    h.profile = { name: "pixelwitch" };
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Gift Ultra" }));
    fireEvent.click(screen.getByRole("button", { name: "Send to a chat" }));
    expect(h.sendToChat).toHaveBeenCalledOnce();
  });
});
