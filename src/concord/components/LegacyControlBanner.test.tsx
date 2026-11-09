import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LegacyControlBanner } from "@/concord/components/LegacyControlBanner";
import { RotateKeysDialog } from "@/concord/components/RotateKeysDialog";

const CID = "c".repeat(64);
const OTHER = "d".repeat(64);

afterEach(() => localStorage.clear());

describe("LegacyControlBanner", () => {
  it("opens the upgrade", () => {
    const onUpgrade = vi.fn();
    render(<LegacyControlBanner communityIdHex={CID} onUpgrade={onUpgrade} />);
    fireEvent.click(screen.getByText("Upgrade security"));
    expect(onUpgrade).toHaveBeenCalledOnce();
  });

  it("stays dismissed per community", () => {
    const { unmount } = render(<LegacyControlBanner communityIdHex={CID} onUpgrade={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Upgrade security")).toBeNull();
    unmount();

    render(<LegacyControlBanner communityIdHex={CID} onUpgrade={() => {}} />);
    expect(screen.queryByText("Upgrade security")).toBeNull();
    render(<LegacyControlBanner communityIdHex={OTHER} onUpgrade={() => {}} />);
    expect(screen.getByText("Upgrade security")).toBeInTheDocument();
  });
});

describe("RotateKeysDialog upgrade framing", () => {
  const props = { open: true, memberCount: 3, privateChannelCount: 0, strandsForeignLinks: false, onClose: () => {} };

  it("runs the same rotation under upgrade wording", async () => {
    const onConfirm = vi.fn(async () => {});
    render(<RotateKeysDialog {...props} upgrade onConfirm={onConfirm} />);
    expect(screen.getByText(/older, less secure format/)).toBeInTheDocument();
    expect(screen.queryByText(/Nobody is removed/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Rotate keys/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Upgrade/ }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
  });

  it("keeps the rotation wording otherwise", () => {
    render(<RotateKeysDialog {...props} onConfirm={async () => {}} />);
    expect(screen.getByRole("button", { name: /Rotate keys/ })).toBeInTheDocument();
    expect(screen.queryByText(/older format/)).toBeNull();
  });

  it("still warns about other members' links", () => {
    render(<RotateKeysDialog {...props} upgrade strandsForeignLinks onConfirm={async () => {}} />);
    expect(screen.getByText(/Invite links created by other members/)).toBeInTheDocument();
  });
});
