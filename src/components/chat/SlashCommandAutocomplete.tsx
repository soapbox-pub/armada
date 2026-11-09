import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAuthor } from "@/hooks/useAuthor";
import { usePortalDropdown } from "@/hooks/usePortalDropdown";
import { matchSlashCommands, type SlashCapability, type SlashCommand } from "@/lib/slashCommands";
import { menuPickHandlers } from "@/lib/menuPick";
import { cn } from "@/lib/utils";
import { useIntl } from "@/i18n";

import type { BotCommandEntry } from "@/lib/botCommands";

interface SlashCommandAutocompleteProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  content: string;
  canModerate: boolean;
  /** Composer capabilities; commands needing an unsupported one are hidden. */
  capabilities?: ReadonlySet<SlashCapability>;
  /** Extra command filter on top of the built-in gates (e.g. mesh has no polls/threads). */
  commandFilter?: (command: SlashCommand) => boolean;
  /** Replace the command word `/query` with `/<name> `. */
  onInsertCommand: (params: { start: number; end: number; replacement: string }) => void;
  /** Run a command immediately (for argument-less commands picked from the menu). */
  onRunCommand: (command: SlashCommand) => void;

  /** Commands from this conversation's bots (`kind:10304` manifests). */
  botEntries?: BotCommandEntry[];
  /** Bots present, whether or not they publish a manifest — drives the loading copy. */
  botCount?: number;
  botsLoading?: boolean;
  /** Recently used bot commands, most recent first, as `<botHex>:<name>` keys. */
  botRecents?: string[];
  onRunBotCommand?: (entry: BotCommandEntry) => void;
}

/** Section headers are not rows and never take focus. */
type Row =
  | { type: "local"; command: SlashCommand }
  | { type: "bot"; entry: BotCommandEntry };

interface Section {
  key: string;
  bot?: string;
  label?: string;
  rows: Row[];
}

/** Argument names shown before collapsing into `+N`, so rows fit the menu. */
const MAX_VISIBLE_ARGS = 2;

const rowKey = (row: Row): string =>
  row.type === "local" ? `local:${row.command.name}` : `bot:${row.entry.bot}:${row.entry.command.name}`;

function BotIdentity({ pubkey, avatarOnly }: { pubkey: string; avatarOnly?: boolean }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = metadata?.name || metadata?.display_name || `${pubkey.slice(0, 8)}…`;
  const image = metadata?.picture;
  return (
    <>
      <Avatar className="size-4 shrink-0">
        <AvatarImage src={image} imeta={author.data?.imeta?.picture} alt="" />
        <AvatarFallback className="text-monogram">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      {!avatarOnly && (
        <span className="truncate">
          <DisplayName pubkey={pubkey} name={name} />
        </span>
      )}
    </>
  );
}

/**
 * Command palette for a leading `/command` while the first token is typed (never
 * URLs or mid-message slashes). Built-ins first, then a section per bot; bot
 * commands are identified by (bot, name).
 */
export function SlashCommandAutocomplete({
  textareaRef,
  content,
  canModerate,
  capabilities,
  commandFilter,
  onInsertCommand,
  onRunCommand,
  botEntries,
  botCount = 0,
  botsLoading = false,
  botRecents,
  onRunBotCommand,
}: SlashCommandAutocompleteProps) {
  const intl = useIntl();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  // Bottom-anchored so the menu grows upward from the composer.
  const [dropdownPos, setDropdownPos] = useState<{ bottom: number; left: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => setIsOpen(false), []);
  const { renderPortal } = usePortalDropdown({
    textareaRef,
    isOpen,
    onClose: handleClose,
    dropdownHeight: 260,
  });

  const sections = useMemo<Section[]>(() => {
    if (!isOpen) return [];
    const out: Section[] = [];

    // Prefix matches hoisted; manifest order kept within a tier (it's meaningful).
    const q = query.toLowerCase();
    const matched = (botEntries ?? []).filter((e) => e.command.name.includes(q));
    const ranked = [
      ...matched.filter((e) => e.command.name.startsWith(q)),
      ...matched.filter((e) => !e.command.name.startsWith(q)),
    ];

    // Recents lead; each row shows its owner bot (two bots' `/roll` differ).
    const recentRows: Row[] = [];
    for (const key of botRecents ?? []) {
      const sep = key.indexOf(":");
      const bot = key.slice(0, sep);
      const name = key.slice(sep + 1);
      const hit = ranked.find((e) => e.bot === bot && e.command.name === name);
      if (hit) recentRows.push({ type: "bot", entry: hit });
    }
    if (recentRows.length > 0) {
      out.push({ key: "recents", label: intl.formatMessage({ id: "slashCommandAutocomplete.recentlyUsed", defaultMessage: "Recently used" }), rows: recentRows });
    }

    const base = matchSlashCommands(query, canModerate, capabilities);
    const local = commandFilter ? base.filter(commandFilter) : base;
    if (local.length > 0) {
      out.push({
        key: "local",
        // No label when it's the whole menu.
        label: recentRows.length > 0 || ranked.length > 0 ? intl.formatMessage({ id: "slashCommandAutocomplete.builtIn", defaultMessage: "Built-in" })
          : undefined,
        rows: local.map((command) => ({ type: "local", command })),
      });
    }

    const byBot = new Map<string, Row[]>();
    for (const entry of ranked) {
      const rows = byBot.get(entry.bot) ?? [];
      rows.push({ type: "bot", entry });
      byBot.set(entry.bot, rows);
    }
    for (const [bot, rows] of byBot) {
      out.push({ key: `bot:${bot}`, bot, rows });
    }

    return out;
  }, [isOpen, query, canModerate, capabilities, commandFilter, botEntries, botRecents, intl]);

  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  // Show loading rather than a false empty, but only when a bot is present, or
  // every `/`-leading message would open an empty menu that swallows Enter.
  const showLoading = isOpen && botsLoading && botCount > 0 && (botEntries?.length ?? 0) === 0;

  // Rows can shrink under a stable draft; keep the cursor in range.
  useEffect(() => {
    setSelectedIndex((prev) => (prev >= rows.length ? Math.max(rows.length - 1, 0) : prev));
  }, [rows.length]);

  const detect = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const value = textarea.value;

    // Whole message is `/word` with no whitespace yet (a space starts arguments).
    const match = value.match(/^\/([\w-]*)$/);
    if (!match) {
      setIsOpen(false);
      return;
    }

    setQuery(match[1]);
    setSelectedIndex(0);
    setIsOpen(true);

    const rect = textarea.getBoundingClientRect();
    setDropdownPos({
      bottom: window.innerHeight - rect.top + 6,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 320 - 8)),
    });
  }, [textareaRef]);

  useEffect(() => {
    detect();
  }, [content, detect]);

  const selectRow = useCallback((row: Row) => {
    setIsOpen(false);
    if (row.type === "bot") {
      onRunBotCommand?.(row.entry);
      return;
    }
    const command = row.command;
    // Argument-less commands run on pick; others insert "/name ".
    if (command.runsOnSelect) {
      onRunCommand(command);
      return;
    }
    const textarea = textareaRef.current;
    const end = textarea?.value.length ?? query.length + 1;
    onInsertCommand({ start: 0, end, replacement: `/${command.name} ` });
  }, [textareaRef, query, onInsertCommand, onRunCommand, onRunBotCommand]);

  useEffect(() => {
    if (!isOpen || (rows.length === 0 && !showLoading)) return;
    const textarea = textareaRef.current;
    if (!textarea) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          if (rows.length === 0) return;
          e.preventDefault();
          setSelectedIndex((prev) => (prev < rows.length - 1 ? prev + 1 : 0));
          break;
        case "ArrowUp":
          if (rows.length === 0) return;
          e.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : rows.length - 1));
          break;
        case "Enter":
        case "Tab": {
          // With no row under the cursor, Enter belongs to the composer.
          const row = rows[selectedIndex];
          if (!row) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          selectRow(row);
          break;
        }
        case "Escape":
          e.preventDefault();
          setIsOpen(false);
          break;
      }
    };

    textarea.addEventListener("keydown", handleKeyDown);
    return () => textarea.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, rows, selectedIndex, textareaRef, selectRow, showLoading]);

  useEffect(() => {
    if (selectedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll("[data-slash-item]");
      items[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (!isOpen || !dropdownPos || (rows.length === 0 && !showLoading)) return null;

  let flatIndex = -1;

  const dropdown = (
    <div
      data-autocomplete-dropdown
      className="fixed z-[300] w-[320px] max-w-[calc(100vw-1rem)] vessel-lift pointer-events-auto"
      style={{ bottom: dropdownPos.bottom, left: dropdownPos.left }}
    >
      <div className="vessel overflow-hidden animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 duration-150">
        {/* No top padding: it would inset the sticky headers and leave a slit. */}
        <div ref={listRef} className="max-h-[260px] overflow-y-auto overflow-x-hidden px-1 pb-1">
          {sections.map((section) => (
            <div key={section.key}>
              {(section.bot || section.label) && (
                // Sticky per section so the current bot's header stays pinned. Opaque.
                <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-popover px-2 pt-2 pb-1 text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {section.bot ? <BotIdentity pubkey={section.bot} /> : section.label}
                </div>
              )}
              {section.rows.map((row) => {
                flatIndex += 1;
                const index = flatIndex;
                const isBot = row.type === "bot";
                const command = isBot ? row.entry.command : row.command;
                const args = isBot ? row.entry.command.args : [];
                return (
                  <button
                    key={rowKey(row)}
                    data-slash-item
                    data-highlighted={index === selectedIndex || undefined}
                    className={cn(
                      // scroll-mt clears the sticky header when arrowing.
                      "relative w-full flex items-baseline gap-2 scroll-mt-8 menu-row clip-corner px-2 py-1.5 text-left transition-colors cursor-pointer",
                      index === selectedIndex ? "bg-foreground/[0.08]" : "hover:bg-foreground/[0.05]",
                    )}
                    {...menuPickHandlers(() => selectRow(row))}
                  >
                    {section.key === "recents" && row.type === "bot" && (
                      <span className="self-center">
                        <BotIdentity pubkey={row.entry.bot} avatarOnly />
                      </span>
                    )}
                    <span className="font-mono text-sm font-semibold shrink-0">
                      {!isBot && row.command.usage ? row.command.usage : `/${command.name}`}
                    </span>
                    {args.slice(0, MAX_VISIBLE_ARGS).map((a) => (
                      <span
                        key={a.name}
                        className={cn("font-mono text-xs shrink-0", a.required ? "text-foreground/70" : "text-muted-foreground/60")}
                      >
                        {a.name}
                      </span>
                    ))}
                    {args.length > MAX_VISIBLE_ARGS && (
                      <span
                        className="shrink-0 font-mono text-xs text-muted-foreground/60"
                        title={args.slice(MAX_VISIBLE_ARGS).map((a) => a.name).join(" ")}
                      >
                        +{args.length - MAX_VISIBLE_ARGS}
                      </span>
                    )}
                    {/* min-w-0 lets `truncate` bite so no row widens the menu. */}
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {command.description}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}

          {showLoading && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
              {botCount > 0
                ? intl.formatMessage(
                  { id: "slashCommandAutocomplete.loadingBots", defaultMessage: "Loading {count, plural, one {# bot} other {# bots}}…" },
                  { count: botCount },
                )
                : intl.formatMessage({ id: "slashCommandAutocomplete.lookingForBots", defaultMessage: "Looking for bots…" })}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return renderPortal(dropdown, document.body);
}
