import { describe, expect, it } from "vitest";

import { SANDBOX_ALLOW, SANDBOX_FLAGS } from "./SandboxFrame";

describe("SandboxFrame policy", () => {
  it("delegates nothing that captures or locates the viewer", () => {
    const allowed = SANDBOX_ALLOW.split("; ");
    for (const feature of [
      "camera",
      "microphone",
      "geolocation",
      "display-capture",
      "midi",
      "window-management",
      "storage-access",
      "idle-detection",
      "clipboard-write",
      "payment",
    ]) {
      expect(allowed).not.toContain(feature);
    }
  });

  it("keeps popups inside the sandbox", () => {
    const flags = SANDBOX_FLAGS.split(" ");
    expect(flags).not.toContain("allow-popups-to-escape-sandbox");
    expect(flags).not.toContain("allow-top-navigation");
  });
});
