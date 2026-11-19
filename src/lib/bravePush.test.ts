// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  bravePushServiceOff,
  isBrave,
  isPushServiceUnavailable,
  setBravePushServiceOff,
} from "@/lib/bravePush";

function asBrave(on: boolean) {
  if (on) Object.defineProperty(navigator, "brave", { value: {}, configurable: true });
  else delete (navigator as { brave?: unknown }).brave;
}

/** What Chromium rejects `subscribe()` with when it has no push service. */
const pushServiceError = new DOMException("Registration failed - push service error", "AbortError");

afterEach(() => {
  asBrave(false);
  localStorage.clear();
});

describe("isPushServiceUnavailable", () => {
  it("recognizes Brave's rejection with Google push switched off", () => {
    asBrave(true);
    expect(isBrave()).toBe(true);
    expect(isPushServiceUnavailable(pushServiceError)).toBe(true);
  });

  it("is not claimed for other browsers, where the same error means something else", () => {
    expect(isPushServiceUnavailable(pushServiceError)).toBe(false);
  });

  it("ignores other subscribe failures", () => {
    asBrave(true);
    expect(isPushServiceUnavailable(new DOMException("Registration failed - permission denied", "NotAllowedError"))).toBe(false);
    expect(isPushServiceUnavailable(new Error("network"))).toBe(false);
    expect(isPushServiceUnavailable(undefined)).toBe(false);
  });
});

describe("bravePushServiceOff", () => {
  it("remembers the outcome per device until a subscribe succeeds", () => {
    asBrave(true);
    expect(bravePushServiceOff()).toBe(false);
    setBravePushServiceOff(true);
    expect(bravePushServiceOff()).toBe(true);
    setBravePushServiceOff(false);
    expect(bravePushServiceOff()).toBe(false);
  });

  it("never reports Brave's setting outside Brave", () => {
    setBravePushServiceOff(true);
    expect(bravePushServiceOff()).toBe(false);
  });
});
