import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { isArmadaAppUrl, isExternallyOpenableUrl, isSignerHandoffUrl, isMagnetUrl, isNsiteUrl, isPaymentUrl, internalAppLinkPath } =
  require("./appOrigin.js");

describe("packaged Electron origin", () => {
  it("admits permission requests from app://armada", () => {
    expect(isArmadaAppUrl("app://armada")).toBe(true);
    expect(isArmadaAppUrl("app://armada/")).toBe(true);
    expect(isArmadaAppUrl("app://armada/c2/community/channel?message=1")).toBe(true);
  });

  it("rejects other schemes and lookalike authorities", () => {
    expect(isArmadaAppUrl("https://armada")).toBe(false);
    expect(isArmadaAppUrl("app://armada.example/")).toBe(false);
    expect(isArmadaAppUrl("app://armada@evil.example/")).toBe(false);
    expect(isArmadaAppUrl("app://evil@armada/")).toBe(false);
    expect(isArmadaAppUrl("not a URL")).toBe(false);
  });

  it("treats the app's own URLs as internal despite the null origin", () => {
    // `new URL("app://armada/x").origin` is the string "null" for a custom
    // scheme, so an origin comparison classifies the app's OWN pages as
    // external and hands them to the OS handler for app:.
    expect(isExternallyOpenableUrl("app://armada/c2/community")).toBe(false);
  });
});

describe("opening a link in the system browser", () => {
  it("allows the web schemes a chat message can legitimately carry", () => {
    expect(isExternallyOpenableUrl("https://example.com/a")).toBe(true);
    expect(isExternallyOpenableUrl("http://example.com/a")).toBe(true);
    expect(isExternallyOpenableUrl("mailto:someone@example.com")).toBe(true);
  });

  it("refuses schemes that hand the OS something to execute", () => {
    // window.open reaches this from ANY frame, including the sandboxed
    // WebXDC/embed iframes that run untrusted third-party app code.
    expect(isExternallyOpenableUrl("file:///etc/passwd")).toBe(false);
    expect(isExternallyOpenableUrl("smb://attacker.example/share")).toBe(false);
    expect(isExternallyOpenableUrl("ms-msdt:/id")).toBe(false);
    expect(isExternallyOpenableUrl("vscode://file/etc/passwd")).toBe(false);
    expect(isExternallyOpenableUrl("javascript:alert(1)")).toBe(false);
    expect(isExternallyOpenableUrl("")).toBe(false);
    expect(isExternallyOpenableUrl("not a URL")).toBe(false);
  });
});

describe("handing a magnet link to the torrent client", () => {
  it("recognizes magnet: only, and keeps it out of what window.open may reach", () => {
    expect(isMagnetUrl("magnet:?xt=urn:btih:abc")).toBe(true);
    expect(isMagnetUrl("https://example.com/magnet:")).toBe(false);
    expect(isMagnetUrl("not a URL")).toBe(false);
    expect(isExternallyOpenableUrl("magnet:?xt=urn:btih:abc")).toBe(false);
  });
});

describe("handing an nsite link to the OS's nsite browser", () => {
  it("recognizes nsite: only, and keeps it out of what window.open may reach", () => {
    expect(isNsiteUrl("nsite://npub1abc/path")).toBe(true);
    expect(isNsiteUrl("https://example.com/nsite://x")).toBe(false);
    expect(isNsiteUrl("not a URL")).toBe(false);
    expect(isExternallyOpenableUrl("nsite://npub1abc/")).toBe(false);
  });
});

describe("handing a payment link to the wallet app", () => {
  it("recognizes bitcoin: and lightning: only, and keeps them out of what window.open may reach", () => {
    expect(isPaymentUrl("bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toBe(true);
    expect(isPaymentUrl("lightning:alice@example.com")).toBe(true);
    expect(isPaymentUrl("https://example.com/bitcoin:x")).toBe(false);
    expect(isPaymentUrl("not a URL")).toBe(false);
    expect(isExternallyOpenableUrl("bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toBe(false);
    expect(isExternallyOpenableUrl("lightning:alice@example.com")).toBe(false);
  });
});

describe("handing a pairing link to a signer app", () => {
  it("recognizes nostrconnect: and nothing else", () => {
    expect(isSignerHandoffUrl("nostrconnect://" + "a".repeat(64) + "?relay=wss%3A%2F%2Fr.example")).toBe(true);
    expect(isSignerHandoffUrl("bunker://" + "a".repeat(64))).toBe(false);
    expect(isSignerHandoffUrl("https://example.com")).toBe(false);
    expect(isSignerHandoffUrl("not a URL")).toBe(false);
  });

  it("is not a scheme window.open may reach", () => {
    expect(isExternallyOpenableUrl("nostrconnect://" + "a".repeat(64))).toBe(false);
  });
});

describe("routing our own App Links into the shell", () => {
  const HOST = "armada.buzz";

  it("returns the router path for a link to our own host", () => {
    expect(internalAppLinkPath("https://armada.buzz/c/community/channel/m/abc", HOST))
      .toBe("/c/community/channel/m/abc");
    expect(internalAppLinkPath("https://armada.buzz/dm/npub1x/m/def", HOST))
      .toBe("/dm/npub1x/m/def");
    // Search and hash travel with the path (invite secrets ride the fragment).
    expect(internalAppLinkPath("https://armada.buzz/invite/naddr1?code=1#secret", HOST))
      .toBe("/invite/naddr1?code=1#secret");
  });

  it("matches the host case-insensitively", () => {
    expect(internalAppLinkPath("https://ARMADA.buzz/s/relay/group/m/x", HOST))
      .toBe("/s/relay/group/m/x");
    expect(internalAppLinkPath("https://armada.buzz/s/relay/group", "ARMADA.BUZZ"))
      .toBe("/s/relay/group");
  });

  it("declines a foreign host, a non-https scheme, or a missing host", () => {
    expect(internalAppLinkPath("https://evil.example/c/a/b/m/x", HOST)).toBe(null);
    expect(internalAppLinkPath("http://armada.buzz/c/a/b/m/x", HOST)).toBe(null);
    expect(internalAppLinkPath("app://armada/c/a/b", HOST)).toBe(null);
    expect(internalAppLinkPath("https://armada.buzz/c/a/b", null)).toBe(null);
    expect(internalAppLinkPath("not a URL", HOST)).toBe(null);
  });

  it("declines the bare root and protocol-relative lookalikes", () => {
    // A bare domain open is not a deep link — leave it to ordinary handling.
    expect(internalAppLinkPath("https://armada.buzz/", HOST)).toBe(null);
    expect(internalAppLinkPath("https://armada.buzz", HOST)).toBe(null);
    // `//evil.example` is a protocol-relative URL naming another origin, even
    // when it arrives on our own host's authority.
    expect(internalAppLinkPath("https://armada.buzz//evil.example/x", HOST)).toBe(null);
  });
});
