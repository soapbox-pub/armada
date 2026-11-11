// @vitest-environment jsdom
/**
 * The account-switch choke point.
 *
 * Two things are load-bearing and neither is obvious from the call site:
 * persistence is AWAITED before the reload (nostrify persists from an effect,
 * which `location.assign` would tear down mid-flight, landing the user back on
 * the account they just left), and the synchronous marker is set first, so the
 * next boot's first render already picks the incoming account's scoped config
 * key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NLoginType } from "@nostrify/react/login";

const setItem = vi.fn<(key: string, value: string) => Promise<void>>();

vi.mock("@/lib/secureStorage", () => ({
  secureStorage: {
    getItem: vi.fn(async () => null),
    setItem: (key: string, value: string) => setItem(key, value),
  },
}));

const assign = vi.fn<(url: string) => void>();

import {
  getActivePubkey,
  setActivePubkey,
  _resetActiveAccountForTests,
} from "./activeAccount";
import {
  _resetBeforeAccountExitForTests,
  registerBeforeAccountExit,
} from "./beforeAccountExit";
import { readEsploraApis, writeEsploraApis } from "./esploraStorage";
import {
  addAndSwitchAccount,
  LOGIN_STORAGE_KEY,
  reorderLogins,
  signOutAccount,
  switchAccount,
} from "./switchAccount";
import { readActive, readConnections, writeWalletStorage } from "./walletStorage";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

const login = (id: string, pubkey: string): NLoginType =>
  ({ id, pubkey, type: "nsec", createdAt: "2026-01-01", data: { nsec: "nsec1x" } }) as NLoginType;

const LOGINS = [login("id-a", A), login("id-b", B), login("id-c", C)];

beforeEach(() => {
  localStorage.clear();
  _resetActiveAccountForTests();
  setActivePubkey(A);
  _resetBeforeAccountExitForTests();
  setItem.mockReset();
  setItem.mockResolvedValue(undefined);
  assign.mockReset();
  vi.stubGlobal("location", { assign, href: "http://localhost/" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  _resetActiveAccountForTests();
  _resetBeforeAccountExitForTests();
});

/** The login list as it was persisted by the last `setItem` call. */
function persistedLogins(): NLoginType[] {
  expect(setItem).toHaveBeenCalledTimes(1);
  const [key, value] = setItem.mock.calls[0];
  expect(key).toBe(LOGIN_STORAGE_KEY);
  return JSON.parse(value) as NLoginType[];
}

describe("reorderLogins", () => {
  it("moves the target to the front and keeps the rest in order", () => {
    expect(reorderLogins(LOGINS, "id-c")?.map((l) => l.id)).toEqual(["id-c", "id-a", "id-b"]);
  });

  it("returns null for a login that isn't there", () => {
    expect(reorderLogins(LOGINS, "id-nope")).toBeNull();
  });
});

describe("switchAccount", () => {
  it("persists the reordered list and then reloads at the root", async () => {
    await switchAccount(LOGINS, "id-b");

    expect(persistedLogins().map((l) => l.id)).toEqual(["id-b", "id-a", "id-c"]);
    expect(assign).toHaveBeenCalledWith("/");
  });

  // The reload is the teardown: it is what drops the React Query cache, the
  // module-level memos and the open subscriptions belonging to the account
  // being left. Switching in place is what leaked them.
  it("reloads rather than switching in place", async () => {
    await switchAccount(LOGINS, "id-b");
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("points the config marker at the incoming account BEFORE reloading", async () => {
    let markerAtAssign: string | null = null;
    assign.mockImplementation(() => {
      markerAtAssign = getActivePubkey();
    });

    await switchAccount(LOGINS, "id-b");

    expect(markerAtAssign).toBe(B);
  });

  it("does not reload before the write has settled", async () => {
    let release!: () => void;
    setItem.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const pending = switchAccount(LOGINS, "id-b");
    await Promise.resolve();
    expect(assign).not.toHaveBeenCalled();

    release();
    await pending;
    expect(assign).toHaveBeenCalledWith("/");
  });

  it("awaits outgoing-account cleanup before changing persistent identity", async () => {
    let release!: () => void;
    registerBeforeAccountExit(() => new Promise<void>((resolve) => { release = resolve; }));

    const pending = switchAccount(LOGINS, "id-b");
    await Promise.resolve();
    expect(setItem).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();

    release();
    await pending;
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/");
  });

  it("broadcasts the cross-tab fence before invoking shared teardown", async () => {
    let epochAtCleanup: unknown;
    registerBeforeAccountExit(async () => {
      epochAtCleanup = JSON.parse(localStorage.getItem("armada:account-exit-epoch:v1") ?? "null");
    });

    await switchAccount(LOGINS, "id-b");

    expect(epochAtCleanup).toMatchObject({ fromPubkey: A, toPubkey: B });
  });

  it("still reloads when the write fails, so the app matches storage", async () => {
    setItem.mockRejectedValue(new Error("keychain unavailable"));

    await switchAccount(LOGINS, "id-b");

    expect(getActivePubkey()).toBe(A);
    expect(assign).toHaveBeenCalledWith("/");
  });

  it("does nothing for an unknown login", async () => {
    await switchAccount(LOGINS, "id-nope");

    expect(setItem).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("addAndSwitchAccount", () => {
  it("cleans up before persisting and reloading into the added account", async () => {
    const added = login("id-new", "d".repeat(64));
    let release!: () => void;
    registerBeforeAccountExit(() => new Promise<void>((resolve) => { release = resolve; }));

    const pending = addAndSwitchAccount(LOGINS, added);
    await Promise.resolve();
    expect(setItem).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();

    release();
    await pending;
    expect(persistedLogins().map((item) => item.id)).toEqual([
      "id-new",
      "id-a",
      "id-b",
      "id-c",
    ]);
    expect(getActivePubkey()).toBe(added.pubkey);
    expect(assign).toHaveBeenCalledWith("/");
  });
});

describe("signOutAccount", () => {
  // Signing out with other accounts left is a switch in disguise: `logins[0]`
  // changes, so the outgoing account's caches are exactly as visible to the
  // incoming one as they'd be on the switch path.
  it("persists the remaining logins, promotes the next, and reloads", async () => {
    await signOutAccount(LOGINS, "id-a");

    expect(persistedLogins().map((l) => l.id)).toEqual(["id-b", "id-c"]);
    expect(getActivePubkey()).toBe(B);
    expect(assign).toHaveBeenCalledWith("/");
  });

  // An NWC connection string is spending authority, and nothing else removes it
  // while another account keeps the device from being purged.
  it("removes the departing account's wallet secrets and leaves the others'", async () => {
    const connection = [{ connectionString: `nostr+walletconnect://${"e".repeat(64)}?secret=s`, alias: "w", addedAt: 1 }];
    writeWalletStorage(A, connection, "w");
    writeWalletStorage(B, connection, "w");
    writeEsploraApis(A, ["https://esplora.example"]);
    writeEsploraApis(B, ["https://esplora.example"]);

    await signOutAccount(LOGINS, "id-a");

    expect(readConnections(A)).toEqual([]);
    expect(readActive(A)).toBeNull();
    expect(localStorage.getItem(`armada:esplora-apis:${A}`)).toBeNull();
    expect(readConnections(B)).toEqual(connection);
    expect(readEsploraApis(B)).toEqual(["https://esplora.example"]);
  });

  it("keeps the wallet secrets of a pubkey another login still holds", async () => {
    const connection = [{ connectionString: `nostr+walletconnect://${"e".repeat(64)}?secret=s`, alias: "w", addedAt: 1 }];
    writeWalletStorage(A, connection, "w");

    await signOutAccount([...LOGINS, login("id-a2", A)], "id-a");

    expect(readConnections(A)).toEqual(connection);
  });

  it("keeps wallet secrets on a switch", async () => {
    const connection = [{ connectionString: `nostr+walletconnect://${"e".repeat(64)}?secret=s`, alias: "w", addedAt: 1 }];
    writeWalletStorage(A, connection, "w");

    await switchAccount(LOGINS, "id-b");

    expect(readConnections(A)).toEqual(connection);
  });

  // The last logout is a different operation — a full `purgeClientStorage`
  // and a redirect to the landing page — and stays with its caller.
  it("leaves the final logout alone", async () => {
    await signOutAccount([login("id-a", A)], "id-a");

    expect(setItem).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});
