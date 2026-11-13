import { useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useEffect } from 'react';

import { KvPrefixCache } from '@/lib/db/kvCache';

export interface RelayInfoDocument {
  name?: string;
  description?: string;
  icon?: string;
  banner?: string;
  pubkey?: string;
  /** NIP-29: the relay's own pubkey, which signs group metadata. */
  self?: string;
  contact?: string;
  software?: string;
  version?: string;
  supported_nips?: number[];
  /** Buzz relays: custom protocol extensions (e.g. "nip-er", "nip-pl"). */
  supported_extensions?: string[];
  /**
   * NIP-AB pairing rendezvous. On `software: "newlay"` it marks Buzz compatibility mode — see
   * `isBuzzRelayInfo`.
   */
  pairing_relay_url?: string;
  auth_required?: boolean;
  payment_required?: boolean;
  limitation?: {
    auth_required?: boolean;
    payment_required?: boolean;
    restricted_writes?: boolean;
  };
  fees?: {
    admission?: { amount: number; unit: string }[];
    subscription?: { amount: number; unit: string; period?: number }[];
  };
}

function relayToHttpUrl(relayUrl: string): string | null {
  try {
    const parsed = new URL(relayUrl);
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

// Disk-backed last-known-good NIP-11 docs so an offline reload still shows the real server
// name/avatar. In ArmadaDB KV (unbounded entries); the sync cache in front keeps `initialData` sync.
export const relayInfoCache = new KvPrefixCache<RelayInfoDocument>({ prefix: 'relay-info:' });

function readCachedInfo(relayUrl: string | undefined): RelayInfoDocument | undefined {
  const cached = relayUrl ? relayInfoCache.get(relayUrl) : undefined;
  // Docs cached before sanitizing existed may still carry malformed fields.
  return cached ? sanitizeRelayInfo(cached) : undefined;
}

const STRING_FIELDS = [
  'name', 'description', 'icon', 'banner', 'pubkey', 'self', 'contact', 'software', 'version',
  'pairing_relay_url',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * NIP-11 is operator-written JSON; keep only fields of the declared type so consumers can
 * trust `RelayInfoDocument` (a string `supported_nips` would otherwise crash `.filter`).
 */
export function sanitizeRelayInfo(payload: unknown): RelayInfoDocument {
  if (!isRecord(payload)) return {};
  const info: RelayInfoDocument = {};
  for (const field of STRING_FIELDS) {
    const value = payload[field];
    if (typeof value === 'string') info[field] = value;
  }
  if (Array.isArray(payload.supported_nips)) {
    info.supported_nips = payload.supported_nips.filter((n): n is number => typeof n === 'number');
  }
  if (Array.isArray(payload.supported_extensions)) {
    info.supported_extensions = payload.supported_extensions.filter((e): e is string => typeof e === 'string');
  }
  if (typeof payload.auth_required === 'boolean') info.auth_required = payload.auth_required;
  if (typeof payload.payment_required === 'boolean') info.payment_required = payload.payment_required;
  if (isRecord(payload.limitation)) {
    const { auth_required, payment_required, restricted_writes } = payload.limitation;
    info.limitation = {
      ...(typeof auth_required === 'boolean' && { auth_required }),
      ...(typeof payment_required === 'boolean' && { payment_required }),
      ...(typeof restricted_writes === 'boolean' && { restricted_writes }),
    };
  }
  if (isRecord(payload.fees)) {
    const { admission, subscription } = payload.fees;
    const isFee = (f: unknown): f is { amount: number; unit: string; period?: number } =>
      isRecord(f) && typeof f.amount === 'number' && typeof f.unit === 'string';
    info.fees = {
      ...(Array.isArray(admission) && { admission: admission.filter(isFee) }),
      ...(Array.isArray(subscription) && { subscription: subscription.filter(isFee) }),
    };
  }
  return info;
}

function writeCachedInfo(relayUrl: string, info: RelayInfoDocument): void {
  // Refreshes mostly return the same doc; on Android every KV write crosses the bridge.
  const cached = relayInfoCache.get(relayUrl);
  if (cached && JSON.stringify(cached) === JSON.stringify(info)) return;
  relayInfoCache.set(relayUrl, info);
}

const latencies = new Map<string, number>();

/** Milliseconds the relay's last answered NIP-11 GET took to respond, this session. */
export function relayLatency(relayUrl: string | undefined): number | undefined {
  return relayUrl ? latencies.get(relayUrl) : undefined;
}

/**
 * Direct NIP-11 fetch, so useRelayGroups can get the signing key without gating on this
 * hook's query. Persists the last-known-good doc.
 */
export async function fetchRelayInfoDoc(
  relayUrl: string,
  signal?: AbortSignal,
): Promise<RelayInfoDocument> {
  const httpUrl = relayToHttpUrl(relayUrl);
  if (!httpUrl) {
    throw new Error('Invalid relay URL');
  }

  const signals = [AbortSignal.timeout(8000), ...(signal ? [signal] : [])];
  const started = performance.now();
  const response = await fetch(httpUrl, {
    headers: { Accept: 'application/nostr+json' },
    signal: AbortSignal.any(signals),
  });
  latencies.set(relayUrl, Math.round(performance.now() - started));

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid NIP-11 response');
  }

  const info = sanitizeRelayInfo(payload);
  writeCachedInfo(relayUrl, info);
  return info;
}

export function useRelayInfo(relayUrl: string | undefined) {
  const httpUrl = relayUrl ? relayToHttpUrl(relayUrl) : null;
  const queryClient = useQueryClient();

  // The seed loads asynchronously; hand it to queries still without data once warm.
  useEffect(() => {
    if (!relayUrl || !httpUrl) return;
    let cancelled = false;
    void relayInfoCache.ready().then(() => {
      if (cancelled) return;
      const cached = readCachedInfo(relayUrl);
      if (!cached) return;
      const key = ['relay-info', relayUrl];
      if (queryClient.getQueryData<RelayInfoDocument>(key) === undefined) {
        queryClient.setQueryData(key, cached, { updatedAt: 0 });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [relayUrl, httpUrl, queryClient]);

  return useQuery(relayInfoQueryOptions(relayUrl));
}

/**
 * Shared by `useRelayReachable`, which observes the same query with a shorter staleTime, so
 * one NIP-11 GET answers both. A seed carries `dataUpdatedAt: 0`, which that hook reads as
 * "not yet heard from the relay".
 */
export function relayInfoQueryOptions(relayUrl: string | undefined) {
  return {
    queryKey: ['relay-info', relayUrl],
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchRelayInfoDoc(relayUrl!, signal),
    enabled: !!relayUrl && !!relayToHttpUrl(relayUrl),
    // Seed as a real success so a fetch failure never blanks it; `initialDataUpdatedAt: 0` still
    // triggers one background refresh.
    initialData: () => readCachedInfo(relayUrl),
    initialDataUpdatedAt: 0,
    staleTime: 12 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 1,
  } satisfies UseQueryOptions<RelayInfoDocument>;
}

