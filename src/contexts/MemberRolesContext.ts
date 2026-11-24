import { createContext } from "react";

/**
 * A member's roles in the CURRENT community, via context so {@link ProfilePreviewCard}
 * can show them from any call site. Display data only.
 */
export interface MemberRole {
  id: string;
  name: string;
  /** Cosmetic badge tint (low 24 bits an #rrggbb); 0 = theme default. */
  color: number;
}

/** The member list's staff tiers, shown beside a name. */
export type StaffTier = "owner" | "admin" | "moderator";

export interface MemberRolesValue {
  /** This member's roles, highest authority first. Empty when they hold none. */
  rolesOf: (pubkey: string) => MemberRole[];
  /** This member's staff tier, or undefined for a regular member. */
  staffTierOf: (pubkey: string) => StaffTier | undefined;
  /** The Role behind a non-owner staff tier, whose name the pill shows. */
  staffRoleOf: (pubkey: string) => MemberRole | undefined;
}

export const MemberRolesContext = createContext<MemberRolesValue | undefined>(undefined);
