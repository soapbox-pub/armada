import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useToast } from "@/hooks/useToast";
import { communityApiBase, communityApiEnabled } from "@/lib/platform";

import type { NostrSigner } from "@nostrify/nostrify";

/**
 * Client for zooid's tenant-management REST API. A whitelisted operator can
 * CRUD whole communities (virtual relays); each community is one config the
 * relay hot-loads. Requests are NIP-98-authed (kind-27235 event with
 * `u`+`method` tags) to `<apiBase>/relay/{id}`, where `apiBase` is either a
 * dedicated host or the community origin + a path prefix (see platform.ts).
 *
 * A community is keyed by `{id}` (the config basename). On create, the body is
 * the community Config; zooid validates host/schema/secret/info.pubkey and
 * rejects duplicate host/schema.
 */

/** The subset of zooid's community Config the UI lets an operator set. */
export interface CommunityConfigInput {
  /** HTTP Host that routes to this community (the inbound Host header). */
  host: string;
  /** SQLite schema/table prefix; lowercase identifier `^[a-z_][a-z0-9_]*$`. */
  schema: string;
  /** 64-hex nostr secret key — the community relay's identity. */
  secret: string;
  info: {
    name?: string;
    icon?: string;
    description?: string;
    /** 64-hex pubkey of the community owner. */
    pubkey: string;
  };
  policy?: { public_join?: boolean; strip_signatures?: boolean };
  groups?: { enabled?: boolean };
  management?: { enabled?: boolean };
  push?: { enabled?: boolean };
  livekit?: { server_url?: string; api_key?: string; api_secret?: string };
}

/** Whether the tenant-management API is configured for this build. */
export function communityAdminEnabled(): boolean {
  return communityApiEnabled();
}

async function nip98Auth(signer: NostrSigner, url: string, method: string): Promise<string> {
  const event = await signer.signEvent({
    kind: 27235,
    content: "",
    tags: [
      ["u", url],
      ["method", method],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

async function adminFetch(
  signer: NostrSigner,
  apiBase: string | undefined,
  id: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<unknown> {
  if (!apiBase) throw new Error("Community management API is not configured.");
  const url = `${apiBase}/relay/${encodeURIComponent(id)}`;
  const auth = await nip98Auth(signer, url, method);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  if (!res.ok) {
    const msg = (json as { error?: string } | undefined)?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

/**
 * Tenant-management mutations. `relayUrl` selects which community origin hosts
 * the API (for the path-mounted single-origin deploy); omit it when using a
 * dedicated `VITE_RELAY_API_BASE`.
 */
export function useCommunityAdmin(relayUrl?: string) {
  const { user } = useCurrentUser();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const apiBase = communityApiBase(relayUrl);

  function call(id: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown) {
    if (!user) throw new Error("You must be signed in.");
    return adminFetch(user.signer, apiBase, id, method, body);
  }

  const createCommunity = useMutation({
    mutationFn: ({ id, config }: { id: string; config: CommunityConfigInput }) => call(id, "POST", config),
    onSuccess: (_data, { config }) => {
      toast({ title: "Community created", description: config.host });
      queryClient.invalidateQueries({ queryKey: ["community-admin"] });
    },
    onError: (err: Error) => toast({ title: "Couldn't create community", description: err.message, variant: "destructive" }),
  });

  const updateCommunity = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<CommunityConfigInput> }) => call(id, "PATCH", patch),
    onSuccess: () => {
      toast({ title: "Community updated" });
      queryClient.invalidateQueries({ queryKey: ["community-admin"] });
    },
    onError: (err: Error) => toast({ title: "Couldn't update community", description: err.message, variant: "destructive" }),
  });

  const deleteCommunity = useMutation({
    mutationFn: (id: string) => call(id, "DELETE"),
    onSuccess: () => {
      toast({ title: "Community deleted" });
      queryClient.invalidateQueries({ queryKey: ["community-admin"] });
    },
    onError: (err: Error) => toast({ title: "Couldn't delete community", description: err.message, variant: "destructive" }),
  });

  return { enabled: communityAdminEnabled(), createCommunity, updateCommunity, deleteCommunity };
}

/** List a community's relay-level member pubkeys via `GET /relay/{id}/members`. */
export function useCommunityMembers(id: string | undefined, relayUrl?: string) {
  const { user } = useCurrentUser();
  const apiBase = communityApiBase(relayUrl);
  return useQuery<string[]>({
    queryKey: ["community-admin", "members", apiBase, id],
    queryFn: async () => {
      if (!user || !id || !apiBase) return [];
      const url = `${apiBase}/relay/${encodeURIComponent(id)}/members`;
      const auth = await nip98Auth(user.signer, url, "GET");
      const res = await fetch(url, { headers: { Authorization: auth } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { members?: string[] };
      return json.members ?? [];
    },
    enabled: Boolean(user && id && apiBase),
    staleTime: 30_000,
  });
}
