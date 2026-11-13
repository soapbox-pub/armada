import { fireEvent, render, screen, within } from "@testing-library/react";
import { Track } from "livekit-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CallStage } from "./CallStage";
import { ScreenShareWatchContext } from "@/contexts/ScreenShareWatchContext";
import { playScreenShareEndSound, playScreenShareSound } from "@/lib/callSounds";

const runtime = vi.hoisted(() => ({
  participants: [] as Array<Record<string, unknown>>,
  tracks: [] as Array<Record<string, unknown>>,
  streaming: new Set<string>(),
  connectionState: "connected",
  call: {
    stageFloating: false,
    floatingVariant: null as "desktop" | "mobile" | null,
    stageDocked: true,
    exiting: false,
    activeCall: null as Record<string, unknown> | null,
  },
}));

const setStageOpen = vi.hoisted(() => vi.fn());

vi.mock("@livekit/components-react", () => ({
  useConnectionState: () => runtime.connectionState,
  useParticipants: () => runtime.participants,
  useSpeakingParticipants: () => [],
  useTracks: () => runtime.tracks,
  useRoomContext: () => ({ localParticipant: { joinedAt: new Date(0) } }),
  VideoTrack: () => <div data-testid="video-track" />,
}));

vi.mock("@/components/chat/CallControls", () => ({
  MicButton: () => <button type="button" aria-label="Mute microphone" />,
  CameraButton: () => <button type="button" aria-label="Turn on camera" />,
  ScreenShareButton: () => <button type="button" aria-label="Share screen" />,
  RaiseHandButton: () => null,
  ReactionsMenu: () => null,
  LeaveButton: () => <button type="button" aria-label="Leave call" />,
}));
vi.mock("@/components/chat/VoiceBar", () => ({
  DeviceMenu: () => <button type="button" aria-label="Audio settings" />,
}));
vi.mock("@/components/VoiceUserContextMenu", () => ({
  VoiceUserContextMenu: ({ children }: { children: React.ReactNode }) => children,
  VolumeSliderRow: () => null,
}));
vi.mock("@/components/DisplayName", () => ({
  DisplayName: ({ name }: { name?: string }) => <>{name}</>,
}));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: { metadata: {} } }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedDisplayName: (pubkey: string) => (pubkey === "a".repeat(64) ? "Me" : "Friend"),
}));
vi.mock("@/contexts/VoiceIdentityContext", () => ({
  useVoiceIdentity: () => (identity: string) => ({
    pubkey: identity === "local" ? "a".repeat(64) : identity === "remote" ? "b".repeat(64) : identity.padEnd(64, "c"),
    verified: true,
  }),
}));
vi.mock("@/contexts/CallSignalsContext", () => ({
  useCallSignals: () => ({ enabled: false, reactions: [], hevcScreenShare: undefined }),
}));
vi.mock("@/hooks/useCall", () => ({
  useCall: () => ({ ...runtime.call, setStageOpen }),
}));
vi.mock("@/hooks/useVoiceActivity", () => ({
  useVoiceActivity: () => ({ raisedHands: new Set(), streamingPubkeys: runtime.streaming }),
}));
vi.mock("@/hooks/useUserVolume", () => ({
  useUserVolume: () => [1, vi.fn()],
  useScreenShareVolume: () => [1, vi.fn()],
}));
vi.mock("@/lib/callSounds", () => ({ playScreenShareSound: vi.fn(), playScreenShareEndSound: vi.fn() }));
vi.mock("@/lib/hevcScreenShare", () => ({ isHevcScreenShareParticipant: () => false }));

function participant(identity: string, isLocal: boolean) {
  return {
    identity,
    isLocal,
    isMicrophoneEnabled: true,
    joinedAt: new Date(0),
    setVolume: vi.fn(),
    getTrackPublication: () => undefined,
  };
}

const local = participant("local", true);
const remote = participant("remote", false);

function camera(of: Record<string, unknown>) {
  return {
    participant: of,
    source: Track.Source.Camera,
    publication: { track: {}, isMuted: false, trackSid: `${of.identity}-cam` },
  };
}

// The setup's matchMedia matches nothing: a phone, as far as useIsDesktop knows.
const phoneMedia = vi.mocked(window.matchMedia).getMockImplementation()!;

afterEach(() => {
  vi.mocked(window.matchMedia).mockImplementation(phoneMedia);
  runtime.participants = [];
  runtime.tracks = [];
  runtime.streaming = new Set();
  runtime.connectionState = "connected";
  runtime.call.stageDocked = true;
  runtime.call.exiting = false;
  runtime.call.activeCall = null;
  vi.clearAllMocks();
});

describe("docked call layout", () => {
  it("shows a voice-only channel call as the hero with its controls, not a stage", () => {
    runtime.participants = [local, remote];
    render(<CallStage open callLabel="#general" />);
    const hero = screen.getByRole("region", { name: "Call" });
    expect(within(hero).getByText("You")).toBeInTheDocument();
    expect(within(hero).getByText("Friend")).toBeInTheDocument();
    expect(within(hero).getByRole("button", { name: "Leave call" })).toBeInTheDocument();
    expect(within(hero).getByRole("button", { name: "Audio settings" })).toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "Resize call pane" })).not.toBeInTheDocument();
  });

  it("folds a crowded room's extra people into a count", () => {
    runtime.participants = [local, ...Array.from({ length: 9 }, (_, i) => participant(`remote-${i}`, false))];
    render(<CallStage open callLabel="#general" />);
    const hero = screen.getByRole("region", { name: "Call" });
    expect(within(hero).getAllByText("Friend")).toHaveLength(7);
    expect(within(hero).getByText("+2")).toBeInTheDocument();
    expect(within(hero).getByText("You")).toBeInTheDocument();
  });

  it("reads Calling… in a DM until the peer is in the room, then runs the clock", () => {
    runtime.call.activeCall = { dm: { peer: "b".repeat(64) } };
    runtime.participants = [local];
    const { rerender } = render(<CallStage open callLabel="Friend" />);
    expect(screen.getByText("Calling…")).toBeInTheDocument();

    runtime.participants = [local, remote];
    rerender(<CallStage open callLabel="Friend" />);
    expect(screen.queryByText("Calling…")).not.toBeInTheDocument();
    expect(screen.getByText("0:00")).toBeInTheDocument();
  });

  it("shows a voice-only DM as both people side by side", () => {
    runtime.call.activeCall = { dm: { peer: "b".repeat(64) } };
    runtime.participants = [local, remote];
    render(<CallStage open callLabel="Friend call" />);
    const hero = screen.getByRole("region", { name: "Call" });
    expect(within(hero).getByText("You")).toBeInTheDocument();
    expect(within(hero).getByText("Friend")).toBeInTheDocument();
    expect(within(hero).getByRole("button", { name: "Leave call" })).toBeInTheDocument();
    expect(within(hero).queryByTitle("Me (you)")).not.toBeInTheDocument();
  });

  it("names the ringing peer in the DM hero before they join", () => {
    runtime.call.activeCall = { dm: { peer: "b".repeat(64) } };
    runtime.participants = [local];
    render(<CallStage open callLabel="Friend call" />);
    const hero = screen.getByRole("region", { name: "Call" });
    expect(within(hero).getByText("Friend")).toBeInTheDocument();
    expect(within(hero).getByText("Calling…")).toBeInTheDocument();
  });

  it("expands the DM hero to full screen and back", () => {
    runtime.call.activeCall = { dm: { peer: "b".repeat(64) } };
    runtime.participants = [local, remote];
    render(<CallStage open callLabel="Friend call" />);
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    const dialog = screen.getByRole("dialog", { name: "Call" });
    expect(within(dialog).getByText("You")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Exit full screen" }));
    expect(screen.queryByRole("dialog", { name: "Call" })).not.toBeInTheDocument();
  });

  it("promotes to the stage when video starts and collapses back on Hide video", () => {
    vi.mocked(window.matchMedia).mockImplementation(
      (query: string) => ({ matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList,
    );
    runtime.participants = [local, remote];
    runtime.tracks = [camera(remote)];
    render(<CallStage open callLabel="Friend" />);
    expect(screen.getByRole("separator", { name: "Resize call pane" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave call" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide video" }));
    expect(setStageOpen).toHaveBeenCalledWith(false);
  });

  it("keeps a collapsed stage as the hero, offering to show the video", () => {
    runtime.participants = [local, remote];
    runtime.tracks = [camera(remote)];
    render(<CallStage open={false} callLabel="Friend" />);
    expect(screen.queryByRole("separator", { name: "Resize call pane" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show video" }));
    expect(setStageOpen).toHaveBeenCalledWith(true);
  });

  it("gives a 1:1 call's stage to the peer and hides our own camera-off tile", () => {
    runtime.participants = [local, remote];
    runtime.tracks = [camera(remote)];
    render(<CallStage open callLabel="Friend" />);
    expect(screen.getAllByTestId("video-track")).toHaveLength(1);
    expect(screen.queryByText(/\(you\)/)).not.toBeInTheDocument();
  });

  it("keeps a late-joining streamer on screen in a crowded room", () => {
    runtime.participants = [local, ...Array.from({ length: 9 }, (_, i) => participant(`remote-${i}`, false))];
    runtime.streaming = new Set(["remote-8".padEnd(64, "c")]);
    render(<CallStage open callLabel="#general" />);
    const hero = screen.getByRole("region", { name: "Call" });
    expect(within(hero).getAllByRole("button", { name: "Watch stream" })).toHaveLength(1);
    expect(within(hero).getByText("+2")).toBeInTheDocument();
  });

  it("tunes into a streamer from the LIVE badge on their avatar", () => {
    runtime.participants = [local, remote];
    runtime.streaming = new Set(["b".repeat(64)]);
    const watch = vi.fn();
    render(
      <ScreenShareWatchContext.Provider value={{ watching: new Set(), watch, stopWatching: vi.fn() }}>
        <CallStage open callLabel="#general" />
      </ScreenShareWatchContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Watch stream" }));
    expect(watch).toHaveBeenCalledWith("b".repeat(64));
  });

  it("offers an unwatched screen share as a Watch stream tile, not its video", () => {
    const sharer = {
      ...participant("sharer", false),
      getTrackPublication: (source: Track.Source) => (source === Track.Source.ScreenShare ? {} : undefined),
    };
    runtime.participants = [local, remote, sharer];
    runtime.tracks = [
      camera(remote),
      { participant: sharer, source: Track.Source.ScreenShare, publication: { track: {}, isMuted: false, trackSid: "ss" } },
    ];
    render(<CallStage open callLabel="#general" />);
    expect(screen.getAllByTestId("video-track")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /Watch stream/ })[0]).toBeInTheDocument();
  });

  it("insets our camera in a 1:1 video call", () => {
    runtime.participants = [local, remote];
    runtime.tracks = [camera(remote), camera(local)];
    render(<CallStage open callLabel="Friend" />);
    const self = screen.getByText(/\(you\)/).closest(".aspect-video");
    expect(self).toHaveClass("absolute");
  });

  it("opens theater on a phone when video starts in the docked call", () => {
    runtime.participants = [local, remote];
    const { rerender } = render(<CallStage open callLabel="Friend" />);
    expect(screen.queryByRole("dialog", { name: "Call" })).not.toBeInTheDocument();

    runtime.tracks = [camera(remote)];
    rerender(<CallStage open callLabel="Friend" />);
    expect(screen.getByRole("dialog", { name: "Call" })).toBeInTheDocument();
  });

  it("leaves theater alone when the stage is not docked", () => {
    runtime.call.stageDocked = false;
    runtime.participants = [local, remote];
    const { rerender } = render(<CallStage open callLabel="Friend" />);
    runtime.tracks = [camera(remote)];
    rerender(<CallStage open callLabel="Friend" />);
    expect(screen.queryByRole("dialog", { name: "Call" })).not.toBeInTheDocument();
  });
});

describe("screen share chirps", () => {
  const sharer = {
    ...participant("sharer", false),
    getTrackPublication: (source: Track.Source) => (source === Track.Source.ScreenShare ? {} : undefined),
  };

  it("chirps up when a share starts and down when it ends", () => {
    runtime.participants = [local, remote];
    const { rerender } = render(<CallStage open callLabel="#general" />);
    runtime.participants = [local, remote, sharer];
    rerender(<CallStage open callLabel="#general" />);
    expect(playScreenShareSound).toHaveBeenCalledTimes(1);
    expect(playScreenShareEndSound).not.toHaveBeenCalled();

    runtime.participants = [local, remote];
    rerender(<CallStage open callLabel="#general" />);
    expect(playScreenShareEndSound).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when our own reconnect drops every share", () => {
    runtime.participants = [local, remote, sharer];
    const { rerender } = render(<CallStage open callLabel="#general" />);
    runtime.connectionState = "reconnecting";
    runtime.participants = [local];
    rerender(<CallStage open callLabel="#general" />);
    expect(playScreenShareEndSound).not.toHaveBeenCalled();
  });
});
