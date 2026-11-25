import type { ReactNode } from "react";

import { SettingsIcon, type SettingsTone } from "@/components/settings/SettingsSection";
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
import { useMinWidth } from "@/hooks/useMinWidth";
import { FormattedMessage, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

/** The pane width from which the sections sit in a sidebar, as Settings does. */
const WIDE_PX = 860;

/** The sidebar's cards: the community itself, its people, and keeping it safe. */
const GROUPS: readonly ModerationPane[][] = [
  ["overview", "settings"],
  ["members", "roles", "invites"],
  ["safety", "reports", "audit"],
];

const TONES: Record<ModerationPane, SettingsTone> = {
  overview: "primary",
  settings: "muted",
  members: "accent2",
  roles: "accent2",
  invites: "accent2",
  safety: "destructive",
  reports: "warning",
  audit: "muted",
};

/**
 * Manage community, laid out as Settings is: on a wide pane a sidebar of sections
 * beside the open one, otherwise a strip of tabs over it. A section the viewer can't
 * open is stated, not swapped, so the URL doesn't lie. The page renders the sections
 * that need its own state (Overview, Settings, and Safety's approval gate and
 * suspicious activity) and passes them in.
 */
export function ModerationView({
  community,
  pane,
  access,
  memberPubkeys,
  canModerateMembers,
  canManageRoles,
  canBan,
  onSelect,
  overview,
  settings,
  safety,
}: {
  community: Community;
  pane: ModerationPane;
  access: ModerationAccess;
  memberPubkeys: string[];
  canModerateMembers: boolean;
  canManageRoles: boolean;
  /** Safety's ban list is only for those who can ban; Manage roles opens Safety for approval alone. */
  canBan: boolean;
  onSelect: (pane: ModerationPane) => void;
  overview: ReactNode;
  settings: ReactNode;
  safety: ReactNode;
}) {
  const intl = useIntl();
  const [wide, attach] = useMinWidth(WIDE_PX);
  const tabs = MODERATION_PANES.filter((p) => access[p]).map((p) => MODERATION_TABS[p]);

  const body = !access[pane] ? (
    <p className="px-1 text-sm text-muted-foreground">
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
    <>
      {safety}
      {canBan && <BannedView community={community} />}
    </>
  ) : pane === "reports" ? (
    <ReportsView community={community} />
  ) : (
    <AuditLogView community={community} />
  );

  const page = (
    // Beside the sidebar it sits against it, as Settings' does; alone it centers.
    <div className={cn("space-y-6 px-4 pt-4 pb-12 sm:px-6", !wide && "mx-auto", pane === "settings" ? "max-w-5xl" : "max-w-2xl")}>
      <h2 className={cn("px-1 font-semibold tracking-tight", wide ? "pt-1 text-2xl" : "text-xl")}>
        {MODERATION_TABS[pane].label}
        {pane === "members" && <span className="ml-2 text-base font-normal text-muted-foreground">{memberPubkeys.length}</span>}
      </h2>
      {body}
    </div>
  );

  // The open section keeps one place in the tree whichever way it is laid out, so a
  // resize across the breakpoint doesn't remount it and lose what it holds.
  return (
    <div ref={attach} className="w-full">
      <div className={cn("mx-auto w-full", wide && "flex", wide && (pane === "settings" ? "max-w-7xl" : "max-w-5xl"))}>
        {wide ? (
          <nav
            aria-label={intl.formatMessage({ id: "concordPage.communityMenu.manage", defaultMessage: "Manage community" })}
            className="sticky top-0 w-64 shrink-0 space-y-4 self-start pl-gutter pr-2 pt-4 pb-8"
          >
            {GROUPS.map((ids) => {
              const shown = ids.filter((p) => access[p]);
              if (shown.length === 0) return null;
              return (
                <div key={ids.join()} className="bg-chrome clip-corner-lg overflow-hidden [&>*]:border-chrome [&>*:not(:first-child)]:border-t">
                  {shown.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => onSelect(p)}
                      aria-current={p === pane ? "page" : undefined}
                      className={cn(
                        "gutter-tick flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-accent/40 active:bg-accent/60",
                        p === pane && "is-active bg-accent/50",
                      )}
                    >
                      <SettingsIcon icon={MODERATION_TABS[p].icon} tone={TONES[p]} className="size-7" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">{MODERATION_TABS[p].label}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </nav>
        ) : (
          <div className="mx-auto max-w-2xl px-4 pt-4 sm:px-6">
            {/* Wraps where every label shows, rather than scrolling one out of sight; a phone shows icons and fits. */}
            <PillTabs tabs={tabs} value={pane} onChange={onSelect} labels="icons" className="justify-between sm:w-full sm:flex-wrap sm:justify-start" />
          </div>
        )}
        <div key="page" className="min-w-0 flex-1">{page}</div>
      </div>
    </div>
  );
}
