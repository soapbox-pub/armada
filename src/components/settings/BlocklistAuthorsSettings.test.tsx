import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@/contexts/AppContext";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  config: { blocklistAuthors: "" } as Pick<AppConfig, "blocklistAuthors">,
  store: false,
}));

vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({
    config: h.config,
    updateConfig: (fn: (c: typeof h.config) => typeof h.config) => {
      h.config = fn(h.config);
    },
  }),
}));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/lib/storeInstall", () => ({ isStoreInstall: async () => h.store }));

const { BlocklistAuthorsSettings } = await import("./BlocklistAuthorsSettings");

const SOAPBOX = "0ddf6c35f61eb040316d01f68ded4d38b579c17423d26715fd489105a981910a";
const NPUB = "npub10qdp2fc9ta6vraczxrcs8prqnv69fru2k6s2dj48gqjcylulmtjsg9arpj";
const NPUB_HEX = "781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5";

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

function add(value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Add a moderation key" }), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
}

beforeEach(() => {
  h.config = { blocklistAuthors: "" };
  h.store = false;
});

describe("BlocklistAuthorsSettings", () => {
  it("lists the deployment's key by default, with no reset", async () => {
    render(<BlocklistAuthorsSettings />, { wrapper });
    expect(await screen.findByRole("button", { name: "Remove moderation key" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset to default" })).not.toBeInTheDocument();
  });

  it("stores none when the last key is removed", async () => {
    render(<BlocklistAuthorsSettings />, { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Remove moderation key" }));
    expect(h.config.blocklistAuthors).toBe("none");
  });

  it("adds an npub beside the keys in effect", async () => {
    render(<BlocklistAuthorsSettings />, { wrapper });
    await screen.findByRole("textbox", { name: "Add a moderation key" });
    add(NPUB);
    expect(h.config.blocklistAuthors).toBe(`${SOAPBOX},${NPUB_HEX}`);
  });

  it("refuses what isn't a key", async () => {
    render(<BlocklistAuthorsSettings />, { wrapper });
    await screen.findByRole("textbox", { name: "Add a moderation key" });
    add("not a key");
    expect(screen.getByText("Enter an npub or a hex public key.")).toBeInTheDocument();
    expect(h.config.blocklistAuthors).toBe("");
  });

  it("resets an override to the deployment's", async () => {
    h.config = { blocklistAuthors: "none" };
    render(<BlocklistAuthorsSettings />, { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Reset to default" }));
    expect(h.config.blocklistAuthors).toBe("");
  });

  it("is not offered in a store install", async () => {
    h.store = true;
    const { container } = render(<BlocklistAuthorsSettings />, { wrapper });
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
