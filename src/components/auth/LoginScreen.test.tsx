import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const clientPubkey = "a".repeat(64);
  const secret = "c00a9648-1a34-42a0-bf52-aa9a5fe28bbb";
  return {
    clientPubkey,
    secret,
    connectUri: `nostrconnect://${clientPubkey}?relay=wss%3A%2F%2Frelay.example&secret=${secret}&name=Armada`,
    writeClipboardText: vi.fn(async (_text: string) => {}),
    toast: vi.fn(),
    isMobile: false,
    // Reports progress like the real handshake, then never settles: the view under
    // test stays on screen.
    nostrconnect: vi.fn(
      async (_params: unknown, _signal?: AbortSignal, onStatus?: (s: string) => void) => {
        onStatus?.("awaiting-connect");
        await new Promise<void>(() => {});
      },
    ),
  };
});

vi.mock("@/hooks/useLoginActions", () => ({
  useLoginActions: () => ({
    nsec: vi.fn(),
    bunker: vi.fn(),
    extension: vi.fn(),
    nostrconnect: h.nostrconnect,
    getRelayUrls: () => ["wss://relay.example"],
  }),
  generateNostrConnectParams: () => ({
    clientSecretKey: new Uint8Array(32),
    clientPubkey: h.clientPubkey,
    secret: h.secret,
    relays: ["wss://relay.example"],
  }),
  generateNostrConnectURI: () => h.connectUri,
}));
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: h.writeClipboardText }));
vi.mock("@/hooks/useToast", () => ({ toast: h.toast }));
vi.mock("@/hooks/useLoggedInAccounts", () => ({
  useLoggedInAccounts: () => ({ currentUser: null, accounts: [] }),
}));
vi.mock("@/lib/credentialManager", () => ({ getNsecCredential: async () => null }));
vi.mock("@/lib/shareOrigin", () => ({ shareOrigin: () => "https://armada.buzz" }));
vi.mock("@/components/auth/AndroidSignerOptions", () => ({ AndroidSignerOptions: () => null }));

import LoginScreen from "@/components/auth/LoginScreen";
import { NOSTR_CONNECT_PERMS } from "@/lib/nostrConnectPerms";

/** The overflow menu's entries, opened the way a keyboard user opens it. */
const openMenu = async () => {
  const trigger = screen.getByRole("button", { name: "More login options" });
  // jsdom has no `PointerEvent`, so the pointerdown Radix opens menus with is not
  // deliverable here; the keyboard path opens the same menu.
  fireEvent.keyDown(trigger, { key: "Enter" });
  await screen.findByRole("menuitem", { name: "Connect remote signer" });
  return screen.getAllByRole("menuitem").map((item) => item.textContent?.trim());
};

/** Login, then "Connect remote signer", landing on the QR view. */
const openConnectQr = async () => {
  await openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Connect remote signer" }));
  // The QR paints from a promise; awaiting it keeps the state update inside act.
  await screen.findByRole("img", { name: "QR code" });
};

/** The URI as the app built it, perms included. */
const CONNECT_URI = `${h.connectUri}&perms=${NOSTR_CONNECT_PERMS}`;

const renderLogin = () =>
  render(<LoginScreen isOpen onClose={vi.fn()} onLogin={vi.fn()} />);

/**
 * Swap `window.location` for a stub while a hand-off runs. jsdom's own Location
 * refuses navigation for an unregistered scheme and logs it, and its `href` is a
 * non-configurable accessor on the instance, so the assignment is captured here
 * instead of spied on.
 */
const stubLocation = () => {
  const original = window.location;
  const stub = { href: "" };
  Object.defineProperty(window, "location", { configurable: true, value: stub });
  return {
    stub,
    restore: () => Object.defineProperty(window, "location", { configurable: true, value: original }),
  };
};

const PHONE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36";
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36";

beforeEach(() => {
  vi.clearAllMocks();
  h.isMobile = false;
  vi.spyOn(window.navigator, "userAgent", "get").mockImplementation(() =>
    h.isMobile ? PHONE_UA : DESKTOP_UA,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  window.innerWidth = 1024;
});

describe("LoginScreen signer link", () => {
  it("offers every sign-in method, on mobile too", async () => {
    const desktop = renderLogin();
    expect(await openMenu()).toEqual([
      "Select key file",
      "Connect remote signer",
      "Open signer app",
    ]);
    desktop.unmount();

    h.isMobile = true;
    renderLogin();
    expect(await openMenu()).toEqual([
      "Select key file",
      "Connect remote signer",
      "Open signer app",
    ]);
  });

  it("offers the QR's link as text and copies exactly that", async () => {
    renderLogin();
    await openConnectQr();

    const field = (await screen.findByLabelText("Signer connect link")) as HTMLInputElement;
    expect(field.value).toBe(CONNECT_URI);
    expect(field.readOnly).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));

    await waitFor(() => expect(h.writeClipboardText).toHaveBeenCalledWith(CONNECT_URI));
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Link copied" }),
    );
    expect(await screen.findByRole("button", { name: "Link copied" })).toBeInTheDocument();
  });

  it("reports a refused clipboard without claiming the link was copied", async () => {
    h.writeClipboardText.mockRejectedValueOnce(new Error("Clipboard write is not available."));
    renderLogin();
    await openConnectQr();

    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));

    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive" }),
      ),
    );
    // Still offering to copy: the failure must not look like the checkmark state.
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link copied" })).not.toBeInTheDocument();
  });

  // A narrow desktop window is still a desktop: no handler may be registered for
  // the scheme, so the QR and its link have to stay up.
  it.each([1440, 600])("keeps the QR and the link on screen when handing off on a %ipx desktop", async (width) => {
    window.innerWidth = width;
    renderLogin();
    await openMenu();

    const { stub, restore } = stubLocation();
    try {
      fireEvent.click(screen.getByRole("menuitem", { name: "Open signer app" }));
      await screen.findByRole("img", { name: "QR code" });
      expect(stub.href).toBe(CONNECT_URI);
    } finally {
      restore();
    }

    expect(h.nostrconnect).toHaveBeenCalled();
    expect(await screen.findByLabelText("Signer connect link")).toHaveValue(CONNECT_URI);
  });

  it("shows progress instead of the QR when handing off on mobile", async () => {
    h.isMobile = true;
    renderLogin();
    await openMenu();

    const { stub, restore } = stubLocation();
    try {
      fireEvent.click(screen.getByRole("menuitem", { name: "Open signer app" }));
      expect(
        await screen.findByText("Waiting for signer connection…"),
      ).toBeInTheDocument();
      expect(stub.href).toBe(CONNECT_URI);
    } finally {
      restore();
    }

    expect(screen.queryByRole("img", { name: "QR code" })).not.toBeInTheDocument();
  });
});
