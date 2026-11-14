import data from "@emoji-mart/data";
import { Picker } from "emoji-mart";
import { Compass } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useStableNavigate } from "@/hooks/useStableNavigate";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { recordReaction } from "@/hooks/useFrequentReactions";
import { syncEmojiMartCategories } from "@/lib/emojiMartCategories";
import { FormattedMessage, useIntl } from "@/i18n";

import { paletteSections } from "@/lib/customEmoji";

import type { CustomEmoji } from "@/hooks/useCustomEmojis";

export interface NativeEmojiSelection {
  type: "native";
  emoji: string;
}

export interface CustomEmojiSelection {
  type: "custom";
  shortcode: string;
  url: string;
}

export type EmojiSelection = NativeEmojiSelection | CustomEmojiSelection;

interface EmojiPickerProps {
  onSelect: (selection: EmojiSelection) => void;
  /** NIP-30 custom emojis to display in a dedicated tab. */
  customEmojis?: CustomEmoji[];
  /** Footer linking to Discover's emoji packs (opt-in; called before navigating). */
  onBrowsePacks?: () => void;
  /** The host has its own packs link; keep the footer only as the no-custom-emoji empty state. */
  packsLinkInHost?: boolean;
  /** Count picks toward the frequent reactions (default). Off where picking isn't using. */
  recordUsage?: boolean;
}

interface EmojiMartCustomEmoji {
  id: string;
  name: string;
  keywords: string[];
  skins: { src: string }[];
}

interface EmojiMartEmoji {
  id: string;
  native?: string;
  shortcodes?: string;
  unified?: string;
  src?: string;
}

/** A lucide icon (24-unit, stroke 2) as a CSS mask, for glyphs inside emoji-mart's shadow root. */
function lucideMask(body: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * Manages the emoji-mart Picker web component imperatively: `@emoji-mart/react`
 * constructs it in an effect, which throws "Illegal constructor" on remount.
 */
/** Grid cell and hover tile (px): emoji-mart's 24px emoji with an even 5px around it. */
const EMOJI_CELL = 40;
const EMOJI_TILE = 34;

export function EmojiPicker({ onSelect, customEmojis, onBrowsePacks, packsLinkInHost, recordUsage = true }: EmojiPickerProps) {
  const intl = useIntl();
  const isMobile = useIsMobile();
  const { user } = useCurrentUser();
  const containerRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<InstanceType<typeof Picker> | null>(null);
  const onSelectRef = useRef(onSelect);

  onSelectRef.current = onSelect;

  const handleSelect = useCallback((emoji: EmojiMartEmoji) => {
    if (emoji.src) {
      if (recordUsage) recordReaction(user?.pubkey, `:${emoji.id}:`, emoji.src, emoji.id);
      onSelectRef.current({
        type: "custom",
        shortcode: emoji.id,
        url: emoji.src,
      });
    } else if (emoji.native) {
      if (recordUsage) recordReaction(user?.pubkey, emoji.native, undefined, emoji.id);
      onSelectRef.current({
        type: "native",
        emoji: emoji.native,
      });
    }
  }, [user?.pubkey, recordUsage]);

  // One custom category PER SOURCE PACK (like Discord per server).
  const customCategories = useMemo(() => {
    if (!customEmojis || customEmojis.length === 0) return undefined;

    // No per-category `icon`: each would get its own nav button and overflow the
    // single-row nav. Without one, packs share the first's nav entry.
    return paletteSections(customEmojis).map((section) => ({
      // Used for DOM ids, so keep a safe charset.
      id:
        section.source === "pack"
          ? `custom-${section.key.replace(/[^a-zA-Z0-9]+/g, "-")}`
          : section.source === "workspace"
            ? "custom-workspace"
            : "custom-nostr",
      name:
        section.source === "workspace"
          ? intl.formatMessage({ id: "emojiPicker.workspace", defaultMessage: "Workspace" })
          : section.name ?? intl.formatMessage({ id: "emojiPicker.custom", defaultMessage: "Custom" }),
      emojis: section.emojis.map(
        (e): EmojiMartCustomEmoji => ({
          id: e.shortcode,
          name: e.shortcode,
          keywords: [e.shortcode],
          skins: [{ src: e.url }],
        }),
      ),
    }));
  }, [customEmojis, intl]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const pickerOptions: Record<string, unknown> = {
      data,
      onEmojiSelect: handleSelect,
      theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
      previewPosition: "none",
      skinTonePosition: "search",
      set: "native",
      maxFrequentRows: 1,
      navPosition: "bottom",
      dynamicWidth: true,
      emojiButtonSize: EMOJI_CELL,
      parent: container,
      autoFocus: !isMobile,
    };
    // emoji-mart sizes the frequent row from `perLine` (default 9) before dynamicWidth
    // measures, orphaning emoji in a narrower picker. Same formula as its own.
    const width = container.getBoundingClientRect().width;
    if (width > 0) pickerOptions.perLine = Math.max(1, Math.floor(width / EMOJI_CELL));

    if (customCategories) {
      // Before the constructor: reconciles emoji-mart's global category table (see
      // syncEmojiMartCategories).
      syncEmojiMartCategories(customCategories);
      pickerOptions.custom = customCategories;
      pickerOptions.categories = [
        "frequent",
        ...customCategories.map((c) => c.id),
        "people",
        "nature",
        "foods",
        "activity",
        "places",
        "objects",
        "flags",
      ];
    }

    const picker = new Picker(pickerOptions);
    pickerRef.current = picker;

    // Shadow-DOM style overrides for sizing and theme.
    requestAnimationFrame(() => {
      const shadowRoot = (container.firstChild as HTMLElement)?.shadowRoot;
      if (shadowRoot) {
        const style = document.createElement("style");
        style.textContent = [
          ":host { width: 100% !important; height: 100% !important; min-height: 0 !important; border-radius: 0 !important; box-shadow: none !important; }",
          "#root { width: 100% !important; background-color: transparent !important; --sidebar-width: 0px !important; }",
          ".scroll { padding-right: var(--padding) !important; }",
          ".sticky { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; background-color: transparent !important; }",
          // Mirrors SearchField: a `clip-corner-lg` chrome well with no focus ring.
          ".search input[type='search'] { background-color: hsl(var(--chrome)) !important; border: 0 !important; border-radius: 0.55rem !important; clip-path: polygon(0.7rem 0, 100% 0, 100% calc(100% - 0.7rem), calc(100% - 0.7rem) 100%, 0 100%, 0 0.7rem) !important; padding: 0.5rem 46px 0.5rem 34px !important; height: 36px !important; }",
          "@media (pointer: coarse) { .search input[type='search'] { height: 44px !important; } }",
          // The sticker/GIF search wrapper's `pt-3 pb-2`; the spacer is emoji-mart's only gap above the field.
          ".spacer { height: 12px !important; }",
          ".flex-middle:has(> .search) { padding-bottom: 8px !important; }",
          ".search input[type='search']:focus { box-shadow: none !important; background-color: hsl(var(--chrome)) !important; }",
          ".search input[type='search']::placeholder { color: hsl(var(--muted-foreground)) !important; opacity: 1 !important; }",
          ".search .icon { color: hsl(var(--muted-foreground)) !important; }",
          // SearchField's lucide glyphs and offsets: 16px icons, loupe 8px in, X centered in a 28px button 8px in.
          ".search .icon svg { display: none !important; }",
          ".search .icon { width: 16px !important; height: 16px !important; background-color: currentColor !important; -webkit-mask: var(--icon) center / contain no-repeat !important; mask: var(--icon) center / contain no-repeat !important; }",
          `.search .loupe { left: 8px !important; right: auto !important; --icon: ${lucideMask(`<path d='m21 21-4.34-4.34'/><circle cx='11' cy='11' r='8'/>`)}; }`,
          `.search .delete { right: 14px !important; left: auto !important; --icon: ${lucideMask(`<path d='M18 6 6 18'/><path d='m6 6 12 12'/>`)}; }`,
          // Matches Input's `text-base md:text-sm` and the app font; emoji-mart sets its own stack.
          "input { font-size: 16px !important; font-family: 'Inter Variable', 'Inter', system-ui, sans-serif !important; }",
          "@media (min-width: 768px) { input { font-size: 14px !important; } }",
          "#nav { flex-shrink: 0 !important; overflow: visible !important; }",
          "#nav svg, #nav img { overflow: visible !important; }",
          "#nav button { color: hsl(var(--muted-foreground)) !important; overflow: visible !important; }",
          "#nav button:hover { color: hsl(var(--foreground)) !important; }",
          "#nav button[aria-selected] { color: hsl(var(--primary)) !important; }",
          "#nav .bar { background-color: hsl(var(--primary)) !important; }",
          // Hover/keyboard tile in the menu-row idiom: a chamfered square at the menus' tint, not a disc.
          // Equal cells (emoji-mart spreads them with space-between) and a square tile
          // centred in each, so the emoji has the same margin to the highlight on every side.
          ".row > * { flex: 1 1 0 !important; width: auto !important; }",
          `.category button .background { top: 50% !important; left: 50% !important; right: auto !important; bottom: auto !important; width: ${EMOJI_TILE}px !important; height: ${EMOJI_TILE}px !important; transform: translate(-50%, -50%) !important; background-color: hsl(var(--foreground) / 0.08) !important; border-radius: 0.3rem !important; clip-path: polygon(0.375rem 0, 100% 0, 100% calc(100% - 0.375rem), calc(100% - 0.375rem) 100%, 0 100%, 0 0.375rem) !important; }`,
          "#nav .bar { border-radius: 0 !important; }",
          ".scroll::-webkit-scrollbar { width: 6px !important; }",
          ".scroll::-webkit-scrollbar-thumb { background-color: transparent !important; border: 0 !important; border-radius: 9999px !important; }",
          ".scroll:hover::-webkit-scrollbar-thumb { background-color: hsl(var(--border)) !important; }",
          ".scroll::-webkit-scrollbar-track { background: transparent !important; }",
          ".sticky { color: hsl(var(--muted-foreground)) !important; font-size: 11px !important; text-transform: uppercase !important; letter-spacing: 0.05em !important; }",
          ".emoji-mart-emoji img[src] { width: 1em; height: 1em; object-fit: contain; }",
          // emoji-mart inlines its own stack, which lacks the bundled Twemoji fallback.
          ".emoji-mart-emoji > span { font-family: var(--emoji-fonts) !important; }",
        ].join(" ");
        shadowRoot.appendChild(style);
      }
    });

    return () => {
      pickerRef.current = null;
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
    };
  }, [handleSelect, customCategories, isMobile]);

  // Inside the fixed height: some hosts size to the picker and clip.
  return (
    <div className="flex w-full flex-col h-[min(360px,55dvh)] min-h-[220px] max-h-full">
      <div
        ref={containerRef}
        className="emoji-mart-wrapper flex w-full flex-1 min-h-0"
        style={{ isolation: "isolate" }}
        onWheel={(e) => {
          e.stopPropagation();
        }}
        onTouchMove={(e) => {
          e.stopPropagation();
        }}
      />
      {onBrowsePacks && !(packsLinkInHost && customEmojis?.length) && (
        <BrowsePacksFooter hasCustom={Boolean(customEmojis?.length)} onBrowse={onBrowsePacks} />
      )}
    </div>
  );
}

function BrowsePacksFooter({ hasCustom, onBrowse }: { hasCustom: boolean; onBrowse: () => void }) {
  const navigate = useStableNavigate();
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-foreground/10 px-3 py-1.5">
      <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {hasCustom ? (
          <FormattedMessage id="emojiPicker.findMorePacks" defaultMessage="Find more emoji packs" />
        ) : (
          <FormattedMessage id="emojiPicker.addCustomPacks" defaultMessage="Add custom emoji packs" />
        )}
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="h-7 touch:h-11 shrink-0 clip-corner-lg px-2 text-xs"
        onClick={() => {
          onBrowse();
          navigate("/discover?tab=emojis");
        }}
      >
        <Compass className="size-3" />
        <FormattedMessage id="emojiPicker.browse" defaultMessage="Browse" />
      </Button>
    </div>
  );
}
