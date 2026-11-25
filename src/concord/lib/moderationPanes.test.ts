import { describe, expect, it } from "vitest";

import { firstModerationPane, managedPaneOf, moderationAccessFor, MODERATION_PANES, type ModerationAccess } from "@/concord/lib/moderationPanes";
import { chatRoute, parseChatRoute } from "@/lib/routes";

const none = Object.fromEntries(MODERATION_PANES.map((p) => [p, false])) as Record<string, boolean>;

describe("Manage community panes", () => {
  it("opens Safety from the routes it replaced", () => {
    expect(managedPaneOf("banned")).toBe("safety");
    expect(managedPaneOf("suspicious")).toBe("safety");
    expect(managedPaneOf("settings")).toBe("settings");
    expect(managedPaneOf("threads")).toBeUndefined();
    expect(managedPaneOf("channel")).toBeUndefined();
  });

  it("routes every tab", () => {
    const communityId = "ab".repeat(32);
    for (const pane of MODERATION_PANES) {
      expect(parseChatRoute(chatRoute({ kind: "concord", communityId, pane }))).toMatchObject({ kind: "concord", pane });
    }
  });

  it("lands staff on Overview and everyone else on Settings", () => {
    expect(firstModerationPane({ ...none, overview: true, settings: true } as ModerationAccess)).toBe("overview");
    expect(firstModerationPane({ ...none, settings: true, invites: true, audit: true } as ModerationAccess)).toBe("settings");
  });

  it("opens Safety, where approval to post is switched, to Manage roles without Ban", () => {
    const access = moderationAccessFor({ canManageRoles: true, canKickAny: false, canBanAny: false, canCreateInvite: false, canReadReports: false, dissolved: false });
    expect(access.safety).toBe(true);
    expect(access.overview).toBe(true);
  });

  it("keeps Safety from a member with no moderation power, so its banner doesn't lead them to a refusal", () => {
    const access = moderationAccessFor({ canManageRoles: false, canKickAny: false, canBanAny: false, canCreateInvite: false, canReadReports: false, dissolved: false });
    expect(access.safety).toBe(false);
  });
});
