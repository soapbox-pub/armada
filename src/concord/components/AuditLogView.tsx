import { Braces, CheckCircle2, Clock3, ScrollText, XCircle } from "lucide-react";
import { useMemo, useState } from "react";

import { EventJsonDialog } from "@/components/EventJsonDialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useControlEvents, useControlFold } from "@/concord/hooks/useControlPlane";
import { bytesToHex } from "@/concord/lib/derive";
import { classifyEditions, type AuditValidity } from "@/concord/lib/auditLog";
import { openControlEditions, type FoldedControl } from "@/concord/lib/control";
import type { ParsedEdition } from "@/concord/lib/edition";
import { openedToStored } from "@/concord/lib/rumorStore";
import {
  VSK_BANLIST,
  VSK_CHANNEL,
  VSK_GRANT,
  VSK_INVITE_REGISTRY,
  VSK_METADATA,
  VSK_ROLE,
} from "@/concord/lib/kinds";
import {
  PERMISSION_LABELS,
  grantFromJSON,
  roleFromJSON,
  type CommunityRoles,
} from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";
import { DisplayName } from "@/components/DisplayName";
import { useAuthor } from "@/hooks/useAuthor";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useLongPress } from "@/hooks/useLongPress";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { FormattedMessage, useIntl, type IntlShape } from "@/i18n";
import { shortTimeAgo } from "@/lib/formatTime";
import type { NostrRumor } from "@/lib/nostrRumor";
import { AvatarInitial } from "@/components/AvatarInitial";

/**
 * CORD-04 control-plane audit log: raw editions with signer, detail, and
 * whether the fold honored, superseded or dropped each. Nothing here is
 * privileged; any member can reconstruct it.
 */
export function AuditLogView({ community }: { community: Community }) {
  const intl = useIntl();
  const control = useControlEvents(community);
  const { data: folded } = useControlFold(community);

  const rows = useMemo<AuditRow[]>(() => {
    if (!control.data) return [];
    const editions = openControlEditions(control.data);
    // Shared with the suspicious-activity watchdog so both read the same verdicts.
    const validity = classifyEditions(editions, folded);
    return editions
      .map((e) => {
        const rumorHex = bytesToHex(e.rumorId);
        return toRow(intl, e, folded?.roster, folded, validity.get(rumorHex) ?? "unknown", rumorHex);
      })
      .sort((a, b) =>
        b.createdAt !== a.createdAt ? b.createdAt - a.createdAt : a.key < b.key ? 1 : -1,
      );
  }, [control.data, folded, intl]);

  return (
    <div className="mx-auto w-full max-w-2xl px-3 py-4">
      <div className="mb-3 flex items-center gap-2">
        <ScrollText className="size-5 text-primary" />
        <h2 className="text-lg font-semibold"><FormattedMessage id="auditLogView.title" defaultMessage="Audit log" /></h2>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        <FormattedMessage
          id="auditLogView.intro"
          defaultMessage="Every action recorded in this community's control plane, signed by the member who took it. Each row shows whether the fold honored the action in context, and anyone can verify this from raw event access."
        />
      </p>
      {control.isLoading && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground"><FormattedMessage id="auditLogView.loading" defaultMessage="Loading the control plane…" /></p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground"><FormattedMessage id="auditLogView.empty" defaultMessage="No control-plane actions yet." /></p>
      ) : (
        <ol className="space-y-2">
          {rows.map((row) => (
            <AuditRowItem key={row.key} row={row} community={community} />
          ))}
        </ol>
      )}
    </div>
  );
}

type Validity = AuditValidity;

interface AuditRow {
  key: string;
  author: string;
  createdAt: number;
  action: string;
  targetMembers?: string[];
  details: string[];
  version: bigint;
  validity: Validity;
  /** Whether the actor cited a specific grant as authority (non-owner actions). */
  citedAuthority: boolean;
  /**
   * The edition RUMOR (the signed bytes) for "View event JSON", not the stream
   * event, whose wire fields depend on how it arrived.
   */
  rumor: NostrRumor;
}

function AuditRowItem({ row, community }: { row: AuditRow; community: Community }) {
  const intl = useIntl();
  const author = useAuthor(row.author);
  const actorName = useScopedDisplayName(row.author, author.data?.metadata);
  const isOwner = row.author === community.owner;
  const isTouch = useIsTouch();
  const [jsonOpen, setJsonOpen] = useState(false);
  // One action, so long-press opens it directly.
  const longPress = useLongPress(isTouch ? () => setJsonOpen(true) : undefined);

  const item = (
    <li
      className="flex items-start gap-2.5 rounded-md bg-foreground/5 px-3 py-2 text-sm"
      {...(isTouch ? longPress : {})}
    >
      <Avatar className="mt-0.5 size-6 shrink-0">
        <AvatarImage src={author.data?.metadata?.picture} imeta={author.data?.imeta?.picture} alt={actorName} />
        <AvatarFallback className="bg-primary/20 text-3xs text-primary">
          <AvatarInitial name={actorName} pubkey={row.author} />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="truncate font-medium">
            <DisplayName pubkey={row.author} name={actorName} />
          </span>
          {isOwner && (
            <Badge variant="secondary" className="px-1.5 py-0 text-3xs">
              <FormattedMessage id="auditLogView.ownerBadge" defaultMessage="Owner" />
            </Badge>
          )}
          <span className="text-muted-foreground">{row.action}</span>
          {row.targetMembers?.map((pk) => <MemberName key={pk} pubkey={pk} community={community} />)}
          <ValidityBadge validity={row.validity} />
        </div>
        {row.details.map((d, i) => (
          <p key={i} className="mt-0.5 break-words text-muted-foreground">
            {d}
          </p>
        ))}
        <p className="mt-0.5 text-2xs text-muted-foreground/70">
          {isOwner ? (
            <FormattedMessage id="auditLogView.version" defaultMessage="v{version}" values={{ version: row.version.toString() }} />
          ) : row.citedAuthority ? (
            <FormattedMessage id="auditLogView.versionCitedAuthority" defaultMessage="v{version} · cited authority" values={{ version: row.version.toString() }} />
          ) : (
            <FormattedMessage id="auditLogView.versionNoAuthority" defaultMessage="v{version} · no authority cited" values={{ version: row.version.toString() }} />
          )}
        </p>
      </div>
      <time
        className="mt-0.5 shrink-0 tabular-nums text-xs text-muted-foreground"
        dateTime={new Date(row.createdAt * 1000).toISOString()}
        title={new Date(row.createdAt * 1000).toLocaleString(intl.locale)}
      >
        {shortTimeAgo(row.createdAt)}
      </time>
    </li>
  );

  return (
    <>
      {/* On touch the long press owns the gesture, so no context menu. */}
      {isTouch ? (
        item
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>{item}</ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ContextMenuItem onSelect={() => setJsonOpen(true)}>
              <Braces className="mr-2 size-4" />
              <FormattedMessage id="auditLogView.viewEventJson" defaultMessage="View event JSON" />
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
      {jsonOpen && (
        <EventJsonDialog
          open={jsonOpen}
          onOpenChange={setJsonOpen}
          source={row.rumor}
          description={intl.formatMessage({
            id: "auditLogView.jsonDescription",
            defaultMessage: "The raw, unsigned control-plane edition its author signed. The signature is on the seal that carried it, which is stored separately.",
          })}
        />
      )}
    </>
  );
}

function MemberName({ pubkey, community }: { pubkey: string; community: Community }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  const isOwner = pubkey === community.owner;
  return (
    <span className="inline-flex items-center gap-1 rounded bg-foreground/10 px-1.5 py-0.5 text-xs font-medium">
      <DisplayName pubkey={pubkey} name={name} />
      {isOwner && <span className="text-3xs uppercase text-muted-foreground"><FormattedMessage id="auditLogView.ownerTag" defaultMessage="owner" /></span>}
    </span>
  );
}

function ValidityBadge({ validity }: { validity: Validity }) {
  const intl = useIntl();
  if (validity === "unknown") return null;
  const map = {
    current: {
      icon: <CheckCircle2 className="size-3" />,
      label: intl.formatMessage({ id: "auditLogView.validity.applied", defaultMessage: "Applied" }),
      cls: "bg-success/15 text-success",
      hint: intl.formatMessage({ id: "auditLogView.validity.appliedHint", defaultMessage: "The fold honored this action and it is the entity's current state." }),
    },
    superseded: {
      icon: <Clock3 className="size-3" />,
      label: intl.formatMessage({ id: "auditLogView.validity.superseded", defaultMessage: "Superseded" }),
      cls: "bg-muted text-muted-foreground",
      hint: intl.formatMessage({ id: "auditLogView.validity.supersededHint", defaultMessage: "Was honored on the verified chain, then a later chained edition replaced it." }),
    },
    dropped: {
      icon: <XCircle className="size-3" />,
      label: intl.formatMessage({ id: "auditLogView.validity.notApplied", defaultMessage: "Not applied" }),
      cls: "bg-destructive/15 text-destructive",
      hint: intl.formatMessage({ id: "auditLogView.validity.notAppliedHint", defaultMessage: "This action wasn't applied. It was unauthorized, forged, or lost a same-version fork." }),
    },
  }[validity];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium ${map.cls}`}
        >
          {map.icon}
          {map.label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-52 text-xs">{map.hint}</TooltipContent>
    </Tooltip>
  );
}

function channelName(intl: IntlShape, folded: FoldedControl | undefined, idHex: string): string {
  return folded?.channels.get(idHex)?.name
    ?? intl.formatMessage({ id: "auditLogView.unknownChannel", defaultMessage: "channel {id}…" }, { id: idHex.slice(0, 8) });
}

function permissionLabels(intl: IntlShape, perms: bigint): string[] {
  const out = PERMISSION_LABELS.filter((p) => (perms & p.bit) === p.bit).map((p) => p.label);
  return out.length ? out : [intl.formatMessage({ id: "auditLogView.noPermissions", defaultMessage: "no permissions" })];
}

function roleNames(roster: CommunityRoles | undefined, roleIds: string[]): string {
  return roleIds
    .map((rid) => roster?.roles.find((r) => r.roleId === rid)?.name ?? `${rid.slice(0, 8)}…`)
    .join(", ");
}

function toRow(
  intl: IntlShape,
  e: ParsedEdition,
  roster: CommunityRoles | undefined,
  folded: FoldedControl | undefined,
  validity: Validity,
  rumorHex: string,
): AuditRow {
  const base = {
    key: rumorHex,
    author: e.author,
    createdAt: e.createdAt,
    version: e.version,
    validity,
    citedAuthority: Boolean(e.authority),
    details: [] as string[],
    rumor: openedToStored(e.opened),
  };
  const eidHex = bytesToHex(e.entityId);

  switch (e.vsk) {
    case VSK_METADATA: {
      let meta: { name?: string; description?: string } = {};
      try {
        meta = JSON.parse(e.content) as typeof meta;
      } catch {
        /* keep empty */
      }
      const details: string[] = [];
      if (meta.name) details.push(intl.formatMessage({ id: "auditLogView.detail.name", defaultMessage: "Name: {name}" }, { name: meta.name }));
      if (meta.description) details.push(intl.formatMessage({ id: "auditLogView.detail.description", defaultMessage: "Description: {description}" }, { description: truncate(meta.description, 120) }));
      return {
        ...base,
        action: e.version === 1n
          ? intl.formatMessage({ id: "auditLogView.action.createdCommunity", defaultMessage: "created the community" })
          : intl.formatMessage({ id: "auditLogView.action.updatedCommunity", defaultMessage: "updated community settings" }),
        details,
      };
    }
    case VSK_ROLE: {
      const role = roleFromJSON(e.content);
      const details: string[] = [];
      if (role) {
        details.push(intl.formatMessage({ id: "auditLogView.detail.role", defaultMessage: "Role \"{name}\" at position {position}" }, { name: role.name, position: role.position }));
        details.push(intl.formatMessage({ id: "auditLogView.detail.permissions", defaultMessage: "Permissions: {permissions}" }, { permissions: permissionLabels(intl, role.permissions).join(", ") }));
      }
      return {
        ...base,
        action: e.version === 1n
          ? intl.formatMessage({ id: "auditLogView.action.createdRole", defaultMessage: "created a role" })
          : intl.formatMessage({ id: "auditLogView.action.updatedRole", defaultMessage: "updated a role" }),
        details,
      };
    }
    case VSK_CHANNEL: {
      let meta: { name?: string; deleted?: boolean; private?: boolean } = {};
      try {
        meta = JSON.parse(e.content) as typeof meta;
      } catch {
        /* keep empty */
      }
      const label = meta.name ?? channelName(intl, folded, eidHex);
      if (meta.deleted) {
        return {
          ...base,
          action: intl.formatMessage({ id: "auditLogView.action.deletedChannel", defaultMessage: "deleted a channel" }),
          details: [`#${label}`],
        };
      }
      const details = [meta.private
        ? intl.formatMessage({ id: "auditLogView.detail.privateChannel", defaultMessage: "#{name} · private" }, { name: label })
        : intl.formatMessage({ id: "auditLogView.detail.publicChannel", defaultMessage: "#{name} · public" }, { name: label })];
      return {
        ...base,
        action: e.version === 1n
          ? intl.formatMessage({ id: "auditLogView.action.createdChannel", defaultMessage: "created a channel" })
          : intl.formatMessage({ id: "auditLogView.action.updatedChannel", defaultMessage: "updated a channel" }),
        details,
      };
    }
    case VSK_GRANT: {
      const grant = grantFromJSON(e.content);
      if (grant && grant.roleIds.length === 0) {
        return {
          ...base,
          action: intl.formatMessage({ id: "auditLogView.action.revokedRoles", defaultMessage: "revoked all roles from" }),
          targetMembers: [grant.member],
          details: [],
        };
      }
      return {
        ...base,
        action: intl.formatMessage({ id: "auditLogView.action.assignedRoles", defaultMessage: "assigned roles to" }),
        targetMembers: grant ? [grant.member] : undefined,
        details: grant ? [intl.formatMessage({ id: "auditLogView.detail.roles", defaultMessage: "Roles: {roles}" }, { roles: roleNames(roster, grant.roleIds) })] : [],
      };
    }
    case VSK_BANLIST: {
      let list: string[] = [];
      try {
        const parsed = JSON.parse(e.content) as unknown[];
        if (Array.isArray(parsed)) {
          list = parsed.filter((x): x is string => typeof x === "string" && /^[0-9a-f]{64}$/i.test(x));
        }
      } catch {
        /* keep empty */
      }
      return {
        ...base,
        action: list.length
          ? intl.formatMessage({ id: "auditLogView.action.setBanList", defaultMessage: "set the ban list to" })
          : intl.formatMessage({ id: "auditLogView.action.clearedBanList", defaultMessage: "cleared the ban list" }),
        targetMembers: list.slice(0, 10),
        details: list.length > 10 ? [intl.formatMessage({ id: "auditLogView.detail.andMore", defaultMessage: "…and {count} more" }, { count: list.length - 10 })] : [],
      };
    }
    case VSK_INVITE_REGISTRY: {
      let count: number | undefined;
      try {
        const list = JSON.parse(e.content) as unknown[];
        if (Array.isArray(list)) count = list.length;
      } catch {
        /* keep undefined */
      }
      return {
        ...base,
        action: intl.formatMessage({ id: "auditLogView.action.updatedInviteLinks", defaultMessage: "updated their invite links" }),
        details: count !== undefined ? [intl.formatMessage({ id: "auditLogView.detail.liveLinks", defaultMessage: "{count, plural, one {# live link} other {# live links}}" }, { count })] : [],
      };
    }
    default:
      return {
        ...base,
        action: intl.formatMessage({ id: "auditLogView.action.publishedEdition", defaultMessage: "published a control edition (type {type})" }, { type: String(e.vsk) }),
        details: [],
      };
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
