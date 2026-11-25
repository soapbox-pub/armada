import { render, screen, within } from "@testing-library/react";
import { Track } from "livekit-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CallStage } from "./CallStage";
import { IrohPeersContext, type P2pPeerView } from "@/lib/irohVoice/peers";

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
  useScopedDisplayName: (pubkey: string) => (pubkey === "a".repeat(64) ? "Me" : pubkey === "d".repeat(64) ? "Vector peer" : "Friend"),
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


afterEach(() => {
  runtime.participants = [];
  runtime.tracks = [];
  vi.clearAllMocks();
});

class FakeMediaStream {
  constructor(readonly tracks: unknown[]) {}
}
vi.stubGlobal("MediaStream", FakeMediaStream);
// jsdom has no media playback.
HTMLMediaElement.prototype.play = () => Promise.resolve();

const vectorPeer: P2pPeerView = {
  pubkey: "d".repeat(64),
  endpoint: "e".repeat(64),
  speaking: true,
  muted: false,
  sending: { camera: false, screen: false },
};

function renderWith(peers: P2pPeerView[], connections = true, onBoth?: ReadonlySet<string>) {
  return render(
    <IrohPeersContext.Provider value={{ peers, connections, onBoth }}>
      <CallStage open callLabel="#lounge" />
    </IrohPeersContext.Provider>,
  );
}

describe("peer-to-peer members on the LiveKit call's stage", () => {
  it("puts a Vector member in the hero beside the LiveKit participants, speaking and muted as they are", () => {
    runtime.participants = [local, remote];
    renderWith([vectorPeer, { ...vectorPeer, pubkey: "f".repeat(64), endpoint: "1".repeat(64), speaking: false, muted: true }]);
    const hero = screen.getByRole("region", { name: "Call" });
    expect(within(hero).getByText("You")).toBeInTheDocument();
    expect(within(hero).getByText("Vector peer")).toBeInTheDocument();
    expect(within(hero).getAllByText("Friend")).toHaveLength(2);
    expect(within(hero).getAllByLabelText("Muted")).toHaveLength(1);
    expect(hero.querySelectorAll(".ring-success")).toHaveLength(1);
  });

  it("shows a Vector member's camera and screen as tiles once their pictures arrive", () => {
    runtime.participants = [local, remote];
    runtime.tracks = [camera(remote)];
    const track = { kind: "video", id: "v" } as unknown as MediaStreamTrack;
    renderWith([{ ...vectorPeer, sending: { camera: true, screen: true }, camera: track, screen: track }]);
    const tiles = screen.getAllByTestId("p2p-tile");
    expect(tiles).toHaveLength(2);
    expect(tiles.every((t) => t.querySelector("video"))).toBe(true);
    expect(screen.getAllByText("Vector peer", { exact: false }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("'s screen", { exact: false })).toBeInTheDocument();
  });

  it("marks how each participant is connected: LiveKit for the room's participants, peer to peer for the Vector member", () => {
    runtime.participants = [local, remote];
    renderWith([vectorPeer]);
    const hero = screen.getByRole("region", { name: "Call" });
    const marks = [...hero.querySelectorAll("[data-connection]")].map((el) => el.getAttribute("data-connection"));
    expect(marks.sort()).toEqual(["p2p", "sfu", "sfu"]);
    expect(within(hero).getAllByLabelText("Connected over the LiveKit server")).toHaveLength(2);
    expect(within(hero).getByLabelText("Connected peer to peer")).toBeInTheDocument();
  });

  it("marks a LiveKit participant also on iroh with both, LiveKit first", () => {
    runtime.participants = [local, remote];
    renderWith([vectorPeer], true, new Set(["b".repeat(64)]));
    const hero = screen.getByRole("region", { name: "Call" });
    const both = [...hero.querySelectorAll("[data-also]")].map((el) => [el.getAttribute("data-connection"), el.getAttribute("data-also")]);
    expect(both).toEqual([["sfu", "p2p"]]);
    expect(within(hero).getByLabelText("On LiveKit and peer to peer, heard here over LiveKit")).toBeInTheDocument();
  });

  it("marks the tiles the same way, and shows no marker on a call that is LiveKit only (NIP-29, DMs)", () => {
    runtime.participants = [local, remote];
    runtime.tracks = [camera(remote)];
    const { unmount } = renderWith([vectorPeer]);
    expect(screen.getAllByTestId("p2p-tile")[0].querySelector("[data-connection=p2p]")).not.toBeNull();
    expect(document.querySelectorAll("[data-connection=sfu]").length).toBeGreaterThanOrEqual(2);
    unmount();
    renderWith([], false);
    expect(document.querySelectorAll("[data-connection]")).toHaveLength(0);
  });
});
