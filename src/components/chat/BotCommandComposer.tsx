import { ArrowUpRight, X } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  argReason,
  buildInvocationText,
  byteLength,
  MAX_ARG_VALUE_BYTES,
  parseInvocation,
  validateInvocation,
  type BotArg,
  type BotCommandEntry,
} from "@/lib/botCommands";
import { FormattedMessage, useIntl } from "@/i18n";
import { menuPickHandlers } from "@/lib/menuPick";
import { cn } from "@/lib/utils";
import type { ImetaEntry } from "@/lib/imeta";

import type { BotRosterProfile } from "@/hooks/useBotManifests";

interface BotCommandComposerProps {
  entry: BotCommandEntry;
  /** Candidates for a `user` argument. */
  memberPubkeys: string[];
  /** Already resolved by the bot sweep. */
  profiles: Record<string, BotRosterProfile>;
  /** Members who spoke here, most recent first; `user` pickers surface them first. */
  recentAuthors?: string[];
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

interface Option {
  value: string;
  label: string;
  picture?: string;
  pictureImeta?: ImetaEntry;
}

const MAX_USER_OPTIONS = 6;

const displayName = (pubkey: string, profiles: Record<string, BotRosterProfile>): string =>
  profiles[pubkey]?.name || `${pubkey.slice(0, 8)}…`;

function orderByRecency(pubkeys: string[], recent: string[]): string[] {
  if (recent.length === 0) return pubkeys;
  const rank = new Map(recent.map((pk, i) => [pk, i] as const));
  const absent = recent.length; // everyone not in `recent` ranks equal, after
  return [...pubkeys].sort((a, b) => (rank.get(a) ?? absent) - (rank.get(b) ?? absent));
}

/** Argument types whose field carries a drop-up, so landing on it should open it. */
const MENU_TYPES = new Set<string>(["choice", "bool", "user"]);

/**
 * Collects a bot command's arguments in typed fields (drop-ups for
 * `choice`/`bool`, member picker for `user`, digits for `int`/`number`, a box for
 * free text), assembling canonical invocation text on submit so quoting is never
 * the user's job. Enter advances/sends; Escape or backspacing out of the first
 * field abandons.
 */
export function BotCommandComposer({
  entry,
  memberPubkeys,
  profiles,
  recentAuthors = [],
  onSubmit,
  onCancel,
}: BotCommandComposerProps) {
  const { command, bot } = entry;
  const args = command.args;
  const intl = useIntl();
  const skipLabel = intl.formatMessage({ id: "botCommandComposer.skip", defaultMessage: "(skip)" });

  const [values, setValues] = useState<string[]>(() => args.map(() => ""));
  const [npubs, setNpubs] = useState<(string | undefined)[]>(() => args.map(() => undefined));
  const [invalid, setInvalid] = useState<boolean[]>(() => args.map(() => false));
  const [focused, setFocused] = useState(0);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);

  const fieldRefs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    fieldRefs.current[0]?.focus();
    // If the first argument is itself a selector, open it on mount too.
    const type = args[0]?.type;
    if (type && MENU_TYPES.has(type)) {
      setMenuFor(0);
      setMenuIndex(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setValue = useCallback((i: number, value: string) => {
    setValues((prev) => prev.map((v, j) => (j === i ? value : v)));
    setInvalid((prev) => prev.map((v, j) => (j === i ? false : v)));
  }, []);

  const focusField = useCallback((i: number, caret: "start" | "end" = "start") => {
    const el = fieldRefs.current[i];
    if (!el) return;
    el.focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const pos = caret === "end" ? el.value.length : 0;
      el.setSelectionRange(pos, pos);
    }
    // Landing on a field with a drop-up opens it.
    const type = args[i]?.type;
    if (type && MENU_TYPES.has(type)) {
      setMenuFor(i);
      setMenuIndex(0);
    }
  }, [args]);

  const optionsFor = useCallback(
    (i: number, query: string): Option[] => {
      const arg = args[i];
      if (arg.type === "choice" || arg.type === "bool") {
        const base = arg.type === "bool" ? ["true", "false"] : arg.choices;
        const opts: Option[] = base.map((c) => ({ value: c, label: c }));
        // Optional arguments can be left out; the wire format just stops early.
        if (!arg.required) opts.unshift({ value: "", label: skipLabel });
        return opts;
      }
      if (arg.type === "user") {
        const q = query.toLowerCase();
        const matched = memberPubkeys.filter(
          (pk) => !q || displayName(pk, profiles).toLowerCase().includes(q) || pk.includes(q),
        );
        return orderByRecency(matched, recentAuthors)
          .slice(0, MAX_USER_OPTIONS)
          .map((pk) => ({
            value: pk,
            label: displayName(pk, profiles),
            picture: profiles[pk]?.picture,
            pictureImeta: profiles[pk]?.pictureImeta,
          }));
      }
      return [];
    },
    [args, memberPubkeys, profiles, recentAuthors, skipLabel],
  );

  const menuOptions = useMemo(
    () => (menuFor === null ? [] : optionsFor(menuFor, values[menuFor] ?? "")),
    [menuFor, optionsFor, values],
  );

  const openMenu = useCallback((i: number) => {
    setMenuFor(i);
    setMenuIndex(0);
  }, []);
  const closeMenu = useCallback(() => setMenuFor(null), []);

  const pickOption = useCallback(
    (i: number, option: Option) => {
      const arg = args[i];
      if (arg.type === "user") {
        // The npub, not the displayed name, goes on the wire.
        setValue(i, option.label);
        const npub = (() => {
          try {
            return nip19.npubEncode(option.value);
          } catch {
            return undefined;
          }
        })();
        setNpubs((prev) => prev.map((v, j) => (j === i ? npub : v)));
      } else {
        setValue(i, option.value);
      }
      closeMenu();
      if (i < args.length - 1) focusField(i + 1);
      else fieldRefs.current[i]?.focus();
    },
    [args, setValue, closeMenu, focusField],
  );

  const submit = useCallback(() => {
    const raw = args.map((a, i) => (a.type === "user" && npubs[i] ? npubs[i]! : values[i] ?? "").trim());

    let lastFilled = -1;
    raw.forEach((v, i) => {
      if (v !== "") lastFilled = i;
    });

    const reject = (i: number) => {
      setInvalid((prev) => prev.map((v, j) => (j === i ? true : v)));
      focusField(i, "end");
    };

    for (let i = 0; i < args.length; i++) {
      const empty = raw[i] === "";
      // Positional text can't express a hole: later values would shift slots.
      if (empty && (args[i].required || i < lastFilled)) return reject(i);
      if (!empty && argReason(args[i], raw[i])) return reject(i);
      // The wire caps values in BYTES (maxLength counts UTF-16); an over-cap value
      // is silently ignored by the bot after the routing tag is published.
      if (byteLength(raw[i]) > MAX_ARG_VALUE_BYTES) return reject(i);
    }

    const text = buildInvocationText(command.name, raw.slice(0, lastFilled + 1));
    // Round-trip check: if we can't parse what we produced, neither can the bot.
    const back = parseInvocation(text, [entry], bot);
    if (!back || validateInvocation(back.command, back.args)) {
      return reject(Math.max(lastFilled, 0));
    }

    onSubmit(text);
  }, [args, npubs, values, command.name, entry, bot, onSubmit, focusField]);

  const onFieldKeyDown = useCallback(
    (e: React.KeyboardEvent, i: number) => {
      const arg = args[i];
      const el = e.currentTarget;
      const isTrigger = el instanceof HTMLButtonElement;

      if (menuFor === i && menuOptions.length > 0) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          const n = menuOptions.length;
          setMenuIndex((prev) => (prev + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
          return;
        }
        if (e.key === "Enter" || (isTrigger && e.key === " ")) {
          e.preventDefault();
          e.stopPropagation();
          pickOption(i, menuOptions[menuIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeMenu();
          return;
        }
      }

      // A trigger has no caret, so caret keys open it.
      if (isTrigger && (e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        e.stopPropagation();
        openMenu(i);
        return;
      }

      if (e.key === "Enter") {
        if (e.shiftKey && el instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey || i === args.length - 1) submit();
        else focusField(i + 1);
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }

      const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : values[i];
      if ((e.key === "Backspace" || e.key === "Delete") && !value) {
        // Backspacing out of the first field abandons the command.
        e.preventDefault();
        if (i === 0) onCancel();
        else focusField(i - 1, "end");
        return;
      }

      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const caretFree = isTrigger;
        const input = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : undefined;
        const collapsed = input ? input.selectionStart === input.selectionEnd : true;
        const atEnd = input ? input.selectionEnd === input.value.length : true;
        const atStart = input ? input.selectionStart === 0 : true;
        if (e.key === "ArrowRight" && i < args.length - 1 && (caretFree || (collapsed && atEnd))) {
          e.preventDefault();
          focusField(i + 1, "start");
        } else if (e.key === "ArrowLeft" && i > 0 && (caretFree || (collapsed && atStart))) {
          e.preventDefault();
          focusField(i - 1, "end");
        }
      }

      void arg;
    },
    [args, menuFor, menuOptions, menuIndex, values, pickOption, closeMenu, openMenu, submit, onCancel, focusField],
  );

  const focusedArg: BotArg | undefined = args[focused];

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-secondary/40 px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <FormattedMessage
          id="botCommandComposer.usingWith"
          defaultMessage="<s>Using</s> <cmd>/{command}</cmd> <s>with</s> <bot>{name}</bot>"
          values={{
            command: command.name,
            name: displayName(bot, profiles),
            s: (chunks) => <span>{chunks}</span>,
            cmd: (chunks) => <span className="font-mono font-semibold text-foreground">{chunks}</span>,
            bot: (chunks) => (
              <>
                <Avatar className="size-4 shrink-0">
                  <AvatarImage src={profiles[bot]?.picture} imeta={profiles[bot]?.pictureImeta} alt="" />
                  <AvatarFallback className="text-monogram">
                    {displayName(bot, profiles).slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="font-medium text-foreground">{chunks}</span>
              </>
            ),
          }}
        />
        {focusedArg?.description && (
          <span className="truncate border-l border-border pl-1.5">{focusedArg.description}</span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto size-5 touch:size-11 shrink-0 clip-corner-lg"
          aria-label={intl.formatMessage({ id: "botCommandComposer.cancel", defaultMessage: "Cancel command" })}
          onClick={onCancel}
        >
          <X className="size-3" />
        </Button>
      </div>

      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-wrap items-start gap-1.5">
          {args.map((arg, i) => (
          <label
            key={arg.name}
            className={cn(
              "relative flex items-center gap-1.5 rounded-lg border bg-background px-2 py-1",
              invalid[i] ? "border-destructive" : "border-border",
              arg.type === "string" && i === args.length - 1 && "flex-1 min-w-[10rem]",
            )}
          >
            <span className="shrink-0 font-mono text-3xs uppercase tracking-wide text-muted-foreground">
              {arg.name}
              {arg.required && <span className="text-destructive">*</span>}
            </span>

            {arg.type === "choice" || arg.type === "bool" ? (
              <button
                type="button"
                aria-label={arg.name}
                ref={(el) => { fieldRefs.current[i] = el; }}
                className={cn(
                  "min-w-[3rem] bg-transparent text-left text-sm outline-none",
                  !values[i] && "text-muted-foreground",
                )}
                onFocus={() => setFocused(i)}
                // Menu rows preventDefault their pointer-down, so any blur is a real move.
                onBlur={() => { if (menuFor === i) closeMenu(); }}
                onKeyDown={(e) => onFieldKeyDown(e, i)}
                onPointerDown={(e) => {
                  e.preventDefault();
                  fieldRefs.current[i]?.focus();
                  if (menuFor === i) closeMenu();
                  else openMenu(i);
                }}
              >
                {values[i] || "…"}
              </button>
            ) : arg.type === "string" && i === args.length - 1 ? (
              <textarea
                aria-label={arg.name}
                ref={(el) => { fieldRefs.current[i] = el; }}
                rows={1}
                maxLength={1024}
                value={values[i]}
                spellCheck
                className="min-w-0 flex-1 resize-none bg-transparent text-sm outline-none"
                onFocus={() => setFocused(i)}
                onChange={(e) => setValue(i, e.target.value)}
                onKeyDown={(e) => onFieldKeyDown(e, i)}
              />
            ) : (
              <input
                type="text"
                aria-label={arg.name}
                ref={(el) => { fieldRefs.current[i] = el; }}
                maxLength={1024}
                value={values[i]}
                autoComplete="off"
                spellCheck={arg.type === "string"}
                inputMode={arg.type === "int" || arg.type === "number" ? "decimal" : undefined}
                placeholder={arg.type === "user" ? intl.formatMessage({ id: "botCommandComposer.memberPlaceholder", defaultMessage: "@member" }) : undefined}
                className="w-28 min-w-0 bg-transparent text-sm outline-none"
                onFocus={() => {
                  setFocused(i);
                  if (arg.type === "user") openMenu(i);
                }}
                // Menu rows preventDefault their pointer-down, so any blur is a real move.
                onBlur={() => { if (menuFor === i) closeMenu(); }}
                onChange={(e) => {
                  let next = e.target.value;
                  if (arg.type === "int" || arg.type === "number") {
                    // inputMode only picks the mobile keypad; filter desktop input too.
                    next = next.replace(arg.type === "int" ? /[^\d-]/g : /[^\d.-]/g, "").replace(/(?!^)-/g, "");
                    const dot = next.indexOf(".");
                    if (dot !== -1) next = next.slice(0, dot + 1) + next.slice(dot + 1).replace(/\./g, "");
                  }
                  setValue(i, next);
                  if (arg.type === "user") {
                    setNpubs((prev) => prev.map((v, j) => (j === i ? undefined : v)));
                    openMenu(i);
                  }
                }}
                onKeyDown={(e) => onFieldKeyDown(e, i)}
              />
            )}

            {menuFor === i && menuOptions.length > 0 && (
              <div className="vessel-lift absolute bottom-full left-0 z-[320] mb-1">
                <div className="vessel max-h-48 min-w-[9rem] overflow-y-auto scroll-py-1.5 p-1.5">
                  {menuOptions.map((option, oi) => (
                    <button
                      key={option.value || "(skip)"}
                      type="button"
                      data-highlighted={oi === menuIndex || undefined}
                      className={cn(
                        "relative flex w-full items-center gap-1.5 menu-row clip-corner px-2 py-1.5 text-left text-sm",
                        oi === menuIndex ? "bg-foreground/[0.08]" : "hover:bg-foreground/[0.05]",
                        option.value === "" && "text-muted-foreground italic",
                      )}
                      {...menuPickHandlers(() => pickOption(i, option))}
                    >
                      {arg.type === "user" && (
                        <Avatar className="size-4 shrink-0">
                          <AvatarImage src={option.picture} imeta={option.pictureImeta} alt="" />
                          <AvatarFallback className="text-monogram">
                            {option.label.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                      )}
                      <span className="truncate">{option.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            </label>
          ))}
        </div>

        <button
          type="button"
          onClick={submit}
          aria-label={intl.formatMessage({ id: "botCommandComposer.send", defaultMessage: "Send command" })}
          className="p-2 shrink-0 clip-corner-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity flex items-center justify-center size-9 touch:size-11"
        >
          <ArrowUpRight className="size-5" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}
