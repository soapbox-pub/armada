import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InCallView } from "./VoiceBar";
import { TooltipProvider } from "@/components/ui/tooltip";

import type { CallContextType } from "@/contexts/CallContext";

const platform = vi.hoisted(() => ({ name: "web" }));
const deviceSelect = vi.hoisted(() => vi.fn());
/** What the mocked useMediaDeviceSelect reports; `devices` overrides the default per-kind list. */
const picker = vi.hoisted(() => ({
  devices: undefined as MediaDeviceInfo[] | undefined,
  activeDeviceId: "",
  setActiveMediaDevice: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => platform.name, isNativePlatform: () => platform.name !== "web" },
}));

vi.mock("@/hooks/useCall", () => ({
  useCall: () => ({ stageVisible: false, toggleStage: vi.fn() }) as unknown as CallContextType,
}));

vi.mock("@livekit/components-react", () => ({
  useConnectionState: () => "connected",
  useParticipants: () => [],
  useLocalParticipant: () => ({
    localParticipant: {
      setMicrophoneEnabled: vi.fn(),
      setCameraEnabled: vi.fn(),
      getTrackPublication: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    },
    isMicrophoneEnabled: true,
    isCameraEnabled: false,
    isScreenShareEnabled: false,
  }),
  useMediaDeviceSelect: (opts: { kind: MediaDeviceKind; requestPermissions: boolean }) => {
    deviceSelect(opts);
    return {
      devices: picker.devices?.filter((d) => d.kind === opts.kind) ?? [
        { deviceId: `${opts.kind}-1`, label: "", kind: opts.kind } as MediaDeviceInfo,
      ],
      activeDeviceId: picker.activeDeviceId,
      setActiveMediaDevice: picker.setActiveMediaDevice,
    };
  },
  useRoomContext: () => ({ canPlaybackAudio: true, startAudio: vi.fn() }),
  DisconnectButton: () => null,
}));

const nativeCall = vi.hoisted(() => ({
  available: false,
  routes: { supported: true, routes: [] as Array<{ id: number; type: string; name: string }>, active: null as number | null },
  selectRoute: vi.fn<(o: { id: number }) => Promise<{ ok: boolean }>>(async () => ({ ok: true })),
}));
vi.mock("@/lib/nativeCall", () => ({
  hasNativeCallService: () => nativeCall.available,
  ArmadaCall: {
    listRoutes: async () => nativeCall.routes,
    selectRoute: (o: { id: number }) => nativeCall.selectRoute(o),
    addListener: async () => ({ remove: vi.fn() }),
  },
}));

vi.mock("@/lib/voiceProcessor", () => ({ rnnoiseSupported: () => false, syncRnnoise: vi.fn() }));
vi.mock("@/lib/callSounds", () => ({
  playJoinSound: vi.fn(),
  playLeaveSound: vi.fn(),
  playMuteSound: vi.fn(),
  playUnmuteSound: vi.fn(),
}));

function stubDevices(list: Array<Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">>) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices: () => Promise.resolve(list) },
  });
}

function openMenu() {
  render(
    <TooltipProvider>
      <InCallView label="#general" compact />
    </TooltipProvider>,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Audio settings" }), { key: "Enter" });
}

/** The permission each picker asked for, by kind, as of its latest render. */
function requested(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [opts] of deviceSelect.mock.calls) out[opts.kind] = opts.requestPermissions;
  return out;
}

beforeEach(() => {
  platform.name = "web";
  stubDevices([
    { deviceId: "default", kind: "audioinput", label: "" },
    { deviceId: "mic-1", kind: "audioinput", label: "USB Mic" },
    { deviceId: "", kind: "videoinput", label: "" },
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
  picker.devices = undefined;
  picker.activeDeviceId = "";
  localStorage.clear();
  nativeCall.available = false;
  nativeCall.routes = { supported: true, routes: [], active: null };
});

describe("call device menu", () => {
  it("opens no capture when device names are already readable, and never asks for the camera", async () => {
    openMenu();
    expect(await screen.findByText("Microphone")).toBeTruthy();
    await waitFor(() => expect(deviceSelect).toHaveBeenCalled());
    expect(requested()).toMatchObject({ audioinput: false, videoinput: false });
  });

  it("asks for the mic only while its devices are unnamed", async () => {
    stubDevices([{ deviceId: "mic-1", kind: "audioinput", label: "" }]);
    openMenu();
    await waitFor(() => expect(requested().audioinput).toBe(true));
    expect(requested().videoinput).toBe(false);
  });

  it("offers no mic or speaker routes on Android", async () => {
    platform.name = "android";
    openMenu();
    expect(await screen.findByText("Camera")).toBeTruthy();
    expect(screen.queryByText("Microphone")).toBeNull();
    expect(screen.queryByText("Speaker")).toBeNull();
    expect(deviceSelect.mock.calls.map(([o]) => o.kind)).not.toContain("audioinput");
  });

  it("offers the native output routes on Android, and applies a pick", async () => {
    platform.name = "android";
    nativeCall.available = true;
    nativeCall.routes = {
      supported: true,
      routes: [
        { id: 9, type: "bluetooth", name: "Pixel Buds" },
        { id: 3, type: "speaker", name: "" },
        { id: 2, type: "earpiece", name: "" },
      ],
      active: 3,
    };
    openMenu();
    expect(await screen.findByText("Output")).toBeTruthy();
    expect(screen.getByText("Pixel Buds")).toBeTruthy();
    expect(screen.getByText("Speaker")).toBeTruthy();
    fireEvent.click(screen.getByText("Phone earpiece"));
    await waitFor(() => expect(nativeCall.selectRoute).toHaveBeenCalledWith({ id: 2 }));
  });

  it("shows no output group where the service reports none", async () => {
    platform.name = "android";
    nativeCall.available = true;
    nativeCall.routes = { supported: false, routes: [], active: null };
    openMenu();
    expect(await screen.findByText("Camera")).toBeTruthy();
    expect(screen.queryByText("Output")).toBeNull();
  });

  it("names unlabeled cameras by position", async () => {
    openMenu();
    expect(await screen.findByText("Camera 1")).toBeTruthy();
  });

  it("checks Default when LiveKit reports the system default as an empty id", async () => {
    // Under webAudioMix, LiveKit records "" when it can't map "default" to a device.
    picker.devices = [
      { deviceId: "default", kind: "audioinput", label: "Default" },
      { deviceId: "mic-1", kind: "audioinput", label: "USB Mic" },
    ] as MediaDeviceInfo[];
    openMenu();
    const checkOf = (label: string) =>
      screen.getByText(label).closest("[role='menuitem']")?.querySelector("svg")?.getAttribute("class");
    expect(await screen.findByText("USB Mic")).toBeTruthy();
    expect(checkOf("Default")).toContain("opacity-100");
    expect(checkOf("USB Mic")).toContain("opacity-0");
  });

  describe("on touch", () => {
    beforeEach(() => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }));
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function openSheet() {
      render(
        <TooltipProvider>
          <InCallView label="#general" compact />
        </TooltipProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Audio settings" }));
      return screen.getByRole("dialog", { name: "Audio settings" });
    }

    it("opens a sheet whose pickers are pages showing the current choice", async () => {
      picker.devices = [
        { deviceId: "default", kind: "audioinput", label: "Default" },
        { deviceId: "mic-1", kind: "audioinput", label: "USB Mic" },
      ] as MediaDeviceInfo[];
      const sheet = openSheet();
      expect(screen.queryByRole("menu")).toBeNull();
      const row = await within(sheet).findByRole("button", { name: /Microphone/ });
      expect(row).toHaveTextContent("Default");
      fireEvent.click(row);
      fireEvent.click(within(sheet).getByRole("radio", { name: "USB Mic" }));
      expect(localStorage.getItem("armada:voice:micDeviceId")).toBe("mic-1");
      expect(screen.getByRole("dialog", { name: "Audio settings" })).toBeInTheDocument();
    });

    it("toggles processing in place, leaving the sheet open", () => {
      const sheet = openSheet();
      const toggle = within(sheet).getByRole("switch", { name: "Echo cancellation" });
      const before = toggle.getAttribute("aria-checked");
      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-checked")).not.toBe(before);
      expect(screen.getByRole("dialog", { name: "Audio settings" })).toBeInTheDocument();
    });

    it("pages the native output routes on Android", async () => {
      platform.name = "android";
      nativeCall.available = true;
      nativeCall.routes = {
        supported: true,
        routes: [
          { id: 3, type: "speaker", name: "" },
          { id: 2, type: "earpiece", name: "" },
        ],
        active: 3,
      };
      const sheet = openSheet();
      const row = await within(sheet).findByRole("button", { name: /Output/ });
      expect(row).toHaveTextContent("Speaker");
      fireEvent.click(row);
      fireEvent.click(within(sheet).getByRole("radio", { name: "Phone earpiece" }));
      await waitFor(() => expect(nativeCall.selectRoute).toHaveBeenCalledWith({ id: 2 }));
    });
  });

  it("only remembers a mic pick, leaving the live switch to VoiceDeviceSync", async () => {
    picker.devices = [{ deviceId: "mic-1", kind: "audioinput", label: "USB Mic" }] as MediaDeviceInfo[];
    openMenu();
    fireEvent.click(await screen.findByText("USB Mic"));
    expect(localStorage.getItem("armada:voice:micDeviceId")).toBe("mic-1");
    expect(picker.setActiveMediaDevice).not.toHaveBeenCalled();
  });
});
