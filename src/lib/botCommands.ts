import { nip19 } from "nostr-tools";
import { z } from "zod";

/**
 * Bot commands wire layer (pure). A bot publishes a replaceable manifest
 * (`kind:10304`) of typed slash-commands; an invocation is an ordinary chat
 * message (`/price btc`), optionally with a `["bot", <pubkey-hex>]` routing tag.
 *
 * The routing tag MUST ride inside the transport's encryption envelope (the
 * inner rumor for Concord), never on an outer wrap, or it leaks who commands which bot.
 */

/** Replaceable manifest: one authoritative command catalog per bot pubkey. */
export const BOT_MANIFEST_KIND = 10304;

/** Routing tag naming the bot that should act. Routing, NOT authorization. */
export const BOT_TAG = "bot";

// Manifest limits: a manifest is untrusted input.
const MAX_COMMANDS = 64;
const MAX_ARGS = 8;
const MAX_CHOICES = 32;
const MAX_CHOICE_BYTES = 32;
const MAX_DESCRIPTION_BYTES = 200;
const MAX_MANIFEST_BYTES = 32768;
/** Per-argument value cap on the wire. Longer ⇒ the text is not an invocation. */
export const MAX_ARG_VALUE_BYTES = 1024;
/** At most this many bots may be addressed by one message. */
export const MAX_BOT_TAGS = 8;

const NAME_RE = /^[a-z0-9_-]{1,32}$/;

/** Length in BYTES; every limit is a byte limit (`maxLength` counts UTF-16 units). */
export const byteLength = (s: string): number => new TextEncoder().encode(s).length;

export type BotArgType = "string" | "int" | "number" | "bool" | "user" | "choice";

/** Argument types this client can render; others hide their command (see parseBotManifest). */
const KNOWN_ARG_TYPES: readonly BotArgType[] = ["string", "int", "number", "bool", "user", "choice"];
const isKnownArgType = (t: string): t is BotArgType => (KNOWN_ARG_TYPES as readonly string[]).includes(t);

/** Unknown fields are stripped (zod default), so newer producers' manifests stay usable. */
const BotArgSchema = z
  .object({
    name: z.string().regex(NAME_RE),
    // Permissive: an unknown type hides only its own command (parseBotManifest).
    type: z.string().min(1),
    description: z.string().optional(),
    required: z.boolean().optional(),
    choices: z.array(z.string()).optional(),
  })
  .superRefine((a, ctx) => {
    if (byteLength(a.description ?? "") > MAX_DESCRIPTION_BYTES) {
      ctx.addIssue({ code: "custom", message: "argument description too long" });
    }
    const choices = a.choices ?? [];
    if (a.type === "choice") {
      if (choices.length < 1 || choices.length > MAX_CHOICES) {
        ctx.addIssue({ code: "custom", message: "a choice argument needs 1-32 choices" });
      }
      if (choices.some((c) => byteLength(c) < 1 || byteLength(c) > MAX_CHOICE_BYTES)) {
        ctx.addIssue({ code: "custom", message: "choice value out of bounds" });
      }
    } else if (isKnownArgType(a.type) && choices.length > 0) {
      // Unknown types are left alone; their command drops regardless.
      ctx.addIssue({ code: "custom", message: "choices on a non-choice argument" });
    }
  })
  .transform((a) => ({
    name: a.name,
    type: a.type,
    description: a.description ?? "",
    required: a.required ?? false,
    choices: a.choices ?? [],
  }));

const BotCommandSchema = z
  .object({
    name: z.string().regex(NAME_RE),
    description: z.string().optional(),
    args: z.array(BotArgSchema).max(MAX_ARGS).optional(),
  })
  .superRefine((c, ctx) => {
    if (byteLength(c.description ?? "") > MAX_DESCRIPTION_BYTES) {
      ctx.addIssue({ code: "custom", message: "command description too long" });
    }
    const args = c.args ?? [];
    const names = new Set(args.map((a) => a.name));
    if (names.size !== args.length) {
      ctx.addIssue({ code: "custom", message: "duplicate argument name" });
    }
    // Required-before-optional: positional invocations can't express a hole.
    const firstOptional = args.findIndex((a) => !a.required);
    if (firstOptional !== -1 && args.slice(firstOptional).some((a) => a.required)) {
      ctx.addIssue({ code: "custom", message: "a required argument follows an optional one" });
    }
  })
  .transform((c) => ({
    name: c.name,
    description: c.description ?? "",
    args: c.args ?? [],
  }));

const BotManifestSchema = z
  .object({
    v: z.literal(1),
    commands: z.array(BotCommandSchema).max(MAX_COMMANDS).optional(),
  })
  .superRefine((m, ctx) => {
    const commands = m.commands ?? [];
    const names = new Set(commands.map((c) => c.name));
    if (names.size !== commands.length) {
      ctx.addIssue({ code: "custom", message: "duplicate command name" });
    }
  })
  .transform((m) => ({ v: m.v, commands: m.commands ?? [] }));

/** A validated argument. `type` is always one this client can render. */
export interface BotArg {
  name: string;
  type: BotArgType;
  description: string;
  required: boolean;
  choices: string[];
}
export interface BotCommand {
  name: string;
  description: string;
  args: BotArg[];
}
export interface BotManifest {
  v: 1;
  commands: BotCommand[];
}

/**
 * Parse a manifest event's `content`. Fail-closed on structural invalidity,
 * but a command using an unknown argument type is hidden, not fatal, so
 * producers can add types without blanking older clients.
 */
export function parseBotManifest(content: string): BotManifest | undefined {
  if (byteLength(content) > MAX_MANIFEST_BYTES) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return undefined;
  }
  const parsed = BotManifestSchema.safeParse(json);
  if (!parsed.success) return undefined;

  const commands: BotCommand[] = [];
  for (const c of parsed.data.commands) {
    if (!c.args.every((a) => isKnownArgType(a.type))) continue;
    commands.push({
      name: c.name,
      description: c.description,
      args: c.args.map((a) => ({ ...a, type: a.type as BotArgType })),
    });
  }
  return { v: parsed.data.v, commands };
}

/** The routing tag for a bot, by hex pubkey. */
export function botTag(pubkeyHex: string): string[] {
  return [BOT_TAG, pubkeyHex];
}

/**
 * Tags routing an invocation to `botHex`. A 1:1 DM routes by recipient and
 * carries no tag, so nothing leaks on transports that don't encrypt tags.
 */
export function invocationTags(botHex: string, opts?: { dm?: boolean }): string[][] {
  return opts?.dm ? [] : [botTag(botHex)];
}

/** Hex pubkeys a message addresses. Empty ⇒ broadcast: any matching bot may answer. */
export function addressedBots(tags: string[][]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    if (t[0] !== BOT_TAG || !t[1]) continue;
    if (!out.includes(t[1])) out.push(t[1]);
    if (out.length === MAX_BOT_TAGS) break;
  }
  return out;
}

/** A message the timeline should render as an action line rather than raw text. */
export interface CommandLine {
  name: string;
  /** Hex pubkey of the bot it names, when it named one. */
  bot?: string;
  /** What followed the command word, as written; empty for a bare command. */
  args: string;
}

/**
 * Whether a message renders as "X ran /y" rather than raw text. Only when it
 * provably is an invocation (addresses a bot, a bare `/command`, or a command in
 * `knownCommands` — how untagged DMs are recognised): a rendering rule must
 * never hide prose like `/shrug I give up`.
 */
export function commandLine(
  content: string,
  tags: string[][],
  knownCommands?: ReadonlySet<string>,
): CommandLine | undefined {
  const text = content.trim();
  // Folded like the parser, so `/PING` doesn't send as a command and render as prose.
  const match = /^\/([A-Za-z0-9_-]{1,32})(\s|$)/.exec(text);
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  const bots = addressedBots(tags);
  if (bots.length === 0 && text !== `/${match[1]}` && !knownCommands?.has(name)) return undefined;
  return { name, bot: bots[0], args: text.slice(match[0].length).trim() };
}

type Token =
  | { kind: "token"; value: string; next: number }
  | { kind: "end" }
  | { kind: "malformed" };

/**
 * ASCII whitespace only, matching the reference parser; `\s` would split on
 * Unicode spaces (NBSP) that a bot treats as part of the token.
 */
const isSpace = (c: string): boolean =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/**
 * One shell-style token from `s` at `start`: a bare word, or a `"quoted span"`
 * in which `\"` is a literal quote and `\\` a literal backslash.
 */
function nextToken(s: string, start: number): Token {
  let i = start;
  while (i < s.length && isSpace(s[i])) i++;
  if (i >= s.length) return { kind: "end" };

  if (s[i] === '"') {
    i++;
    let value = "";
    while (i < s.length) {
      if (s[i] === "\\" && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === "\\")) {
        value += s[i + 1];
        i += 2;
      } else if (s[i] === '"') {
        return { kind: "token", value, next: i + 1 };
      } else {
        value += s[i];
        i++;
      }
    }
    return { kind: "malformed" };
  }

  const from = i;
  while (i < s.length && !isSpace(s[i])) i++;
  return { kind: "token", value: s.slice(from, i), next: i };
}

/** Strip leading / trailing ASCII whitespace, on the same class as the tokenizer. */
const trimAsciiStart = (s: string): string => {
  let i = 0;
  while (i < s.length && isSpace(s[i])) i++;
  return s.slice(i);
};
const trimAsciiEnd = (s: string): string => {
  let i = s.length;
  while (i > 0 && isSpace(s[i - 1])) i--;
  return s.slice(0, i);
};

export interface ParsedInvocation {
  command: BotCommand;
  /** The bot that declared it, hex. Meaningless when `ambiguous`. */
  bot: string;
  /** Values in declared order. Shorter than `command.args` when optionals were omitted. */
  args: string[];
  /**
   * Several bots declare this name and none was picked. Untagged = broadcast;
   * callers MUST NOT invent a routing tag (it silences the other bot).
   */
  ambiguous: boolean;
}

/** A command paired with the bot that declared it. */
export interface BotCommandEntry {
  /** Hex pubkey. */
  bot: string;
  command: BotCommand;
}

/** What picking a command from the `/` menu does. */
export type BotCommandPick =
  | { kind: "send" }
  | { kind: "draft"; text: string }
  | { kind: "fields" };

/**
 * As the manifest declares it: a command that takes nothing sends on pick; one whose
 * only argument is a free-text string is just the rest of the line (the greedy tail),
 * so it becomes a `/name ` draft; anything richer opens the typed fields.
 */
export function botCommandPick(command: BotCommand): BotCommandPick {
  if (command.args.length === 0) return { kind: "send" };
  if (command.args.length === 1 && command.args[0].type === "string") {
    return { kind: "draft", text: `/${command.name} ` };
  }
  return { kind: "fields" };
}

/** A command picked from one bot's section of the `/` menu, still sitting in the draft. */
export interface ArmedCommand {
  /** Hex pubkey. */
  bot: string;
  name: string;
}

/**
 * Whether `content` still begins with the picked command's word. Once the draft stops
 * naming it, the pick no longer says which bot the text is for, and a later hand-typed
 * command must not inherit its routing.
 */
export function draftNamesCommand(content: string, name: string): boolean {
  const match = content.trimStart().match(/^\/(\S+)/);
  return match?.[1].toLowerCase() === name;
}

/**
 * Match `content` against the conversation's commands. Undefined when not an
 * invocation (an unknown `/word` is ordinary chat and must still send).
 * `preferBot` disambiguates duplicate names. The command word is
 * case-insensitive; argument values keep case and `choice` matches exactly.
 */
export function parseInvocation(
  content: string,
  entries: BotCommandEntry[],
  preferBot?: string,
): ParsedInvocation | undefined {
  const text = content.trim();
  if (!text.startsWith("/")) return undefined;
  const rest = text.slice(1);

  const head = nextToken(rest, 0);
  // A quoted first token is not a command word.
  if (head.kind !== "token" || !head.value || rest.startsWith('"')) return undefined;

  const name = head.value.toLowerCase();
  const matches = entries.filter((e) => e.command.name === name);
  if (matches.length === 0) return undefined;
  const picked = preferBot ? matches.find((e) => e.bot === preferBot) : undefined;
  const entry = picked ?? matches[0];
  const ambiguous = !picked && matches.length > 1;
  const spec = entry.command;

  const args: string[] = [];
  let cursor = head.next;
  for (let i = 0; i < spec.args.length; i++) {
    const remainder = trimAsciiStart(rest.slice(cursor));
    if (!remainder) break;

    const isLast = i === spec.args.length - 1;
    let value: string;
    if (isLast && spec.args[i].type === "string" && !remainder.startsWith('"')) {
      // Greedy tail: a final free-text argument takes the raw remainder unquoted.
      value = trimAsciiEnd(remainder);
      cursor = rest.length;
    } else {
      const tok = nextToken(rest, cursor);
      if (tok.kind === "malformed") return undefined;
      if (tok.kind === "end") break;
      value = tok.value;
      cursor = tok.next;
    }
    if (byteLength(value) > MAX_ARG_VALUE_BYTES) return undefined;
    args.push(value);
  }

  return { command: spec, bot: entry.bot, args, ambiguous };
}

/** Canonical invocation text, quoting/escaping values so the bot re-parses them exactly. */
export function buildInvocationText(name: string, values: string[]): string {
  let out = `/${name}`;
  for (const v of values) {
    out += " ";
    if (v === "" || /[\s"]/.test(v)) {
      out += `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    } else {
      out += v;
    }
  }
  return out;
}

/**
 * Check one value against one argument spec; returns the canonical failure
 * reason (fixed by the spec, byte-identical across implementations) or undefined.
 */
export function argReason(spec: BotArg, value: string): string | undefined {
  switch (spec.type) {
    case "int": {
      // Signed 64-bit range, like a bot parsing into an i64.
      if (!/^[+-]?\d+$/.test(value)) return "not an integer";
      const n = BigInt(value);
      return n >= -(2n ** 63n) && n <= 2n ** 63n - 1n ? undefined : "not an integer";
    }
    case "number":
      // Decimal only; `Number()` would accept JS forms (`0x1f`) a bot's float parser rejects.
      return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value))
        ? undefined
        : "not a number";
    case "bool":
      return ["true", "false", "yes", "no", "1", "0"].includes(value.toLowerCase())
        ? undefined
        : "not a boolean";
    case "user":
      return normalizeUser(value) ? undefined : "not an npub";
    case "choice":
      return spec.choices.includes(value)
        ? undefined
        : `not one of ${spec.choices.join(", ")}`;
    case "string":
      return undefined;
  }
}

/** A `user` value (bare or NIP-21 `nostr:` npub, checksum-verified) as a bare npub. */
export function normalizeUser(value: string): string | undefined {
  const raw = value.startsWith("nostr:") ? value.slice(6) : value;
  if (!raw.startsWith("npub1")) return undefined;
  try {
    return nip19.decode(raw).type === "npub" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Validate an invocation's arguments; returns the canonical `{argument}: {reason}` or undefined. */
export function validateInvocation(command: BotCommand, args: string[]): string | undefined {
  for (let i = 0; i < command.args.length; i++) {
    const spec = command.args[i];
    const value = args[i];
    // Absent ≠ empty: `""` is a legal supplied value; its type check still applies.
    if (value === undefined) {
      if (spec.required) return `${spec.name}: required`;
      continue;
    }
    const reason = argReason(spec, value);
    if (reason) return `${spec.name}: ${reason}`;
  }
  return undefined;
}

function typeLabel(type: BotArgType): string {
  switch (type) {
    case "string":
      return "text";
    case "bool":
      return "true|false";
    case "user":
      return "npub";
    default:
      return type;
  }
}

/** Usage line `/name <required:type> [optional:type]`, the shape bots put in error replies. */
export function usageLine(command: BotCommand): string {
  const parts = command.args.map((a) =>
    a.required ? `<${a.name}:${typeLabel(a.type)}>` : `[${a.name}:${typeLabel(a.type)}]`,
  );
  return [`/${command.name}`, ...parts].join(" ");
}
