import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { useToast } from "@/hooks/useToast";
import { relayToHttpUrl } from "@/lib/platform";
import { nip86Request } from "@/lib/nip86";
import {
  KIND_RELAY_MEMBERS,
  KIND_RELAY_ROLE,
  parseCommunityMemberRoles,
  parseCommunityRole,
  type CommunityRole,
} from "@/lib/nip29";

export interface CommunityRolesData {
  /** The community's dynamic role catalog (kind 33534), sorted by order then label. */
  roles: CommunityRole[];
  /** pubkey (hex) → assigned role ids, from the kind-13534 members list. */
  assignments: Map<string, string[]>;
}

export interface CreateRoleInput {
  id: string;
  label?: string;
  description?: string;
  color?: number;
  order?: number;
}

/**
 * Read and manage a community's zooid dynamic member roles.
 *
 * Reads the role catalog (kind 33534) and per-member assignments (kind 13534)
 * from the community relay; mutations go over NIP-86 RPC to the relay's HTTP
 * origin (only community admins are authorized — the relay enforces it).
 */
export function useCommunityRoles(relayUrl: string | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: relayInfo, isLoading: infoLoading } = useRelayInfo(relayUrl);

  const relaySelf = relayInfo?.self || relayInfo?.pubkey;
  const httpUrl = relayUrl ? relayToHttpUrl(relayUrl) : undefined;
  const queryKey = ["community-roles", relayUrl, relaySelf ?? "any"] as const;

  const query = useQuery<CommunityRolesData>({
    queryKey,
    queryFn: async ({ signal }) => {
      const events = await nostr.relay(relayUrl!).query(
        [{
          kinds: [KIND_RELAY_ROLE, KIND_RELAY_MEMBERS],
          ...(relaySelf ? { authors: [relaySelf] } : {}),
        }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );

      // Newest role definition per id; newest members list overall.
      const roleEvents = new Map<string, typeof events[number]>();
      let membersEvent: typeof events[number] | undefined;
      for (const event of events) {
        if (event.kind === KIND_RELAY_ROLE) {
          const d = event.tags.find(([n]) => n === "d")?.[1];
          if (!d) continue;
          const existing = roleEvents.get(d);
          if (!existing || existing.created_at < event.created_at) roleEvents.set(d, event);
        } else if (event.kind === KIND_RELAY_MEMBERS) {
          if (!membersEvent || membersEvent.created_at < event.created_at) membersEvent = event;
        }
      }

      const roles = [...roleEvents.values()]
        .map(parseCommunityRole)
        .filter((r): r is CommunityRole => Boolean(r))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.label ?? a.id).localeCompare(b.label ?? b.id));

      return {
        roles,
        assignments: membersEvent ? parseCommunityMemberRoles(membersEvent) : new Map(),
      };
    },
    enabled: Boolean(relayUrl) && !infoLoading,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  function rpc(method: string, params: Array<string | number>) {
    if (!user) throw new Error("You must be signed in.");
    if (!httpUrl) throw new Error("No relay selected.");
    return nip86Request(user.signer, httpUrl, method, params);
  }

  const refetch = () => queryClient.invalidateQueries({ queryKey });

  const createRole = useMutation({
    mutationFn: (input: CreateRoleInput) =>
      rpc("createrole", [input.id, input.label ?? "", input.description ?? "", input.color ?? 0, input.order ?? 0]),
    onSuccess: refetch,
    onError: (err: Error) => toast({ title: "Couldn't create role", description: err.message, variant: "destructive" }),
  });

  const editRole = useMutation({
    mutationFn: (input: CreateRoleInput) =>
      rpc("editrole", [input.id, input.label ?? "", input.description ?? "", input.color ?? 0, input.order ?? 0]),
    onSuccess: refetch,
    onError: (err: Error) => toast({ title: "Couldn't update role", description: err.message, variant: "destructive" }),
  });

  const deleteRole = useMutation({
    mutationFn: (id: string) => rpc("deleterole", [id]),
    onSuccess: refetch,
    onError: (err: Error) => toast({ title: "Couldn't delete role", description: err.message, variant: "destructive" }),
  });

  const assignRole = useMutation({
    mutationFn: ({ pubkey, roleId }: { pubkey: string; roleId: string }) => rpc("assignrole", [pubkey, roleId]),
    onSuccess: refetch,
    onError: (err: Error) => toast({ title: "Couldn't assign role", description: err.message, variant: "destructive" }),
  });

  const unassignRole = useMutation({
    mutationFn: ({ pubkey, roleId }: { pubkey: string; roleId: string }) => rpc("unassignrole", [pubkey, roleId]),
    onSuccess: refetch,
    onError: (err: Error) => toast({ title: "Couldn't remove role", description: err.message, variant: "destructive" }),
  });

  return { ...query, createRole, editRole, deleteRole, assignRole, unassignRole };
}
