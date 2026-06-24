import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCommunityRoles, type CreateRoleInput } from "@/hooks/useCommunityRoles";
import type { CommunityRole } from "@/lib/nip29";

interface CommunityRolesDialogProps {
  relayUrl: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** Map a zooid hue int (0–255) to a preview swatch. */
function hueColor(hue?: number): string | undefined {
  if (hue === undefined || hue === 0) return undefined;
  return `hsl(${Math.round((hue / 255) * 360)} 70% 55%)`;
}

/**
 * Manage a community's dynamic member roles (zooid kind-33534 roles, set over
 * NIP-86). These are cosmetic labels — create/rename/recolor/delete them here,
 * then assign them to members from the member list. Only community admins can
 * mutate; the relay rejects unauthorized callers.
 */
export function CommunityRolesDialog({ relayUrl, open, onOpenChange }: CommunityRolesDialogProps) {
  const { data, isLoading, createRole, editRole, deleteRole } = useCommunityRoles(relayUrl);
  const roles = data?.roles ?? [];

  const [editing, setEditing] = useState<CommunityRole | null>(null);
  const [creating, setCreating] = useState(false);

  // Form state
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("0");
  const [order, setOrder] = useState("0");

  useEffect(() => {
    if (!open) {
      setEditing(null);
      setCreating(false);
    }
  }, [open]);

  function startCreate() {
    setEditing(null);
    setCreating(true);
    setId("");
    setLabel("");
    setDescription("");
    setColor("0");
    setOrder("0");
  }

  function startEdit(role: CommunityRole) {
    setCreating(false);
    setEditing(role);
    setId(role.id);
    setLabel(role.label ?? "");
    setDescription(role.description ?? "");
    setColor(String(role.color ?? 0));
    setOrder(String(role.order ?? 0));
  }

  const formOpen = creating || editing !== null;
  const idValid = SLUG.test(id);
  const busy = createRole.isPending || editRole.isPending;

  async function submit() {
    const input: CreateRoleInput = {
      id,
      label: label.trim() || undefined,
      description: description.trim() || undefined,
      color: Number(color) || 0,
      order: Number(order) || 0,
    };
    try {
      if (editing) await editRole.mutateAsync(input);
      else await createRole.mutateAsync(input);
      setCreating(false);
      setEditing(null);
    } catch {
      /* toast handled in hook */
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Community roles</DialogTitle>
          <DialogDescription>
            Cosmetic roles you can assign to members of this community. Real moderation
            privileges are configured in the community's server config.
          </DialogDescription>
        </DialogHeader>

        {formOpen ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="role-id">Role id</Label>
              <Input
                id="role-id"
                value={id}
                disabled={Boolean(editing)}
                placeholder="vip"
                onChange={(e) => setId(e.target.value.toLowerCase())}
              />
              {!editing && id && !idValid && (
                <p className="text-xs text-destructive">Use lowercase letters, numbers, and hyphens.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role-label">Label</Label>
              <Input id="role-label" value={label} placeholder="VIP" onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role-desc">Description</Label>
              <Input id="role-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="flex gap-3">
              <div className="space-y-1.5 flex-1">
                <Label htmlFor="role-color">Color (0–255)</Label>
                <Input id="role-color" type="number" min={0} max={255} value={color} onChange={(e) => setColor(e.target.value)} />
              </div>
              <div className="space-y-1.5 flex-1">
                <Label htmlFor="role-order">Order</Label>
                <Input id="role-order" type="number" value={order} onChange={(e) => setOrder(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => { setCreating(false); setEditing(null); }}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={busy || (!editing && !idValid)}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {editing ? "Save" : "Create role"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-2">
            {isLoading ? (
              <p className="text-sm text-muted-foreground py-4 text-center">Loading roles…</p>
            ) : roles.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No roles yet.</p>
            ) : (
              <ul className="space-y-1">
                {roles.map((role) => (
                  <li key={role.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50">
                    <span
                      className="size-3 rounded-full shrink-0 border"
                      style={{ backgroundColor: hueColor(role.color) ?? "transparent" }}
                    />
                    <span className="flex-1 min-w-0 truncate text-sm">
                      {role.label || role.id}
                      <span className="text-muted-foreground"> · {role.id}</span>
                    </span>
                    <Button variant="ghost" size="icon" className="size-7" aria-label={`Edit ${role.id}`} onClick={() => startEdit(role)}>
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-destructive"
                      aria-label={`Delete ${role.id}`}
                      disabled={deleteRole.isPending}
                      onClick={() => deleteRole.mutate(role.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <Button variant="outline" className="w-full gap-2" onClick={startCreate}>
              <Plus className="size-4" />
              New role
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
