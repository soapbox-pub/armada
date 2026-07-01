import { nip19 } from "nostr-tools";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Slash commands for the chat composer. Typing `/` at the very start of an
 * empty composer opens an autocomplete menu; picking (or sending) a command
 * runs it locally instead of sending a literal "/command" message.
 *
 * Commands fall into three categories:
 *  - "text":       rewrite the outgoing message text (e.g. /me, /shrug).
 *  - "action":     trigger a composer side-effect (e.g. /poll, /thread).
 *  - "moderation": map to a NIP-29 moderation action; admin-only.
 */
export type SlashCommandKind = "text" | "action" | "moderation";

/**
 * A composer capability a command depends on. The composer advertises which it
 * supports (e.g. NIP-29 group chat has all of them; Concord's encrypted send
 * path has none of the group-only ones), and commands needing an unsupported
 * capability are hidden from the menu and rejected on send. Universal commands
 * (e.g. /me, /shrug, /mention) declare no requirement and work everywhere.
 */
export type SlashCapability = "poll" | "thread" | "moderation";

/** Marker prefix the renderer styles as an italic third-person action line. */
export const ME_ACTION_PREFIX = "\u200b/me ";

export interface SlashCommandContext {
  /** Whether the current user can moderate the group (admin). */
  canModerate: boolean;
  /** Resolve the first `nostr:npub`/`nprofile` or raw npub in `arg` to a hex pubkey. */
  resolvePubkey: (arg: string) => string | undefined;
}

export type SlashRunResult =
  /** Replace the outgoing message with this text and send it normally. */
  | { type: "send"; text: string }
  /** Run a composer action; nothing is sent. */
  | { type: "action"; action: SlashAction }
  /** Show an error toast; nothing is sent. */
  | { type: "error"; message: string }
  /** Command needs no further work and sent nothing. */
  | { type: "noop" };

export type SlashAction =
  | { kind: "openPoll" }
  | { kind: "clearDraft" }
  | { kind: "openMention"; prefix?: string }
  | { kind: "openThread" }
  | { kind: "post"; text: string }
  | { kind: "kick"; pubkey: string }
  | { kind: "ban"; pubkey: string; reason?: string };

export interface SlashCommand {
  /** Primary name, without the leading slash. */
  name: string;
  aliases?: string[];
  description: string;
  /** Usage hint shown in the menu, e.g. "/kick @user". */
  usage?: string;
  kind: SlashCommandKind;
  /**
   * Composer capabilities this command needs. Omitted/empty means universal
   * (works in any composer, including Concord's delegated send). The composer
   * filters the menu and guards execution by its advertised capabilities.
   */
  requires?: SlashCapability[];
  /**
   * Whether picking this command from the menu (Tab/Enter/click) should run it
   * immediately. True for commands that need no argument (e.g. /poll, /thread,
   * /shrug); false for ones that take a target/text (e.g. /kick, /me), which
   * instead insert "/name " so the user can type the argument.
   */
  runsOnSelect?: boolean;
  /**
   * Run the command. `arg` is everything after the command word (trimmed).
   * Returns what the composer should do next.
   */
  run: (arg: string, ctx: SlashCommandContext) => SlashRunResult;
}

const requireTarget = (
  arg: string,
  ctx: SlashCommandContext,
  build: (pubkey: string, rest: string) => SlashRunResult,
): SlashRunResult => {
  if (!ctx.canModerate) return { type: "error", message: "You don't have permission to moderate this channel." };
  const trimmed = arg.trim();
  if (!trimmed) return { type: "error", message: "Specify a user, e.g. by @mention or npub." };
  const pubkey = ctx.resolvePubkey(trimmed);
  if (!pubkey) return { type: "error", message: "Couldn't find that user. Mention them with @ or paste their npub." };
  // The rest of the arg after the resolved target (a reason, for /ban).
  const rest = trimmed.replace(/^\S+\s*/, "").trim();
  return build(pubkey, rest);
};

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "me",
    description: "Send a third-person action message",
    usage: "/me <action>",
    kind: "text",
    run: (arg) => {
      const action = arg.trim();
      if (!action) return { type: "error", message: "Usage: /me <action>" };
      return { type: "send", text: ME_ACTION_PREFIX + action };
    },
  },
  {
    name: "shrug",
    description: "Append \u00af\\_(\u30c4)_/\u00af",
    kind: "text",
    runsOnSelect: true,
    run: (arg) => ({ type: "send", text: `${arg.trim()} \u00af\\_(\u30c4)_/\u00af`.trim() }),
  },
  {
    name: "tableflip",
    description: "Append (\u256f\u00b0\u25a1\u00b0)\u256f\ufe35 \u253b\u2501\u253b",
    kind: "text",
    runsOnSelect: true,
    run: (arg) => ({ type: "send", text: `${arg.trim()} (\u256f\u00b0\u25a1\u00b0)\u256f\ufe35 \u253b\u2501\u253b`.trim() }),
  },
  {
    name: "unflip",
    description: "Append \u252c\u2500\u252c \u30ce( \u309c-\u309c\u30ce)",
    kind: "text",
    runsOnSelect: true,
    run: (arg) => ({ type: "send", text: `${arg.trim()} \u252c\u2500\u252c \u30ce( \u309c-\u309c\u30ce)`.trim() }),
  },
  {
    name: "poll",
    description: "Create a poll",
    kind: "action",
    requires: ["poll"],
    runsOnSelect: true,
    run: () => ({ type: "action", action: { kind: "openPoll" } }),
  },
  {
    name: "post",
    description: "Create a rebroadcastable Nostr post",
    usage: "/post <message>",
    kind: "action",
    run: (arg) => {
      const text = arg.trim();
      if (!text) return { type: "error", message: "Usage: /post <message>" };
      return { type: "action", action: { kind: "post", text } };
    },
  },
  {
    name: "mention",
    description: "Mention a user (opens the @ picker)",
    kind: "action",
    runsOnSelect: true,
    run: () => ({ type: "action", action: { kind: "openMention" } }),
  },
  {
    name: "thread",
    description: "Start a thread on the latest message",
    kind: "action",
    requires: ["thread"],
    runsOnSelect: true,
    run: () => ({ type: "action", action: { kind: "openThread" } }),
  },
  {
    name: "slap",
    description: "Slap someone around a bit with a large trout",
    usage: "/slap <name>",
    kind: "text",
    runsOnSelect: true,
    run: (arg) => {
      const rest = arg.trim();
      // Picked from the menu with no target yet: open the @ picker seeded with
      // "/slap " so the resolved mention re-runs this command on send.
      if (!rest) return { type: "action", action: { kind: "openMention", prefix: "/slap " } };
      // The target is the first token (a resolved nostr: mention or raw name);
      // anything after it is the user's own action text. Default to the classic
      // "around a bit with a large trout" when they appended nothing.
      const [target, ...tail] = rest.split(/\s+/);
      const suffix = tail.length ? tail.join(" ") : "around a bit with a large trout";
      return { type: "send", text: `${ME_ACTION_PREFIX}slaps ${target} ${suffix}` };
    },
  },
  {
    name: "kick",
    aliases: ["remove"],
    description: "Remove a user from the channel",
    usage: "/kick @user",
    kind: "moderation",
    requires: ["moderation"],
    run: (arg, ctx) => requireTarget(arg, ctx, (pubkey) => ({ type: "action", action: { kind: "kick", pubkey } })),
  },
  {
    name: "ban",
    description: "Remove a user (with a reason)",
    usage: "/ban @user [reason]",
    kind: "moderation",
    requires: ["moderation"],
    run: (arg, ctx) =>
      requireTarget(arg, ctx, (pubkey, reason) => ({ type: "action", action: { kind: "ban", pubkey, reason } })),
  },
];

/** Find a command by name or alias (case-insensitive). */
export function findSlashCommand(word: string): SlashCommand | undefined {
  const w = word.toLowerCase();
  return SLASH_COMMANDS.find((c) => c.name === w || c.aliases?.includes(w));
}

/**
 * If `content` is a slash-command invocation, return the matched command and
 * its argument. Only triggers when the whole message starts with `/word`.
 */
export function parseSlashCommand(content: string): { command: SlashCommand; arg: string } | undefined {
  const match = content.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  const command = findSlashCommand(match[1]);
  if (!command) return undefined;
  return { command, arg: match[2] ?? "" };
}

/**
 * Host callbacks for {@link executeSlashCommand}. A chat surface (the Nostr
 * group composer, the Bluetooth mesh, …) supplies whichever of these it
 * supports; the shared runner maps a command's {@link SlashRunResult} onto
 * them. This is the single place command results are dispatched — surfaces
 * differ only in *how* they send/act, never in the result-handling logic.
 */
export interface SlashCommandHandlers {
  /** Send the (rewritten) message text. */
  send: (text: string) => void | Promise<void>;
  /**
   * Open the `@` mention picker, optionally seeding the draft with `prefix`
   * (e.g. "/slap ") so the resolved mention re-runs that command on send.
   */
  openMention: (prefix?: string) => void;
  /** Clear the composer/draft (a `noop`/`clearDraft` outcome). */
  clearDraft?: () => void;
  /** Surface a recoverable error to the user (e.g. a toast). */
  onError: (message: string) => void;
  /**
   * Handle a non-mention {@link SlashAction} (open poll/thread, moderation, …).
   * Surfaces that don't support a given action should reject (or simply not
   * provide this), and the runner reports it as unavailable.
   */
  onAction?: (action: SlashAction) => void | Promise<void>;
  /**
   * Optional gate: return false for commands this surface doesn't support, to
   * produce a friendly "isn't available here" error instead of running them.
   * Should match the menu's `commandFilter` so typed and picked commands agree.
   */
  isAllowed?: (command: SlashCommand) => boolean;
}

/**
 * Run a slash command and dispatch its result onto the host's handlers. Used by
 * every chat composer (group, mesh, …) so the run → result → side-effect logic
 * lives in exactly one place. Mention actions go to `openMention`; `openPoll`/
 * `openThread`/moderation go to `onAction`; text rewrites and `/me`-style sends
 * go to `send`.
 */
export async function executeSlashCommand(
  command: SlashCommand,
  arg: string,
  ctx: SlashCommandContext,
  handlers: SlashCommandHandlers,
): Promise<void> {
  if (handlers.isAllowed && !handlers.isAllowed(command)) {
    handlers.onError(`/${command.name} isn't available here.`);
    return;
  }

  const result = command.run(arg, ctx);
  switch (result.type) {
    case "error":
      handlers.onError(result.message);
      return;
    case "noop":
      handlers.clearDraft?.();
      return;
    case "send":
      await handlers.send(result.text);
      return;
    case "action":
      if (result.action.kind === "openMention") {
        handlers.openMention(result.action.prefix);
        return;
      }
      if (result.action.kind === "clearDraft") {
        handlers.clearDraft?.();
        return;
      }
      // openPoll / openThread / moderation — delegated to the surface.
      if (!handlers.onAction) {
        handlers.onError(`/${command.name} isn't available here.`);
        return;
      }
      await handlers.onAction(result.action);
      return;
  }
}

/** Commands whose name/alias starts with `query` (no leading slash), for the menu. */
export function matchSlashCommands(
  query: string,
  canModerate: boolean,
  capabilities?: ReadonlySet<SlashCapability>,
): SlashCommand[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter((c) => {
    if (c.kind === "moderation" && !canModerate) return false;
    // Hide commands needing a capability this composer doesn't advertise.
    if (capabilities && c.requires?.some((r) => !capabilities.has(r))) return false;
    if (!q) return true;
    return c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q));
  });
}

/**
 * Resolve a `@`-mention's `nostr:npub`/`nprofile` token, or a raw npub/nprofile,
 * to a hex pubkey. Returns undefined when nothing usable is found.
 */
export function resolveNpubArg(arg: string): string | undefined {
  const match = arg.match(/(?:nostr:)?(npub1[023456789acdefghjklmnpqrstuvwxyz]+|nprofile1[023456789acdefghjklmnpqrstuvwxyz]+)/i);
  if (!match) return undefined;
  try {
    const decoded = nip19.decode(match[1]);
    if (decoded.type === "npub") return decoded.data;
    if (decoded.type === "nprofile") return decoded.data.pubkey;
  } catch {
    return undefined;
  }
  return undefined;
}

/** True if a stored chat message is a `/me` action line. */
export function isMeAction(event: NostrEvent): boolean {
  return event.content.startsWith(ME_ACTION_PREFIX);
}

/** The action text of a `/me` message (without the marker prefix). */
export function meActionText(event: NostrEvent): string {
  return event.content.slice(ME_ACTION_PREFIX.length);
}
