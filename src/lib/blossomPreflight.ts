/**
 * BUD-06 upload preflight (`HEAD /upload`), asking the server's size/type policy
 * before transcoding/encrypting. Unauthenticated to avoid a signer prompt per
 * attachment; a 401 is just "unknown".
 */

import { t } from "@/i18n";

/** What a server said about a prospective upload. */
export type PreflightVerdict =
  | { kind: "accepted" }
  | { kind: "refused"; status: number; reason?: string }
  /** No usable answer: no BUD-06, auth wanted, network error, timeout. */
  | { kind: "unknown" };

export interface PreflightRequest {
  size: number;
  type?: string;
  /** Hex SHA-256, when already known. Omitted rather than computed for this. */
  sha256?: string;
}

/**
 * Statuses that refuse THIS blob (too large, bad type, payment). Others (e.g. a
 * 400 demanding `X-SHA-256`) say nothing about acceptance.
 */
const REFUSAL_STATUSES = new Set([402, 413, 415]);

const PREFLIGHT_TIMEOUT_MS = 5_000;

export async function preflightUpload(
  server: string,
  req: PreflightRequest,
  opts: { signal?: AbortSignal; fetch?: typeof globalThis.fetch } = {},
): Promise<PreflightVerdict> {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const headers: Record<string, string> = { "X-Content-Length": String(req.size) };
  if (req.type) headers["X-Content-Type"] = req.type;
  if (req.sha256) headers["X-SHA-256"] = req.sha256;
  try {
    const timeout = AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS);
    const response = await doFetch(new URL("/upload", server), {
      method: "HEAD",
      headers,
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    if (response.ok) return { kind: "accepted" };
    if (REFUSAL_STATUSES.has(response.status)) {
      return { kind: "refused", status: response.status, reason: response.headers.get("x-reason") ?? undefined };
    }
    return { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
}

/** The first refusal reason if EVERY server refuses (uploads race all servers), else undefined. */
export async function preflightRefusal(
  servers: string[],
  req: PreflightRequest,
  opts: { signal?: AbortSignal; fetch?: typeof globalThis.fetch } = {},
): Promise<{ status: number; reason?: string } | undefined> {
  if (servers.length === 0) return undefined;
  // Settles on the first non-refusal, so one unresponsive server doesn't hold every attachment for the timeout.
  const refusals: Extract<PreflightVerdict, { kind: "refused" }>[] = [];
  return new Promise((resolve) => {
    for (const server of servers) {
      void preflightUpload(server, req, opts).then((verdict) => {
        if (verdict.kind !== "refused") return resolve(undefined);
        refusals.push(verdict);
        if (refusals.length === servers.length) {
          resolve({ status: refusals[0].status, reason: refusals.find((r) => r.reason)?.reason });
        }
      });
    }
  });
}

/** Human wording for a refusal whose server gave no reason. */
export function describeRefusal(refusal: { status: number; reason?: string }): string {
  if (refusal.reason) return refusal.reason;
  switch (refusal.status) {
    case 413: return t({ id: "blossomPreflight.tooLarge", defaultMessage: "The file is larger than your media servers accept." });
    case 415: return t({ id: "blossomPreflight.badType", defaultMessage: "Your media servers don't accept this type of file." });
    case 402: return t({ id: "blossomPreflight.paymentRequired", defaultMessage: "Your media servers require payment for this upload." });
    default: return t({ id: "blossomPreflight.refused", defaultMessage: "Your media servers refused this file." });
  }
}

/**
 * The server's own words from a failed upload: unwraps the `Promise.any`
 * `AggregateError` into per-server `Blossom request failed (<status>): …` errors.
 */
export function uploadFailureReason(error: unknown): string | undefined {
  const errors = error instanceof AggregateError ? error.errors : [error];
  for (const e of errors) {
    const message = e instanceof Error ? e.message : undefined;
    const match = message?.match(/^Blossom request failed \((\d+)\): ([\s\S]*)$/);
    if (!match) continue;
    const reason = match[2].trim();
    // A body can be an HTML error page; only a short plain line is worth showing.
    if (reason && reason.length <= 200 && !reason.startsWith("<")) return reason;
    return describeRefusal({ status: Number(match[1]) });
  }
  return undefined;
}

/**
 * Why an encrypted upload failed, when a server refused it: ciphertext can't
 * be sniffed as media, so a refusal is almost always the server's type policy.
 */
export function encryptedUploadFailureReason(error: unknown): string | undefined {
  if (uploadFailureReason(error) === undefined) return undefined;
  return t({
    id: "blossomPreflight.encryptedRefused",
    defaultMessage: "Your media servers don't accept encrypted files. Add one that does in Relays › Media.",
  });
}

/** Per-PUT timeout scaled by size (a flat 30 s killed large files on mobile data). */
export function uploadTimeoutMs(size: number): number {
  const FLOOR_MS = 30_000;
  const SLOW_BYTES_PER_SECOND = 50 * 1024;
  return FLOOR_MS + Math.ceil((size / SLOW_BYTES_PER_SECOND) * 1000);
}
