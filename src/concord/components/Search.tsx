import { Check, FileText, Hash, Image as ImageIcon, Link as LinkIcon, Loader2, Lock, Search, SlidersHorizontal, Video, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";

import { DisplayName } from "@/components/DisplayName";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAuthor } from "@/hooks/useAuthor";
import { usePortalDropdown } from "@/hooks/usePortalDropdown";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useMemberProfiles, useRosterProfiles } from "@/hooks/useSearchProfiles";
import {
  activeFacetCount,
  dateTokenPatch,
  formatSearchDate,
  HAS_VALUES,
  parseSearchDate,
  removeToken,
  SEARCH_TOKEN_KEYS,
  tokenAtCaret,
  type SearchFilters,
  type SearchMedia,
  type SearchTokenKey,
} from "@/concord/lib/search";
import { cn } from "@/lib/utils";
import { defineMessage, defineMessages, FormattedMessage, useIntl, type IntlShape, type MessageDescriptor } from "@/i18n";

import type { ChatMsg } from "@/components/chat/transport";
import type { Channel } from "@/concord/lib/types";

const MEDIA_OPTIONS: Array<{ value: SearchMedia; label: MessageDescriptor; icon?: typeof ImageIcon }> = [
  { value: "all", label: defineMessage({ id: "search.media.all", defaultMessage: "All" }) },
  { value: "images", label: defineMessage({ id: "search.media.images", defaultMessage: "Images" }), icon: ImageIcon },
  { value: "videos", label: defineMessage({ id: "search.media.videos", defaultMessage: "Videos" }), icon: Video },
  { value: "links", label: defineMessage({ id: "search.media.links", defaultMessage: "Links" }), icon: LinkIcon },
  { value: "none", label: defineMessage({ id: "search.media.text", defaultMessage: "Text" }), icon: FileText },
];

function MediaToggle({ media, onChange }: { media: SearchMedia; onChange: (m: SearchMedia) => void }) {
  return (
    <ToggleGroup
      type="single"
      value={media}
      onValueChange={(v) => onChange((v || "all") as SearchMedia)}
      className="flex flex-wrap justify-start gap-1"
    >
      {MEDIA_OPTIONS.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          className="gap-1.5 h-auto px-3 py-1.5 touch:py-2.5 text-sm font-normal clip-corner-lg text-muted-foreground hover:bg-foreground/5 hover:text-foreground data-[state=on]:bg-primary data-[state=on]:font-medium data-[state=on]:text-primary-foreground"
        >
          {o.icon && <o.icon className="size-3.5" />}
          <FormattedMessage {...o.label} />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function AuthorChip({ pubkey, onRemove }: { pubkey: string; onRemove: () => void }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  const intl = useIntl();
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 py-0.5 pl-1 pr-1.5 text-xs text-foreground">
      <UserAvatar pubkey={pubkey} metadata={author.data?.metadata} imeta={author.data?.imeta?.picture} name={name} alt="" className="size-4" fallbackClassName="text-monogram" />
      <span className="max-w-28 truncate">
        {name ? <DisplayName pubkey={pubkey} name={name} /> : pubkey.slice(0, 8)}
      </span>
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "search.removeChip", defaultMessage: "Remove {label}" }, { label: name })}
        onClick={onRemove} className="text-muted-foreground hover:text-foreground">
        <X className="size-3" />
      </button>
    </span>
  );
}

function AuthorOption({
  pubkey,
  query,
  selected,
  onToggle,
}: {
  pubkey: string;
  query: string;
  selected: boolean;
  onToggle: () => void;
}) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  // Names resolve async, so each row self-hides.
  if (query && !name.toLowerCase().includes(query) && !pubkey.toLowerCase().startsWith(query)) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-foreground/5"
    >
      <UserAvatar pubkey={pubkey} metadata={author.data?.metadata} imeta={author.data?.imeta?.picture} name={name} alt="" className="size-6" fallbackClassName="text-monogram" />
      <span className="min-w-0 flex-1 truncate">
        {name ? <DisplayName pubkey={pubkey} name={name} /> : pubkey.slice(0, 12)}
      </span>
      {selected && <Check className="size-4 shrink-0 text-primary" />}
    </button>
  );
}

function AuthorFacet({
  members,
  selected,
  onToggle,
}: {
  members: string[];
  selected: string[];
  onToggle: (pubkey: string) => void;
}) {
  const intl = useIntl();
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  return (
    <div className="space-y-1.5">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((pk) => (
            <AuthorChip key={pk} pubkey={pk} onRemove={() => onToggle(pk)} />
          ))}
        </div>
      )}
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={intl.formatMessage({ id: "search.filterPeople", defaultMessage: "Filter people…" })}
        className="h-8"
      />
      <div className="-mx-1 max-h-40 space-y-0.5 overflow-y-auto px-1">
        {members.map((pk) => (
          <AuthorOption
            key={pk}
            pubkey={pk}
            query={query}
            selected={selected.includes(pk)}
            onToggle={() => onToggle(pk)}
          />
        ))}
      </div>
    </div>
  );
}

function ChannelFacet({
  channels,
  selected,
  onToggle,
  onClear,
}: {
  channels: Channel[];
  selected: string[];
  onToggle: (idHex: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label>
          <FormattedMessage id="search.channels" defaultMessage="Channels" />
        </Label>
        {selected.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            <FormattedMessage id="search.allChannels" defaultMessage="All" />
          </button>
        )}
      </div>
      <div className="-mx-1 max-h-40 space-y-0.5 overflow-y-auto px-1">
        {channels.map((c) => (
          <label
            key={c.idHex}
            className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-foreground/5"
          >
            <Checkbox checked={selected.includes(c.idHex)} onCheckedChange={() => onToggle(c.idHex)} />
            {c.isPrivate ? (
              <Lock className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <Hash className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
          </label>
        ))}
      </div>
      <p className="text-2xs text-muted-foreground">
        {selected.length === 0 ? (
          <FormattedMessage id="search.searchingAllChannels" defaultMessage="Searching all channels" />
        ) : (
          <FormattedMessage id="search.selectedCount" defaultMessage="{count} selected" values={{ count: selected.length }} />
        )}
      </p>
    </div>
  );
}

function DateFacet({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (patch: Pick<SearchFilters, "dateFrom" | "dateTo">) => void;
}) {
  const today = parseSearchDate("today") ?? undefined;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>
          <FormattedMessage id="search.date" defaultMessage="Date" />
        </Label>
        {(from || to) && (
          <button
            type="button"
            onClick={() => onChange({ dateFrom: "", dateTo: "" })}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            <FormattedMessage id="search.anyTime" defaultMessage="Any time" />
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-2xs text-muted-foreground">
            <FormattedMessage id="search.dateFrom" defaultMessage="From" />
          </span>
          <Input
            type="date"
            value={from}
            max={to || today}
            onChange={(e) => onChange({ dateFrom: e.target.value, dateTo: to })}
            className="h-8 px-2 text-sm"
          />
        </label>
        <label className="space-y-1">
          <span className="text-2xs text-muted-foreground">
            <FormattedMessage id="search.dateTo" defaultMessage="To" />
          </span>
          <Input
            type="date"
            value={to}
            min={from || undefined}
            max={today}
            onChange={(e) => onChange({ dateFrom: from, dateTo: e.target.value })}
            className="h-8 px-2 text-sm"
          />
        </label>
      </div>
    </div>
  );
}

/** Structured search filters (media, authors, channels), mirroring Ditto's popover. */
export function SearchFiltersPopover({
  channels,
  members,
  filters,
  onChange,
}: {
  channels: Channel[];
  members: string[];
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
}) {
  const intl = useIntl();
  const count = activeFacetCount(filters);
  const set = (patch: Partial<SearchFilters>) => onChange({ ...filters, ...patch });
  const toggleAuthor = (pk: string) =>
    set({
      authors: filters.authors.includes(pk)
        ? filters.authors.filter((a) => a !== pk)
        : [...filters.authors, pk],
    });
  const toggleChannel = (id: string) =>
    set({
      channelIds: filters.channelIds.includes(id)
        ? filters.channelIds.filter((c) => c !== id)
        : [...filters.channelIds, id],
    });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={intl.formatMessage({ id: "search.filters", defaultMessage: "Search filters" })}
          className={cn(
            "relative size-8 touch:size-10 shrink-0 text-muted-foreground",
            count > 0 && "text-foreground",
          )}
        >
          <SlidersHorizontal className="size-4" />
          {count > 0 && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-4 p-3">
        <div className="space-y-1.5">
          <Label>
            <FormattedMessage id="search.mediaLabel" defaultMessage="Media" />
          </Label>
          <MediaToggle media={filters.media} onChange={(m) => set({ media: m })} />
        </div>
        <div className="space-y-1.5">
          <Label>
            <FormattedMessage id="search.fromLabel" defaultMessage="From" />
          </Label>
          <AuthorFacet members={members} selected={filters.authors} onToggle={toggleAuthor} />
        </div>
        <DateFacet from={filters.dateFrom} to={filters.dateTo} onChange={set} />
        <ChannelFacet
          channels={channels}
          selected={filters.channelIds}
          onToggle={toggleChannel}
          onClear={() => set({ channelIds: [] })}
        />
      </PopoverContent>
    </Popover>
  );
}

const NO_MEMBERS: string[] = [];
const TOKEN_LABEL = defineMessages({
  from: { id: "search.token.from", defaultMessage: "From user" },
  in: { id: "search.token.in", defaultMessage: "In channel" },
  has: { id: "search.token.has", defaultMessage: "Message contains" },
  before: { id: "search.token.before", defaultMessage: "Before date" },
  after: { id: "search.token.after", defaultMessage: "After date" },
  during: { id: "search.token.during", defaultMessage: "On date" },
}) satisfies Record<SearchTokenKey, MessageDescriptor>;

interface Suggestion {
  id: string;
  node: ReactNode;
  apply: () => void;
}

function SuggestProfile({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return (
    <>
      <UserAvatar pubkey={pubkey} metadata={author.data?.metadata} imeta={author.data?.imeta?.picture} name={name} alt="" className="size-6" fallbackClassName="text-monogram" />
      <span className="min-w-0 flex-1 truncate">
        {name ? <DisplayName pubkey={pubkey} name={name} /> : pubkey.slice(0, 12)}
      </span>
    </>
  );
}

/**
 * Discord-style typed filters: `from:`/`in:`/`has:`/`before:`/`after:`/`during:`
 * at the caret offer matches, and picking one turns the token into its facet.
 */
/** `from:` rows; the list scrolls, and typing narrows a large roster from there. */
const FROM_SUGGESTIONS = 50;

export function SearchTokenSuggest({
  inputRef,
  filters,
  onChange,
  members,
  channels,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
  members: string[];
  channels: Channel[];
}) {
  const intl = useIntl();
  /** null while the input is unfocused. */
  const [caret, setCaret] = useState<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const sync = () => {
      setCaret(input.selectionStart ?? input.value.length);
      setRect(input.getBoundingClientRect());
    };
    const onInput = () => {
      setDismissed(false);
      setSelected(0);
      sync();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) sync();
    };
    const onBlur = () => setCaret(null);
    if (document.activeElement === input) sync();
    input.addEventListener("input", onInput);
    input.addEventListener("focus", sync);
    input.addEventListener("click", sync);
    input.addEventListener("keyup", onKeyUp);
    input.addEventListener("blur", onBlur);
    return () => {
      input.removeEventListener("input", onInput);
      input.removeEventListener("focus", sync);
      input.removeEventListener("click", sync);
      input.removeEventListener("keyup", onKeyUp);
      input.removeEventListener("blur", onBlur);
    };
  }, [inputRef]);

  const query = filters.query;
  const tok = caret === null ? null : tokenAtCaret(query, Math.min(caret, query.length));
  const roster = useRosterProfiles(members, tok?.key === "from");
  const profiles = useMemberProfiles(
    tok?.key === "from" ? members : NO_MEMBERS,
    tok?.key === "from" ? tok.value : "",
    { limit: FROM_SUGGESTIONS, loaded: roster },
  );

  const placeCaret = (pos: number) => {
    // After React has written the new value, which resets the selection.
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };
  const commit = (patch: Partial<SearchFilters>) => {
    if (!tok) return;
    let next = removeToken(query, tok.start, tok.end);
    const atEnd = tok.end >= query.length;
    if (atEnd && next) next += " ";
    onChange({ ...filters, ...patch, query: next });
    setSelected(0);
    placeCaret(atEnd ? next.length : Math.min(tok.start, next.length));
  };

  const items: Suggestion[] = [];
  let heading = intl.formatMessage({ id: "search.options", defaultMessage: "Search options" });
  let hint: string | undefined;
  if (tok?.key) {
    heading = intl.formatMessage(TOKEN_LABEL[tok.key]);
    const v = tok.value.toLowerCase();
    if (tok.key === "from") {
      for (const p of profiles) {
        if (filters.authors.includes(p.pubkey)) continue;
        items.push({
          id: p.pubkey,
          node: <SuggestProfile pubkey={p.pubkey} />,
          apply: () => commit({ authors: [...filters.authors, p.pubkey] }),
        });
      }
    } else if (tok.key === "in") {
      for (const c of channels) {
        if (filters.channelIds.includes(c.idHex) || !c.name.toLowerCase().includes(v)) continue;
        items.push({
          id: c.idHex,
          node: (
            <>
              {c.isPrivate ? (
                <Lock className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <Hash className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
            </>
          ),
          apply: () => commit({ channelIds: [...filters.channelIds, c.idHex] }),
        });
        if (items.length >= 10) break;
      }
    } else if (tok.key === "has") {
      for (const h of HAS_VALUES) {
        if (!h.value.startsWith(v)) continue;
        items.push({ id: h.value, node: <span>{h.value}</span>, apply: () => commit({ media: h.media }) });
      }
    } else {
      const key = tok.key;
      hint = intl.formatMessage({ id: "search.dateHint", defaultMessage: "YYYY-MM-DD, today or yesterday" });
      const exact = parseSearchDate(tok.value);
      const words = exact ? [tok.value] : ["today", "yesterday"].filter((w) => w.startsWith(v));
      for (const word of words) {
        const ymd = parseSearchDate(word)!;
        items.push({
          id: word,
          node: (
            <span className="min-w-0 flex-1 truncate">
              {formatSearchDate(ymd)}
              {!exact && <span className="text-muted-foreground"> · {word}</span>}
            </span>
          ),
          apply: () => commit(dateTokenPatch(key, ymd)),
        });
      }
    }
  } else if (tok && (tok.value || !query.trim())) {
    const v = tok.value.toLowerCase();
    for (const k of SEARCH_TOKEN_KEYS) {
      if (!k.key.startsWith(v)) continue;
      items.push({
        id: k.key,
        node: (
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{k.key}:</span>{" "}
            <span className="text-muted-foreground">{k.hint}</span>
          </span>
        ),
        apply: () => {
          const text = `${k.key}:`;
          onChange({ ...filters, query: query.slice(0, tok.start) + text + query.slice(tok.end) });
          setSelected(0);
          placeCaret(tok.start + text.length);
        },
      });
    }
  }

  const open = caret !== null && !dismissed && !!rect && (items.length > 0 || !!hint);
  const active = Math.min(selected, Math.max(items.length - 1, 0));
  const tabCompletes = !!tok && (!!tok.key || !!tok.value);

  useEffect(() => {
    const input = inputRef.current;
    if (!open || !input) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const n = items.length;
      if (e.key === "ArrowDown" && n > 0) setSelected((active + 1) % n);
      else if (e.key === "ArrowUp" && n > 0) setSelected((active - 1 + n) % n);
      else if ((e.key === "Enter" || (e.key === "Tab" && tabCompletes)) && n > 0) items[active].apply();
      else if (e.key === "Escape") setDismissed(true);
      else return;
      // Native and first, so the bar's own Escape (close search) never sees it.
      e.preventDefault();
      e.stopPropagation();
    };
    input.addEventListener("keydown", onKeyDown);
    return () => input.removeEventListener("keydown", onKeyDown);
  });

  const close = useCallback(() => setDismissed(true), []);
  const { renderPortal } = usePortalDropdown({ textareaRef: inputRef, isOpen: open, onClose: close, dropdownHeight: 280 });
  if (!open || !rect) return null;

  const width = Math.min(320, window.innerWidth - 16);
  return renderPortal(
    <div
      data-autocomplete-dropdown
      className="fixed z-[300] vessel-lift pointer-events-auto"
      style={{ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width }}
    >
      <div className="vessel overflow-hidden animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150">
        <p className="px-3 pt-2 pb-1 text-2xs uppercase tracking-wide text-muted-foreground/80">{heading}</p>
        <div className="max-h-[240px] overflow-y-auto scroll-py-1 px-1 pb-1">
          {items.map((item, i) => (
            <button
              key={item.id}
              type="button"
              data-highlighted={i === active || undefined}
              className={cn(
                "flex w-full items-center gap-2 clip-corner px-2 py-1.5 touch:py-2.5 text-left text-sm transition-colors",
                i === active ? "bg-foreground/[0.08]" : "hover:bg-foreground/[0.05]",
              )}
              onMouseEnter={() => setSelected(i)}
              // Pointer-down keeps the input focused; touch fires it reliably.
              onPointerDown={(e) => {
                e.preventDefault();
                item.apply();
              }}
            >
              {item.node}
            </button>
          ))}
          {hint && <p className="px-2 py-1.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function FilterChip({ children, onRemove, label }: { children: ReactNode; onRemove: () => void; label: string }) {
  const intl = useIntl();
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 py-0.5 pl-2 pr-1.5 text-xs text-foreground">
      <span className="max-w-40 truncate">{children}</span>
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "search.removeChip", defaultMessage: "Remove {label}" }, { label })}
        onClick={onRemove} className="text-muted-foreground hover:text-foreground">
        <X className="size-3" />
      </button>
    </span>
  );
}

function dateRangeLabel(intl: IntlShape, from: string, to: string): string {
  if (from && to) {
    return from === to
      ? intl.formatMessage({ id: "search.dateOn", defaultMessage: "On {date}" }, { date: formatSearchDate(from) })
      : intl.formatMessage(
          { id: "search.dateRange", defaultMessage: "{from} – {to}" },
          { from: formatSearchDate(from), to: formatSearchDate(to) },
        );
  }
  return from
    ? intl.formatMessage({ id: "search.dateSince", defaultMessage: "From {date}" }, { date: formatSearchDate(from) })
    : intl.formatMessage({ id: "search.dateUntil", defaultMessage: "Until {date}" }, { date: formatSearchDate(to) });
}

/** The active facets as removable chips above the results. */
function SearchFilterChips({
  filters,
  onChange,
  channels,
}: {
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
  channels: Channel[];
}) {
  const intl = useIntl();
  const set = (patch: Partial<SearchFilters>) => onChange({ ...filters, ...patch });
  const media = MEDIA_OPTIONS.find((o) => o.value === filters.media);
  if (activeFacetCount(filters) === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 px-3 pb-1">
      {filters.authors.map((pk) => (
        <AuthorChip key={pk} pubkey={pk} onRemove={() => set({ authors: filters.authors.filter((a) => a !== pk) })} />
      ))}
      {filters.channelIds.map((id) => {
        const c = channels.find((ch) => ch.idHex === id);
        return (
          <FilterChip
            key={id}
            label={c?.name ?? intl.formatMessage({ id: "search.chipChannel", defaultMessage: "channel" })}
            onRemove={() => set({ channelIds: filters.channelIds.filter((x) => x !== id) })}
          >
            #{c?.name ?? intl.formatMessage({ id: "search.chipUnknown", defaultMessage: "unknown" })}
          </FilterChip>
        );
      })}
      {filters.media !== "all" && media && (
        <FilterChip label={intl.formatMessage(media.label)} onRemove={() => set({ media: "all" })}>
          {filters.media === "none" ? (
            <FormattedMessage id="search.chipTextOnly" defaultMessage="Text only" />
          ) : (
            <FormattedMessage
              id="search.chipHas"
              defaultMessage="{media, select, images {Has images} videos {Has videos} links {Has links} other {Has media}}"
              values={{ media: filters.media }}
            />
          )}
        </FilterChip>
      )}
      {(filters.dateFrom || filters.dateTo) && (
        <FilterChip
          label={intl.formatMessage({ id: "search.chipDate", defaultMessage: "date" })}
          onRemove={() => set({ dateFrom: "", dateTo: "" })}
        >
          {dateRangeLabel(intl, filters.dateFrom, filters.dateTo)}
        </FilterChip>
      )}
    </div>
  );
}

/** Read-only search result row; jumps to the message. */
const SearchRow = memo(function SearchRow({
  event,
  highlight,
  channelIdHex,
  onJumpTo,
}: {
  event: ChatMsg;
  highlight?: string;
  /** Absent when the channel is unknown: nowhere to jump to. */
  channelIdHex?: string;
  onJumpTo: (channelIdHex: string, message: ChatMsg) => void;
}) {
  const intl = useIntl();
  // `ChatMsg` is already signature-less, so the message IS the rumor.
  const rumor = event;
  // Bound here rather than by the list so the row's props keep their identity.
  const jump = useCallback(() => {
    if (channelIdHex) onJumpTo(channelIdHex, event);
  }, [channelIdHex, onJumpTo, event]);
  const onJump = channelIdHex ? jump : undefined;
  // The message's menus are portaled yet still React children, so their events
  // bubble here; only an event from the row's own DOM jumps.
  const onRowClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.currentTarget.contains(e.target as Node)) jump();
    },
    [jump],
  );
  const onRowKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if ((e.key === "Enter" || e.key === " ") && e.currentTarget.contains(e.target as Node)) {
        e.preventDefault();
        jump();
      }
    },
    [jump],
  );
  // Hover tint is a clipped `::before`: clipping the wrapper would slice off
  // ChatMessage's floating toolbar.
  return (
    <div
      role={onJump ? "button" : undefined}
      tabIndex={onJump ? 0 : undefined}
      onClick={onJump ? onRowClick : undefined}
      onKeyDown={onJump ? onRowKeyDown : undefined}
      className={cn(
        "relative isolate",
        onJump &&
          "cursor-pointer before:absolute before:inset-0 before:-z-10 before:clip-corner-lg before:transition-colors before:content-[''] hover:before:bg-foreground/5",
      )}
      aria-label={onJump ? intl.formatMessage({ id: "search.jumpToMessage", defaultMessage: "Jump to this message" }) : undefined}
    >
      <ChatMessage
        event={event}
        rumor={rumor}
        canWrite={false}
        canModerate={false}
        highlight={highlight}
        onJump={onJump}
      />
    </div>
  );
});

/** Cross-channel results, newest-first, grouped by channel. */
export function SearchResultsView({
  channels,
  results,
  isLoading,
  query,
  onJump,
  filters,
  onFiltersChange,
  historyIncomplete = false,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: {
  channels: Channel[];
  results: ChatMsg[];
  isLoading: boolean;
  query: string;
  onJump: (channelIdHex: string, message: ChatMsg) => void;
  filters: SearchFilters;
  onFiltersChange: (filters: SearchFilters) => void;
  /** Some searched channel's older history isn't on this device yet. */
  historyIncomplete?: boolean;
  /** The results are a full page; more matches may follow. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  const nameByChannel = useMemo(() => {
    const m = new Map<string, Channel>();
    for (const c of channels) m.set(c.idHex, c);
    return m;
  }, [channels]);

  const chips = <SearchFilterChips filters={filters} onChange={onFiltersChange} channels={channels} />;
  const coverage = historyIncomplete ? (
    <p className="flex items-center gap-1.5 px-3 pb-1 text-xs text-muted-foreground">
      <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
      <FormattedMessage
        id="search.historyIncomplete"
        defaultMessage="Older messages are still downloading, so some may not show up yet."
      />
    </p>
  ) : null;
  if (isLoading) {
    return (
      <div className="flex flex-col px-2 py-2">
        {chips}
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="flex flex-col px-2 py-2">
        {chips}
        {coverage}
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Search className="mb-3 size-9 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            <FormattedMessage id="search.noResults" defaultMessage="No messages found" />
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col px-2 py-2">
      {chips}
      {coverage}
      <p className="px-3 pb-1 text-2xs uppercase tracking-wide text-muted-foreground/80">
        <FormattedMessage
          id="search.resultCount"
          defaultMessage="{count, plural, one {# result} other {# results}}"
          values={{ count: results.length }}
        />
      </p>
      {results.map((msg) => {
        const channelIdHex = msg.tags.find((t) => t[0] === "channel")?.[1] ?? "";
        const ch = nameByChannel.get(channelIdHex);
        return (
          <div key={msg.id} className="pb-1">
            <div className="flex items-center gap-1 px-3 pt-2 pb-0.5 text-xs font-medium text-muted-foreground">
              {ch?.isPrivate ? <Lock className="size-3 shrink-0" /> : <Hash className="size-3 shrink-0" />}
              <span className="truncate">
                {ch?.name ?? <FormattedMessage id="search.unknownChannel" defaultMessage="unknown channel" />}
              </span>
            </div>
            <SearchRow
              event={msg}
              highlight={query}
              channelIdHex={ch ? channelIdHex : undefined}
              onJumpTo={onJump}
            />
          </div>
        );
      })}
      {(hasMore || loadingMore) && onLoadMore && (
        <div className="flex justify-center py-3">
          <Button variant="secondary" size="sm" className="touch:h-11" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore && <Loader2 className="size-4 animate-spin" aria-hidden />}
            <FormattedMessage id="search.showMore" defaultMessage="Show more results" />
          </Button>
        </div>
      )}
    </div>
  );
}
