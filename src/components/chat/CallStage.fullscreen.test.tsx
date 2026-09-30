import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Track } from "livekit-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CallStage } from "./CallStage";
import { ScreenShareWatchContext } from "@/contexts/ScreenShareWatchContext";

const runtime = vi.hoisted(() => ({
  platform: "web",
  tracks: [] as Array<Record<string, unknown>>,
  signals: {
    enabled: true,
    raisedHands: new Set<string>(),
    reactions: [],
    hevcScreenShare: undefined as Record<string, unknown> | undefined,
  },
}));

const setStageOpen = vi.hoisted(() => vi.fn());
const exitFullscreen = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => runtime.platform },
}));

vi.mock("@livekit/components-react", () => ({
  useConnectionState: () => "connected",
  useParticipants: () => [],
  useSpeakingParticipants: () => [],
  useTracks: () => runtime.tracks,
  useRoomContext: () => ({
    localParticipant: { joinedAt: new Date(0) },
  }),
  VideoTrack: () => <div data-testid="video-track" />,
}));

vi.mock("@/components/chat/CallControls", () => ({
  MicButton: () => <button type="button" aria-label="Mute microphone" />,
  CameraButton: () => <button type="button" aria-label="Turn on camera" />,
  ScreenShareButton: () => <button type="button" aria-label="Screen share options" />,
  RaiseHandButton: () => <button type="button" aria-label="Raise hand" />,
  ReactionsMenu: () => <button type="button" aria-label="Reactions" />,
  LeaveButton: () => <button type="button" aria-label="Leave call" />,
}));

vi.mock("@/components/chat/VoiceBar", () => ({
  DeviceMenu: () => <button type="button" aria-label="Audio settings" />,
}));

vi.mock("@/components/chat/ScreenShareDiagnosticsDialog", async () => {
  const { createPortal } = await vi.importActual<typeof import("react-dom")>("react-dom");
  return {
    ScreenShareDiagnosticsDialog: ({
      open,
      portalContainer,
    }: {
      open: boolean;
      portalContainer?: HTMLElement;
    }) => open
      ? createPortal(<div role="dialog" data-state="open">Stream details</div>, portalContainer ?? document.body)
      : null,
  };
});

vi.mock("@/components/VoiceUserContextMenu", () => ({
  VoiceUserContextMenu: ({ children }: { children: React.ReactNode }) => children,
  VolumeSliderRow: () => null,
}));
vi.mock("@/components/DisplayName", () => ({
  DisplayName: ({ name }: { name?: string }) => <>{name}</>,
}));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: { metadata: {} } }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedDisplayName: () => "Friend",
}));
vi.mock("@/contexts/VoiceIdentityContext", () => ({
  useVoiceIdentity: () => () => ({ pubkey: "f".repeat(64), verified: true }),
}));
vi.mock("@/contexts/CallSignalsContext", () => ({
  useCallSignals: () => runtime.signals,
}));
vi.mock("@/hooks/useCall", () => ({
  useCall: () => ({
    setStageOpen,
    stageFloating: false,
    floatingVariant: "desktop",
  }),
}));
vi.mock("@/hooks/useVoiceActivity", () => ({
  useVoiceActivity: () => ({ raisedHands: new Set(), streamingPubkeys: new Set(), reactions: [] }),
}));
vi.mock("@/hooks/useUserVolume", () => ({
  useUserVolume: () => [1, vi.fn()],
  useScreenShareVolume: () => [1, vi.fn()],
}));
vi.mock("@/lib/callSounds", () => ({ playScreenShareSound: vi.fn(), playScreenShareEndSound: vi.fn() }));
vi.mock("@/lib/hevcScreenShare", () => ({
  isHevcScreenShareParticipant: () => false,
}));

let fullscreenElement: Element | null = null;
let requestFullscreen: ReturnType<typeof vi.fn>;
const originalRequestFullscreen = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "requestFullscreen",
);
const originalExitFullscreen = Object.getOwnPropertyDescriptor(document, "exitFullscreen");
const originalFullscreenElement = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
const originalFullscreenEnabled = Object.getOwnPropertyDescriptor(document, "fullscreenEnabled");
const originalResizeObserver = globalThis.ResizeObserver;
const originalMediaStream = globalThis.MediaStream;
const originalPlay = HTMLMediaElement.prototype.play;

function enterFullscreen(element: HTMLElement) {
  fullscreenElement = element;
  document.dispatchEvent(new Event("fullscreenchange"));
}

function standardScreenShare() {
  const participant = {
    identity: "remote",
    isLocal: false,
    isMicrophoneEnabled: true,
    joinedAt: new Date(0),
    setVolume: vi.fn(),
  };
  runtime.tracks = [{
    participant,
    source: Track.Source.ScreenShare,
    publication: {
      track: {},
      isMuted: false,
      trackSid: "screen-sid",
      videoTrack: { isLocal: false },
    },
  }];
}

// The viewer has opted into the remote stream.
function renderStage() {
  return render(
    <ScreenShareWatchContext.Provider
      value={{ watching: new Set(["f".repeat(64)]), watch: vi.fn(), stopWatching: vi.fn() }}
    >
      <CallStage open callLabel="Test call" />
    </ScreenShareWatchContext.Provider>,
  );
}

async function openFullscreen() {
  fireEvent.click(await screen.findByRole("button", { name: "View stream fullscreen" }));
  const controls = await waitFor(() => {
    const element = document.querySelector<HTMLElement>("[data-fullscreen-controls]");
    expect(element).not.toBeNull();
    return element!;
  });
  return controls;
}

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
  globalThis.MediaStream = class MediaStreamMock {
    constructor(_tracks?: MediaStreamTrack[]) {}
  } as typeof MediaStream;
  HTMLMediaElement.prototype.play = vi.fn(async () => {});
  requestFullscreen = vi.fn(function (this: HTMLElement) {
    enterFullscreen(this);
    return Promise.resolve();
  });
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
    configurable: true,
    value: requestFullscreen,
  });
  Object.defineProperty(document, "exitFullscreen", {
    configurable: true,
    value: exitFullscreen,
  });
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenElement,
  });
  Object.defineProperty(document, "fullscreenEnabled", {
    configurable: true,
    get: () => true,
  });
});

afterEach(() => {
  runtime.platform = "web";
  runtime.tracks = [];
  runtime.signals.hevcScreenShare = undefined;
  fullscreenElement = null;
  vi.useRealTimers();
  vi.clearAllMocks();
});

afterAll(() => {
  const restore = (target: object, key: PropertyKey, descriptor?: PropertyDescriptor) => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  };
  restore(HTMLElement.prototype, "requestFullscreen", originalRequestFullscreen);
  restore(document, "exitFullscreen", originalExitFullscreen);
  restore(document, "fullscreenElement", originalFullscreenElement);
  restore(document, "fullscreenEnabled", originalFullscreenEnabled);
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.MediaStream = originalMediaStream;
  HTMLMediaElement.prototype.play = originalPlay;
});

describe("screen-share fullscreen controls", () => {
  it("hides fullscreen affordances when the element API is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "requestFullscreen",
    );
    Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
    try {
      standardScreenShare();
      renderStage();
      expect(
        screen.queryByRole("button", { name: "View stream fullscreen" }),
      ).not.toBeInTheDocument();
    } finally {
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, "requestFullscreen", descriptor);
      }
    }
  });

  it("hides the unsupported arbitrary-element fullscreen action on Android", () => {
    runtime.platform = "android";
    standardScreenShare();
    renderStage();
    expect(screen.queryByRole("button", { name: "View stream fullscreen" })).not.toBeInTheDocument();
  });

  it("stays stable when the browser rejects the fullscreen request", async () => {
    standardScreenShare();
    requestFullscreen.mockRejectedValueOnce(new Error("fullscreen denied"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderStage();

    fireEvent.click(await screen.findByRole("button", { name: "View stream fullscreen" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.querySelector("[data-fullscreen-controls]")).toBeNull();
    expect(screen.getByRole("button", { name: "View stream fullscreen" })).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith(
      "failed to enter screen-share fullscreen",
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("exposes every call control for a standard share and keeps stats fullscreen", async () => {
    standardScreenShare();
    renderStage();
    const controls = await openFullscreen();
    for (const name of [
      "Mute microphone",
      "Turn on camera",
      "Screen share options",
      "Raise hand",
      "Reactions",
      "Leave call",
    ]) {
      expect(within(controls).getByRole("button", { name })).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole("button", { name: "Show stream details" }));
    const dialog = await screen.findByRole("dialog");
    expect(exitFullscreen).not.toHaveBeenCalled();
    expect(fullscreenElement).toContainElement(dialog);
  });

  it("auto-hides after three idle seconds, reveals on input, and ignores mouse focus", async () => {
    standardScreenShare();
    renderStage();
    const controls = await openFullscreen();
    vi.useFakeTimers();
    expect(controls).toHaveClass("opacity-100");

    const mic = within(controls).getByRole("button", { name: "Mute microphone" });
    const originalQuerySelector = controls.querySelector.bind(controls);
    const focusVisible = vi.spyOn(controls, "querySelector").mockImplementation(
      (selector: string) => selector === ":focus-visible"
        ? null
        : originalQuerySelector(selector),
    );
    fireEvent.pointerDown(mic);
    mic.focus();
    fireEvent.pointerUp(document);
    expect(document.activeElement).toBe(mic);
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(controls).toHaveClass("opacity-0");
    focusVisible.mockRestore();

    fireEvent.pointerMove(fullscreenElement!);
    expect(controls).toHaveClass("opacity-100");
  });

  it("stays visible for keyboard focus and open fullscreen surfaces", async () => {
    standardScreenShare();
    renderStage();
    const controls = await openFullscreen();
    vi.useFakeTimers();
    const mic = within(controls).getByRole("button", { name: "Mute microphone" });
    const originalQuerySelector = controls.querySelector.bind(controls);
    const focusVisible = vi.spyOn(controls, "querySelector").mockImplementation(
      (selector: string) => selector === ":focus-visible"
        ? mic
        : originalQuerySelector(selector),
    );

    fireEvent.keyDown(document, { key: "Tab" });
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(controls).toHaveClass("opacity-100");

    focusVisible.mockRestore();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    fullscreenElement!.append(dialog);
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(controls).toHaveClass("opacity-100");

    dialog.remove();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(controls).toHaveClass("opacity-0");
  });

  it("renders the same controls and in-fullscreen stats for local H.265", async () => {
    runtime.tracks = [];
    runtime.signals.hevcScreenShare = {
      active: true,
      previewTrack: { readyState: "live" },
      publisherIdentity: "hevc-publisher",
      status: { active: true, state: "connected" },
    };
    renderStage();
    const controls = await openFullscreen();
    for (const name of [
      "Mute microphone",
      "Turn on camera",
      "Screen share options",
      "Raise hand",
      "Reactions",
      "Leave call",
    ]) {
      expect(within(controls).getByRole("button", { name })).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole("button", { name: "Show stream details" }));
    const dialog = await screen.findByRole("dialog");
    expect(exitFullscreen).not.toHaveBeenCalled();
    expect(fullscreenElement).toContainElement(dialog);
  });

  it("removes fullscreen controls when the browser exits externally", async () => {
    standardScreenShare();
    renderStage();
    await openFullscreen();
    fullscreenElement = null;
    fireEvent(document, new Event("fullscreenchange"));
    await waitFor(() => {
      expect(document.querySelector("[data-fullscreen-controls]")).toBeNull();
    });
    expect(screen.getByRole("button", { name: "View stream fullscreen" })).toBeInTheDocument();
  });
});
