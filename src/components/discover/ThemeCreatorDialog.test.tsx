import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { nip19 } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeCreatorDialog } from "./ThemeCreatorDialog";
import { THEME_DEFINITION_KIND } from "@/lib/themeEvent";
import { PublishQueuedError } from "@/lib/publishOutbox";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

const h = vi.hoisted(() => ({
  publishEvent: vi.fn(),
  applyCustomTheme: vi.fn(),
  toast: vi.fn(),
  writeClipboardText: vi.fn(),
}));

vi.mock("@/hooks/useNostrPublish", () => ({
  useNostrPublish: () => ({ mutateAsync: h.publishEvent, isPending: false }),
}));
vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({ applyCustomTheme: h.applyCustomTheme }),
}));
vi.mock("@/hooks/useToast", () => ({ toast: h.toast }));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: "a".repeat(64) } }),
}));
vi.mock("@/hooks/useUploadFile", () => ({
  useUploadFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { appRelays: ["wss://relay.example"] } }),
}));
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: h.writeClipboardText }));
// The color picker paints on a canvas, which jsdom does not implement. Its own
// behaviour is not what this dialog is responsible for.
vi.mock("@/components/ui/color-picker", () => ({
  ColorPicker: ({ label }: { label?: string }) => <button type="button">{label}</button>,
}));

const PUBLISHED = {
  id: "new-theme-event",
  kind: THEME_DEFINITION_KIND,
  pubkey: "a".repeat(64),
  tags: [["d", "sunset-x1"]],
} as NostrRumor;

/** The unsearched Discover themes key: [.., relays, authorFilter, query]. */
const BROWSE_KEY = ["discover", "themes", ["wss://relay.example"], ["a".repeat(64)], ""];
/** The same tab with a search term — deliberately left alone. */
const SEARCH_KEY = ["discover", "themes", ["wss://relay.example"], ["a".repeat(64)], "sunset"];

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const existing = [{ id: "existing-theme" } as NostrRumor];
  queryClient.setQueryData(BROWSE_KEY, existing);
  queryClient.setQueryData(SEARCH_KEY, existing);

  render(
    <QueryClientProvider client={queryClient}>
      <ThemeCreatorDialog open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
  return queryClient;
}

const publishButton = () => screen.getByRole("button", { name: "Publish theme" });
const nameField = () => screen.getByLabelText("Name");

describe("ThemeCreatorDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.publishEvent.mockResolvedValue(PUBLISHED);
  });

  it("will not publish an unnamed theme", () => {
    renderDialog();

    expect(publishButton()).toBeDisabled();
    expect(screen.getByText("Give the theme a name.")).toBeInTheDocument();

    fireEvent.change(nameField(), { target: { value: "Sunset" } });

    expect(publishButton()).toBeEnabled();
    expect(
      screen.getByText("Anyone will be able to find and apply this theme."),
    ).toBeInTheDocument();
  });

  it("publishes a kind 36767 definition carrying the trimmed name", async () => {
    renderDialog();
    fireEvent.change(nameField(), { target: { value: "  Sunset  " } });
    fireEvent.click(publishButton());

    await waitFor(() => expect(h.publishEvent).toHaveBeenCalledTimes(1));
    const template = h.publishEvent.mock.calls[0][0];
    expect(template.kind).toBe(THEME_DEFINITION_KIND);
    expect(template.tags).toContainEqual(["title", "Sunset"]);
    expect(template.tags.filter(([n]: string[]) => n === "c")).toHaveLength(3);
    // The active profile theme (kind 16767) is a separate action, never this one.
    expect(h.publishEvent).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 16767 }));
  });

  it("seeds the browse grid with the new theme instead of refetching it away", async () => {
    const queryClient = renderDialog();
    fireEvent.change(nameField(), { target: { value: "Sunset" } });
    fireEvent.click(publishButton());

    await waitFor(() => {
      expect(queryClient.getQueryData<NostrRumor[]>(BROWSE_KEY)).toEqual([
        PUBLISHED,
        { id: "existing-theme" },
      ]);
    });
    // Marked stale so the next natural fetch reconciles, but not refetched now:
    // a refetch races relay indexing and can return less than is on screen.
    expect(queryClient.getQueryState(BROWSE_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(BROWSE_KEY)?.fetchStatus).toBe("idle");
    // A search result has its own criteria — the new theme may not match it.
    expect(queryClient.getQueryData<NostrRumor[]>(SEARCH_KEY)).toEqual([{ id: "existing-theme" }]);
  });

  it("refreshes the settings theme library", async () => {
    const queryClient = renderDialog();
    queryClient.setQueryData(["user-themes", "pubkey"], []);
    fireEvent.change(nameField(), { target: { value: "Sunset" } });
    fireEvent.click(publishButton());

    await waitFor(() => {
      expect(queryClient.getQueryState(["user-themes", "pubkey"])?.isInvalidated).toBe(true);
    });
  });

  it("applies the theme locally when the box is checked, and not when it is cleared", async () => {
    renderDialog();
    fireEvent.change(nameField(), { target: { value: "Sunset" } });
    fireEvent.click(publishButton());

    await waitFor(() =>
      expect(h.applyCustomTheme).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Sunset" }),
      ),
    );
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Theme published",
        description: "Sunset, applied as your theme",
      }),
    );

    vi.clearAllMocks();
    h.publishEvent.mockResolvedValue(PUBLISHED);
    fireEvent.click(screen.getByRole("checkbox", { name: "Apply as my theme" }));
    fireEvent.click(publishButton());

    await waitFor(() => expect(h.publishEvent).toHaveBeenCalled());
    expect(h.applyCustomTheme).not.toHaveBeenCalled();
  });

  it("offers the published theme's link from the success toast", async () => {
    h.writeClipboardText.mockResolvedValue(undefined);
    renderDialog();
    fireEvent.change(nameField(), { target: { value: "Sunset" } });
    fireEvent.click(publishButton());

    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Theme published" })),
    );
    const { action } = h.toast.mock.calls.find(([t]) => t.title === "Theme published")![0];
    expect(action.props.children).toBe("Copy link");
    action.props.onClick();

    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ title: "Link copied" }));
    const url: string = h.writeClipboardText.mock.calls[0][0];
    expect(url.startsWith(`${window.location.origin}/naddr1`)).toBe(true);
    const decoded = nip19.decode(url.slice(window.location.origin.length + 1));
    expect(decoded).toEqual({
      type: "naddr",
      data: {
        kind: THEME_DEFINITION_KIND,
        pubkey: "a".repeat(64),
        identifier: "sunset-x1",
        relays: ["wss://relay.example"],
      },
    });
  });

  it("treats a queued offline publish as success, so the user does not retry into a second theme", async () => {
    const onOpenChange = vi.fn();
    // Signed and durably stored; the retry worker lands it. Retrying would
    // re-roll the random `d` suffix and publish a second theme.
    h.publishEvent.mockRejectedValue(new PublishQueuedError(PUBLISHED as NostrEvent, new Error("offline")));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(BROWSE_KEY, [{ id: "existing-theme" } as NostrRumor]);
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeCreatorDialog open onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    );

    fireEvent.change(nameField(), { target: { value: "Sunset" } });
    fireEvent.click(publishButton());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Theme published",
        description: "Sunset, applied as your theme (syncing when the network is back)",
      }),
    );
    expect(h.applyCustomTheme).toHaveBeenCalledWith(expect.objectContaining({ title: "Sunset" }));
    // Seeded from the signed event the error carries, exactly as on a live publish.
    expect(queryClient.getQueryData<NostrRumor[]>(BROWSE_KEY)).toEqual([
      PUBLISHED,
      { id: "existing-theme" },
    ]);
  });

  it("leaves the dialog open and applies nothing when publishing fails", async () => {
    const onOpenChange = vi.fn();
    h.publishEvent.mockRejectedValue(new Error("no relay accepted the event"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(BROWSE_KEY, [{ id: "existing-theme" } as NostrRumor]);
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeCreatorDialog open onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    );

    fireEvent.change(nameField(), { target: { value: "Sunset" } });
    fireEvent.click(publishButton());

    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Couldn't publish theme", variant: "destructive" }),
      ),
    );
    expect(h.applyCustomTheme).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(queryClient.getQueryData<NostrRumor[]>(BROWSE_KEY)).toEqual([{ id: "existing-theme" }]);
  });

  describe("saving an adopted theme", () => {
    const CREATOR = "c".repeat(64);
    const ADOPTED = {
      title: "Dusk",
      colors: { background: "275 31% 6%", text: "0 0% 100%", primary: "24 100% 50%" },
      source: { pubkey: CREATOR, identifier: "dusk" },
    };

    it("credits the creator on the published copy and the applied theme", async () => {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <ThemeCreatorDialog open onOpenChange={vi.fn()} initial={ADOPTED} />
        </QueryClientProvider>,
      );
      fireEvent.click(publishButton());

      await waitFor(() => expect(h.publishEvent).toHaveBeenCalledTimes(1));
      const { tags } = h.publishEvent.mock.calls[0][0];
      expect(tags).toContainEqual(["a", `${THEME_DEFINITION_KIND}:${CREATOR}:dusk`]);
      expect(tags).toContainEqual(["p", CREATOR]);
      await waitFor(() =>
        expect(h.applyCustomTheme).toHaveBeenCalledWith(expect.objectContaining({ source: ADOPTED.source })),
      );
    });
  });

  describe("editing one of the user's themes", () => {
    const OWN = {
      id: "own-theme-event",
      kind: THEME_DEFINITION_KIND,
      pubkey: "a".repeat(64),
      created_at: 1,
      content: "",
      tags: [
        ["d", "dusk-1a2b3c"],
        ["title", "Dusk"],
        ["c", "#100b15", "background"],
        ["c", "#ffffff", "text"],
        ["c", "#ff6600", "primary"],
      ],
    } as NostrRumor;
    const EDITING = {
      identifier: "dusk-1a2b3c",
      title: "Dusk",
      colors: { background: "275 31% 6%", text: "0 0% 100%", primary: "24 100% 50%" },
      event: OWN,
    };

    function renderEditor() {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      queryClient.setQueryData(["user-themes", "a".repeat(64)], [EDITING]);
      const onOpenChange = vi.fn();
      render(
        <QueryClientProvider client={queryClient}>
          <ThemeCreatorDialog open onOpenChange={onOpenChange} editing={EDITING} />
        </QueryClientProvider>,
      );
      return { queryClient, onOpenChange };
    }

    it("republishes under the same d-tag, replacing the old event", async () => {
      h.publishEvent.mockResolvedValue({ ...OWN, id: "edited" });
      renderEditor();
      fireEvent.change(nameField(), { target: { value: "Dusk II" } });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(h.publishEvent).toHaveBeenCalledTimes(1));
      const template = h.publishEvent.mock.calls[0][0];
      expect(template.tags).toContainEqual(["d", "dusk-1a2b3c"]);
      expect(template.tags).toContainEqual(["title", "Dusk II"]);
      expect(template.prev).toBe(OWN);
      // Editing doesn't silently re-skin the app.
      expect(h.applyCustomTheme).not.toHaveBeenCalled();
    });

    it("deletes by address after confirming, and drops it from the library", async () => {
      h.publishEvent.mockResolvedValue({ id: "deletion" });
      const { queryClient, onOpenChange } = renderEditor();
      fireEvent.click(screen.getByRole("button", { name: "Delete theme" }));
      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(h.publishEvent).toHaveBeenCalledWith({
        kind: 5,
        content: "",
        tags: [
          ["e", "own-theme-event"],
          ["a", `${THEME_DEFINITION_KIND}:${"a".repeat(64)}:dusk-1a2b3c`],
          ["k", String(THEME_DEFINITION_KIND)],
        ],
      });
      expect(queryClient.getQueryData(["user-themes", "a".repeat(64)])).toEqual([]);
    });
  });
});
