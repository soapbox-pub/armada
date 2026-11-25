import { Ban } from "lucide-react";
import type { ReactNode } from "react";

import { PillTabs } from "@/components/ui/pill-tabs";
import { AuditLogView } from "@/concord/components/AuditLogView";
import { BannedView } from "@/concord/components/BannedView";
import { InvitesView } from "@/concord/components/InvitesView";
import { MembersView } from "@/concord/components/MembersView";
import { ReportsView } from "@/concord/components/ReportsView";
import { RolesView } from "@/concord/components/RolesView";
import {
  MODERATION_PANES,
  MODERATION_TABS,
  type ModerationAccess,
  type ModerationPane,
} from "@/concord/lib/moderationPanes";
import type { Community } from "@/concord/lib/types";
import { FormattedMessage } from "@/i18n";

/**
 * Manage community: every admin surface behind one tab strip. A pane the viewer can't
 * open is stated, not swapped, so the URL doesn't lie. The page renders the panes that
 * need its own state (Overview, Settings, Safety's suspicious activity) and passes them in.
 */
export function ModerationView({
  community,
  pane,
  access,
  memberPubkeys,
  canModerateMembers,
  canManageRoles,
  onSelect,
  overview,
  settings,
  suspicious,
}: {
  community: Community;
  pane: ModerationPane;
  access: ModerationAccess;
  memberPubkeys: string[];
  canModerateMembers: boolean;
  canManageRoles: boolean;
  onSelect: (pane: ModerationPane) => void;
  overview: ReactNode;
  settings: ReactNode;
  suspicious: ReactNode;
}) {
  const tabs = MODERATION_PANES.filter((p) => access[p]).map((p) => MODERATION_TABS[p]);

  return (
    <div className="flex flex-col">
      <div className="mx-auto flex w-full max-w-2xl px-4 pt-4">
        <PillTabs tabs={tabs} value={pane} onChange={onSelect} />
      </div>
      {!access[pane] ? (
        <p className="mx-auto w-full max-w-2xl p-4 text-sm text-muted-foreground">
          <FormattedMessage id="moderationView.noPermission" defaultMessage="You don't have permission to see this." />
        </p>
      ) : pane === "overview" ? (
        overview
      ) : pane === "settings" ? (
        settings
      ) : pane === "members" ? (
        <MembersView
          community={community}
          memberPubkeys={memberPubkeys}
          canModerate={canModerateMembers}
          canManageRoles={canManageRoles}
        />
      ) : pane === "roles" ? (
        <RolesView community={community} />
      ) : pane === "invites" ? (
        <InvitesView community={community} />
      ) : pane === "safety" ? (
        <div className="pb-24">
          {suspicious}
          <div className="mx-auto flex w-full max-w-2xl items-center gap-2 px-4 pt-2">
            <Ban className="size-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">
              <FormattedMessage id="moderationView.banned" defaultMessage="Banned members" />
            </h2>
          </div>
          <BannedView community={community} />
        </div>
      ) : pane === "reports" ? (
        <ReportsView community={community} />
      ) : (
        <AuditLogView community={community} />
      )}
    </div>
  );
}
