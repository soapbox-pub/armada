import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Bell, Folder, Trash2 } from "lucide-react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { closeOpenMenuSheets, useOpenContextMenu } from "@/hooks/useMenuSheet";

/** A phone: the primary pointer is a finger, so a context menu is a sheet. */
function stubTouch() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)",
    media: query,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

const hold = (el: HTMLElement) => fireEvent.contextMenu(el, { clientX: 5, clientY: 5 });

describe("ContextMenu on touch", () => {
  beforeEach(stubTouch);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens a sheet headed by what it was opened on, not a popup", () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>row</ContextMenuTrigger>
        <ContextMenuContent sheetIdentity={{ title: "general", sub: "Text channels" }}>
          <ContextMenuItem>
            <Bell className="size-4" />
            Mark as read
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    hold(screen.getByText("row"));
    const sheet = screen.getByRole("dialog", { name: "general" });
    expect(within(sheet).getByText("Text channels")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Mark as read" })).toBeInTheDocument();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByText("row")).toHaveAttribute("data-state", "open");
  });

  it("runs an item and closes, unless the item keeps the menu open", () => {
    const onChoose = vi.fn();
    const onExpand = vi.fn((e: Event) => e.preventDefault());
    const onOpenChange = vi.fn();
    render(
      <ContextMenu onOpenChange={onOpenChange}>
        <ContextMenuTrigger>row</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onExpand}>Moderation</ContextMenuItem>
          <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={onChoose}>
            <Trash2 className="size-4" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    hold(screen.getByText("row"));
    fireEvent.click(screen.getByRole("button", { name: "Moderation" }));
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    const del = screen.getByRole("button", { name: "Delete" });
    expect(del).toHaveClass("text-destructive");
    fireEvent.click(del);
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByText("row")).toHaveAttribute("data-state", "closed");
  });

  function NotifMenu({ onLevel }: { onLevel: (level: string) => void }) {
    const [level, setLevel] = useState("all");
    return (
      <ContextMenu>
        <ContextMenuTrigger>row</ContextMenuTrigger>
        <ContextMenuContent sheetIdentity={{ title: "general" }}>
          <ContextMenuItem>Mark as read</ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger value={level === "all" ? "All messages" : "Nothing"}>
              <Bell className="size-4" />
              Notifications
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup
                value={level}
                onValueChange={(next) => {
                  setLevel(next);
                  onLevel(next);
                }}
              >
                <ContextMenuRadioItem value="all">All messages</ContextMenuRadioItem>
                <ContextMenuRadioItem value="nothing">Nothing</ContextMenuRadioItem>
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  it("turns a submenu into a page that a choice leaves", () => {
    const onLevel = vi.fn();
    render(<NotifMenu onLevel={onLevel} />);
    hold(screen.getByText("row"));

    // The row shows the current setting; its page is not rendered until opened.
    const row = screen.getByRole("button", { name: /Notifications/ });
    expect(row).toHaveTextContent("All messages");
    expect(screen.queryByRole("radio")).toBeNull();

    fireEvent.click(row);
    expect(screen.getByRole("heading", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "All messages" })).toBeChecked();
    // The root list stays mounted under the page, hidden.
    expect(screen.getByRole("button", { name: "Mark as read" }).closest(".hidden")).not.toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Nothing" }));
    expect(onLevel).toHaveBeenCalledWith("nothing");
    // Back on the root, which now shows the new setting, and still open.
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByRole("button", { name: /Notifications/ })).toHaveTextContent("Nothing");
    expect(screen.getByRole("button", { name: "Mark as read" }).closest(".hidden")).toBeNull();
  });

  it("goes back from a page with its back button", () => {
    render(<NotifMenu onLevel={() => undefined} />);
    hold(screen.getByText("row"));
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByRole("dialog", { name: "general" })).toBeInTheDocument();
  });

  it("toggles a checkbox row and stays open when the item asks to", () => {
    const onCheckedChange = vi.fn();
    render(
      <ContextMenu>
        <ContextMenuTrigger>row</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuCheckboxItem
            checked={false}
            onCheckedChange={onCheckedChange}
            onSelect={(e) => e.preventDefault()}
          >
            <Folder className="size-4" />
            Moderator
          </ContextMenuCheckboxItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    hold(screen.getByText("row"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Moderator" }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("opens only the inner menu for a hold on a nested trigger", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      render(
        <ContextMenu onOpenChange={outer}>
          <ContextMenuTrigger>
            channel
            <ContextMenu onOpenChange={inner}>
              <ContextMenuTrigger>participant</ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem>Mute</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Permissions</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>,
      );
      fireEvent.pointerDown(screen.getByText("participant"), { pointerType: "touch", clientX: 5, clientY: 5 });
      now += 800;
      act(() => {
        vi.advanceTimersByTime(800);
      });
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
    expect(inner).toHaveBeenCalledWith(true);
    expect(outer).not.toHaveBeenCalled();
  });

  function MoreButton() {
    const open = useOpenContextMenu();
    return (
      <button type="button" onClick={() => open?.()}>
        more
      </button>
    );
  }

  it("opens from a button inside the menu, and closes from outside React", () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>
          row
          <MoreButton />
        </ContextMenuTrigger>
        <ContextMenuContent sheetIdentity={{ title: "alice" }}>
          <ContextMenuItem>Mention</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.click(screen.getByRole("button", { name: "more" }));
    expect(screen.getByRole("dialog", { name: "alice" })).toHaveAttribute("data-state", "open");
    act(() => closeOpenMenuSheets());
    expect(screen.getByText("row").closest("[data-state]")).toHaveAttribute("data-state", "closed");
  });
});

describe("DropdownMenu on touch", () => {
  beforeEach(stubTouch);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function Actions({ touchSheet, onMute, onPause }: { touchSheet?: boolean; onMute?: () => void; onPause?: () => void }) {
    return (
      <DropdownMenu touchSheet={touchSheet}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="More options" />
        </DropdownMenuTrigger>
        <DropdownMenuContent sheetIdentity={{ title: "general" }}>
          <DropdownMenuItem className="sidebar:hidden" onClick={onMute}>
            <Bell className="size-4" />
            Mute channel
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href="https://example.com/profile">
              <Folder className="size-4" />
              View profile
            </a>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger value="Off">Pause community</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={onPause}>1 hour</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  it("opens an action menu as a sheet on the tap, and closes it on a choice", () => {
    const onMute = vi.fn();
    render(<Actions touchSheet onMute={onMute} />);
    const more = screen.getByRole("button", { name: "More options" });
    expect(more).toHaveAttribute("data-state", "closed");

    // Radix's popup opens on pointerdown; the sheet waits for the tap.
    fireEvent.pointerDown(more, { button: 0, pointerType: "touch" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(more);
    const sheet = screen.getByRole("dialog", { name: "general" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(more).toHaveAttribute("aria-expanded", "true");

    // An item's breakpoint visibility survives; the rest of its styling is the row's.
    const mute = within(sheet).getByRole("button", { name: "Mute channel" });
    expect(mute).toHaveClass("sidebar:hidden");
    fireEvent.click(mute);
    expect(onMute).toHaveBeenCalledTimes(1);
    expect(more).toHaveAttribute("data-state", "closed");
  });

  it("keeps an item written around a link a link", () => {
    render(<Actions touchSheet />);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    const link = screen.getByRole("link", { name: "View profile" });
    expect(link).toHaveAttribute("href", "https://example.com/profile");
    expect(link.closest("button")).toBeNull();
  });

  it("turns a submenu into a page of the sheet", () => {
    const onPause = vi.fn();
    render(<Actions touchSheet onPause={onPause} />);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    const row = screen.getByRole("button", { name: /Pause community/ });
    expect(row).toHaveTextContent("Off");
    fireEvent.click(row);
    expect(screen.getByRole("heading", { name: "Pause community" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "1 hour" }));
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it("stays a popup at its trigger unless it is marked an action menu", () => {
    render(<Actions />);
    const more = screen.getByRole("button", { name: "More options" });
    fireEvent.keyDown(more, { key: "Enter" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
