import { nip19 } from "nostr-tools";

import { t } from "@/i18n";
import {
  MAX_DICE,
  MAX_SIDES,
  formatRollMessage,
  parseDiceExpression,
  rollDice,
  splitRollArgument,
} from "@/lib/dice";
import { presetRoll } from "@/lib/dicePresets";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Composer slash commands, run locally instead of sent. "text" rewrites the
 * message, "action" triggers a composer side-effect, "moderation" maps to a
 * NIP-29 admin action.
 */
export type SlashCommandKind = "text" | "action" | "moderation";

/**
 * A composer capability a command needs; commands needing one the composer
 * doesn't advertise are hidden and rejected (Concord's encrypted send has none).
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
  /** Required composer capabilities; omitted means universal. */
  requires?: SlashCapability[];
  /**
   * Run immediately when picked from the menu (no-argument commands); otherwise
   * insert "/name " for the user to type the argument.
   */
  runsOnSelect?: boolean;
  /** `arg` is everything after the command word, trimmed. */
  run: (arg: string, ctx: SlashCommandContext) => SlashRunResult;
}

const requireTarget = (
  arg: string,
  ctx: SlashCommandContext,
  build: (pubkey: string, rest: string) => SlashRunResult,
): SlashRunResult => {
  if (!ctx.canModerate) return { type: "error", message: t({ id: "slashCommands.noPermission", defaultMessage: "You don't have permission to moderate this channel." }) };
  const trimmed = arg.trim();
  if (!trimmed) return { type: "error", message: t({ id: "slashCommands.specifyUser", defaultMessage: "Specify a user, e.g. by @mention or npub." }) };
  const pubkey = ctx.resolvePubkey(trimmed);
  if (!pubkey) return { type: "error", message: t({ id: "slashCommands.userNotFound", defaultMessage: "Couldn't find that user. Mention them with @ or paste their npub." }) };
  const rest = trimmed.replace(/^\S+\s*/, "").trim();
  return build(pubkey, rest);
};

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "me",
    get description() {
      return t({ id: "slashCommands.me.description", defaultMessage: "Send a third-person action message" });
    },
    usage: "/me <action>",
    kind: "text",
    run: (arg) => {
      const action = arg.trim();
      if (!action) return { type: "error", message: t({ id: "slashCommands.usage", defaultMessage: "Usage: {usage}" }, { usage: "/me <action>" }) };
      return { type: "send", text: ME_ACTION_PREFIX + action };
    },
  },
  {
    name: "shrug",
    description: "\u00af\\_(\u30c4)_/\u00af",
    kind: "text",
    runsOnSelect: true,
    run: (arg) => ({ type: "send", text: `${arg.trim()} \u00af\\_(\u30c4)_/\u00af`.trim() }),
  },
  {
    name: "tableflip",
    description: "(\u256f\u00b0\u25a1\u00b0)\u256f\ufe35 \u253b\u2501\u253b",
    kind: "text",
    runsOnSelect: true,
    run: (arg) => ({ type: "send", text: `${arg.trim()} (\u256f\u00b0\u25a1\u00b0)\u256f\ufe35 \u253b\u2501\u253b`.trim() }),
  },
  {
    name: "unflip",
    description: "\u252c\u2500\u252c \u30ce( \u309c-\u309c\u30ce)",
    kind: "text",
    runsOnSelect: true,
    run: (arg) => ({ type: "send", text: `${arg.trim()} \u252c\u2500\u252c \u30ce( \u309c-\u309c\u30ce)`.trim() }),
  },
  {
    name: "poll",
    get description() {
      return t({ id: "slashCommands.poll.description", defaultMessage: "Create a poll" });
    },
    kind: "action",
    requires: ["poll"],
    runsOnSelect: true,
    run: () => ({ type: "action", action: { kind: "openPoll" } }),
  },
  {
    name: "mention",
    get description() {
      return t({ id: "slashCommands.mention.description", defaultMessage: "Mention a user (opens the @ picker)" });
    },
    kind: "action",
    runsOnSelect: true,
    run: () => ({ type: "action", action: { kind: "openMention" } }),
  },
  {
    name: "thread",
    get description() {
      return t({ id: "slashCommands.thread.description", defaultMessage: "Start a thread on the latest message" });
    },
    kind: "action",
    requires: ["thread"],
    runsOnSelect: true,
    run: () => ({ type: "action", action: { kind: "openThread" } }),
  },
  {
    name: "slap",
    get description() {
      return t({ id: "slashCommands.slap.description", defaultMessage: "Slap someone around a bit with a large trout" });
    },
    usage: "/slap <name>",
    kind: "text",
    runsOnSelect: true,
    run: (arg) => {
      const rest = arg.trim();
      // No target: open the @ picker seeded with "/slap " so the mention re-runs this.
      if (!rest) return { type: "action", action: { kind: "openMention", prefix: "/slap " } };
      const [target, ...tail] = rest.split(/\s+/);
      const suffix = tail.length ? tail.join(" ") : "around a bit with a large trout";
      return { type: "send", text: `${ME_ACTION_PREFIX}slaps ${target} ${suffix}` };
    },
  },
  {
    name: "roll",
    aliases: ["dice"],
    get description() {
      return t({ id: "slashCommands.roll.description", defaultMessage: "Roll dice, e.g. 2d6+3 or fireball 5 (a d20 by default)" });
    },
    usage: "/roll 2d6+3 · /roll fireball 5",
    kind: "text",
    run: (rawArg) => {
      // `[2d6+3]`, copied from a usage line's optional-argument brackets, is still the roll.
      const arg = rawArg.replace(/^\s*[[(]\s*([^\])]*?)\s*[\])]/, "$1");
      const preset = presetRoll(arg);
      if (preset?.ok) return { type: "send", text: formatRollMessage(rollDice(preset.terms, preset.label)) };
      if (preset?.reason === "level") {
        return {
          type: "error",
          message: t(
            { id: "slashCommands.roll.level", defaultMessage: "{name} can be cast with a spell slot of level {min} to 9." },
            { name: preset.preset.name, min: preset.preset.level ?? 1 },
          ),
        };
      }
      const { expression, label } = splitRollArgument(arg);
      // Dice we couldn't read are reported, never quietly turned into a d20's label.
      const garbled = !expression && /^\S*\d*d\d/i.test(label);
      const parsed = preset ?? (garbled ? { ok: false as const, reason: "invalid" as const } : parseDiceExpression(expression || "1d20"));
      if (parsed.ok) return { type: "send", text: formatRollMessage(rollDice(parsed.terms, label)) };
      if (parsed.reason === "limits") {
        return {
          type: "error",
          message: t(
            { id: "slashCommands.roll.limits", defaultMessage: "You can roll up to {dice} dice with up to {sides} sides each." },
            { dice: MAX_DICE, sides: MAX_SIDES },
          ),
        };
      }
      return {
        type: "error",
        message: t({ id: "slashCommands.roll.invalid", defaultMessage: "Couldn't read that roll. Try something like /roll 2d6+3." }),
      };
    },
  },
  {
    name: "kick",
    aliases: ["remove"],
    get description() {
      return t({ id: "slashCommands.kick.description", defaultMessage: "Remove a user from the channel" });
    },
    usage: "/kick @user",
    kind: "moderation",
    requires: ["moderation"],
    run: (arg, ctx) => requireTarget(arg, ctx, (pubkey) => ({ type: "action", action: { kind: "kick", pubkey } })),
  },
  {
    name: "ban",
    get description() {
      return t({ id: "slashCommands.ban.description", defaultMessage: "Remove a user (with a reason)" });
    },
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

/** Host callbacks a chat surface supplies for {@link executeSlashCommand}. */
export interface SlashCommandHandlers {
  /** Send the (rewritten) message text. */
  send: (text: string) => void | Promise<void>;
  /** Open the `@` picker, optionally seeding the draft with `prefix` (e.g. "/slap "). */
  openMention: (prefix?: string) => void;
  /** Clear the composer/draft (a `noop`/`clearDraft` outcome). */
  clearDraft?: () => void;
  /** Surface a recoverable error to the user (e.g. a toast). */
  onError: (message: string) => void;
  /** Non-mention actions; without it, they're reported as unavailable. */
  onAction?: (action: SlashAction) => void | Promise<void>;
  /** Gate for unsupported commands; should match the menu's `commandFilter`. */
  isAllowed?: (command: SlashCommand) => boolean;
}

/** Run a slash command and dispatch its result onto the host's handlers. */
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
export function isMeAction(event: NostrRumor): boolean {
  return event.content.startsWith(ME_ACTION_PREFIX);
}

/** The action text of a `/me` message (without the marker prefix). */
export function meActionText(event: NostrRumor): string {
  return event.content.slice(ME_ACTION_PREFIX.length);
}
