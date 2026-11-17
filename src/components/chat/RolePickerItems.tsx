import { useMenuSheet } from "@/hooks/useMenuSheet";
import { cn } from "@/lib/utils";

import type { ComponentType, ReactNode } from "react";

export interface RolePickerOption {
  id: string;
  name: string;
  /** Low 24 bits as #rrggbb; 0 = theme default. */
  color: number;
  /** Channel-scoped hint; `null` when that channel was deleted. */
  channelName?: string | null;
  /** Viewer outranks this role's position (may grant/revoke it). */
  assignable: boolean;
}

/** Radix's DropdownMenu and ContextMenu checkbox items share these props. */
export type RoleCheckboxItem = ComponentType<{
  className?: string;
  checked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  onSelect?: (e: Event) => void;
  children?: ReactNode;
}>;

const roleTint = (color: number) => `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;

/** Role checkbox rows for any menu family, so gating and the toggle guard live once. */
export function RolePickerItems({
  CheckboxItem,
  pubkey,
  catalog,
  heldRoleIds,
  isToggling,
  onToggle,
}: {
  CheckboxItem: RoleCheckboxItem;
  pubkey: string;
  catalog: RolePickerOption[];
  heldRoleIds?: string[];
  isToggling?: (pubkey: string, roleId: string) => boolean;
  onToggle: (pubkey: string, roleId: string, on: boolean) => void;
}) {
  const inSheet = useMenuSheet() !== null;
  return (
    <>
      {catalog.map((role) => (
        <CheckboxItem
          key={role.id}
          className="py-2"
          checked={heldRoleIds?.includes(role.id) ?? false}
          // A Grant replaces the whole role list, so a second click would publish a stale set.
          disabled={!role.assignable || Boolean(isToggling?.(pubkey, role.id))}
          onCheckedChange={(on) => onToggle(pubkey, role.id, on)}
          // Keep the menu open so several roles can be toggled in one visit.
          onSelect={(e) => e.preventDefault()}
        >
          {/* A sheet row leads with a tile; the role's colour fills it. */}
          {inSheet && (
            <span
              className={cn("size-3 rounded-full bg-current", !role.color && "text-muted-foreground")}
              style={role.color ? { color: roleTint(role.color) } : undefined}
            />
          )}
          <span
            className={cn("min-w-0 flex-1 truncate", !inSheet && "text-sm")}
            style={role.color ? { color: roleTint(role.color) } : undefined}
          >
            {role.name}
          </span>
          {role.channelName && (
            <span className="ml-2 shrink-0 text-2xs text-muted-foreground truncate max-w-24"># {role.channelName}</span>
          )}
        </CheckboxItem>
      ))}
    </>
  );
}
