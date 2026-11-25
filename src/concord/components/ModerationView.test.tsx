import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { MODERATION_PANES, type ModerationAccess } from "@/concord/lib/moderationPanes";
import type { Community } from "@/concord/lib/types";

const env = vi.hoisted(() => ({ wide: false, mounts: 0 }));

vi.mock("@/hooks/useMinWidth", () => ({ useMinWidth: () => [env.wide, () => undefined] }));

const { ModerationView } = await import("@/concord/components/ModerationView");

/** A section holding state of its own: a drafted edit, a sub-tab, a scroll position. */
function Section() {
  useEffect(() => {
    env.mounts++;
  }, []);
  return <p>section</p>;
}

const ALL = Object.fromEntries(MODERATION_PANES.map((p) => [p, true])) as ModerationAccess;

function view() {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ModerationView
        community={{ idHex: "00".repeat(32) } as Community}
        pane="settings"
        access={ALL}
        memberPubkeys={[]}
        canModerateMembers={false}
        canManageRoles={false}
        canBan={false}
        onSelect={() => undefined}
        overview={null}
        settings={<Section />}
        safety={null}
      />
    </QueryClientProvider>
  );
}

describe("ModerationView", () => {
  it("keeps the open section mounted when the pane crosses into the sidebar layout and back", () => {
    env.mounts = 0;
    env.wide = false;
    const { rerender } = render(view());
    env.wide = true;
    rerender(view());
    env.wide = false;
    rerender(view());
    expect(env.mounts).toBe(1);
  });
});
