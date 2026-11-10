import { GripVertical, Layers, Loader2, Plus, Shield, Trash2, Users } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ColorPicker } from "@/components/ui/color-picker";
import { ChromeDialogContent, ChromeDialogFooter, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRankedRoles } from "@/concord/hooks/useRankedRoles";
import type { FoldedControl } from "@/concord/lib/control";
import { rankedOrder, roleAuthor, type RoleAuthor, type RoleFields } from "@/concord/lib/rankedWrites";
import { BENEATH_EVERY_ROLE, colorToHex, hexToColor, MAX_ROLES_PER_COMMUNITY, PERMISSION_LABELS, type Role } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

const DEFAULT_SWATCH = "#5865f2";

type Editing = { kind: "new" } | { kind: "role"; role: Role } | { kind: "everyone" };

function authorOf(folded: FoldedControl | undefined, me: string | undefined): RoleAuthor | undefined {
  if (!folded || !me) return undefined;
  try {
    return roleAuthor(folded, me);
  } catch {
    return undefined;
  }
}

/**
 * The vsk-13 Roster's editor (CORD-04 §2, §3), as Vector's: Roles in rank order,
 * dragged to reorder, each edited or deleted in place, and what `@everyone` holds.
 * Every bit a Role or `@everyone` can carry is offered; one the editor can't
 * give is shown disabled.
 */
export function RankedRolesBody({ community }: { community: Community }) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const { folded, createRole, editRole, reorderRoles, deleteRole, setEveryone, isSaving } = useRankedRoles(community);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const roles = useMemo(() => (folded ? rankedOrder(folded) : []), [folded]);
  const author = useMemo(() => authorOf(folded, user?.pubkey), [folded, user?.pubkey]);
  const holderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of folded?.roster.grants ?? []) for (const id of g.roleIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  }, [folded]);

  const fail = (e: unknown, fallback: string) => setError(e instanceof Error ? e.message : fallback);

  // Pointer events, not HTML5 DnD (which never fires on touch).
  const rowIndexAt = (clientY: number): number | null => {
    const rows = listRef.current?.querySelectorAll("[data-role-row]");
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
    // Only among the Roles beneath the editor (Vector `RolesSection` targets).
    if (over !== null && author?.outranks(roles[over].position)) setDragOver(over);
  };
  const endDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const from = dragFrom;
    const to = dragOver;
    setDragFrom(null);
    setDragOver(null);
    if (from === null || to === null || from === to) return;
    setError(null);
    const next = roles.map((r) => r.roleId);
    const [picked] = next.splice(from, 1);
    next.splice(to, 0, picked);
    reorderRoles({ ordered: next }).catch((err: unknown) =>
      fail(err, t({ id: "rankedRolesView.moveFailed", defaultMessage: "Couldn't move the role." })),
    );
  };

  if (editing) {
    const role = editing.kind === "role" ? editing.role : undefined;
    const bottom = roles.reduce((m, r) => Math.max(m, r.position), 0) + 1;
    const reach = editing.kind === "everyone" ? BENEATH_EVERY_ROLE : role ? role.position : bottom;
    return (
      <RankedRoleEditor
        key={role?.roleId ?? editing.kind}
        everyone={editing.kind === "everyone"}
        initial={
          editing.kind === "everyone"
            ? { name: "@everyone", color: 0, permissions: folded?.roster.everyone ?? 0n, display: false, mentionable: false }
            : role
              ? { name: role.name, color: role.color, permissions: role.permissions, display: role.display === true, mentionable: role.mentionable === true }
              : { name: intl.formatMessage({ id: "rankedRolesView.newRoleName", defaultMessage: "New role" }), color: 0, permissions: 0n, display: false, mentionable: false }
        }
        holders={role ? (holderCounts.get(role.roleId) ?? 0) : 0}
        mayGive={(bit) => author?.supports(reach, bit) ?? false}
        canDelete={Boolean(role && author?.outranks(role.position) && author.supports(role.position, 0n))}
        saving={isSaving}
        error={error}
        onCancel={() => {
          setEditing(null);
          setError(null);
        }}
        onDelete={async () => {
          if (!role) return;
          setError(null);
          try {
            await deleteRole({ roleId: role.roleId });
            toast({ title: t({ id: "rankedRolesView.deleted", defaultMessage: "Role deleted" }) });
            setEditing(null);
          } catch (e) {
            fail(e, t({ id: "rankedRolesView.deleteFailed", defaultMessage: "Couldn't delete the role." }));
          }
        }}
        onSave={async (fields) => {
          setError(null);
          try {
            if (editing.kind === "everyone") await setEveryone({ permissions: fields.permissions });
            else if (role) await editRole({ roleId: role.roleId, fields });
            else await createRole(fields);
            toast({ title: t({ id: "rolesView.roleSaved", defaultMessage: "Role saved" }) });
            setEditing(null);
          } catch (e) {
            fail(e, t({ id: "rolesView.saveFailed", defaultMessage: "Couldn't save the role." }));
          }
        }}
      />
    );
  }

  return (
    <div className="flex flex-col items-center gap-6">
      <p className="text-sm text-muted-foreground">
        <FormattedMessage
          id="rankedRolesView.intro"
          defaultMessage="Roles bundle permissions at a rank: a role higher in the list outranks those beneath it. Drag to reorder."
        />
      </p>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div ref={listRef} className="w-full space-y-1 rounded-lg bg-secondary/40 p-1">
        {roles.map((r, i) => {
          const movable = Boolean(author?.outranks(r.position)) && !isSaving;
          const tint = colorToHex(r.color);
          return (
            <div
              key={r.roleId}
              data-role-row
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
                className={cn("flex size-6 touch:size-11 shrink-0 touch-none items-center justify-center rounded text-muted-foreground", movable ? "cursor-grab active:cursor-grabbing" : "opacity-30")}
              >
                <GripVertical className="size-4" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setEditing({ kind: "role", role: r });
                }}
                className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left"
              >
                <Shield className="size-4 shrink-0" style={tint ? { color: tint } : undefined} />
                <span className="flex-1 truncate text-sm font-medium" style={tint ? { color: tint } : undefined}>
                  {r.name}
                </span>
                <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs tabular-nums text-muted-foreground">
                  <Users className="size-3" aria-hidden />
                  {holderCounts.get(r.roleId) ?? 0}
                </span>
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => {
            setError(null);
            setEditing({ kind: "everyone" });
          }}
          className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-secondary/70"
        >
          <Users className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate text-sm font-medium">@everyone</span>
          <span className="text-2xs text-muted-foreground">
            <FormattedMessage id="rankedRolesView.everyoneHint" defaultMessage="Every member" />
          </span>
        </button>
      </div>

      {roles.length >= MAX_ROLES_PER_COMMUNITY && (
        <p className="text-xs text-muted-foreground">
          <FormattedMessage
            id="rankedRolesView.limitReached"
            defaultMessage="This community has reached the limit of {max} roles. Delete one to make room."
            values={{ max: MAX_ROLES_PER_COMMUNITY }}
          />
        </p>
      )}
      <Button
        type="button"
        variant="secondary"
        className="w-full clip-corner-lg"
        disabled={!folded || !author || isSaving || roles.length >= MAX_ROLES_PER_COMMUNITY}
        onClick={() => {
          setError(null);
          setEditing({ kind: "new" });
        }}
      >
        <Plus className="size-4 mr-2" /> <FormattedMessage id="rolesView.createRole" defaultMessage="Create role" />
      </Button>
    </div>
  );
}

/**
 * The owner's offer to move a legacy Community to ranked roles (CORD-04 §2, Vector
 * `activate_roles_v2`): one-way, so it asks first.
 */
export function RankedRolesSwitch({ community }: { community: Community }) {
  const intl = useIntl();
  const { activate, isActivating } = useRankedRoles(community);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setError(null);
    activate({})
      .then((unfiled) => {
        setOpen(false);
        toast({
          title: t({ id: "rankedRolesView.switched", defaultMessage: "This community now uses ranked roles" }),
          ...(unfiled.length > 0
            ? {
                description: t(
                  {
                    id: "rankedRolesView.switchedUnfiled",
                    defaultMessage: "{count, plural, one {# private channel you don't hold the key to stays out of any category.} other {# private channels you don't hold the keys to stay out of any category.}}",
                  },
                  { count: unfiled.length },
                ),
              }
            : {}),
        });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : t({ id: "rankedRolesView.switchFailed", defaultMessage: "Couldn't switch to ranked roles." })));
  };

  return (
    <div className="w-full space-y-1.5">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <FormattedMessage id="rankedRolesView.switchSection" defaultMessage="Ranked roles" />
      </span>
      <div className="space-y-2.5 rounded-lg bg-secondary/40 p-3">
        <p className="text-xs text-muted-foreground">
          <FormattedMessage
            id="rankedRolesView.switchCard"
            defaultMessage="Channel permissions, categories with their own rules, and roles you can delete. Every role, grant and category, and the channel order, carry across."
          />
        </p>
        <Button type="button" size="sm" className="clip-corner-lg" onClick={() => setOpen(true)}>
          <Layers className="size-4" />
          <FormattedMessage id="rankedRolesView.switch" defaultMessage="Switch to ranked roles" />
        </Button>
      </div>

      <Dialog open={open} onOpenChange={(next) => !isActivating && setOpen(next)}>
        <ChromeDialogContent
          title={intl.formatMessage({ id: "rankedRolesView.switchTitle", defaultMessage: "Switch to ranked roles?" })}
          className="sm:max-w-sm"
          hideClose={isActivating}
        >
          <ChromeDialogHeader
            icon={Layers}
            tone="warning"
            title={intl.formatMessage({ id: "rankedRolesView.switchHeading", defaultMessage: "switch to ranked roles?" })}
            description={intl.formatMessage({
              id: "rankedRolesView.switchOfferCarry",
              defaultMessage: "Ranked roles add channel permissions, categories with their own rules, and roles you can delete. Every role, grant and category, and the channel order, carry across.",
            })}
          />
          <p className="mt-5 clip-corner-lg bg-warning/10 px-3 py-2 text-xs text-warning">
            <FormattedMessage
              id="rankedRolesView.switchConfirmOlder"
              defaultMessage="This can't be undone. Members on an older Armada will see this community's roles, channels and categories wrongly until they update."
            />
          </p>
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          <ChromeDialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={isActivating}>
              <FormattedMessage {...common.cancel} />
            </Button>
            <Button type="button" onClick={run} disabled={isActivating}>
              {isActivating ? <Loader2 className="size-4 animate-spin" /> : <Layers className="size-4" />}
              <FormattedMessage id="rankedRolesView.switchNow" defaultMessage="Switch now" />
            </Button>
          </ChromeDialogFooter>
        </ChromeDialogContent>
      </Dialog>
    </div>
  );
}

function RankedRoleEditor({
  everyone,
  initial,
  holders,
  mayGive,
  canDelete,
  saving,
  error,
  onSave,
  onDelete,
  onCancel,
}: {
  everyone: boolean;
  initial: RoleFields;
  holders: number;
  mayGive: (bit: bigint) => boolean;
  canDelete: boolean;
  saving: boolean;
  error: string | null;
  onSave: (fields: RoleFields) => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const intl = useIntl();
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState(initial.color);
  const [perms, setPerms] = useState(initial.permissions);
  const [display, setDisplay] = useState(initial.display);
  const [mentionable, setMentionable] = useState(initial.mentionable);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ name, color, permissions: perms, display, mentionable });
      }}
      className="flex flex-col gap-5"
    >
      {everyone ? (
        <p className="text-sm text-muted-foreground">
          <FormattedMessage id="rankedRolesView.everyoneIntro" defaultMessage="What every member holds, beneath every role." />
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="ranked-role-name">
              <FormattedMessage id="rolesView.roleName" defaultMessage="Role name" />
            </Label>
            <Input id="ranked-role-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label>
              <FormattedMessage id="rolesView.colour" defaultMessage="Colour" />
            </Label>
            <div className="flex items-center gap-3">
              <ColorPicker value={colorToHex(color) ?? DEFAULT_SWATCH} onChange={(hex) => setColor(hexToColor(hex))} disabled={saving} />
              <span className="flex-1 text-xs text-muted-foreground">
                {colorToHex(color) ? (
                  <FormattedMessage id="rolesView.colourTint" defaultMessage="Tints the role badge and name." />
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
          <label htmlFor="ranked-role-display" className="flex items-start gap-3 cursor-pointer">
            <Checkbox id="ranked-role-display" checked={display} onCheckedChange={(c) => setDisplay(c === true)} className="mt-0.5" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                <FormattedMessage id="rolesView.display" defaultMessage="Display on member list" />
              </span>
              <span className="block text-xs text-muted-foreground">
                <FormattedMessage id="rolesView.displayHint" defaultMessage="Group holders under this role's own name in the member panel." />
              </span>
            </span>
          </label>
          <label htmlFor="ranked-role-mentionable" className="flex items-start gap-3 cursor-pointer">
            <Checkbox id="ranked-role-mentionable" checked={mentionable} onCheckedChange={(c) => setMentionable(c === true)} className="mt-0.5" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                <FormattedMessage id="rankedRolesView.mentionable" defaultMessage="Anyone can mention this role" />
              </span>
              <span className="block text-xs text-muted-foreground">
                <FormattedMessage id="rankedRolesView.mentionableHint" defaultMessage="Members without Mention everyone can still @mention it." />
              </span>
            </span>
          </label>
        </>
      )}

      <div className="space-y-2">
        <Label>
          <FormattedMessage id="rolesView.permissions" defaultMessage="Permissions" />
        </Label>
        <div className="space-y-2 rounded-lg bg-secondary/40 p-3">
          {PERMISSION_LABELS.map(({ bit, label, hint }) => {
            const id = `ranked-perm-${bit.toString()}`;
            const on = (perms & bit) === bit;
            // A bit already carried can always be taken away; only giving one needs it held.
            const locked = !on && !mayGive(bit);
            return (
              <label key={id} htmlFor={id} className={cn("flex items-start gap-3", locked ? "opacity-50" : "cursor-pointer")}>
                <Checkbox
                  id={id}
                  checked={on}
                  disabled={locked || saving}
                  onCheckedChange={(c) => setPerms((p) => (c === true ? p | bit : p & ~bit))}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="block text-xs text-muted-foreground">{hint}</span>
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
        {canDelete && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={intl.formatMessage({ id: "rankedRolesView.deleteRole", defaultMessage: "Delete role" })}
            title={intl.formatMessage({ id: "rankedRolesView.deleteRole", defaultMessage: "Delete role" })}
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
            disabled={saving}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
        <Button type="button" variant="ghost" className="flex-1" onClick={onCancel} disabled={saving}>
          <FormattedMessage {...common.cancel} />
        </Button>
        <Button type="submit" className="flex-1 clip-corner-lg" disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <FormattedMessage {...common.save} />}
        </Button>
      </div>

      {/* Closing mid-delete only hides the dialog; the delete finishes and toasts on its own. */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <ChromeDialogContent
          title={intl.formatMessage({ id: "rankedRolesView.deleteTitle", defaultMessage: "Delete {name}?" }, { name: initial.name })}
          className="sm:max-w-sm"
        >
          <ChromeDialogHeader
            icon={Trash2}
            tone="destructive"
            title={intl.formatMessage({ id: "rankedRolesView.deleteHeading", defaultMessage: "delete {name}?" }, { name: initial.name })}
            description={intl.formatMessage(
              {
                id: "rankedRolesView.deleteBody",
                defaultMessage: "{count, plural, =0 {Nobody holds it. Deleting a role can't be undone.} one {It's taken from the # member who holds it. Deleting a role can't be undone.} other {It's taken from the # members who hold it. Deleting a role can't be undone.}}",
              },
              { count: holders },
            )}
          />
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          <ChromeDialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmDelete(false)} disabled={saving}>
              <FormattedMessage {...common.cancel} />
            </Button>
            <Button type="button" variant="destructive" onClick={onDelete} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              <FormattedMessage id="rankedRolesView.deleteRole" defaultMessage="Delete role" />
            </Button>
          </ChromeDialogFooter>
        </ChromeDialogContent>
      </Dialog>
    </form>
  );
}
