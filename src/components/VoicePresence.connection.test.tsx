import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { VoiceRowTransport } from "@/concord/lib/voice";

import { VoiceParticipantList } from "./VoicePresence";

vi.mock("@/components/VoiceUserContextMenu", () => ({
  VoiceUserContextMenu: ({ children }: { children: React.ReactNode }) => children,
  VoiceUserMenuButton: () => null,
}));
vi.mock("@/components/DisplayName", () => ({ DisplayName: ({ name }: { name?: string }) => <>{name}</> }));
vi.mock("@/components/UserAvatar", () => ({ UserAvatar: () => null }));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useCall", () => ({ useCall: () => ({}) }));

const pk = (c: string) => c.repeat(64);

describe("the voice roster's connection marker", () => {
  it("shows exactly one marker per member: LiveKit when on it, peer to peer only when off it", () => {
    const transports = new Map<string, VoiceRowTransport>([
      [pk("a"), "sfu"],
      [pk("b"), "bridge"],
      [pk("c"), "linked"],
      [pk("d"), "other"],
    ]);
    const { container } = render(
      <TooltipProvider>
        <VoiceParticipantList participants={[pk("a"), pk("b"), pk("c"), pk("d")]} transports={transports} />
      </TooltipProvider>,
    );
    const marks = [...container.querySelectorAll("[data-connection]")].map((el) => el.getAttribute("data-connection"));
    expect(marks).toEqual(["sfu", "sfu", "p2p", "p2p"]);
    expect(screen.getByLabelText("Connected over the LiveKit server")).toBeInTheDocument();
    expect(screen.getByLabelText("In the call peer to peer, connected to you")).toBeInTheDocument();
    expect(screen.getByLabelText("In the call peer to peer only")).toBeInTheDocument();
  });

  it("shows a member on both transports with both icons, the one heard over first", () => {
    const transports = new Map<string, VoiceRowTransport>([
      [pk("a"), "both"],
      [pk("b"), "bothLinked"],
    ]);
    const { container } = render(
      <TooltipProvider>
        <VoiceParticipantList participants={[pk("a"), pk("b")]} transports={transports} />
      </TooltipProvider>,
    );
    const marks = [...container.querySelectorAll("[data-connection]")].map((el) => [el.getAttribute("data-connection"), el.getAttribute("data-also")]);
    expect(marks).toEqual([["sfu", "p2p"], ["p2p", "sfu"]]);
    expect(screen.getByLabelText("On LiveKit and peer to peer, heard here over LiveKit")).toBeInTheDocument();
    expect(screen.getByLabelText("On LiveKit and peer to peer, heard here peer to peer")).toBeInTheDocument();
  });
});
