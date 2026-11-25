import { Flag, LayoutDashboard, Link as LinkIcon, ScrollText, Settings, Shield, ShieldAlert, Users } from "lucide-react";

import type { PillTab } from "@/components/ui/pill-tabs";
import { t } from "@/i18n/intl";
import type { Concord2Pane } from "@/lib/routes";

/**
 * The Manage community panes, in tab order. Each is its own route (`/c/<id>/members`,
 * …) so panes are linkable and back steps between tabs.
 */
export const MODERATION_PANES = [
  "overview",
  "settings",
  "members",
  "roles",
  "invites",
  "safety",
  "reports",
  "audit",
] as const;

export type ModerationPane = (typeof MODERATION_PANES)[number];

export function isModerationPane(value: string): value is ModerationPane {
  return (MODERATION_PANES as readonly string[]).includes(value);
}

/** The tab a route opens: older routes that became part of Safety keep working. */
export function managedPaneOf(pane: Concord2Pane | "channel"): ModerationPane | undefined {
  if (pane === "banned" || pane === "suspicious") return "safety";
  return isModerationPane(pane) ? pane : undefined;
}

/**
 * Which tabs this viewer may open — UI only; the fold re-checks each permission
 * (CORD-04), so a wrongly shown tab just costs a refused publish.
 */
export type ModerationAccess = Readonly<Record<ModerationPane, boolean>>;

/** Each pane's icon + name (formatted on read), shared by the tab strip and page header. */
export const MODERATION_TABS: Readonly<Record<ModerationPane, PillTab<ModerationPane>>> = {
  overview: {
    id: "overview",
    icon: LayoutDashboard,
    get label() {
      return t({ id: "moderationPanes.overview", defaultMessage: "Overview" });
    },
  },
  settings: {
    id: "settings",
    icon: Settings,
    get label() {
      return t({ id: "moderationPanes.settings", defaultMessage: "Settings" });
    },
  },
  members: {
    id: "members",
    icon: Users,
    get label() {
      return t({ id: "moderationPanes.members", defaultMessage: "Members" });
    },
  },
  roles: {
    id: "roles",
    icon: Shield,
    get label() {
      return t({ id: "moderationPanes.roles", defaultMessage: "Roles" });
    },
  },
  invites: {
    id: "invites",
    icon: LinkIcon,
    get label() {
      return t({ id: "moderationPanes.invites", defaultMessage: "Invite links" });
    },
  },
  safety: {
    id: "safety",
    icon: ShieldAlert,
    get label() {
      return t({ id: "moderationPanes.safety", defaultMessage: "Safety" });
    },
  },
  reports: {
    id: "reports",
    icon: Flag,
    get label() {
      return t({ id: "moderationPanes.reports", defaultMessage: "Reports" });
    },
  },
  audit: {
    id: "audit",
    icon: ScrollText,
    get label() {
      return t({ id: "moderationPanes.audit", defaultMessage: "Audit log" });
    },
  },
};

/**
 * Where "Manage community" lands: the first tab this viewer may open (ordered so
 * moderators land on the overview, everyone else on settings).
 */
export function firstModerationPane(access: ModerationAccess): ModerationPane | undefined {
  return MODERATION_PANES.find((pane) => access[pane]);
}
