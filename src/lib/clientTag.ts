/**
 * The NIP-89 `client` tag Armada puts on what it signs: outer events, and the
 * chat rumors inside Concord and NIP-17 wraps. The tag is the deployment's
 * `CLIENT_TAG` (a JSON array, build or `window.ENV`; empty = none), else
 * `["client", APP_NAME]`. The user can turn it off (`AppConfig.clientTag`,
 * pushed here by `AppProvider`).
 */
import { config } from "@/lib/env";
import { APP_NAME } from "@/lib/platform";

/** Longest client name shown; the tag is sender-controlled text. */
const MAX_CLIENT_NAME = 48;

/**
 * `CLIENT_TAG` as a tag: `null` for an explicit empty value (no tag), the
 * default for unset or malformed. NIP-89's optional handler address and relay
 * hint ride along as given.
 */
export function parseClientTag(raw: string | undefined, fallback: string[]): string[] | null {
  if (raw === undefined) return fallback;
  if (raw.trim() === "") return null;
  try {
    const tag: unknown = JSON.parse(raw);
    if (
      Array.isArray(tag) &&
      tag.length >= 2 &&
      tag[0] === "client" &&
      tag.every((v) => typeof v === "string") &&
      (tag[1] as string).trim() !== ""
    ) {
      return tag as string[];
    }
  } catch { /* fall through */ }
  console.warn("[armada] CLIENT_TAG must be a JSON array like [\"client\",\"Armada\"]; using the default.");
  return fallback;
}

let parsed: { raw: string | undefined; tag: string[] | null } | undefined;

/** The deployment's tag, `null` when it carries none. */
export function configuredClientTag(): string[] | null {
  const raw = config("CLIENT_TAG");
  if (!parsed || parsed.raw !== raw) parsed = { raw, tag: parseClientTag(raw, ["client", APP_NAME]) };
  return parsed.tag;
}

let enabled = true;

/** The user's choice; off means nothing Armada signs names it. */
export function setClientTagEnabled(on: boolean): void {
  enabled = on;
}

export function clientTag(): string[] | null {
  return enabled ? configuredClientTag() : null;
}

/**
 * `tags` with this build's `client` tag in place of any other: a replaceable
 * read-modify-write or an edit copies the previous writer's.
 */
export function withClientTag(tags: readonly string[][]): string[][] {
  const tag = clientTag();
  const rest = tags.filter(([name]) => name !== "client");
  return tag ? [...rest, [...tag]] : rest;
}

/** The client an event names, for display: whitespace collapsed, capped. */
export function clientNameOf(tags: readonly string[][]): string | undefined {
  const raw = tags.find(([name]) => name === "client")?.[1];
  if (typeof raw !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!name) return undefined;
  return name.length > MAX_CLIENT_NAME ? `${name.slice(0, MAX_CLIENT_NAME - 1)}…` : name;
}
