import { useCallback, useEffect, useRef, useState } from "react";

/** What a role toggle publishes: the member's complete new role set. */
export type PublishRoles<R = unknown> = (args: { member: string; roleIds: string[] }) => Promise<R>;

const keyOf = (member: string, roleId: string) => `${member}:${roleId}`;

/**
 * Sequencing for per-member role toggles. A Grant replaces a member's WHOLE role
 * list (CORD-04 §2) and the fold lags its own publish, so each toggle composes on
 * the last set THIS client asked for. The overlay drops once the fold agrees, so
 * changes made elsewhere take over. Repeat toggles in flight are ignored (they'd
 * double-publish and, for gated channels, start two rotations).
 */
export function useRoleIntent<R = unknown>(
  memberRoleIds: Record<string, string[] | undefined>,
  publish: PublishRoles<R>,
) {
  // A ref because intent is read and written in one synchronous toggle; mirrored
  // into state only for the UI's pending flags.
  const intent = useRef(new Map<string, string[]>());
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const syncPending = useCallback(() => setPending(new Set(inFlight.current)), []);

  // Checked on every fold change, not lazily: the agreement can come and go
  // (fold catches up, then someone else edits), and a lazy check would mask it.
  useEffect(() => {
    for (const [member, local] of intent.current) {
      const folded = memberRoleIds[member] ?? [];
      if (local.length === folded.length && local.every((id) => folded.includes(id))) {
        intent.current.delete(member);
      }
    }
  }, [memberRoleIds]);

  const baseFor = useCallback(
    (member: string): string[] => intent.current.get(member) ?? memberRoleIds[member] ?? [],
    [memberRoleIds],
  );

  const toggle = useCallback(
    /**
     * Resolves to the set published and what `publish` returned, or undefined for a repeat in flight.
     * `via` publishes this one toggle in `publish`'s place.
     */
    async (member: string, roleId: string, on: boolean, via: PublishRoles<R> = publish): Promise<{ roleIds: string[]; published: R } | undefined> => {
      const k = keyOf(member, roleId);
      if (inFlight.current.has(k)) return undefined;

      const base = baseFor(member);
      const next = new Set(base);
      if (on) next.add(roleId);
      else next.delete(roleId);
      const roleIds = [...next];

      // Fallback on failure. Deleting the overlay would drop an earlier toggle that
      // landed and let the next toggle silently revoke that role.
      const hadIntent = intent.current.has(member);

      intent.current.set(member, roleIds);
      inFlight.current.add(k);
      syncPending();
      try {
        const published = await via({ member, roleIds });
        return { roleIds, published };
      } catch (e) {
        // Roll back to the set that was true before this toggle, not the lagging fold.
        if (hadIntent) intent.current.set(member, base);
        else intent.current.delete(member);
        throw e;
      } finally {
        inFlight.current.delete(k);
        syncPending();
      }
    },
    [baseFor, publish, syncPending],
  );

  const isPending = useCallback((member: string, roleId: string) => pending.has(keyOf(member, roleId)), [pending]);

  /** The set a row should render as checked: local intent, else the fold. */
  const rolesFor = useCallback((member: string) => intent.current.get(member) ?? memberRoleIds[member] ?? [], [memberRoleIds]);

  return { toggle, isPending, rolesFor };
}
