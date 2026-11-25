import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Nip05Status } from "./Nip05Status";

const PK = "a".repeat(64);

const h = vi.hoisted(() => ({ queryProfile: vi.fn() }));
vi.mock("nostr-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nostr-tools")>();
  return { ...actual, nip05: { ...actual.nip05, queryProfile: h.queryProfile } };
});

function renderStatus(nip05: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Nip05Status pubkey={PK} nip05={nip05} />
    </QueryClientProvider>,
  );
}

const state = (container: HTMLElement) => container.querySelector("[data-nip05-state]")?.getAttribute("data-nip05-state");

describe("Nip05Status", () => {
  beforeEach(() => {
    h.queryProfile.mockReset();
  });

  it("shows the identifier while checking, without waiting for the lookup", () => {
    h.queryProfile.mockReturnValue(new Promise(() => {}));
    const { container } = renderStatus("alice@example.com");
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(state(container)).toBe("checking");
  });

  it("is verified when the domain maps the name to this pubkey", async () => {
    h.queryProfile.mockResolvedValue({ pubkey: PK });
    const { container } = renderStatus("alice@example.com");
    await waitFor(() => expect(state(container)).toBe("verified"));
    expect(h.queryProfile).toHaveBeenCalledWith("alice@example.com");
    expect(screen.getByText("alice@example.com is verified by example.com")).toBeInTheDocument();
  });

  it("shows a root identifier as its domain", async () => {
    h.queryProfile.mockResolvedValue({ pubkey: PK });
    const { container } = renderStatus("_@example.com");
    await waitFor(() => expect(state(container)).toBe("verified"));
    expect(screen.getByText("example.com")).toBeInTheDocument();
  });

  it("is not verified when the name maps to another pubkey", async () => {
    h.queryProfile.mockResolvedValue({ pubkey: "b".repeat(64) });
    const { container } = renderStatus("alice@example.com");
    await waitFor(() => expect(state(container)).toBe("unverified"));
    expect(screen.getByText("not verified")).toBeInTheDocument();
  });

  it("is not verified when the lookup fails", async () => {
    // nostr-tools reports a failed lookup as no match.
    h.queryProfile.mockResolvedValue(null);
    const { container } = renderStatus("alice@example.com");
    await waitFor(() => expect(state(container)).toBe("unverified"));
  });

  it("never fetches a loopback or private domain", async () => {
    const { container } = renderStatus("admin@192.168.1.1");
    await waitFor(() => expect(state(container)).toBe("unverified"));
    expect(h.queryProfile).not.toHaveBeenCalled();
  });

  it("renders nothing for an unparseable identifier", () => {
    const { container } = renderStatus("not an address");
    expect(container).toBeEmptyDOMElement();
    expect(h.queryProfile).not.toHaveBeenCalled();
  });
});
