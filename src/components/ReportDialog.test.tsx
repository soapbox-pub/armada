import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/hooks/useSendReport", () => ({ useSendReport: () => ({ mutateAsync: send }) }));
vi.mock("@/hooks/useMuteList", () => ({
  useMutedPubkeys: () => ({ mutedPubkeys: new Set([("a").repeat(64)]) }),
  useMuteUser: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({ useScopedDisplayName: () => "alice" }));
vi.mock("@/components/DisplayName", () => ({ DisplayName: () => <span>alice</span> }));
vi.mock("@/components/ui/select", () => ({
  Select: ({ onValueChange }: { onValueChange: (v: string) => void }) => (
    <button type="button" onClick={() => onValueChange("spam")}>pick reason</button>
  ),
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

import { ReportDialog } from "./ReportDialog";

const target = { pubkey: "a".repeat(64), eventId: "e".repeat(64) };
const destination = { kind: "network" } as never;

describe("ReportDialog remove from this device", () => {
  it("removes the reported message locally once the report is sent", async () => {
    const remove = vi.fn();
    render(<ReportDialog open onOpenChange={() => {}} target={target} destination={destination} onRemoveLocal={remove} />);
    expect(screen.getByText("Also remove it from this device")).toBeInTheDocument();
    fireEvent.click(screen.getByText("pick reason"));
    fireEvent.click(screen.getByRole("button", { name: /^Report$/ }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalled();
  });

  it("offers removal for a DM report, whose target names only the person", () => {
    render(<ReportDialog open onOpenChange={() => {}} target={{ pubkey: target.pubkey }} destination={destination} onRemoveLocal={vi.fn()} />);
    expect(screen.getByText("Also remove it from this device")).toBeInTheDocument();
  });

  it("offers nothing to remove for a report about a person", () => {
    render(<ReportDialog open onOpenChange={() => {}} target={{ pubkey: target.pubkey }} destination={destination} />);
    expect(screen.queryByText("Also remove it from this device")).toBeNull();
  });
});
