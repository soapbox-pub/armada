import { GripVertical, Hash, Loader2, Lock, Plus, Shield, ShieldOff, Users } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ColorPicker } from "@/components/ui/color-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useChannelRekey } from "@/concord/hooks/useRekey";
import { useRoles } from "@/concord/hooks/useRoles";
import { roleRevokeCut } from "@/concord/lib/channelAccess";
import { bytesToHex } from "@/concord/lib/derive";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { toast } from "@/hooks/useToast";
import {
  byDisplayOrder,
  canActOnMember,
  canActOnPosition,
  colorToHex,
  emptyRoles,
  hexToColor,
  highestPosition,
  MAX_ROLES_PER_COMMUNITY,
  normalizeOrder,
  PERMISSION_LABELS,
  Permissions,
  projectReorder,
  type CommunityRoles,
  type MemberGrant,
  type Role,
  type RoleScope,
} from "@/concord/lib/roles";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import type { Community } from "@/concord/lib/types";
import { cn } from "@/lib/utils";
import { common, FormattedMessage, t, useIntl, type IntlShape, type MessageDescriptor } from "@/i18n";

/** A table label that may be a plain string or a message descriptor. */
function labelText(intl: IntlShape, label: string | MessageDescriptor): string {
  return typeof label === "string" ? label : intl.formatMessage(label);
}

/** Fallback swatch for a role on the theme default (`color === 0`). */
const DEFAULT_SWATCH = "#5865f2";

function MemberLabel({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return <DisplayName pubkey={pubkey} name={name || pubkey.slice(0, 8)} />;
}

function MemberNames({ members }: { members: MemberGrant[] }) {
  return (
    <>
      {members.map((g, i) => (
        <span key={g.member}>
          {i > 0 && ", "}
          <MemberLabel pubkey={g.member} />
        </span>
      ))}
    </>
  );
}

/** Role management. Each save is a version-chained Role (vsk 1) edition; folds re-check MANAGE_ROLES + strict outrank (CORD-04). */
export function RolesView({ community }: { community: Community }) {
  return (
    <div className="mx-auto w-full max-w-2xl p-4">
      <RolesBody community={community} />
    </div>
  );
}

function RolesBody({ community }: { community: Community }) {
  const { folded } = useRoles(community);
  if (folded?.rankedRoster) return <RankedRolesReadOnly roster={folded.roster} />;
  return <LegacyRolesBody community={community} />;
}

/**
 * The vsk-13 Roster (CORD-04 §2), read-only: Roles in rank order with what they
 * carry and who holds them, and what `@everyone` holds.
 */
function RankedRolesReadOnly({ roster }: { roster: CommunityRoles }) {
  const intl = useIntl();
  const roles = [...roster.roles].sort(byDisplayOrder);
  const bitsOf = (perms: bigint) =>
    PERMISSION_LABELS.filter((l) => (perms & l.bit) === l.bit).map((l) => labelText(intl, l.label)).join(", ");
  return (
    <div className="space-y-4">
      <Alert>
        <AlertDescription>
          <FormattedMessage
            id="rolesView.rankedReadOnly"
            defaultMessage="This community uses ranked roles with channel permissions. Armada can show them, but can't edit them yet."
          />
        </AlertDescription>
      </Alert>
      <div className="space-y-2">
        {roles.map((role) => (
          <div key={role.roleId} className="rounded-lg bg-secondary/40 p-3">
            <div className="flex items-center gap-2">
              <span className="size-3 shrink-0 rounded-full bg-muted-foreground" style={colorToHex(role.color) ? { backgroundColor: colorToHex(role.color) } : undefined} />
              <span className="truncate text-sm font-medium">{role.name}</span>
              <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Users className="size-3.5" />
                {roster.grants.filter((g) => g.roleIds.includes(role.roleId)).length}
              </span>
            </div>
            {role.permissions !== 0n && <p className="mt-1 text-xs text-muted-foreground">{bitsOf(role.permissions)}</p>}
          </div>
        ))}
        <div className="rounded-lg bg-secondary/40 p-3">
          <span className="text-sm font-medium">@everyone</span>
          <p className="mt-1 text-xs text-muted-foreground">{bitsOf(roster.everyone ?? 0n)}</p>
        </div>
      </div>
    </div>
  );
}

function LegacyRolesBody({ community }: { community: Community }) {
  const { folded, saveRole, isSavingRole, setMemberRoles, isSettingRoles, newRoleId } = useRoles(community);
  const { rekeyChannel, isRekeyingChannel, canRekeyChannel } = useChannelRekey(community);
  const { user } = useCurrentUser();
  const intl = useIntl();
  const [editing, setEditing] = useState<Role | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  /** Held as role ids: the fold can advance between refusal and click. */
  const [evenOut, setEvenOut] = useState<string[] | null>(null);

  const roster = folded?.roster ?? emptyRoles();
  const actor = user?.pubkey;
  const busy = isSavingRole || isSettingRoles || isRekeyingChannel;

  const roles = useMemo(
    () => [...(folded?.roster.roles ?? [])].sort(byDisplayOrder),
    [folded],
  );

  // Deleted channels are excluded; the fold keeps their stale definitions.
  const channels = useMemo(
    () => [...(folded?.channels.values() ?? [])].filter((c) => !c.deleted),
    [folded],
  );
  // Every live Private Channel, flagged by whether I hold its key (see roleRevokeCut).
  const privateChannels = useMemo(() => {
    const heldIds = new Set(community.privateChannels.map((ch) => bytesToHex(ch.id)));
    return channels.filter((c) => c.isPrivate).map((c) => ({ idHex: c.channelIdHex, heldByMe: heldIds.has(c.channelIdHex) }));
  }, [community, channels]);
  const liveChannel = (channelId: string) => {
    const c = folded?.channels.get(channelId);
    return c && !c.deleted ? c : undefined;
  };

  const holderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of folded?.roster.grants ?? []) {
      for (const id of g.roleIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [folded]);

  const ownerHex = folded?.ownerHex ?? community.owner;

  /** Same gate the fold applies (CORD-04 §3 strict outrank), so illegal moves fail here readably. */
  const mayTouch = (position: number) =>
    Boolean(actor && canActOnPosition(roster, actor, ownerHex, position, Permissions.MANAGE_ROLES));

  /** Lowest claimable position: rank + 1 (owner: 1, never 0; CORD-04 §3). null without any role. */
  const writableFloor = useMemo(() => {
    if (!actor) return null;
    if (actor === ownerHex) return 1;
    const rank = highestPosition(roster, actor);
    return rank === undefined ? null : rank + 1;
  }, [actor, ownerHex, roster]);

  /**
   * A Grant edition restates every role the member keeps, so the actor must
   * outrank the MEMBER, not just the role, or every fold drops it (CORD-04 §3).
   */
  const mayStrip = (member: string) =>
    Boolean(actor && canActOnMember(roster, actor, ownerHex, member, Permissions.MANAGE_ROLES));

  /** Grants holding `role`, split by rewritability; the owner is separated (never removable, CORD-04 §3). */
  const holdersOf = (role: Role) => {
    const holders = roster.grants.filter((g) => g.roleIds.includes(role.roleId));
    const blocked = holders.filter((g) => !mayStrip(g.member));
    return {
      strippable: holders.filter((g) => mayStrip(g.member)),
      skipped: blocked,
      skippedOwner: blocked.filter((g) => g.member === ownerHex),
      skippedRank: blocked.filter((g) => g.member !== ownerHex),
    };
  };

  /**
   * Commit a reorder by REUSING the existing position multiset (renumbering
   * 1..N would claim positions only the owner may write). Only changed roles republish.
   */
  const commitOrder = async (next: Role[]) => {
    setError(null);
    setEvenOut(null);
    const { landing, rendered } = projectReorder(roles, next);
    const moved = next
      .map((role, i) => ({ role, position: landing[i].position }))
      .filter(({ role, position }) => role.position !== position);
    // Reused positions can't separate peers, so an order is satisfiable or not;
    // catch the unsatisfiable case (e.g. A(3) B(3) C(5), C to top) before publishing.
    const missed = rendered.findIndex((role, i) => role.roleId !== next[i].roleId);
    if (missed < 0 && moved.length === 0) return; // already in the order asked for
    if (moved.length === 0 || missed >= 0) {
      setError(unsatisfiable(next, landing, rendered, missed));
      // Offer (not apply) the even-out escape: it rewrites roles the user didn't drag.
      if (planEvenOut(next)) setEvenOut(next.map((r) => r.roleId));
      return;
    }
    await applyMoves(moved);
  };

  /** Explains that the target position isn't free, so the tie-break decides. */
  const unsatisfiable = (next: Role[], landing: Role[], rendered: Role[], missed: number) => {
    const wanted = landing.find((r) => r.roleId === next[missed].roleId)!;
    const peers = landing.filter((r) => r.position === wanted.position && r.roleId !== wanted.roleId);
    const ahead = rendered.slice(0, rendered.findIndex((r) => r.roleId === wanted.roleId));
    const winner = ahead[ahead.length - 1];
    const values = {
      role: wanted.name,
      position: wanted.position,
      peers: intl.formatList(peers.map((r) => r.name), { type: "conjunction" }),
      count: peers.length,
    };
    return winner
      ? intl.formatMessage(
          {
            id: "rolesView.unsatisfiableBehind",
            defaultMessage:
              "{role} can't go there: the only position free for it is {position}, which {peers} already {count, plural, one {holds} other {hold}}, and ties go to the lower role id, so it would render behind {winner}, not where you dropped it. Nothing was published.",
          },
          { ...values, winner: winner.name },
        )
      : intl.formatMessage(
          {
            id: "rolesView.unsatisfiableOutOfOrder",
            defaultMessage:
              "{role} can't go there: the only position free for it is {position}, which {peers} already {count, plural, one {holds} other {hold}}, and ties go to the lower role id, so it would render out of order, not where you dropped it. Nothing was published.",
          },
          values,
        );
  };

  /** Independent publishes, not a transaction; report how far it got on failure. */
  const applyMoves = async (moved: Array<{ role: Role; position: number }>) => {
    // The actor must outrank both the old and new position.
    for (const { role, position } of moved) {
      if (!mayTouch(role.position) || !mayTouch(position)) {
        setError(t({ id: "rolesView.crossesRank", defaultMessage: "That move crosses your own rank." }));
        return;
      }
    }
    let done = 0;
    try {
      for (const { role, position } of moved) {
        await saveRole({ role: { ...role, position } });
        done++;
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : t({ id: "rolesView.reorderFailed", defaultMessage: "Couldn't reorder roles." });
      // A half-applied swap can leave peers the tie-break renders in the original
      // order, so name that outcome rather than suggest re-dragging.
      const landed = new Map(roles.map((r) => [r.roleId, r.position]));
      for (let i = 0; i < done; i++) landed.set(moved[i].role.roleId, moved[i].position);
      const seen = new Set<number>();
      const shared = [...new Set([...landed.values()].filter((p) => seen.size === seen.add(p).size))].sort(
        (a, b) => a - b,
      );
      setError(
        shared.length > 0
          ? t(
              {
                id: "rolesView.reorderPartialShared",
                defaultMessage:
                  "{why} {done} of {total} roles moved, leaving two or more roles on position {positions}. Nothing was undone. Roles at one position are peers and render by role id, so the list may look unchanged. Drag one of them again and accept the offer to even out the positions.",
              },
              {
                why,
                done,
                total: moved.length,
                positions: intl.formatList(shared.map(String), { type: "conjunction" }),
              },
            )
          : t(
              {
                id: "rolesView.reorderPartial",
                defaultMessage:
                  "{why} {done} of {total} roles moved; the rest kept their old position. Nothing was undone. Reorder again to finish.",
              },
              { why, done, total: moved.length },
            ),
      );
    }
  };

  /** Distinct positions in the requested order, or null if unwritable; computed against the current roster. */
  const planEvenOut = (next: Role[]): Role[] | null => {
    if (writableFloor === null) return null;
    const plan = normalizeOrder(next, writableFloor);
    if (!plan) return null;
    // Gate only changed roles: the unchanged lead includes the actor's own role,
    // which is never touchable, so gating all would refuse every non-owner.
    const rewrites = plan
      .map((planned, i) => ({ from: next[i].position, to: planned.position }))
      .filter(({ from, to }) => from !== to);
    if (rewrites.length === 0) return null;
    return rewrites.every(({ from, to }) => mayTouch(from) && mayTouch(to)) ? plan : null;
  };

  const applyEvenOut = async () => {
    if (!evenOut) return;
    setEvenOut(null);
    setError(null);
    // Rebuild from the CURRENT roster; if roles changed, re-dragging is the recovery.
    const found = evenOut.map((roleId) => roles.find((r) => r.roleId === roleId));
    const next = found.filter((r): r is Role => r !== undefined);
    const plan = next.length === evenOut.length && next.length === roles.length ? planEvenOut(next) : null;
    if (!plan) {
      setError(
        t({ id: "rolesView.rolesChanged", defaultMessage: "The roles changed while that was on screen. Drag it again." }),
      );
      return;
    }
    const moved = plan
      .map((planned, i) => ({ role: next[i], position: planned.position }))
      .filter(({ role, position }) => role.position !== position);
    if (moved.length === 0) return;
    await applyMoves(moved);
  };

  // Pointer events, not HTML5 DnD (which never fires on touch). The grip
  // captures the pointer; `touch-none` stops the browser claiming a scroll.

  const rowIndexAt = (clientY: number): number | null => {
    const rows = listRef.current?.children;
    if (!rows) return null;
    for (let i = 0; i < rows.length; i++) {
      const box = rows[i].getBoundingClientRect();
      if (clientY >= box.top && clientY <= box.bottom) return i;
    }
    return null;
  };

  const startDrag = (index: number) => (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragFrom(index);
    setDragOver(index);
  };

  const moveDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (dragFrom === null) return;
    const over = rowIndexAt(e.clientY);
    if (over !== null) setDragOver(over);
  };

  const endDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const from = dragFrom;
    const to = dragOver;
    setDragFrom(null);
    setDragOver(null);
    if (from === null || to === null || from === to) return;
    const next = [...roles];
    const [picked] = next.splice(from, 1);
    next.splice(to, 0, picked);
    void commitOrder(next);
  };

  /** Rotate a revoked role's channel key away from the members it cut; the reason it couldn't, else null. */
  const rotateAway = async (cut: NonNullable<ReturnType<typeof roleRevokeCut>>): Promise<string | null> => {
    const channel = `#${liveChannel(cut.channelIdHex)?.name ?? cut.channelIdHex.slice(0, 8)}`;
    if (!cut.heldByMe) {
      return t(
        {
          id: "rolesView.keyNotHeld",
          defaultMessage: "You don't hold the key to {channel}, so its former holders keep reading until a member who does rotates it.",
        },
        { channel },
      );
    }
    if (!canRekeyChannel) {
      return t(
        {
          id: "rolesView.keyNeedsPermission",
          defaultMessage:
            "Its former holders still have the key to {channel}, and rotating it needs the Manage channels permission. Ask an admin to rotate it.",
        },
        { channel },
      );
    }
    try {
      await rekeyChannel({ channelIdHex: cut.channelIdHex, keepRecipients: cut.keep, removedTargets: cut.removed });
      return null;
    } catch (e) {
      return t(
        {
          id: "rolesView.keyRotationFailed",
          defaultMessage: "Rotating the key to {channel} failed, so its former holders can still read it: {error} Rotate it from the channel's access settings.",
        },
        { channel, error: e instanceof Error ? e.message : String(e) },
      );
    }
  };

  /**
   * Revoke a role: strip it from every Grant, then publish it with no
   * permissions. NOT deletion: CORD-04 has no Role tombstone, so it keeps a
   * slot of the 100 (§2). Grants first (§6 ordering).
   */
  const revokeRole = async (role: Role) => {
    setError(null);
    setEvenOut(null);
    const { strippable, skippedOwner, skippedRank } = holdersOf(role);
    // Judged on the pre-strip roster: once the Grants land, nobody holds the role to cut.
    const cut = roleRevokeCut(roster, ownerHex, role, strippable.map((g) => g.member), privateChannels, folded?.banned);
    let stripped = 0;
    try {
      for (const g of strippable) {
        await setMemberRoles({ member: g.member, roleIds: g.roleIds.filter((r) => r !== role.roleId) });
        stripped++;
      }
      // The stripped members still hold the channel key; only a rotation cuts them (CORD-06).
      const keyLeft = cut ? await rotateAway(cut) : null;
      // Clear `display` too: un-outranked holders keep the role, so a hoisted section would linger.
      await saveRole({ role: { ...role, permissions: 0n, display: undefined } });
      // Owner is separated: `canActOnMember` refuses them as a target outright.
      const description =
        skippedRank.length > 0 && skippedOwner.length > 0
          ? t(
              {
                id: "rolesView.revokedStillHeldBoth",
                defaultMessage:
                  "It now confers nothing, but {count, plural, one {# member you don't outrank} other {# members you don't outrank}} and the owner (never removable) still list it.",
              },
              { count: skippedRank.length },
            )
          : skippedRank.length > 0
            ? t(
                {
                  id: "rolesView.revokedStillHeldRank",
                  defaultMessage:
                    "It now confers nothing, but {count, plural, one {# member you don't outrank still lists} other {# members you don't outrank still list}} it.",
                },
                { count: skippedRank.length },
              )
            : skippedOwner.length > 0
              ? t({
                  id: "rolesView.revokedStillHeldOwner",
                  defaultMessage: "It now confers nothing, but the owner (never removable) still lists it.",
                })
              : t({ id: "rolesView.revokedFromAll", defaultMessage: "Taken from every member; it now confers nothing." });
      toast({
        title: t({ id: "rolesView.roleRevoked", defaultMessage: "Role revoked" }),
        description,
      });
      if (keyLeft) {
        setError(keyLeft);
        return;
      }
      setConfirmRevoke(null);
    } catch (e) {
      const why = e instanceof Error ? e.message : t({ id: "rolesView.revokeFailed", defaultMessage: "Couldn't revoke the role." });
      setError(
        t(
          {
            id: "rolesView.revokePartial",
            defaultMessage:
              "{why} {stripped} of {total} grants were stripped and the role still carries its permissions. Nothing was undone. Revoke again to finish.",
          },
          { why, stripped, total: strippable.length },
        ),
      );
    }
  };

  if (confirmRevoke) {
    const { strippable, skipped, skippedOwner, skippedRank } = holdersOf(confirmRevoke);
    return (
      <div className="flex flex-col gap-5">
        <div className="space-y-2">
          <h2 className="font-mono text-xl font-bold lowercase tracking-tight">
            <FormattedMessage
              id="rolesView.revokeHeading"
              defaultMessage="revoke {name}?"
              values={{ name: confirmRevoke.name }}
            />
          </h2>
          <p className="text-sm text-muted-foreground">
            {strippable.length > 0 ? (
              <FormattedMessage
                id="rolesView.revokeStripTaken"
                defaultMessage="{count, plural, one {It will be stripped of every permission and taken from # member.} other {It will be stripped of every permission and taken from # members.}}"
                values={{ count: strippable.length }}
              />
            ) : (
              <FormattedMessage id="rolesView.revokeStrip" defaultMessage="It will be stripped of every permission." />
            )}
          </p>
          {skippedRank.length > 0 && (
            <p className="text-sm text-muted-foreground">
              <FormattedMessage
                id="rolesView.revokeSkippedRank"
                defaultMessage="{count, plural, one {You don't outrank {names}, so the role stays listed on their grant.} other {You don't outrank {names}, so the role stays listed on their grants.}}"
                values={{ count: skippedRank.length, names: <MemberNames members={skippedRank} /> }}
              />
            </p>
          )}
          {skippedOwner.length > 0 && (
            <p className="text-sm text-muted-foreground">
              <FormattedMessage
                id="rolesView.revokeSkippedOwner"
                defaultMessage="The owner's grant can never be rewritten by anyone, so the role stays listed on it."
              />
            </p>
          )}
          {skipped.length > 0 && (
            <p className="text-sm text-muted-foreground">
              <FormattedMessage
                id="rolesView.revokeConfersNothing"
                defaultMessage="With no permissions left it confers nothing there either."
              />
            </p>
          )}
          {/* No Role tombstone (CORD-04 §2); reuse only when nobody still holds it. */}
          <p className="text-sm text-muted-foreground">
            {skipped.length === 0 ? (
              <FormattedMessage
                id="rolesView.revokeNoDeleteReusable"
                defaultMessage="Roles can't be deleted: they're part of the community's signed history, which every member's app replays so that everyone sees the same list. So it stays here, holding one of the community's {max} role slots, but grants nothing. You can rename it later to reuse the slot."
                values={{ max: MAX_ROLES_PER_COMMUNITY }}
              />
            ) : (
              <FormattedMessage
                id="rolesView.revokeNoDelete"
                defaultMessage="Roles can't be deleted: they're part of the community's signed history, which every member's app replays so that everyone sees the same list. So it stays here, holding one of the community's {max} role slots, but grants nothing."
                values={{ max: MAX_ROLES_PER_COMMUNITY }}
              />
            )}
          </p>
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            className="flex-1"
            onClick={() => {
              setConfirmRevoke(null);
              setError(null);
            }}
            disabled={busy}
          >
            <FormattedMessage {...common.cancel} />
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="flex-1 clip-corner-lg"
            onClick={() => void revokeRole(confirmRevoke)}
            disabled={busy}
          >
            {busy ? (
              <>
                <Loader2 className="size-4 mr-2 animate-spin" />{" "}
                <FormattedMessage id="rolesView.revoking" defaultMessage="Revoking..." />
              </>
            ) : (
              <FormattedMessage id="rolesView.revokeRole" defaultMessage="Revoke role" />
            )}
          </Button>
        </div>
      </div>
    );
  }

  if (editing) {
    return (
      <RoleEditor
        role={editing}
        channels={channels.map((c) => ({ idHex: c.channelIdHex, name: c.name, isPrivate: c.isPrivate }))}
        holders={holderCounts.get(editing.roleId) ?? 0}
        saving={isSavingRole}
        error={error}
        canRevoke={roles.some((r) => r.roleId === editing.roleId) && mayTouch(editing.position)}
        onRevoke={() => {
          setError(null);
          setConfirmRevoke(editing);
          setEditing(null);
        }}
        onCancel={() => {
          setEditing(null);
          setError(null);
        }}
        onSave={async (role) => {
          setError(null);
          try {
            await saveRole({ role });
            toast({ title: t({ id: "rolesView.roleSaved", defaultMessage: "Role saved" }) });
            setEditing(null);
          } catch (e) {
            setError(e instanceof Error ? e.message : t({ id: "rolesView.saveFailed", defaultMessage: "Couldn't save the role." }));
          }
        }}
      />
    );
  }

  return (
    <div className="flex flex-col items-center gap-6">
      <p className="text-sm text-muted-foreground">
        <FormattedMessage
          id="rolesView.intro"
          defaultMessage="Roles bundle permissions at a rank. Lower position = higher authority; the owner is position 0 and unmintable."
        />
      </p>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}
            {evenOut && (
              <>
                <span className="mt-2 block">
                  <FormattedMessage
                    id="rolesView.evenOutOffer"
                    defaultMessage="Give every role its own position and this move works. It rewrites the position of roles you did not drag; nothing else about them changes."
                  />
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  disabled={busy}
                  onClick={() => void applyEvenOut()}
                >
                  {busy ? (
                    <>
                      <Loader2 className="size-4 mr-2 animate-spin" />{" "}
                      <FormattedMessage id="rolesView.evening" defaultMessage="Evening out..." />
                    </>
                  ) : (
                    <FormattedMessage id="rolesView.evenOut" defaultMessage="Even out positions and move" />
                  )}
                </Button>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      <div ref={listRef} className="w-full space-y-1 rounded-lg bg-secondary/40 p-1">
        {roles.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            <FormattedMessage id="rolesView.empty" defaultMessage="No roles yet." />
          </div>
        ) : (
          roles.map((r, i) => {
            const movable = mayTouch(r.position) && !busy;
            const tint = colorToHex(r.color);
            const scopedTo = r.scope.kind === "channel" ? liveChannel(r.scope.channelId) : undefined;
            return (
              <div
                key={r.roleId}
                className={cn(
                  "flex items-center gap-2 rounded-md px-1 transition-colors hover:bg-secondary/70",
                  dragFrom === i && "opacity-50",
                  dragFrom !== null && dragOver === i && dragOver !== dragFrom && "ring-1 ring-primary",
                )}
              >
                <button
                  type="button"
                  aria-label={intl.formatMessage({ id: "rolesView.reorder", defaultMessage: "Reorder {name}" }, { name: r.name })}
                  disabled={!movable}
                  onPointerDown={startDrag(i)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  className={cn(
                    "shrink-0 touch-none rounded p-1 touch:p-2 text-muted-foreground",
                    movable ? "cursor-grab active:cursor-grabbing" : "opacity-30",
                  )}
                >
                  <GripVertical className="size-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setEvenOut(null);
                    setEditing(r);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left"
                >
                  <Shield className="size-4 shrink-0" style={tint ? { color: tint } : undefined} />
                  <span className="flex-1 truncate text-sm font-medium" style={tint ? { color: tint } : undefined}>
                    {r.name}
                  </span>
                  {scopedTo && (
                    <span
                      className="inline-flex min-w-0 items-center gap-0.5 text-2xs text-muted-foreground"
                      title={
                        scopedTo.isPrivate
                          ? intl.formatMessage(
                              { id: "rolesView.accessRoleTitle", defaultMessage: "Access role: holders can read #{channel}" },
                              { channel: scopedTo.name },
                            )
                          : intl.formatMessage(
                              { id: "rolesView.scopedTitle", defaultMessage: "Permissions apply only in #{channel}" },
                              { channel: scopedTo.name },
                            )
                      }
                    >
                      {scopedTo.isPrivate
                        ? <Lock
                            className="size-3 shrink-0"
                            aria-label={intl.formatMessage({
                              id: "rolesView.privateAccess",
                              defaultMessage: "Private channel access",
                            })}
                          />
                        : <Hash className="size-3 shrink-0" aria-hidden />}
                      <span className="truncate max-w-24">{scopedTo.name}</span>
                    </span>
                  )}
                  <span
                    className="inline-flex shrink-0 items-center gap-0.5 text-2xs tabular-nums text-muted-foreground"
                    title={intl.formatMessage(
                      {
                        id: "rolesView.holdersTitle",
                        defaultMessage: "{count, plural, one {# member hold this role} other {# members hold this role}}",
                      },
                      { count: holderCounts.get(r.roleId) ?? 0 },
                    )}
                  >
                    <Users className="size-3" aria-hidden />
                    {holderCounts.get(r.roleId) ?? 0}
                  </span>
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* CORD-04 §2 cap; revoked roles count (no tombstone). */}
      {roles.length >= MAX_ROLES_PER_COMMUNITY && (
        <p className="text-xs text-muted-foreground">
          <FormattedMessage
            id="rolesView.limitReached"
            defaultMessage="This community has reached the limit of {max} roles. Revoked roles still count, since roles are part of the signed history and can't be deleted. To make room, rename a revoked role that nobody holds and give it new permissions."
            values={{ max: MAX_ROLES_PER_COMMUNITY }}
          />
        </p>
      )}
      {/* Wait for the fold: the cap reads 0/100 until it lands. */}
      <Button
        type="button"
        variant="secondary"
        className="w-full clip-corner-lg"
        disabled={!folded || busy || roles.length >= MAX_ROLES_PER_COMMUNITY}
        onClick={() => {
          setError(null);
          setEvenOut(null);
          const lowest = roles.reduce((m, r) => Math.max(m, r.position), 1);
          setEditing({
            roleId: newRoleId(),
            name: "New role",
            position: lowest + 1,
            permissions: 0n,
            scope: { kind: "server" },
            color: 0,
          });
        }}
      >
        <Plus className="size-4 mr-2" /> <FormattedMessage id="rolesView.createRole" defaultMessage="Create role" />
      </Button>
    </div>
  );
}

export function RoleEditor({
  role,
  channels,
  holders,
  saving,
  error,
  canRevoke,
  onSave,
  onRevoke,
  onCancel,
}: {
  role: Role;
  channels: Array<{ idHex: string; name: string; isPrivate?: boolean }>;
  holders: number;
  saving: boolean;
  error: string | null;
  canRevoke: boolean;
  onSave: (role: Role) => void;
  onRevoke: () => void;
  onCancel: () => void;
}) {
  const intl = useIntl();
  const [name, setName] = useState(role.name);
  const [perms, setPerms] = useState<bigint>(role.permissions);
  const [display, setDisplay] = useState(Boolean(role.display));
  const [color, setColor] = useState<number>(role.color);
  // `0` is "theme default" on the wire, so black can't be distinguished; remember to explain.
  const [choseBlack, setChoseBlack] = useState(false);
  const [scopeValue, setScopeValue] = useState(role.scope.kind === "channel" ? role.scope.channelId : "server");

  const toggle = (bit: bigint, on: boolean) => {
    setPerms((p) => (on ? p | bit : p & ~bit));
  };

  // A deleted-channel scope keeps its id so saves don't silently rescope.
  const savedScopeId = role.scope.kind === "channel" ? role.scope.channelId : undefined;
  const deletedScope = savedScopeId && !channels.some((c) => c.idHex === savedScopeId) ? savedScopeId : undefined;
  const onDeletedScope = deletedScope !== undefined && scopeValue === deletedScope;

  const selectedChannel = scopeValue === "server" ? undefined : channels.find((c) => c.idHex === scopeValue);
  const savedChannel = savedScopeId ? channels.find((c) => c.idHex === savedScopeId) : undefined;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const scope: RoleScope = scopeValue === "server" ? { kind: "server" } : { kind: "channel", channelId: scopeValue };
        const rescoped = role.scope.kind === "channel" && (scope.kind !== "channel" || scope.channelId !== role.scope.channelId);
        // Scope is a private channel's access list (CORD-04 §2); saving doesn't move
        // keys, so warn before publishing.
        if (rescoped && savedChannel?.isPrivate) {
          const ok = confirm(
            t(
              {
                id: "rolesView.confirmRescope",
                defaultMessage:
                  "Move this role off #{channel}?\n\nIt is part of #{channel}'s access list. Holders will no longer count as members of the channel, but they keep the key they already have. Rotate the channel's key (community settings, channel access) to cut them off from what's said next.",
              },
              { channel: savedChannel.name },
            ),
          );
          if (!ok) return;
        }
        const gainsPrivate = scope.kind === "channel" && selectedChannel?.isPrivate &&
          !(role.scope.kind === "channel" && role.scope.channelId === scope.channelId);
        if (gainsPrivate && holders > 0) {
          const ok = confirm(
            t(
              {
                id: "rolesView.confirmGainsAccess",
                defaultMessage:
                  "Make this an access role for #{channel}?\n\n{count, plural, one {Its holder} other {Its # holders}} may read #{channel} from now on, but a save does NOT send them the channel key. Re-grant the role from the member list (or the channel's Add members) to deliver it.",
              },
              { channel: selectedChannel.name, count: holders },
            ),
          );
          if (!ok) return;
        }
        onSave({ ...role, name: name.trim() || "Role", permissions: perms, color, scope, display: display || undefined });
      }}
      className="flex flex-col gap-5"
    >
      <div className="space-y-1.5">
        <Label htmlFor="role2-name">
          <FormattedMessage id="rolesView.roleName" defaultMessage="Role name" />
        </Label>
        <Input id="role2-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" />
      </div>

      <div className="space-y-1.5">
        <Label>
          <FormattedMessage id="rolesView.colour" defaultMessage="Colour" />
        </Label>
        <div className="flex items-center gap-3">
          <ColorPicker
            value={colorToHex(color) ?? DEFAULT_SWATCH}
            onChange={(hex) => {
              setChoseBlack(/^#?0{6}$/.test(hex.trim()));
              setColor(hexToColor(hex));
            }}
            disabled={saving}
          />
          <span className="flex-1 text-xs text-muted-foreground">
            {colorToHex(color) ? (
              <FormattedMessage id="rolesView.colourTint" defaultMessage="Tints the role badge and name." />
            ) : choseBlack ? (
              <FormattedMessage
                id="rolesView.colourBlack"
                defaultMessage="Pure black is the wire value for “theme default” — pick #010101 for a near-black tint."
              />
            ) : (
              <FormattedMessage id="rolesView.colourDefault" defaultMessage="Using the theme default." />
            )}
          </span>
          {colorToHex(color) && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setColor(0)} disabled={saving}>
              <FormattedMessage id="rolesView.reset" defaultMessage="Reset" />
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="role2-scope">
          <FormattedMessage id="rolesView.scope" defaultMessage="Scope" />
        </Label>
        <Select value={scopeValue} onValueChange={setScopeValue}>
          <SelectTrigger id="role2-scope">
            <SelectValue>{onDeletedScope ? <span className="text-muted-foreground">
                  <FormattedMessage id="rolesView.deletedChannel" defaultMessage="A deleted channel" />
                </span> : undefined}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="server">
              <FormattedMessage id="rolesView.entireCommunity" defaultMessage="Entire community" />
            </SelectItem>
            {channels.map((c) => (
              <SelectItem key={c.idHex} value={c.idHex}>
                <span className="inline-flex items-center gap-1">
                  {c.isPrivate
                    ? <Lock
                        className="size-3.5 text-muted-foreground"
                        aria-label={intl.formatMessage({ id: "rolesView.privateChannel", defaultMessage: "Private channel" })}
                      />
                    : <Hash className="size-3.5 text-muted-foreground" aria-hidden />}
                  {c.name}
                  {c.isPrivate && <span className="text-xs text-muted-foreground">
                      <FormattedMessage id="rolesView.grantsAccess" defaultMessage="· grants access" />
                    </span>}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {onDeletedScope ? (
            <FormattedMessage
              id="rolesView.scopeDeleted"
              defaultMessage="The channel this role was scoped to has been deleted. Saving keeps the role as it is; pick a scope above to move it."
            />
          ) : selectedChannel?.isPrivate ? (
            <FormattedMessage
              id="rolesView.scopePrivate"
              defaultMessage="Holders of this role can read <b>#{channel}</b>. Scoping a role to a private channel is how it grants access: granting the role sends the channel key, revoking it rotates the key away."
              values={{ channel: selectedChannel.name, b: (chunks) => <span className="font-medium">{chunks}</span> }}
            />
          ) : selectedChannel ? (
            <FormattedMessage
              id="rolesView.scopeChannel"
              defaultMessage="Scoping names the channel this role is about. It does not confine the permission bits below."
            />
          ) : (
            <FormattedMessage id="rolesView.scopeServer" defaultMessage="Permissions apply across the whole community." />
          )}
        </p>
      </div>

      <label htmlFor="role2-display" className="flex items-start gap-3 cursor-pointer">
        <Checkbox id="role2-display" checked={display} onCheckedChange={(c) => setDisplay(c === true)} className="mt-0.5" />
        <span className="min-w-0">
          <span className="block text-sm font-medium">
            <FormattedMessage id="rolesView.display" defaultMessage="Display on member list" />
          </span>
          <span className="block text-xs text-muted-foreground">
            <FormattedMessage
              id="rolesView.displayHint"
              defaultMessage="Group holders under this role's own name in the member panel."
            />
          </span>
        </span>
      </label>

      <div className="space-y-2">
        <Label>
          <FormattedMessage id="rolesView.permissions" defaultMessage="Permissions" />
        </Label>
        {selectedChannel && (
          // CORD-04 defines Role `scope` but never applies it (§3/§5), so bits are
          // community-wide; staff bits also mail the `control_root`.
          <p className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
            <FormattedMessage
              id="rolesView.scopeBitsWarning"
              defaultMessage="These bits are <b>community-wide</b>, not limited to #{channel}. The protocol has no channel-limited permissions. Ticking one of Manage roles, Manage channels, Manage community, Ban, Create invites or Pin messages also makes the holder staff and sends them the community's control key. For access alone, leave every box unchecked."
              values={{ channel: selectedChannel.name, b: (chunks) => <span className="font-medium">{chunks}</span> }}
            />
          </p>
        )}
        <div className="space-y-2 rounded-lg bg-secondary/40 p-3">
          {PERMISSION_LABELS.filter((l) => !l.rankedRoles).map(({ bit, label, hint }) => {
            const id = `perm2-${bit.toString()}`;
            const on = (perms & bit) === bit;
            return (
              <label key={id} htmlFor={id} className="flex items-start gap-3 cursor-pointer">
                <Checkbox id={id} checked={on} onCheckedChange={(c) => toggle(bit, c === true)} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{labelText(intl, label)}</span>
                  <span className="block text-xs text-muted-foreground">{labelText(intl, hint)}</span>
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex gap-2">
        {canRevoke && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={intl.formatMessage({ id: "rolesView.revokeRole", defaultMessage: "Revoke role" })}
            title={intl.formatMessage({
              id: "rolesView.revokeTitle",
              defaultMessage: "Revoke from every member (Concord cannot delete a role)",
            })}
            className="text-destructive hover:text-destructive"
            onClick={onRevoke}
            disabled={saving}
          >
            <ShieldOff className="size-4" />
          </Button>
        )}
        <Button type="button" variant="ghost" className="flex-1" onClick={onCancel} disabled={saving}>
          <FormattedMessage {...common.cancel} />
        </Button>
        <Button type="submit" className={cn("flex-1 clip-corner-lg")} disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="size-4 mr-2 animate-spin" />{" "}
              <FormattedMessage id="rolesView.saving" defaultMessage="Saving..." />
            </>
          ) : (
            <FormattedMessage id="rolesView.saveRole" defaultMessage="Save role" />
          )}
        </Button>
      </div>
    </form>
  );
}
