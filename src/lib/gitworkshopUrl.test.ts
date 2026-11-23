import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import {
  GIT_ISSUE_KIND,
  GIT_PULL_REQUEST_KIND,
  parseGitTicket,
} from "@/lib/gitActivity";
import {
  gitworkshopRelaySegment,
  gitworkshopRepositoryPath,
  gitworkshopRepositoryUrl,
  gitworkshopTicketUrl,
  ngitCloneUrl,
  parseGitworkshopUrl,
} from "@/lib/gitworkshopUrl";
import { routeParamToRelay } from "@/lib/platform";

import type { NostrRumor } from "@/lib/nostrRumor";

const OWNER = "a".repeat(64);
const AUTHOR = "b".repeat(64);
const TICKET_ID = "c".repeat(64);

function ticket(kind: typeof GIT_ISSUE_KIND | typeof GIT_PULL_REQUEST_KIND) {
  return parseGitTicket({
    id: TICKET_ID,
    pubkey: AUTHOR,
    created_at: 1,
    kind,
    content: "",
    tags: [
      ["a", `30617:${OWNER}:armada`, "wss://gleasonator.dev/relay"],
      ["subject", "Relay paths"],
    ],
  } satisfies NostrRumor)!;
}

describe("GitWorkshop repository routes", () => {
  it("keeps a path-bearing relay hint in exactly one segment and round-trips it", () => {
    const path = gitworkshopRepositoryPath(
      "soapbox.pub",
      "armada",
      "wss://gleasonator.dev/relay",
    );

    expect(path).toBe("/soapbox.pub/gleasonator.dev%2Frelay/armada/");

    const [, identity, relaySegment, repositorySegment] = path.split("/");
    expect(identity).toBe("soapbox.pub");
    expect(routeParamToRelay(relaySegment)).toBe("wss://gleasonator.dev/relay");
    expect(decodeURIComponent(repositorySegment)).toBe("armada");
  });

  it("keeps host-only wss relays readable and preserves ws relay schemes", () => {
    expect(gitworkshopRelaySegment("wss://relay.damus.io")).toBe("relay.damus.io");
    expect(gitworkshopRelaySegment("wss://relay.example:7447/nostr?scope=git")).toBe(
      "relay.example%3A7447%2Fnostr%3Fscope%3Dgit",
    );
    const wsSegment = gitworkshopRelaySegment("ws://localhost:7777/nostr?x=1")!;
    expect(wsSegment).toBe("ws%3Alocalhost%3A7777%2Fnostr%3Fx%3D1");
    expect(routeParamToRelay(wsSegment)).toBe("ws://localhost:7777/nostr?x=1");
  });

  it("encodes the repository d-tag independently from the relay segment", () => {
    expect(gitworkshopRepositoryPath(
      "soapbox.pub",
      "team/armada",
      "wss://gleasonator.dev/relay",
    )).toBe("/soapbox.pub/gleasonator.dev%2Frelay/team%2Farmada/");
  });

  it.each([
    [GIT_ISSUE_KIND, "issues"],
    [GIT_PULL_REQUEST_KIND, "prs"],
  ] as const)("uses the shared repository route for kind %s links", (kind, collection) => {
    const parsed = ticket(kind);
    const nevent = nip19.neventEncode({
      id: parsed.id,
      author: parsed.author,
      kind: parsed.kind,
    });

    expect(gitworkshopTicketUrl(parsed)).toBe(
      `https://gitworkshop.dev/${nip19.npubEncode(OWNER)}/gleasonator.dev%2Frelay/armada/${collection}/${nevent}`,
    );
  });
});

describe("repository links", () => {
  const npub = nip19.npubEncode(OWNER);

  it("builds the GitWorkshop repository page", () => {
    expect(gitworkshopRepositoryUrl(OWNER, "armada", "wss://relay.ngit.dev")).toBe(
      `https://gitworkshop.dev/${npub}/relay.ngit.dev/armada/`,
    );
    expect(gitworkshopRepositoryUrl("not-a-pubkey", "armada")).toBeUndefined();
  });

  it("builds ngit's nostr:// remote, keeping only a bare wss host as the relay", () => {
    expect(ngitCloneUrl(OWNER, "armada", "wss://relay.ngit.dev")).toBe(`nostr://${npub}/relay.ngit.dev/armada`);
    expect(ngitCloneUrl(OWNER, "armada", "wss://relay.example:7447")).toBe(`nostr://${npub}/relay.example:7447/armada`);
    expect(ngitCloneUrl(OWNER, "armada", "wss://gleasonator.dev/relay")).toBe(`nostr://${npub}/armada`);
    expect(ngitCloneUrl(OWNER, "armada", "ws://localhost:7777")).toBe(`nostr://${npub}/armada`);
    expect(ngitCloneUrl(OWNER, "team armada")).toBe(`nostr://${npub}/team%20armada`);
  });
});

describe("parseGitworkshopUrl", () => {
  const npub = nip19.npubEncode(OWNER);

  it("reads a repository with a relay segment", () => {
    expect(parseGitworkshopUrl(`https://gitworkshop.dev/${npub}/relay.ngit.dev/armada`)).toEqual({
      owner: OWNER,
      identifier: "armada",
      relays: ["wss://relay.ngit.dev"],
      view: "repository",
      ticket: undefined,
    });
  });

  it("round-trips the routes this client builds", () => {
    const url = gitworkshopRepositoryUrl(OWNER, "my repo", "wss://gleasonator.dev/relay")!;
    expect(parseGitworkshopUrl(url)).toMatchObject({
      owner: OWNER,
      identifier: "my repo",
      relays: ["wss://gleasonator.dev/relay"],
      view: "repository",
    });
    const ticketUrl = gitworkshopTicketUrl(ticket(GIT_ISSUE_KIND))!;
    expect(parseGitworkshopUrl(ticketUrl)).toMatchObject({
      identifier: "armada",
      view: "issue",
      ticket: { id: TICKET_ID, author: AUTHOR },
    });
  });

  it("does not take a section after the identifier for a relay", () => {
    expect(parseGitworkshopUrl(`https://gitworkshop.dev/${npub}/foo.js/issues`)).toMatchObject({
      identifier: "foo.js",
      relays: [],
      view: "issues",
    });
    expect(parseGitworkshopUrl(`https://gitworkshop.dev/${npub}/armada/prs`)?.view).toBe("pull-requests");
    expect(parseGitworkshopUrl(`https://gitworkshop.dev/${npub}/armada/tree/main`)?.view).toBe("repository");
  });

  it("reads a NIP-05 owner and a repository naddr", () => {
    expect(parseGitworkshopUrl("https://gitworkshop.dev/soapbox.pub/armada")).toMatchObject({
      owner: undefined,
      identifier: "armada",
    });
    const naddr = nip19.naddrEncode({ kind: 30617, pubkey: OWNER, identifier: "armada", relays: ["wss://relay.ngit.dev"] });
    expect(parseGitworkshopUrl(`https://gitworkshop.dev/${naddr}/issues`)).toMatchObject({
      owner: OWNER,
      identifier: "armada",
      relays: ["wss://relay.ngit.dev"],
      view: "issues",
    });
  });

  it("ignores other hosts and GitWorkshop's own pages", () => {
    expect(parseGitworkshopUrl(`https://example.com/${npub}/armada`)).toBeNull();
    expect(parseGitworkshopUrl(`https://gitworkshop.dev/${npub}`)).toBeNull();
    expect(parseGitworkshopUrl("https://gitworkshop.dev/quick-start")).toBeNull();
    expect(parseGitworkshopUrl("https://gitworkshop.dev/search/armada")).toBeNull();
  });
});
