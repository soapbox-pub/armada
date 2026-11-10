import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@/contexts/AppContext";

const h = vi.hoisted(() => ({
  config: { discoverCuration: "", discoverUnfiltered: false } as Pick<AppConfig, "discoverCuration" | "discoverUnfiltered">,
  allowed: true,
  signedIn: true,
}));

vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({
    config: h.config,
    updateConfig: (fn: (c: typeof h.config) => typeof h.config) => {
      h.config = fn(h.config);
    },
  }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.signedIn ? { pubkey: "a".repeat(64) } : undefined }),
}));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useDiscover", () => ({
  useDiscoverEveryoneAllowed: () => h.allowed,
}));

const { DiscoverCurationSettings } = await import("./DiscoverCurationSettings");

function add(value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Add a curator" }), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
}
const typeNone = () => add("none");

beforeEach(() => {
  h.config = { discoverCuration: "", discoverUnfiltered: false };
  h.allowed = true;
  h.signedIn = true;
});

const NPUB = "npub10qdp2fc9ta6vraczxrcs8prqnv69fru2k6s2dj48gqjcylulmtjsg9arpj";
const HEX = "b".repeat(64);

describe("DiscoverCurationSettings", () => {
  it("lists the Armada Developers as the default curators", () => {
    render(<DiscoverCurationSettings />);
    expect(screen.getByText("Armada Developers")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Armada Developers" })).not.toBeInTheDocument();
  });

  it("adds curators to the list, once each", () => {
    const { rerender } = render(<DiscoverCurationSettings />);
    add(HEX);
    expect(h.config.discoverCuration).toBe(`armada-developers, ${HEX}`);
    rerender(<DiscoverCurationSettings />);
    add(`${HEX}, ${NPUB}`);
    expect(h.config.discoverCuration).toBe(`armada-developers, ${HEX}, ${NPUB}`);
  });

  it("removes a curator, down to none, and can add the developers back", () => {
    h.config = { ...h.config, discoverCuration: `armada-developers, ${HEX}` };
    const { rerender } = render(<DiscoverCurationSettings />);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove curator" })[0]);
    expect(h.config.discoverCuration).toBe(HEX);
    rerender(<DiscoverCurationSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Remove curator" }));
    expect(h.config.discoverCuration).toBe("none");
    rerender(<DiscoverCurationSettings />);
    expect(screen.getByText(/No curators/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Armada Developers" }));
    expect(h.config.discoverCuration).toBe("armada-developers");
  });

  it("reads typed none as only the network, and asks before going unfiltered", () => {
    render(<DiscoverCurationSettings />);
    typeNone();

    expect(h.config).toEqual({ discoverCuration: "none", discoverUnfiltered: false });
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/not responsible/);

    fireEvent.click(screen.getByRole("button", { name: "I understand" }));
    expect(h.config.discoverUnfiltered).toBe(true);
  });

  it("stays filtered when the warning is cancelled", () => {
    render(<DiscoverCurationSettings />);
    typeNone();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(h.config).toEqual({ discoverCuration: "none", discoverUnfiltered: false });
  });

  it("answers behind the ⓘ beside no curators, and asks before going unfiltered", () => {
    const { rerender } = render(<DiscoverCurationSettings />);
    expect(screen.queryByRole("button", { name: "About no curators" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove curator" }));
    rerender(<DiscoverCurationSettings />);
    fireEvent.click(screen.getByRole("button", { name: "About no curators" }));
    fireEvent.click(screen.getByRole("button", { name: "Turn off filtering" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/not responsible/);
    fireEvent.click(screen.getByRole("button", { name: "I understand" }));

    expect(h.config).toEqual({ discoverCuration: "none", discoverUnfiltered: true });
  });

  it("lists everyone while on, and removes it like a curator", () => {
    h.config = { discoverCuration: "none", discoverUnfiltered: true };
    render(<DiscoverCurationSettings />);
    expect(screen.getByText("Unfiltered")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Turn off unfiltered" }));
    expect(h.config).toEqual({ discoverCuration: "none", discoverUnfiltered: false });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("turns everyone off when a curator is added", () => {
    h.config = { discoverCuration: "none", discoverUnfiltered: true };
    render(<DiscoverCurationSettings />);
    add(HEX);

    expect(h.config).toEqual({ discoverCuration: HEX, discoverUnfiltered: false });
  });

  it("never brings a stale switch back by removing the last curator", () => {
    h.config = { discoverCuration: HEX, discoverUnfiltered: true };
    render(<DiscoverCurationSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Remove curator" }));

    expect(h.config).toEqual({ discoverCuration: "none", discoverUnfiltered: false });
  });

  it("offers nothing unfiltered in a store install or signed out", () => {
    for (const [allowed, signedIn] of [[false, true], [true, false]]) {
      h.allowed = allowed;
      h.signedIn = signedIn;
      h.config = { discoverCuration: "none", discoverUnfiltered: false };
      const { unmount } = render(<DiscoverCurationSettings />);
      expect(screen.queryByRole("button", { name: "About no curators" })).not.toBeInTheDocument();
      typeNone();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(h.config).toEqual({ discoverCuration: "none", discoverUnfiltered: false });
      unmount();
    }
  });
});
