import { describe, expect, it } from "vitest";

import { NOSTR_CONNECT_PERMS, withConnectPerms } from "./nostrConnectPerms";

describe("withConnectPerms", () => {
  it("asks for the Concord kinds Amber's basic policy leaves out", () => {
    const perms = NOSTR_CONNECT_PERMS.split(",");
    expect(perms).toContain("sign_event:20013");
    expect(perms).toContain("sign_event:33302");
    expect(perms).toContain("nip44_encrypt");
  });

  it("appends one perms parameter, keeping the URI's own", () => {
    const uri = withConnectPerms("nostrconnect://abc?relay=wss%3A%2F%2Fr&secret=s&name=Armada");
    const params = new URL(uri.replace("nostrconnect://", "https://")).searchParams;
    expect(params.get("secret")).toBe("s");
    expect(params.get("name")).toBe("Armada");
    expect(params.get("perms")).toBe(NOSTR_CONNECT_PERMS);
  });

  it("keeps the perms unescaped so the login QR stays scannable", () => {
    const uri = withConnectPerms("nostrconnect://abc?secret=s");
    expect(uri).toBe(`nostrconnect://abc?secret=s&perms=${NOSTR_CONNECT_PERMS}`);
    expect(uri).not.toMatch(/%2C|%3A/);
  });
});
