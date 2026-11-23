import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VoiceDeviceSettings } from "@/components/VoiceDeviceSettings";

vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { preferredVoiceServer: "" }, updateConfig: vi.fn() }),
}));
vi.mock("@/concord/hooks/useVoice", () => ({ ownAvServers: () => [] }));
vi.mock("@/concord/lib/voice", () => ({ probeAvBroker: async () => false }));
vi.mock("@/concord/lib/irohVoice", () => ({ deploymentIrohRelays: async () => undefined }));
// The tone button only renders where speaker selection exists (not jsdom).
vi.mock("@/lib/voiceDevices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voiceDevices")>()),
  supportsSpeakerSelection: () => true,
}));

const contexts: { closed: boolean }[] = [];

class FakeAudioContext {
  closed = false;
  currentTime = 0;
  constructor() { contexts.push(this); }
  createMediaStreamDestination() { return { stream: {} }; }
  createOscillator() {
    return { type: "", frequency: { value: 0 }, connect: (n: unknown) => n, start: vi.fn(), stop: vi.fn() };
  }
  createGain() {
    return { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: (n: unknown) => n };
  }
  close() { this.closed = true; return Promise.resolve(); }
}

class FakeAudio {
  srcObject: unknown = null;
  play() { return Promise.resolve(); }
}

beforeEach(() => {
  contexts.length = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("Audio", FakeAudio);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices: async () => [], addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <VoiceDeviceSettings />
    </QueryClientProvider>,
  );
}

async function startTone() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Test$/ })); });
  await screen.findByRole("button", { name: /Playing/ });
  expect(contexts).toHaveLength(1);
}

describe("VoiceDeviceSettings test tone", () => {
  it("closes the context when the tone finishes", async () => {
    const view = mount();
    await startTone();
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(contexts[0].closed).toBe(true);
    view.unmount();
  });

  it("closes the context when unmounted mid-tone", async () => {
    const view = mount();
    await startTone();
    expect(contexts[0].closed).toBe(false);
    view.unmount();
    expect(contexts[0].closed).toBe(true);
  });
});
